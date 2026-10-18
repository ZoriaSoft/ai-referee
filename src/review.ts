import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import { chunkDiff, globMatch, parseDiff, type DiffChunk, type FileDiff } from "./diff.js";
import { run } from "./exec.js";
import * as git from "./git.js";
import { buildPrReview } from "./comments.js";
import { buildFixPrompt, buildParseRetryPrompt, buildReviewPrompt, repoNoteSnippet } from "./prompt.js";
import { buildReviewer, invokeChain, type Reviewer } from "./reviewer.js";
import type { ChunkResult, Finding, GateReport, TestResult, TokenUsage } from "./types.js";
import { parseVerdict, VerdictParseError } from "./verdict.js";

export interface ReviewTarget {
  kind: "local" | "pr";
  base: string;
  head: string;
  pr?: number;
  /** Directory the diff/tests/fix run against. */
  worktree: string;
  /** Set for PR targets; caller-owned cleanup happens in runReview. */
  tempWorktree: boolean;
}

export interface ReviewOptions {
  config: Config;
  cwd: string;
  /** Explicit base ref; defaults to upstream/origin default branch. */
  base?: string;
  /** PR number to review in an isolated git worktree. */
  pr?: number;
  /** Include uncommitted working-tree changes (local target only). */
  includeUncommitted?: boolean;
  /** Skip the test step entirely. */
  skipTests?: boolean;
  /** Run one fixer round on REJECT, then re-review (local target only). */
  fix?: boolean;
  /** Merge via `gh pr merge` on APPROVE (PR target only). */
  autoMerge?: boolean;
  /** Post the verdict + findings as a GitHub review on the PR (PR target only). */
  postComments?: boolean;
  /** Max parse retries per chunk after the first attempt. */
  maxParseRetries?: number;
}

export class ReviewError extends Error {}

/** Resolves which ref pair and worktree this review operates on. */
export async function resolveTarget(opts: {
  cwd: string;
  base?: string;
  pr?: number;
  includeUncommitted?: boolean;
}): Promise<ReviewTarget> {
  const { cwd, base, pr, includeUncommitted } = opts;

  if (pr !== undefined) {
    const headSha = await git.fetchPrHead(cwd, pr);
    const ghBase = await git.ghPrBase(cwd, pr);
    const resolvedBase = base ?? (ghBase ? `origin/${ghBase}` : await git.defaultBase(cwd));
    const dir = await mkdtemp(join(tmpdir(), `ai-referee-pr${pr}-`));
    await git.addWorktree(cwd, dir, headSha);
    return {
      kind: "pr",
      base: resolvedBase,
      head: headSha,
      pr,
      worktree: dir,
      tempWorktree: true,
    };
  }

  const resolvedBase = base ?? (await git.defaultBase(cwd));
  const head = includeUncommitted ? `${await git.currentBranch(cwd)} (worktree)` : await git.headSha(cwd);
  return {
    kind: "local",
    base: resolvedBase,
    head,
    worktree: cwd,
    tempWorktree: false,
  };
}

/** Fetches, chunks and reviews a diff; the complete merge-gate pipeline. */
export async function runReview(opts: ReviewOptions): Promise<GateReport> {
  const { config, cwd } = opts;
  const target = await resolveTarget({
    cwd,
    base: opts.base,
    pr: opts.pr,
    includeUncommitted: opts.includeUncommitted,
  });

  try {
    return await runReviewOnTarget(opts, target);
  } finally {
    if (target.tempWorktree) {
      await git.removeWorktree(cwd, target.worktree);
      await rm(target.worktree, { recursive: true, force: true });
    }
  }
}

async function runReviewOnTarget(opts: ReviewOptions, target: ReviewTarget): Promise<GateReport> {
  const { config } = opts;
  const wt = target.worktree;

  const rawDiff = await git.diffAgainst(
    wt,
    target.base,
    target.kind === "local" && opts.includeUncommitted === true,
  );
  if (!rawDiff.trim()) {
    throw new ReviewError(`empty diff between ${target.base} and ${target.head} — nothing to review`);
  }

  const allFiles = parseDiff(rawDiff);
  const excluded = new Set(
    allFiles.filter((f) => config.exclude.some((p) => globMatch(p, f.path))).map((f) => f.path),
  );
  const files = allFiles.filter((f) => !excluded.has(f.path) && !f.isBinary);
  const chunks = chunkDiff(files, config.chunkBudget);

  const tests = await runTests(config, wt, opts.skipTests === true);
  const reviewers = config.reviewers.map(buildReviewer);
  const repoNote = await repoNoteSnippet(await readOptional(join(wt, "README.md")));

  const reviewed = await reviewChunks({
    chunks,
    reviewers,
    target,
    repoNote,
    worktree: wt,
    maxParseRetries: opts.maxParseRetries ?? 1,
    concurrency: config.reviewConcurrency,
    contextBudget: config.contextBudget,
    round: 1,
  });

  let findings = aggregateFindings(reviewed);
  let { verdict, reasons } = decideVerdict(reviewed, tests, reviewers.length === 0);

  const fix = { requested: opts.fix === true, ran: false, detail: null as string | null };
  if (
    opts.fix === true &&
    verdict === "REJECT" &&
    config.fixerCommand &&
    target.kind === "local" &&
    reviewed.every((c) => c.failedReason === null) &&
    tests.passed
  ) {
    fix.ran = true;
    fix.detail = await runFixer(config.fixerCommand, config.fixerTimeoutMs, wt, findings, target);
    // Re-review the modified worktree once.
    const newDiff = await git.diffAgainst(wt, target.base, true);
    const newFiles = parseDiff(newDiff).filter((f) => !excluded.has(f.path) && !f.isBinary);
    const newChunks = chunkDiff(newFiles, config.chunkBudget);
    const reReviewed = await reviewChunks({
      chunks: newChunks,
      reviewers,
      target,
      repoNote,
      worktree: wt,
      maxParseRetries: opts.maxParseRetries ?? 1,
      concurrency: config.reviewConcurrency,
      contextBudget: config.contextBudget,
      round: 2,
    });
    const reTests = await runTests(config, wt, false);
    findings = aggregateFindings(reReviewed);
    const decided = decideVerdict(reReviewed, reTests, false);
    verdict = decided.verdict;
    reasons = decided.reasons;
    reviewed.length = 0;
    reviewed.push(...reReviewed);
    tests.passed = reTests.passed;
    tests.outputTail = reTests.outputTail;
  }

  const totals = allFiles.reduce(
    (acc, f) => ({ insertions: acc.insertions + f.insertions, deletions: acc.deletions + f.deletions }),
    { insertions: 0, deletions: 0 },
  );

  const report: GateReport = {
    tool: "ai-referee",
    version: "0.1.0",
    generatedAt: new Date().toISOString(),
    target: {
      kind: target.kind,
      base: target.base,
      head: target.head,
      ...(target.pr !== undefined ? { pr: target.pr } : {}),
    },
    stats: {
      filesChanged: allFiles.length,
      insertions: totals.insertions,
      deletions: totals.deletions,
      chunks: reviewed.length,
      ...(() => {
        const tokens = totalTokens(reviewed);
        return tokens ? { tokens } : {};
      })(),
    },
    tests,
    verdict,
    summary: summarize(reviewed, verdict),
    findings,
    chunks: reviewed,
    reasons,
    fix,
    comments: { requested: opts.postComments === true && target.pr !== undefined, posted: false, detail: null },
  };

  if (report.comments.requested && target.pr !== undefined) {
    try {
      const payload = buildPrReview(report, allFiles);
      await git.ghPostReview(opts.cwd, target.pr, payload);
      report.comments.posted = true;
      report.comments.detail = `posted ${payload.event} with ${payload.comments.length} inline comment(s)`;
    } catch (err) {
      // Comment posting is best-effort: the gate verdict stands on its own.
      report.comments.detail = `post failed: ${(err as Error).message}`;
    }
  }

  if (opts.autoMerge && verdict === "APPROVE" && target.pr !== undefined) {
    try {
      const out = await git.ghMergePr(opts.cwd, target.pr);
      report.reasons.push(`auto-merged PR #${target.pr}: ${out}`);
    } catch (err) {
      report.verdict = "REJECT";
      report.reasons.push(`auto-merge failed: ${(err as Error).message}`);
    }
  }

  return report;
}



async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function runTests(config: Config, worktree: string, skip: boolean): Promise<TestResult> {
  if (skip || !config.testCommand) {
    return { ran: false, command: config.testCommand, passed: true, outputTail: "" };
  }
  const res = await run(config.testCommand, {
    cwd: config.workdir ? join(worktree, config.workdir) : worktree,
    timeoutMs: config.testTimeoutMs,
  });
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  return {
    ran: true,
    command: config.testCommand,
    passed: res.exitCode === 0 && !res.timedOut,
    outputTail: combined.split("\n").slice(-30).join("\n"),
  };
}

async function reviewChunks(opts: {
  chunks: DiffChunk[];
  reviewers: Reviewer[];
  target: ReviewTarget;
  repoNote: string | null;
  worktree: string;
  maxParseRetries: number;
  concurrency: number;
  contextBudget: number;
  round: number;
}): Promise<ChunkResult[]> {
  const { chunks, reviewers, target, repoNote, worktree, maxParseRetries, concurrency, contextBudget, round } = opts;

  /** Reviews one chunk through the fallback chain with parse retries. */
  const reviewOne = async (chunk: DiffChunk): Promise<ChunkResult> => {
    const result: ChunkResult = {
      index: chunk.index,
      files: chunk.files.map((f) => f.path),
      parsed: null,
      failedReason: null,
      attempts: [],
      round,
    };

    if (reviewers.length === 0) {
      result.failedReason = "no reviewers configured";
      return result;
    }

    const { files: contextFiles, skipped: contextSkipped } = await gatherContext(chunk.files, worktree, contextBudget);
    let prompt = buildReviewPrompt({
      index: chunk.index,
      files: result.files,
      patch: chunk.patch,
      truncated: chunk.truncated,
      totalChunks: chunks.length,
      base: target.base,
      head: target.head,
      repoNote,
      contextFiles,
      contextSkipped,
    });

    for (let attempt = 0; attempt <= maxParseRetries; attempt++) {
      const chain = await invokeChain(reviewers, prompt, worktree);
      result.attempts.push(...chain.attempts);
      if (!chain.response) {
        result.failedReason = "no referee answered (all reviewers unavailable)";
        break;
      }
      try {
        result.parsed = parseVerdict(chain.response.output);
        result.failedReason = null;
        break;
      } catch (err) {
        const why = err instanceof VerdictParseError ? err.message : String(err);
        if (attempt === maxParseRetries) {
          result.failedReason = `unparseable verdict after ${attempt + 1} attempt(s): ${why}`;
        } else {
          prompt = buildParseRetryPrompt(why);
        }
      }
    }
    return result;
  };

  // Bounded worker pool: chunks run `concurrency` at a time; results keep
  // diff order regardless of completion order.
  const results = new Array<ChunkResult>(chunks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      const i = next++;
      results[i] = await reviewOne(chunks[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), chunks.length || 1) }, worker));
  return results;
}

/**
 * Reads the post-change body of each changed file for prompt context until
 * `budget` chars run out. Deleted/binary files and unreadable paths skip
 * silently — the diff alone still reviews fine.
 */
async function gatherContext(
  files: FileDiff[],
  worktree: string,
  budget: number,
): Promise<{ files: { path: string; content: string }[]; skipped: string[] }> {
  const out: { path: string; content: string }[] = [];
  const skipped: string[] = [];
  if (budget <= 0) return { files: out, skipped };
  let left = budget;
  for (const f of files) {
    if (f.isDeleted || f.isBinary) continue;
    const content = await readOptional(join(worktree, f.path));
    if (content === null) continue;
    const text = content.length <= left ? content : content.slice(0, left) + "\n[... truncated for context budget ...]";
    out.push({ path: f.path, content: text });
    left -= text.length;
    if (left <= 0) break;
  }
  const seen = new Set(out.map((f) => f.path));
  for (const f of files) {
    if (!f.isDeleted && !f.isBinary && !seen.has(f.path)) skipped.push(f.path);
  }
  return { files: out, skipped };
}

/** Summed token usage across all attempts; null when nothing reported it. */
function totalTokens(chunks: ChunkResult[]): TokenUsage | null {
  let acc: TokenUsage | null = null;
  for (const c of chunks) {
    for (const a of c.attempts) {
      if (!a.tokens) continue;
      acc = acc
        ? { prompt: acc.prompt + a.tokens.prompt, completion: acc.completion + a.tokens.completion, total: acc.total + a.tokens.total }
        : { ...a.tokens };
    }
  }
  return acc;
}

/** Drops exact duplicate findings across chunks (same file, line, message). */
function aggregateFindings(chunks: ChunkResult[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  const order: Record<string, number> = { blocker: 0, major: 1, minor: 2, info: 3 };
  for (const c of chunks) {
    for (const f of c.parsed?.findings ?? []) {
      const key = `${f.file}:${f.line ?? ""}:${f.message.toLowerCase().slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  out.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.file.localeCompare(b.file));
  return out;
}

function decideVerdict(
  chunks: ChunkResult[],
  tests: TestResult,
  noReviewersConfigured: boolean,
): { verdict: "APPROVE" | "REJECT"; reasons: string[] } {
  const reasons: string[] = [];
  if (tests.ran && !tests.passed) reasons.push("tests failed");
  if (noReviewersConfigured) reasons.push("no referees configured — refusing to approve");
  for (const c of chunks) {
    if (c.failedReason) {
      reasons.push(`chunk ${c.index + 1}: ${c.failedReason}`);
    } else if (c.parsed?.verdict === "REJECT") {
      reasons.push(`chunk ${c.index + 1}: reviewer rejected`);
    }
  }
  return { verdict: reasons.length ? "REJECT" : "APPROVE", reasons };
}

function summarize(chunks: ChunkResult[], verdict: "APPROVE" | "REJECT"): string {
  const summaries = chunks.map((c) => c.parsed?.summary).filter((s): s is string => !!s);
  if (summaries.length === 0) {
    return verdict === "REJECT" ? "Rejected: review could not complete." : "Approved.";
  }
  const seen = new Set<string>();
  const unique = summaries.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
  return unique.join(" | ");
}

async function runFixer(
  command: string,
  timeoutMs: number,
  worktree: string,
  findings: Finding[],
  target: ReviewTarget,
): Promise<string> {
  const findingsText = findings
    .map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}${f.suggestion ? ` (hint: ${f.suggestion})` : ""}`)
    .join("\n");
  const prompt = buildFixPrompt({ findingsText, base: target.base, head: target.head });
  const res = await run(command, { cwd: worktree, stdin: prompt, timeoutMs });
  if (res.timedOut) return "fixer timed out";
  if (res.exitCode !== 0) return `fixer exited ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`;
  return res.stdout.trim().slice(0, 400) || "fixer completed";
}

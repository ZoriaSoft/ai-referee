import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, type Config } from "./config.js";
import { globMatch, parseDiff, type DiffChunk, type FileDiff } from "./diff.js";
import { run, scrubSecretEnv } from "./exec.js";
import * as git from "./git.js";
import { buildPrReviewSet, REVIEW_MARKER } from "./comments.js";
import { buildFixPrompt, buildParseRetryPrompt, buildReviewPrompt, newNonce, repoNoteSnippet } from "./prompt.js";
import { buildReviewer, invokeChain, type Reviewer } from "./reviewer.js";
import { chunkFilesByRoute, planForFile, type ReviewPlan } from "./routing.js";
import type { ChunkResult, Finding, GateReport, ReviewProfile, TestResult, TokenUsage } from "./types.js";
import { parseVerdict, VerdictParseError } from "./verdict.js";

export interface ReviewTarget {
  kind: "local" | "pr";
  base: string;
  /** Full commit SHA under review; for uncommitted local reviews a "<branch> (worktree)" label. */
  head: string;
  /** True when `head` is an exact commit SHA that diff, tests and review are bound to. */
  pinned: boolean;
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
  /** Post a GitHub commit status (pending → success/failure) on the PR head SHA. */
  postStatus?: boolean;
  /** Max parse retries per chunk after the first attempt. */
  maxParseRetries?: number;
  /** Prompt profile override; defaults to config.profile ("strict"). */
  profile?: ReviewProfile;
  /** Verify REJECT verdicts with a second reviewer; defaults to config.confirmRejections. */
  confirmRejections?: boolean;
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

  if (base !== undefined) git.assertRef(base);
  if (pr !== undefined) {
    git.assertPrNumber(pr);
    const headSha = await git.fetchPrHead(cwd, pr);
    const ghBase = await git.ghPrBase(cwd, pr);
    const resolvedBase = base ?? (ghBase ? `origin/${ghBase}` : await git.defaultBase(cwd));
    const dir = await mkdtemp(join(tmpdir(), `ai-referee-pr${pr}-`));
    await git.addWorktree(cwd, dir, headSha);
    return {
      kind: "pr",
      base: resolvedBase,
      head: headSha,
      pinned: true,
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
    pinned: !includeUncommitted,
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
    // Scratch ref from fetchPrHead; the worktree holds the objects, so the
    // ref is only bookkeeping. Dropped best-effort — a leftover just gets
    // overwritten by the next review of the same PR.
    if (target.pr !== undefined) await git.dropPrRef(cwd, target.pr);
  }
}

async function runReviewOnTarget(opts: ReviewOptions, target: ReviewTarget): Promise<GateReport> {
  const { config } = opts;
  const wt = target.worktree;

  // Bound to the exact SHA: what the reviewer sees is what tests ran on and
  // what auto-merge is allowed to merge (--match-head-commit).
  const rawDiff = await git.diffAgainst(
    wt,
    target.base,
    !target.pinned,
    target.pinned ? target.head : "HEAD",
  );
  if (!rawDiff.trim()) {
    throw new ReviewError(`empty diff between ${target.base} and ${target.head} — nothing to review`);
  }

  const allFiles = parseDiff(rawDiff);
  const excluded = new Set(
    allFiles.filter((f) => config.exclude.some((p) => globMatch(p, f.path))).map((f) => f.path),
  );
  const files = allFiles.filter((f) => !excluded.has(f.path) && !f.isBinary);
  const preWarnings: string[] = [];
  if (target.kind === "pr" && allFiles.some((f) => f.path === CONFIG_FILENAME || f.path.endsWith(`/${CONFIG_FILENAME}`))) {
    preWarnings.push(
      `PR changes ${CONFIG_FILENAME} — ignored: the gate ran with the local (trusted) config, not the PR's`,
    );
  }

  // Commit status: "pending" marks the head while tests + review run; the
  // final state lands after auto-merge so a failed merge reads "failure".
  // Best-effort like comments — status problems never flip the verdict.
  const statusWanted = opts.postStatus === true && target.pr !== undefined;
  let statusState: "pending" | "success" | "failure" | null = null;
  const statusNotes: string[] = [];
  const postStatus = async (state: "pending" | "success" | "failure", description: string): Promise<void> => {
    if (!statusWanted) return;
    try {
      await git.ghPostCommitStatus(opts.cwd, target.head, state, description);
      statusState = state;
      statusNotes.push(`${state} posted`);
    } catch (err) {
      statusNotes.push(`${state} post failed: ${(err as Error).message}`);
    }
  };
  await postStatus("pending", `ai-referee reviewing PR #${target.pr}…`);

  // PR tests execute code from the pull request: strip credential-looking env
  // vars unless the (trusted, local) config explicitly opts back in.
  const testEnv = target.kind === "pr" && !config.passSecretsToTests ? scrubSecretEnv() : undefined;
  const tests = await runTests(config, wt, opts.skipTests === true, testEnv);
  const integrity = target.pinned ? await checkWorktreeIntegrity(target) : null;
  const runProfile: ReviewProfile = opts.profile ?? config.profile;
  const byName = new Map(config.reviewers.map((r) => [r.name, buildReviewer(r)]));
  const defaultChain = config.reviewers.map((r) => byName.get(r.name)!);
  // README context comes from the trusted local checkout, never from the PR.
  const repoNote = await repoNoteSnippet(await readOptional(join(opts.cwd, "README.md")));
  // PR reviewers run in an empty dir by default: agent CLIs auto-load
  // instruction files (AGENTS.md, CLAUDE.md…) from their cwd, and in a PR
  // worktree those are written by the PR author.
  const isolatedDir =
    target.kind === "pr" && config.reviewerWorkdir === "isolated"
      ? await mkdtemp(join(tmpdir(), "ai-referee-reviewer-"))
      : null;
  try {

  const reviewed = await reviewChunks({
    files,
    byName,
    defaultChain,
    runProfile,
    target,
    repoNote,
    worktree: wt,
    reviewerCwd: isolatedDir ?? wt,
    contextSha: target.pinned ? target.head : null,
    requireNonce: config.requireNonce,
    maxParseRetries: opts.maxParseRetries ?? 1,
    concurrency: config.reviewConcurrency,
    contextBudget: config.contextBudget,
    chunkBudget: config.chunkBudget,
    routes: config.routes,
    confirmRejections: opts.confirmRejections ?? config.confirmRejections,
    round: 1,
  });

  let findings = aggregateFindings(reviewed);
  let { verdict, reasons, warnings } = decideVerdict(reviewed, tests, config.reviewers.length === 0);
  if (integrity) {
    reasons.push(integrity);
    verdict = "REJECT";
  }
  warnings.unshift(...preWarnings);

  const fix = { requested: opts.fix === true, ran: false, detail: null as string | null };
  const fixGroups = partitionFindingsByFixer(findings, config, runProfile);
  const anyFixable = fixGroups.some(([cmd]) => cmd !== null);
  if (
    opts.fix === true &&
    verdict === "REJECT" &&
    anyFixable &&
    target.kind === "local" &&
    reviewed.every((c) => c.failedReason === null) &&
    tests.passed
  ) {
    fix.ran = true;
    // Route-aware: each finding goes to the fixer its file's route resolves;
    // no route match inherits the global fixerCommand, an explicit route
    // `fixer: null` (or no fixer at all) leaves the finding unfixed.
    const details: string[] = [];
    for (const [command, group, label] of fixGroups) {
      if (command === null) {
        if (group.length > 0) details.push(`${group.length} finding(s) without a fixer skipped${label ? ` (${label})` : ""}`);
        continue;
      }
      const res = await runFixer(command, config.fixerTimeoutMs, wt, group, target);
      details.push(label ? `[${label}] ${res}` : res);
    }
    fix.detail = details.join(" | ");
    // Re-review the modified worktree once.
    const newDiff = await git.diffAgainst(wt, target.base, true);
    const newFiles = parseDiff(newDiff).filter((f) => !excluded.has(f.path) && !f.isBinary);
    const reReviewed = await reviewChunks({
      files: newFiles,
      byName,
      defaultChain,
      runProfile,
      target,
      repoNote,
      worktree: wt,
      reviewerCwd: wt,
      contextSha: null, // the fixer edited the worktree; read bodies from disk
      requireNonce: config.requireNonce,
      maxParseRetries: opts.maxParseRetries ?? 1,
      concurrency: config.reviewConcurrency,
      contextBudget: config.contextBudget,
      chunkBudget: config.chunkBudget,
      routes: config.routes,
      confirmRejections: opts.confirmRejections ?? config.confirmRejections,
      round: 2,
    });
    const reTests = await runTests(config, wt, false, testEnv);
    findings = aggregateFindings(reReviewed);
    const decided = decideVerdict(reReviewed, reTests, false);
    verdict = decided.verdict;
    reasons = decided.reasons;
    warnings = [...preWarnings, ...decided.warnings];
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
      ...(target.pinned ? { reviewedSha: target.head } : {}),
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
    warnings,
    fix,
    comments: { requested: opts.postComments === true && target.pr !== undefined, posted: false, detail: null },
    status: { requested: statusWanted, state: null, detail: null },
  };

  // Auto-merge preconditions are checked before anything is posted, so a
  // refused merge never leaves an APPROVE review behind. Merge only the exact
  // commit that was tested and reviewed; without a test run there is nothing
  // to bind "tested" to, so refuse.
  if (opts.autoMerge && report.verdict === "APPROVE" && target.pr !== undefined) {
    if (!target.pinned || fix.ran) {
      report.verdict = "REJECT";
      report.reasons.push("auto-merge refused: the reviewed state is not a single pinned commit");
    } else if (!report.tests.ran) {
      report.verdict = "REJECT";
      report.reasons.push("auto-merge refused: tests did not run on the reviewed commit (set testCommand, drop --skip-tests)");
    }
  }

  if (report.comments.requested && target.pr !== undefined) {
    try {
      const { payload, fileComments } = buildPrReviewSet(report, allFiles);
      await git.ghPostReview(opts.cwd, target.pr, payload);
      report.comments.posted = true;
      let detail = `posted ${payload.event} with ${payload.comments.length} inline comment(s)`;
      let filePosted = 0;
      let fileFailed = 0;
      for (const fc of fileComments) {
        try {
          await git.ghPostFileComment(opts.cwd, target.pr, { ...fc, commit_id: report.target.head });
          filePosted++;
        } catch {
          fileFailed++;
        }
      }
      if (filePosted) detail += ` + ${filePosted} file-level comment(s)`;
      if (fileFailed) detail += ` (${fileFailed} file comment(s) failed)`;
      try {
        const dismissed = await dismissStaleReviews(opts.cwd, target.pr, target.head);
        if (dismissed > 0) detail += `; dismissed ${dismissed} superseded review(s)`;
      } catch (err) {
        detail += `; stale-review cleanup failed: ${(err as Error).message}`;
      }
      report.comments.detail = detail;
    } catch (err) {
      // Comment posting is best-effort: the gate verdict stands on its own.
      report.comments.detail = `post failed: ${(err as Error).message}`;
    }
  }

  if (opts.autoMerge && report.verdict === "APPROVE" && target.pr !== undefined) {
      try {
        const out = await git.ghMergePr(opts.cwd, target.pr, target.head);
        report.reasons.push(`auto-merged PR #${target.pr} at ${target.head.slice(0, 12)}: ${out}`);
      } catch (err) {
        report.verdict = "REJECT";
        report.reasons.push(`auto-merge failed: ${(err as Error).message}`);
      }
  }

  // Final commit status lands last: it must reflect the post-merge verdict,
  // since a failed merge flips APPROVE to REJECT.
  if (statusWanted) {
    await postStatus(
      report.verdict === "APPROVE" ? "success" : "failure",
      statusDescription(report.verdict, report.reasons, report.summary, findings.length, report.tests),
    );
    report.status.state = statusState;
    report.status.detail = statusNotes.join("; ");
  }

  return report;
  } finally {
    if (isolatedDir) await rm(isolatedDir, { recursive: true, force: true });
  }
}

/**
 * After the test run, the PR worktree must still be exactly the reviewed
 * commit: same HEAD, no modified tracked files. Test code from the PR could
 * otherwise check out or rewrite files so the gate approves something else.
 * Returns a REJECT reason, or null when intact.
 */
async function checkWorktreeIntegrity(target: ReviewTarget): Promise<string | null> {
  try {
    const head = await git.headSha(target.worktree);
    if (head !== target.head) {
      return `worktree HEAD moved during tests (${target.head.slice(0, 12)} → ${head.slice(0, 12)}) — refusing to approve`;
    }
    if (target.kind === "pr" && (await git.hasUncommittedChanges(target.worktree))) {
      return "tests modified tracked files in the PR worktree — refusing to approve";
    }
    return null;
  } catch (err) {
    return `could not verify the reviewed commit after tests: ${(err as Error).message}`;
  }
}

/**
 * One-line description for the commit status (GitHub truncates at 140 chars).
 * APPROVE carries findings/tests context; REJECT leads with the gate reason.
 */
export function statusDescription(
  verdict: "APPROVE" | "REJECT",
  reasons: string[],
  summary: string,
  findingCount: number,
  tests: { ran: boolean; passed: boolean },
): string {
  const base =
    verdict === "APPROVE"
      ? `ai-referee approved — ${findingCount} finding(s), ${tests.ran ? "tests passed" : "tests skipped"}`
      : `ai-referee rejected — ${reasons[0] ?? summary}`;
  return base.slice(0, 140);
}



async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function runTests(
  config: Config,
  worktree: string,
  skip: boolean,
  env?: NodeJS.ProcessEnv,
): Promise<TestResult> {
  if (skip || !config.testCommand) {
    return { ran: false, command: config.testCommand, passed: true, outputTail: "" };
  }
  const res = await run(config.testCommand, {
    cwd: config.workdir ? join(worktree, config.workdir) : worktree,
    timeoutMs: config.testTimeoutMs,
    env,
  });
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  return {
    ran: true,
    command: config.testCommand,
    passed: res.exitCode === 0 && !res.timedOut,
    outputTail: (res.timedOut ? `[timed out after ${config.testTimeoutMs} ms]\n` : "") +
      combined.split("\n").slice(-30).join("\n"),
  };
}

async function reviewChunks(opts: {
  files: FileDiff[];
  byName: Map<string, Reviewer>;
  defaultChain: Reviewer[];
  runProfile: ReviewProfile;
  target: ReviewTarget;
  repoNote: string | null;
  worktree: string;
  /** cwd for reviewer processes (an empty dir for isolated PR reviews). */
  reviewerCwd: string;
  /** When set, context file bodies are read from this commit, not the disk. */
  contextSha: string | null;
  requireNonce: boolean;
  maxParseRetries: number;
  concurrency: number;
  contextBudget: number;
  chunkBudget: number;
  routes: Config["routes"];
  /** Verify each REJECT with the next reviewer in the chunk's chain. */
  confirmRejections: boolean;
  round: number;
}): Promise<ChunkResult[]> {
  const { files, byName, defaultChain, runProfile, target, repoNote, worktree, reviewerCwd, contextSha, requireNonce, maxParseRetries, concurrency, contextBudget, confirmRejections, round } = opts;

  // Plan per file (route match → reviewer subset, profile, instructions),
  // then chunk so routed and unrouted files never share a prompt.
  const planned = chunkFilesByRoute(
    files,
    { routes: opts.routes, chunkBudget: opts.chunkBudget },
    runProfile,
  ).chunks;

  /** Reviews one chunk through its routed fallback chain with parse retries. */
  const reviewOne = async (entry: { chunk: DiffChunk; plan: ReviewPlan }): Promise<ChunkResult> => {
    const { chunk, plan } = entry;
    const chain =
      plan.reviewerNames.length === 0
        ? defaultChain
        : plan.reviewerNames.map((n) => byName.get(n)!).filter(Boolean);
    const result: ChunkResult = {
      index: chunk.index,
      files: chunk.files.map((f) => f.path),
      parsed: null,
      failedReason: null,
      attempts: [],
      round,
      profile: plan.profile,
      route: plan.route,
    };

    if (chain.length === 0) {
      result.failedReason = "no reviewers configured";
      return result;
    }

    const { files: contextFiles, skipped: contextSkipped } = await gatherContext(chunk.files, worktree, contextBudget, contextSha);
    // Fresh unguessable nonce per chunk: fences the untrusted diff in the
    // prompt and must come back inside the verdict JSON.
    const nonce = newNonce();
    const parseOpts = { nonce, requireNonce };
    const basePrompt = buildReviewPrompt({
      nonce,
      index: chunk.index,
      files: result.files,
      patch: chunk.patch,
      truncated: chunk.truncated,
      totalChunks: planned.length,
      base: target.base,
      head: target.head,
      repoNote,
      profile: plan.profile,
      instructions: plan.instructions,
      contextFiles,
      contextSkipped,
    });
    let prompt = basePrompt;

    for (let attempt = 0; attempt <= maxParseRetries; attempt++) {
      const tried = await invokeChain(chain, prompt, reviewerCwd);
      result.attempts.push(...tried.attempts);
      if (!tried.response) {
        const where = plan.route ? ` for route "${plan.route}"` : "";
        result.failedReason = `no referee answered${where} (all reviewers unavailable)`;
        break;
      }
      try {
        result.parsed = parseVerdict(tried.response.output, parseOpts);
        result.failedReason = null;
        break;
      } catch (err) {
        const why = err instanceof VerdictParseError ? err.message : String(err);
        if (attempt === maxParseRetries) {
          result.failedReason = `unparseable verdict after ${attempt + 1} attempt(s): ${why}`;
        } else {
          // Re-send the full prompt: stateless CLI reviewers have no memory
          // of the diff, and a bare "reply again" would invite a blind verdict.
          prompt = `${basePrompt}\n\n${buildParseRetryPrompt(why, nonce)}`;
        }
      }
    }

    // Second-referee check: a REJECT is contested before the next reviewer in
    // the chunk's chain — the one who already judged must not confirm itself.
    // An overruled rejection is downgraded to a warning in decideVerdict; an
    // inconclusive check leaves the rejection standing (fail closed).
    if (confirmRejections && result.parsed?.verdict === "REJECT" && !result.failedReason) {
      const judge = [...result.attempts].reverse().find((a) => a.ok)?.reviewer ?? null;
      const confirmChain = chain.filter((r) => r.name !== judge);
      if (confirmChain.length === 0) {
        result.confirmation = {
          reviewer: null,
          verdict: null,
          overruled: false,
          detail: "no second referee available to confirm",
          findings: [],
        };
      } else {
        const confirmNonce = newNonce();
        const confirmPrompt = buildReviewPrompt({
          nonce: confirmNonce,
          index: chunk.index,
          files: result.files,
          patch: chunk.patch,
          truncated: chunk.truncated,
          totalChunks: planned.length,
          base: target.base,
          head: target.head,
          repoNote,
          profile: plan.profile,
          instructions: plan.instructions,
          contextFiles,
          contextSkipped,
          contested: {
            reviewer: judge ?? "unknown",
            summary: result.parsed.summary,
            findings: result.parsed.findings,
          },
        });
        const checked = await invokeChain(confirmChain, confirmPrompt, reviewerCwd);
        result.attempts.push(...checked.attempts.map((a) => ({ ...a, phase: "confirm" as const })));
        if (!checked.response) {
          result.confirmation = {
            reviewer: null,
            verdict: null,
            overruled: false,
            detail: "second referee unavailable",
            findings: [],
          };
        } else {
          const confirmer = checked.attempts[checked.attempts.length - 1]!.reviewer;
          try {
            const parsed = parseVerdict(checked.response.output, { nonce: confirmNonce, requireNonce });
            result.confirmation = {
              reviewer: confirmer,
              verdict: parsed.verdict,
              overruled: parsed.verdict === "APPROVE",
              findings: parsed.findings,
            };
          } catch (err) {
            result.confirmation = {
              reviewer: confirmer,
              verdict: null,
              overruled: false,
              detail: `confirmation verdict unparseable: ${err instanceof VerdictParseError ? err.message : String(err)}`,
              findings: [],
            };
          }
        }
      }
    }
    return result;
  };

  // Bounded worker pool: chunks run `concurrency` at a time; results keep
  // diff order regardless of completion order.
  const results = new Array<ChunkResult>(planned.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < planned.length) {
      const i = next++;
      results[i] = await reviewOne(planned[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), planned.length || 1) }, worker));
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
  sha: string | null,
): Promise<{ files: { path: string; content: string }[]; skipped: string[] }> {
  const out: { path: string; content: string }[] = [];
  const skipped: string[] = [];
  if (budget <= 0) return { files: out, skipped };
  let left = budget;
  for (const f of files) {
    if (f.isDeleted || f.isBinary) continue;
    const content = sha
      ? await git.readFileAtCommit(worktree, sha, f.path)
      : await readOptional(join(worktree, f.path));
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
    for (const f of [...(c.parsed?.findings ?? []), ...(c.confirmation?.findings ?? [])]) {
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
): { verdict: "APPROVE" | "REJECT"; reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (tests.ran && !tests.passed) reasons.push("tests failed");
  if (noReviewersConfigured) reasons.push("no referees configured — refusing to approve");
  for (const c of chunks) {
    if (c.failedReason) {
      reasons.push(`chunk ${c.index + 1}: ${c.failedReason}`);
    } else if (c.parsed?.verdict === "REJECT") {
      const judge = [...c.attempts].reverse().find((a) => a.ok && a.phase !== "confirm")?.reviewer;
      if (c.confirmation?.overruled) {
        // Second referee rejected the rejection — warn, don't gate.
        warnings.push(
          `chunk ${c.index + 1}: ${judge ?? "reviewer"} rejected but ${c.confirmation.reviewer} overruled — treated as warning`,
        );
      } else if (c.profile === "light" && c.parsed.findings.length > 0 && !c.parsed.findings.some((f) => f.severity === "blocker")) {
        // Light profile: the reviewer should only reject on blockers. A REJECT
        // that lists no blocker finding is reviewer noise — warn, don't gate.
        // Zero findings can't be reclassified, so it still fails closed.
        warnings.push(
          `chunk ${c.index + 1}: light review rejected without blocker findings — treated as warning`,
        );
      } else if (c.confirmation !== undefined) {
        const suffix = c.confirmation.verdict === "REJECT"
          ? ` — confirmed by ${c.confirmation.reviewer}`
          : ` (${c.confirmation.detail ?? "confirmation inconclusive"})`;
        reasons.push(`chunk ${c.index + 1}: reviewer rejected${suffix}`);
      } else {
        reasons.push(`chunk ${c.index + 1}: reviewer rejected`);
      }
    }
  }
  return { verdict: reasons.length ? "REJECT" : "APPROVE", reasons, warnings };
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

/**
 * Groups findings by the fixer that should address them: a route match
 * resolves that route's fixer (string) or opts out (null); unmatched files
 * — and findings without a file — use the global fixerCommand.
 * Returns [command|null, findings, routeLabel|null] preserving file order.
 */
export function partitionFindingsByFixer(
  findings: Finding[],
  config: Config,
  runProfile: ReviewProfile,
): [command: string | null, findings: Finding[], routeLabel: string | null][] {
  const groups = new Map<string | null, { findings: Finding[]; label: string | null }>();
  for (const f of findings) {
    const plan = f.file ? planForFile(config.routes, f.file, runProfile) : null;
    const command = plan !== null && plan.fixer !== undefined ? plan.fixer : config.fixerCommand;
    const label = plan?.route ?? null;
    const existing = groups.get(command);
    if (existing) {
      existing.findings.push(f);
      if (!existing.label) existing.label = label;
    } else {
      groups.set(command, { findings: [f], label });
    }
  }
  return [...groups.entries()].map(([command, g]) => [command, g.findings, g.label]);
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

/**
 * Dismisses ai-referee CHANGES_REQUESTED reviews left on earlier commits —
 * otherwise a stale rejection keeps blocking the PR after the head moved.
 * Only reviews carrying our marker are touched; human reviews are never
 * dismissed. Returns the number dismissed.
 */
async function dismissStaleReviews(cwd: string, pr: number, head: string): Promise<number> {
  const reviews = await git.ghListPrReviews(cwd, pr);
  const stale = reviews.filter(
    (r) => r.state === "CHANGES_REQUESTED" && r.commit_id !== head && r.body.includes(REVIEW_MARKER),
  );
  let dismissed = 0;
  for (const r of stale) {
    await git.ghDismissPrReview(cwd, pr, r.id, `ai-referee: superseded by ${head.slice(0, 10)}`);
    dismissed++;
  }
  return dismissed;
}

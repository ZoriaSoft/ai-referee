import { runArgv, type ExecResult } from "./exec.js";

export class GitError extends Error {}

/*
 * Every git/gh call here goes through runArgv: arguments travel as a real
 * argv array and are never parsed by a shell, so PR numbers, refs, SHAs and
 * paths cannot inject commands. The validators below additionally stop
 * option injection (a "ref" that starts with "-" would be read as a flag).
 */

/** A PR number must be a positive safe integer — nothing else reaches gh/git. */
export function assertPrNumber(pr: unknown): number {
  if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr <= 0) {
    throw new GitError(`invalid PR number: ${String(pr)}`);
  }
  return pr;
}

/** Full hex object id (SHA-1 or SHA-256). Abbreviations are refused on purpose. */
export function assertSha(sha: unknown): string {
  if (typeof sha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new GitError(`invalid commit SHA: ${JSON.stringify(sha)}`);
  }
  return sha;
}

/**
 * Conservative ref check for user/remote-supplied refs (e.g. --base, PR base
 * branch names). Rejects leading "-" (option injection), whitespace, control
 * characters and anything outside the usual ref alphabet.
 */
export function assertRef(ref: unknown): string {
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > 255 ||
    ref.startsWith("-") ||
    ref.includes("..") || // ranges are built here, never accepted from input
    !/^[A-Za-z0-9._/@{}^~+-]+$/.test(ref)
  ) {
    throw new GitError(`invalid git ref: ${JSON.stringify(ref)}`);
  }
  return ref;
}

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const res = await runArgv("git", args, { cwd, timeoutMs });
  if (res.exitCode !== 0) {
    throw new GitError(`git ${args[0]} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout;
}

function gh(cwd: string, args: string[], timeoutMs: number, stdin?: string): Promise<ExecResult> {
  return runArgv("gh", args, { cwd, timeoutMs, stdin });
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  const sym = await runArgv("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd, timeoutMs: 15_000 });
  if (sym.exitCode === 0 && sym.stdout.trim()) return sym.stdout.trim();
  const short = await runArgv("git", ["rev-parse", "--short", "HEAD"], { cwd, timeoutMs: 15_000 });
  return short.stdout.trim() || "HEAD";
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

/** Resolves `ref` to a full commit SHA. */
export async function resolveCommit(cwd: string, ref: string): Promise<string> {
  assertRef(ref);
  return assertSha((await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim());
}

/**
 * Picks the merge base for a local branch diff: the tracking upstream if set,
 * else the remote default branch (origin/HEAD), else `main`/`master`.
 */
export async function defaultBase(cwd: string): Promise<string> {
  const upstream = await runArgv("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd,
    timeoutMs: 15_000,
  });
  if (upstream.exitCode === 0 && upstream.stdout.trim()) return upstream.stdout.trim();

  const head = await runArgv("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], { cwd, timeoutMs: 15_000 });
  if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim();

  for (const cand of ["origin/main", "origin/master", "main", "master"]) {
    const ok = await runArgv("git", ["rev-parse", "--verify", "--quiet", cand], { cwd, timeoutMs: 15_000 });
    if (ok.exitCode === 0) return cand;
  }
  throw new GitError("could not determine a base ref; pass --base explicitly");
}

/**
 * Unified diff of base...head with 5 lines of context. `head` should be a full
 * SHA so the diff is bound to exactly the commit under review. When
 * `includeUncommitted` is set, working-tree changes are folded in as well
 * (base vs worktree) and `head` is ignored.
 */
export async function diffAgainst(
  cwd: string,
  base: string,
  includeUncommitted: boolean,
  head = "HEAD",
): Promise<string> {
  assertRef(base);
  if (includeUncommitted) {
    // worktree diff includes committed changes too; prefer it wholesale.
    return git(cwd, ["diff", "--find-renames", "-U5", "--end-of-options", base], 120_000);
  }
  assertRef(head);
  return git(cwd, ["diff", "--find-renames", "-U5", "--end-of-options", `${base}...${head}`], 120_000);
}

/** Returns true when tracked working-tree changes exist. */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const res = await runArgv("git", ["status", "--porcelain", "--untracked-files=no"], { cwd, timeoutMs: 15_000 });
  return res.stdout.trim().length > 0;
}

/**
 * File body at a commit (`git show <sha>:<path>`), or null when absent.
 * Reading from the object store instead of the worktree keeps prompt context
 * bound to the reviewed SHA even if a test run rewrote files on disk.
 */
export async function readFileAtCommit(cwd: string, sha: string, path: string): Promise<string | null> {
  assertSha(sha);
  if (path.startsWith("-") || path.includes("\0")) return null;
  const res = await runArgv("git", ["show", `${sha}:${path}`], { cwd, timeoutMs: 30_000 });
  return res.exitCode === 0 ? res.stdout : null;
}

/**
 * Fetches a PR head via the portable `refs/pull/<n>/head` ref (works for forks
 * on GitHub) into a scratch ref `refs/ai-referee/pr-<n>` and returns its SHA.
 * The namespaced ref + --no-write-fetch-head keep FETCH_HEAD untouched, so
 * parallel reviews of different PRs cannot race each other. The scratch ref is
 * dropped by dropPrRef once the review's worktree exists.
 */
export async function fetchPrHead(cwd: string, pr: number): Promise<string> {
  assertPrNumber(pr);
  const ref = `refs/ai-referee/pr-${pr}`;
  // The "+" allows following force-pushed heads. FETCH_HEAD stays unwritten:
  // parallel fetches share it otherwise and one review would read another's SHA.
  await git(cwd, ["fetch", "--no-write-fetch-head", "origin", `+refs/pull/${pr}/head:${ref}`], 300_000);
  return assertSha((await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim());
}

/** Removes the scratch ref fetchPrHead created; best-effort, never throws. */
export async function dropPrRef(cwd: string, pr: number): Promise<void> {
  try {
    assertPrNumber(pr);
    await git(cwd, ["update-ref", "-d", `refs/ai-referee/pr-${pr}`]);
  } catch {
    // already absent or concurrently removed — nothing to clean up
  }
}

/** Creates a detached worktree at commit `sha`; caller removes it with removeWorktree. */
export async function addWorktree(cwd: string, dir: string, sha: string): Promise<void> {
  assertSha(sha);
  await git(cwd, ["worktree", "add", "--detach", "--", dir, sha], 120_000);
}

export async function removeWorktree(cwd: string, dir: string): Promise<void> {
  await runArgv("git", ["worktree", "remove", "--force", "--", dir], { cwd, timeoutMs: 60_000 });
}

/** `gh` CLI helpers — used for PR metadata and optional auto-merge. */
export async function ghPrBase(cwd: string, pr: number): Promise<string | null> {
  assertPrNumber(pr);
  const res = await gh(cwd, ["pr", "view", String(pr), "--json", "baseRefName", "-q", ".baseRefName"], 30_000);
  const name = res.stdout.trim();
  if (res.exitCode !== 0 || !name) return null;
  try {
    return assertRef(name);
  } catch {
    return null;
  }
}

/** Current head SHA of a PR as GitHub sees it right now. */
export async function ghPrHeadSha(cwd: string, pr: number): Promise<string> {
  assertPrNumber(pr);
  const res = await gh(cwd, ["pr", "view", String(pr), "--json", "headRefOid", "-q", ".headRefOid"], 30_000);
  if (res.exitCode !== 0) {
    throw new GitError(`gh pr view failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return assertSha(res.stdout.trim());
}

/**
 * Merges a PR **only if its head is still `reviewedSha`**. Two guards:
 *  1. re-reads the PR head right before merging and refuses on mismatch;
 *  2. passes `--match-head-commit`, so GitHub itself rejects the merge if a
 *     push lands between the check and the merge call.
 * A commit pushed after the review can therefore never merge unreviewed.
 */
export async function ghMergePr(cwd: string, pr: number, reviewedSha: string): Promise<string> {
  assertPrNumber(pr);
  assertSha(reviewedSha);
  const current = await ghPrHeadSha(cwd, pr);
  if (current !== reviewedSha) {
    throw new GitError(
      `PR #${pr} head moved from reviewed ${reviewedSha.slice(0, 12)} to ${current.slice(0, 12)} — refusing to merge unreviewed code`,
    );
  }
  const res = await gh(
    cwd,
    ["pr", "merge", String(pr), "--merge", "--match-head-commit", reviewedSha],
    60_000,
  );
  if (res.exitCode !== 0) {
    throw new GitError(`gh pr merge failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout.trim();
}

export interface GhPrSummary {
  number: number;
  headRefOid: string;
  title: string;
}

/** Open PRs with their head SHAs; requires `gh` and a GitHub remote. */
export async function ghListOpenPrs(cwd: string): Promise<GhPrSummary[]> {
  const res = await gh(cwd, ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefOid,title"], 60_000);
  if (res.exitCode !== 0) {
    throw new GitError(`gh pr list failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const parsed: unknown = JSON.parse(res.stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (x): x is GhPrSummary =>
      typeof x === "object" && x !== null &&
      Number.isSafeInteger((x as GhPrSummary).number) && (x as GhPrSummary).number > 0 &&
      typeof (x as GhPrSummary).headRefOid === "string" &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test((x as GhPrSummary).headRefOid),
  );
}
export interface GhReviewComment {
  path: string;
  /** End (right-side) line of the comment; also the anchor for single-line comments. */
  line: number;
  side: "RIGHT";
  /** Set for multi-line comments: the first line of the range. Requires start_side. */
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface GhReviewPayload {
  commit_id: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments: GhReviewComment[];
}

/**
 * Posts a PR review (verdict event + anchored inline comments) through
 * `gh api`. The {owner}/{repo} placeholders are resolved by gh from the
 * repo's remote; the JSON payload travels on stdin.
 */
export async function ghPostReview(cwd: string, pr: number, payload: GhReviewPayload): Promise<string> {
  assertPrNumber(pr);
  const res = await gh(cwd, ["api", `repos/{owner}/{repo}/pulls/${pr}/reviews`, "-X", "POST", "--input", "-"], 60_000, JSON.stringify(payload));
  if (res.exitCode !== 0) {
    throw new GitError(`gh api review failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout.trim();
}

/**
 * Posts one file-level PR comment (subject_type:"file") through `gh api`.
 * The bulk reviews endpoint does not support file-level comments, so these
 * travel individually — caller treats failures as best-effort.
 */
export async function ghPostFileComment(
  cwd: string,
  pr: number,
  comment: { path: string; body: string; commit_id: string },
): Promise<void> {
  assertPrNumber(pr);
  const res = await gh(
    cwd,
    ["api", `repos/{owner}/{repo}/pulls/${pr}/comments`, "-X", "POST", "--input", "-"],
    30_000,
    JSON.stringify({ ...comment, subject_type: "file" }),
  );
  if (res.exitCode !== 0) {
    throw new GitError(`gh api comments failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
}

/** One PR review as returned by `GET /pulls/{n}/reviews`. */
export interface GhPrReview {
  id: number;
  state: string;
  commit_id: string;
  body: string;
  user: { login: string } | null;
}

/** All reviews on a PR (first 100). */
export async function ghListPrReviews(cwd: string, pr: number): Promise<GhPrReview[]> {
  assertPrNumber(pr);
  const res = await gh(cwd, ["api", `repos/{owner}/{repo}/pulls/${pr}/reviews?per_page=100`], 60_000);
  if (res.exitCode !== 0) {
    throw new GitError(`gh api reviews failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const parsed: unknown = JSON.parse(res.stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (x): x is GhPrReview =>
      typeof x === "object" && x !== null &&
      Number.isSafeInteger((x as GhPrReview).id) &&
      typeof (x as GhPrReview).state === "string",
  );
}

/**
 * Dismisses one PR review (PUT .../reviews/{id}/dismissals). Used to retract
 * ai-referee CHANGES_REQUESTED reviews that a newer head superseded.
 */
export async function ghDismissPrReview(cwd: string, pr: number, reviewId: number, message: string): Promise<void> {
  assertPrNumber(pr);
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0) throw new GitError(`invalid review id: ${reviewId}`);
  const res = await gh(
    cwd,
    ["api", `repos/{owner}/{repo}/pulls/${pr}/reviews/${reviewId}/dismissals`, "-X", "PUT", "--input", "-"],
    60_000,
    JSON.stringify({ message }),
  );
  if (res.exitCode !== 0) {
    throw new GitError(`gh api dismissals failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
}

/** Commit status states GitHub accepts; we only ever send these three. */
export type GhStatusState = "pending" | "success" | "failure";

/**
 * Posts one commit status on `sha` through `gh api` (context "ai-referee").
 * Branch protection can then require the context, turning the gate verdict
 * into an enforced check. Descriptions are capped at 140 chars.
 */
export async function ghPostCommitStatus(
  cwd: string,
  sha: string,
  state: GhStatusState,
  description: string,
): Promise<void> {
  assertSha(sha);
  const res = await gh(
    cwd,
    ["api", `repos/{owner}/{repo}/statuses/${sha}`, "-X", "POST", "--input", "-"],
    30_000,
    JSON.stringify({ state, context: "ai-referee", description: description.slice(0, 140) }),
  );
  if (res.exitCode !== 0) {
    throw new GitError(`gh api statuses failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
}

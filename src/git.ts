import { run, shellEscape } from "./exec.js";

export class GitError extends Error {}

async function git(cwd: string, args: string, timeoutMs = 60_000): Promise<string> {
  const res = await run(`git ${args}`, { cwd, timeoutMs });
  if (res.exitCode !== 0) {
    throw new GitError(`git ${args.split(" ")[0]} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout;
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, "rev-parse --show-toplevel")).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  const res = await run("git symbolic-ref --short -q HEAD || git rev-parse --short HEAD", {
    cwd,
    timeoutMs: 15_000,
  });
  return res.stdout.trim() || "HEAD";
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, "rev-parse HEAD")).trim();
}

/**
 * Picks the merge base for a local branch diff: the tracking upstream if set,
 * else the remote default branch (origin/HEAD), else `main`/`master`.
 */
export async function defaultBase(cwd: string): Promise<string> {
  const upstream = await run("git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null", {
    cwd,
    timeoutMs: 15_000,
  });
  if (upstream.exitCode === 0 && upstream.stdout.trim()) return upstream.stdout.trim();

  const head = await run("git rev-parse --abbrev-ref origin/HEAD 2>/dev/null", {
    cwd,
    timeoutMs: 15_000,
  });
  if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim();

  for (const cand of ["origin/main", "origin/master", "main", "master"]) {
    const ok = await run(`git rev-parse --verify --quiet ${shellEscape(cand)}`, { cwd, timeoutMs: 15_000 });
    if (ok.exitCode === 0) return cand;
  }
  throw new GitError("could not determine a base ref; pass --base explicitly");
}

/**
 * Unified diff of base...head with 5 lines of context. When `includeUncommitted`
 * is set, working-tree changes are folded in as well (base...HEAD + worktree).
 */
export async function diffAgainst(cwd: string, base: string, includeUncommitted: boolean): Promise<string> {
  const committed = await git(cwd, `diff --find-renames -U5 ${shellEscape(base)}...HEAD`, 120_000);
  if (!includeUncommitted) return committed;
  const worktree = await git(cwd, `diff --find-renames -U5 ${shellEscape(base)}`, 120_000);
  // worktree diff includes committed changes too; prefer it wholesale.
  return worktree;
}

/** Returns true when tracked working-tree changes exist. */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const res = await run("git status --porcelain --untracked-files=no", { cwd, timeoutMs: 15_000 });
  return res.stdout.trim().length > 0;
}

/**
 * Fetches a PR head via the portable `refs/pull/<n>/head` ref (works for forks
 * on GitHub) into FETCH_HEAD and returns its SHA.
 */
export async function fetchPrHead(cwd: string, pr: number): Promise<string> {
  await git(cwd, `fetch origin ${shellEscape(`refs/pull/${pr}/head`)}`, 300_000);
  return (await git(cwd, "rev-parse FETCH_HEAD")).trim();
}

/** Creates a detached worktree at `ref`; caller removes it with removeWorktree. */
export async function addWorktree(cwd: string, dir: string, ref: string): Promise<void> {
  await git(cwd, `worktree add --detach ${shellEscape(dir)} ${shellEscape(ref)}`, 120_000);
}

export async function removeWorktree(cwd: string, dir: string): Promise<void> {
  await run(`git worktree remove --force ${shellEscape(dir)}`, { cwd, timeoutMs: 60_000 });
}

/** `gh` CLI helpers — used for PR metadata and optional auto-merge. */
export async function ghPrBase(cwd: string, pr: number): Promise<string | null> {
  const res = await run(
    `gh pr view ${pr} --json baseRefName -q .baseRefName`,
    { cwd, timeoutMs: 30_000 },
  );
  return res.exitCode === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

export async function ghMergePr(cwd: string, pr: number): Promise<string> {
  const res = await run(`gh pr merge ${pr} --merge`, { cwd, timeoutMs: 60_000 });
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
  const res = await run(
    "gh pr list --state open --limit 100 --json number,headRefOid,title",
    { cwd, timeoutMs: 60_000 },
  );
  if (res.exitCode !== 0) {
    throw new GitError(`gh pr list failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const parsed: unknown = JSON.parse(res.stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (x): x is GhPrSummary =>
      typeof x === "object" && x !== null &&
      typeof (x as GhPrSummary).number === "number" &&
      typeof (x as GhPrSummary).headRefOid === "string",
  );
}

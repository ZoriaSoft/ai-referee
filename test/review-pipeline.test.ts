import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { run } from "../src/exec.js";
import { runReview } from "../src/review.js";

const APPROVE = `{"verdict":"APPROVE","summary":"looks fine","findings":[]}`;
const REJECT = `{"verdict":"REJECT","summary":"has a bug","findings":[{"file":"a.ts","line":2,"severity":"major","message":"unused variable shadowing"}]}`;

let dir: string;

async function sh(cmd: string): Promise<void> {
  const res = await run(cmd, { cwd: dir });
  if (res.exitCode !== 0) throw new Error(`setup failed: ${cmd}\n${res.stderr}`);
}

/** Creates a repo on branch `feat` with one committed change vs main. */
async function makeRepo(change = "export const x = 1;"): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "air-test-"));
  await sh("git init -q -b main && git config user.email t@t && git config user.name t");
  await writeFile(join(dir, "a.ts"), "export const a = 0;\n");
  await sh("git add -A && git commit -qm init && git checkout -qb feat");
  await writeFile(join(dir, "a.ts"), `export const a = 0;\n${change}\n`);
  await sh("git add -A && git commit -qm change");
}

function cfg(overrides: Partial<Config>): Config {
  return {
    testCommand: "true",
    testTimeoutMs: 10_000,
    chunkBudget: 100_000,
    exclude: [],
    reviewers: [],
    fixerCommand: null,
    fixerTimeoutMs: 10_000,
    autoMerge: false,
    prComments: false,
    commitStatus: false,
    reviewConcurrency: 1,
    profile: "strict",
    routes: [],
    contextBudget: 40_000,
    daemonIntervalSec: 120,
    daemonConcurrency: 1,
    confirmRejections: false,
    workdir: null,
    // These fixtures answer with static JSON; nonce enforcement has its own
    // tests in security.test.ts.
    requireNonce: false,
    reviewerWorkdir: "isolated",
    passSecretsToTests: false,
    ...overrides,
  };
}

const echo = (out: string): string => `printf '%s' '${out.replace(/'/g, "'\\''")}'`;

beforeEach(() => makeRepo());
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runReview pipeline", () => {
  it("APPROVE when tests pass and reviewer approves", async () => {
    const report = await runReview({
      cwd: dir,
      config: cfg({ reviewers: [{ name: "ok", type: "cli", command: echo(APPROVE) }] }),
      base: "main",
    });
    expect(report.verdict).toBe("APPROVE");
    expect(report.stats.filesChanged).toBe(1);
    expect(report.stats.insertions).toBeGreaterThan(0);
    expect(report.tests.passed).toBe(true);
  });

  it("REJECT when tests fail even if reviewer approves", async () => {
    const report = await runReview({
      cwd: dir,
      config: cfg({
        testCommand: "false",
        reviewers: [{ name: "ok", type: "cli", command: echo(APPROVE) }],
      }),
      base: "main",
    });
    expect(report.verdict).toBe("REJECT");
    expect(report.reasons).toContain("tests failed");
  });

  it("REJECT when the reviewer rejects, with findings surfaced", async () => {
    const report = await runReview({
      cwd: dir,
      config: cfg({ reviewers: [{ name: "strict", type: "cli", command: echo(REJECT) }] }),
      base: "main",
    });
    expect(report.verdict).toBe("REJECT");
    expect(report.findings[0]!.file).toBe("a.ts");
    expect(report.findings[0]!.severity).toBe("major");
  });

  it("falls back to the second reviewer when the first fails", async () => {
    const report = await runReview({
      cwd: dir,
      config: cfg({
        reviewers: [
          { name: "dead", type: "cli", command: "exit 1" },
          { name: "alive", type: "cli", command: echo(APPROVE) },
        ],
      }),
      base: "main",
    });
    expect(report.verdict).toBe("APPROVE");
    const names = report.chunks[0]!.attempts.map((a) => a.reviewer);
    expect(names).toEqual(["dead", "alive"]);
  });

  it("REJECT when no reviewer answers — no referee, no merge", async () => {
    const report = await runReview({
      cwd: dir,
      config: cfg({
        reviewers: [
          { name: "a", type: "cli", command: "exit 1" },
          { name: "b", type: "cli", command: "no-such-binary-xyz" },
        ],
      }),
      base: "main",
    });
    expect(report.verdict).toBe("REJECT");
    expect(report.reasons.join(" ")).toContain("no referee");
  });

  it("REJECT when reviewers list is empty — fail closed", async () => {
    const report = await runReview({ cwd: dir, config: cfg({}), base: "main" });
    expect(report.verdict).toBe("REJECT");
    expect(report.reasons.join(" ")).toContain("no referees configured");
  });

  it("retries once after unparseable output, then accepts", async () => {
    const script = `f=${dir}/count; c=$(( $(cat $f 2>/dev/null || echo 0) + 1 )); echo $c > $f; if [ $c -eq 1 ]; then echo 'not json at all'; else printf '%s' '${APPROVE}'; fi`;
    const report = await runReview({
      cwd: dir,
      config: cfg({ reviewers: [{ name: "flaky", type: "cli", command: script }] }),
      base: "main",
    });
    expect(report.verdict).toBe("APPROVE");
    expect(report.chunks[0]!.attempts).toHaveLength(2);
  });

  it("REJECT after exhausting parse retries on garbage output", async () => {
    const report = await runReview({
      cwd: dir,
      config: cfg({ reviewers: [{ name: "gibberish", type: "cli", command: "echo 'I dunno, looks ok'" }] }),
      base: "main",
    });
    expect(report.verdict).toBe("REJECT");
    expect(report.reasons.join(" ")).toContain("unparseable");
  });

  it("runs one fix round on REJECT and re-reviews", async () => {
    const script = `f=${dir}/rcount; c=$(( $(cat $f 2>/dev/null || echo 0) + 1 )); echo $c > $f; if [ $c -eq 1 ]; then printf '%s' '${REJECT.replace(/'/g, "'\\''")}'; else printf '%s' '${APPROVE}'; fi`;
    const report = await runReview({
      cwd: dir,
      fix: true,
      config: cfg({
        reviewers: [{ name: "r", type: "cli", command: script }],
        fixerCommand: "echo 'export const y = 2;' >> a.ts",
      }),
      base: "main",
    });
    expect(report.fix.ran).toBe(true);
    // fixer changed the tree; the second review sees it and approves
    expect(report.verdict).toBe("APPROVE");
    expect(report.chunks.every((c) => c.round === 2)).toBe(true);
  });

  it("routes findings to the route's own fixer, not the global one", async () => {
    // A routed file so the finding's file lands inside the "security" route.
    await mkdir(join(dir, "src/auth"), { recursive: true });
    await writeFile(join(dir, "src/auth/keys.ts"), "export const k = 1;\n");
    await sh("git add -A && git commit -qm auth");
    const rejectAuth = REJECT.replace('"file":"a.ts"', '"file":"src/auth/keys.ts"');
    const script = `f=${dir}/rfc; c=$(( $(cat $f 2>/dev/null || echo 0) + 1 )); echo $c > $f; if [ $c -eq 1 ]; then printf '%s' '${rejectAuth.replace(/'/g, "'\\''")}'; else printf '%s' '${APPROVE}'; fi`;
    const report = await runReview({
      cwd: dir,
      fix: true,
      config: cfg({
        reviewers: [{ name: "r", type: "cli", command: script }],
        fixerCommand: `echo global >> ${dir}/global-used`,
        routes: [{
          name: "security",
          match: ["src/auth/**"],
          reviewers: ["r"],
          fixer: `echo route >> ${dir}/route-used`,
        }],
      }),
      base: "main",
    });
    expect(report.fix.ran).toBe(true);
    // Only the route fixer ran; the global fixer must not touch routed files.
    expect((await run(`test -f ${dir}/route-used`, { cwd: dir })).exitCode).toBe(0);
    expect((await run(`test -f ${dir}/global-used`, { cwd: dir })).exitCode).not.toBe(0);
    expect(report.fix.detail).toContain("[security]");
  });

  it("skips findings a route opted out of with fixer: null", async () => {
    await mkdir(join(dir, "src/auth"), { recursive: true });
    await writeFile(join(dir, "src/auth/keys.ts"), "export const k = 1;\n");
    await sh("git add -A && git commit -qm auth");
    const rejectAuth = REJECT.replace('"file":"a.ts"', '"file":"src/auth/keys.ts"');
    const script = `f=${dir}/nfc; c=$(( $(cat $f 2>/dev/null || echo 0) + 1 )); echo $c > $f; if [ $c -eq 1 ]; then printf '%s' '${rejectAuth.replace(/'/g, "'\\''")}'; else printf '%s' '${APPROVE}'; fi`;
    const report = await runReview({
      cwd: dir,
      fix: true,
      config: cfg({
        reviewers: [{ name: "r", type: "cli", command: script }],
        fixerCommand: `echo global >> ${dir}/global-used`,
        routes: [{
          name: "security",
          match: ["src/auth/**"],
          reviewers: ["r"],
          fixer: null,
        }],
      }),
      base: "main",
    });
    // fixer: null opts the file out — nothing fixable, so no fixer ran at all.
    expect(report.fix.ran).toBe(false);
    expect((await run(`test -f ${dir}/global-used`, { cwd: dir })).exitCode).not.toBe(0);
  });

  it("still fixes when only a route provides a fixer (no global fixerCommand)", async () => {
    await mkdir(join(dir, "src/auth"), { recursive: true });
    await writeFile(join(dir, "src/auth/keys.ts"), "export const k = 1;\n");
    await sh("git add -A && git commit -qm auth");
    const rejectAuth = REJECT.replace('"file":"a.ts"', '"file":"src/auth/keys.ts"');
    const script = `f=${dir}/ofc; c=$(( $(cat $f 2>/dev/null || echo 0) + 1 )); echo $c > $f; if [ $c -eq 1 ]; then printf '%s' '${rejectAuth.replace(/'/g, "'\\''")}'; else printf '%s' '${APPROVE}'; fi`;
    const report = await runReview({
      cwd: dir,
      fix: true,
      config: cfg({
        reviewers: [{ name: "r", type: "cli", command: script }],
        fixerCommand: null,
        routes: [{
          name: "security",
          match: ["src/auth/**"],
          reviewers: ["r"],
          fixer: `echo route >> ${dir}/route-used`,
        }],
      }),
      base: "main",
    });
    expect(report.fix.ran).toBe(true);
    expect((await run(`test -f ${dir}/route-used`, { cwd: dir })).exitCode).toBe(0);
  });

  it("includes uncommitted changes when asked", async () => {
    // dirty a tracked file without committing
    await appendFile(join(dir, "a.ts"), "export const dirty = true;\n");

    const without = await runReview({
      cwd: dir,
      config: cfg({ reviewers: [{ name: "ok", type: "cli", command: echo(APPROVE) }] }),
      base: "main",
    });
    const withUncommitted = await runReview({
      cwd: dir,
      includeUncommitted: true,
      config: cfg({ reviewers: [{ name: "ok", type: "cli", command: echo(APPROVE) }] }),
      base: "main",
    });
    expect(withUncommitted.stats.insertions).toBeGreaterThan(without.stats.insertions);
  });

  it("reviews chunks in parallel when reviewConcurrency > 1", async () => {
    await writeFile(join(dir, "b.ts"), `export const b = 1;\n${"// pad\n".repeat(80)}`);
    await writeFile(join(dir, "c.ts"), `export const c = 1;\n${"// pad\n".repeat(80)}`);
    await sh("git add -A && git commit -qm more");
    const pool = join(dir, "pool");
    const marker = join(dir, "saw-parallel");
    const script =
      `touch '${pool}.'$$; sleep 0.3; ` +
      `[ $(ls '${pool}.'* 2>/dev/null | wc -l) -ge 2 ] && touch '${marker}'; rm -f '${pool}.'$$; ` +
      `printf '%s' '${APPROVE}'`;
    const report = await runReview({
      cwd: dir,
      config: cfg({
        chunkBudget: 400,
        reviewConcurrency: 2,
        reviewers: [{ name: "slow", type: "cli", command: script }],
      }),
      base: "main",
    });
    expect(report.stats.chunks).toBeGreaterThanOrEqual(2);
    expect(report.chunks.map((c) => c.index)).toEqual(report.chunks.map((_, i) => i));
    const saw = await run(`test -f '${marker}'`, { cwd: dir });
    expect(saw.exitCode).toBe(0);
  });

  it("keeps results sequential at concurrency 1", async () => {
    await writeFile(join(dir, "b.ts"), `export const b = 1;\n${"// pad\n".repeat(80)}`);
    await writeFile(join(dir, "c.ts"), `export const c = 1;\n${"// pad\n".repeat(80)}`);
    await sh("git add -A && git commit -qm more");
    const pool = join(dir, "poolseq");
    const marker = join(dir, "saw-parallel-seq");
    const script =
      `touch '${pool}.'$$; sleep 0.3; ` +
      `[ $(ls '${pool}.'* 2>/dev/null | wc -l) -ge 2 ] && touch '${marker}'; rm -f '${pool}.'$$; ` +
      `printf '%s' '${APPROVE}'`;
    const report = await runReview({
      cwd: dir,
      config: cfg({
        chunkBudget: 400,
        reviewConcurrency: 1,
        reviewers: [{ name: "slow", type: "cli", command: script }],
      }),
      base: "main",
    });
    expect(report.stats.chunks).toBeGreaterThanOrEqual(2);
    const saw = await run(`test -f '${marker}'`, { cwd: dir });
    expect(saw.exitCode).not.toBe(0);
  });

  it("injects full file bodies into the prompt within contextBudget", async () => {
    const capture = join(dir, "prompt.txt");
    const script = `cat > '${capture}'; printf '%s' '${APPROVE}'`;
    await runReview({
      cwd: dir,
      config: cfg({ reviewers: [{ name: "spy", type: "cli", command: script }] }),
      base: "main",
    });
    const prompt = await readFile(capture, "utf8");
    expect(prompt).toContain("Full file contents after the change");
    expect(prompt).toContain("export const x = 1;");
  });

  it("omits file bodies when contextBudget is 0", async () => {
    const capture = join(dir, "prompt0.txt");
    const script = `cat > '${capture}'; printf '%s' '${APPROVE}'`;
    await runReview({
      cwd: dir,
      config: cfg({ contextBudget: 0, reviewers: [{ name: "spy", type: "cli", command: script }] }),
      base: "main",
    });
    const prompt = await readFile(capture, "utf8");
    expect(prompt).not.toContain("Full file contents after the change");
  });

  it("sums api token usage into stats.tokens", async () => {
    const body = {
      choices: [{ message: { content: APPROVE } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const report = await runReview({
      cwd: dir,
      config: cfg({ reviewers: [{ name: "api", type: "api", url: "https://api.test/x" }] }),
      base: "main",
    });
    vi.unstubAllGlobals();
    expect(report.stats.tokens).toEqual({ prompt: 100, completion: 10, total: 110 });
  });

  it("posts a REQUEST_CHANGES review with anchored comments for a PR", async () => {
    // Build a fake "origin" remote that serves refs/pull/7/head.
    const remote = join(dir, "remote.git");
    await sh(`git init -q --bare '${remote}'`);
    // Push objects first — update-ref refuses SHAs the remote doesn't have.
    await sh(`git remote add origin '${remote}' && git push -q origin main feat && git fetch -q origin`);
    const featSha = (await run("git rev-parse feat", { cwd: dir })).stdout.trim();
    await sh(`git -C '${remote}' update-ref refs/pull/7/head ${featSha}`);

    // Fake gh: answers `pr view` and captures `api` stdin + argv.
    const fakebin = join(dir, "fakebin");
    await mkdir(fakebin);
    const capStdin = join(dir, "gh-stdin.json");
    const capArgs = join(dir, "gh-args.txt");
    await writeFile(
      join(fakebin, "gh"),
      `#!/bin/sh\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo main; exit 0; fi\n` +
        `if [ "$1" = "api" ]; then\n` +
        `  case "$*" in\n` +
        `    *" -X POST"*) cat > '${capStdin}'; echo "$@" > '${capArgs}'; echo '{}'; exit 0;;\n` +
        `    *reviews* ) echo '[]'; exit 0;;\n` +
        `  esac\n` +
        `fi\n` +
        `exit 1`,
    );
    await chmod(join(fakebin, "gh"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakebin}:${savedPath}`;
    try {
      const report = await runReview({
        cwd: dir,
        pr: 7,
        postComments: true,
        config: cfg({ reviewers: [{ name: "strict", type: "cli", command: echo(REJECT) }] }),
      });
      expect(report.comments.requested).toBe(true);
      expect(report.comments.posted).toBe(true);
      expect(report.verdict).toBe("REJECT");

      const payload = JSON.parse(await readFile(capStdin, "utf8"));
      expect(payload.event).toBe("REQUEST_CHANGES");
      expect(payload.commit_id).toBe(featSha);
      expect(payload.comments).toEqual([
        { path: "a.ts", line: 2, side: "RIGHT", body: expect.stringContaining("MAJOR") },
      ]);
      const args = await readFile(capArgs, "utf8");
      expect(args).toContain("pulls/7/reviews");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("does not flip the verdict when comment posting fails", async () => {
    const remote = join(dir, "remote2.git");
    await sh(`git init -q --bare '${remote}'`);
    await sh(`git remote add origin '${remote}' && git push -q origin main feat && git fetch -q origin`);
    const featSha = (await run("git rev-parse feat", { cwd: dir })).stdout.trim();
    await sh(`git -C '${remote}' update-ref refs/pull/8/head ${featSha}`);

    const fakebin = join(dir, "fakebin2");
    await mkdir(fakebin);
    await writeFile(
      join(fakebin, "gh"),
      `#!/bin/sh\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo main; exit 0; fi\n` +
        `if [ "$1" = "api" ]; then echo 'Forbidden' >&2; exit 1; fi\n` +
        `exit 1`,
    );
    await chmod(join(fakebin, "gh"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakebin}:${savedPath}`;
    try {
      const report = await runReview({
        cwd: dir,
        pr: 8,
        postComments: true,
        config: cfg({ reviewers: [{ name: "ok", type: "cli", command: echo(APPROVE) }] }),
      });
      expect(report.verdict).toBe("APPROVE");
      expect(report.comments.posted).toBe(false);
      expect(report.comments.detail).toContain("post failed");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("posts pending then failure commit status on the PR head", async () => {
    const remote = join(dir, "remote3.git");
    await sh(`git init -q --bare '${remote}'`);
    await sh(`git remote add origin '${remote}' && git push -q origin main feat && git fetch -q origin`);
    const featSha = (await run("git rev-parse feat", { cwd: dir })).stdout.trim();
    await sh(`git -C '${remote}' update-ref refs/pull/9/head ${featSha}`);

    // Fake gh: answers `pr view`; every `gh api` call logs argv and captures
    // its stdin body into a numbered file so call order can be asserted.
    const fakebin = join(dir, "fakebin3");
    await mkdir(fakebin);
    const capDir = join(dir, "ghcap");
    const capArgs = join(dir, "gh-args.txt");
    await writeFile(
      join(fakebin, "gh"),
      `#!/bin/sh\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo main; exit 0; fi\n` +
        `if [ "$1" = "api" ]; then\n` +
        `  n=$(ls '${capDir}' 2>/dev/null | wc -l)\n` +
        `  mkdir -p '${capDir}'\n` +
        `  echo "$@" >> '${capArgs}'\n` +
        `  cat > '${capDir}/body-'$n'.json'\n` +
        `  echo '{}'; exit 0\n` +
        `fi\n` +
        `exit 1`,
    );
    await chmod(join(fakebin, "gh"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakebin}:${savedPath}`;
    try {
      const report = await runReview({
        cwd: dir,
        pr: 9,
        postStatus: true,
        config: cfg({ reviewers: [{ name: "strict", type: "cli", command: echo(REJECT) }] }),
      });
      expect(report.verdict).toBe("REJECT");
      expect(report.status.requested).toBe(true);
      expect(report.status.state).toBe("failure");

      const pending = JSON.parse(await readFile(join(capDir, "body-0.json"), "utf8"));
      const final = JSON.parse(await readFile(join(capDir, "body-1.json"), "utf8"));
      expect(pending.state).toBe("pending");
      expect(pending.context).toBe("ai-referee");
      expect(final.state).toBe("failure");
      expect(final.context).toBe("ai-referee");
      expect(final.description.length).toBeLessThanOrEqual(140);

      const args = await readFile(capArgs, "utf8");
      expect(args).toContain(`statuses/${featSha}`);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("keeps the verdict when status posting fails", async () => {
    const remote = join(dir, "remote4.git");
    await sh(`git init -q --bare '${remote}'`);
    await sh(`git remote add origin '${remote}' && git push -q origin main feat && git fetch -q origin`);
    const featSha = (await run("git rev-parse feat", { cwd: dir })).stdout.trim();
    await sh(`git -C '${remote}' update-ref refs/pull/10/head ${featSha}`);

    const fakebin = join(dir, "fakebin4");
    await mkdir(fakebin);
    await writeFile(
      join(fakebin, "gh"),
      `#!/bin/sh\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo main; exit 0; fi\n` +
        `if [ "$1" = "api" ]; then echo 'Forbidden' >&2; exit 1; fi\n` +
        `exit 1`,
    );
    await chmod(join(fakebin, "gh"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakebin}:${savedPath}`;
    try {
      const report = await runReview({
        cwd: dir,
        pr: 10,
        postStatus: true,
        config: cfg({ reviewers: [{ name: "ok", type: "cli", command: echo(APPROVE) }] }),
      });
      expect(report.verdict).toBe("APPROVE");
      expect(report.status.requested).toBe(true);
      expect(report.status.state).toBeNull();
      expect(report.status.detail).toContain("post failed");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("routes matched files to their own reviewer chain and prompt", async () => {
    await mkdir(join(dir, "src/auth"), { recursive: true });
    await writeFile(join(dir, "src/auth/token.ts"), "export const t = 1;\n");
    await sh("git add -A && git commit -qm auth");

    const report = await runReview({
      cwd: dir,
      config: cfg({
        reviewers: [
          { name: "default", type: "cli", command: `echo def >> ${dir}/calls && ${echo(APPROVE)}` },
          { name: "sec", type: "cli", command: `cat > ${dir}/sec.prompt && echo sec >> ${dir}/calls && ${echo(APPROVE)}` },
        ],
        routes: [{ name: "security", match: ["src/auth/**"], reviewers: ["sec"], instructions: "watch auth bypass" }],
      }),
      base: "main",
    });

    expect(report.verdict).toBe("APPROVE");
    expect(report.chunks).toHaveLength(2);
    const secChunk = report.chunks.find((c) => c.route === "security")!;
    expect(secChunk.files).toEqual(["src/auth/token.ts"]);
    expect(secChunk.attempts.map((a) => a.reviewer)).toEqual(["sec"]);
    const plain = report.chunks.find((c) => c.route === null)!;
    expect(plain.files).toEqual(["a.ts"]);
    expect(plain.attempts.map((a) => a.reviewer)).toEqual(["default"]);

    const calls = (await readFile(join(dir, "calls"), "utf8")).trim().split("\n");
    expect(calls).toEqual(["def", "sec"]);
    const prompt = await readFile(join(dir, "sec.prompt"), "utf8");
    expect(prompt).toContain("Additional instructions for this path:");
    expect(prompt).toContain("watch auth bypass");
    expect(prompt).toContain("src/auth/token.ts");
    expect(prompt).not.toContain("a.ts");
  });

  it("fails closed when routed referees are down — no silent fallback to the default chain", async () => {
    await mkdir(join(dir, "src/auth"), { recursive: true });
    await writeFile(join(dir, "src/auth/token.ts"), "export const t = 1;\n");
    await sh("git add -A && git commit -qm auth");

    const report = await runReview({
      cwd: dir,
      config: cfg({
        reviewers: [
          { name: "default", type: "cli", command: echo(APPROVE) },
          { name: "sec", type: "cli", command: "exit 1" },
        ],
        routes: [{ name: "security", match: ["src/auth/**"], reviewers: ["sec"] }],
      }),
      base: "main",
    });

    expect(report.verdict).toBe("REJECT");
    expect(report.reasons.join(" ")).toContain('no referee answered for route "security"');
    const secChunk = report.chunks.find((c) => c.route === "security")!;
    expect(secChunk.attempts.map((a) => a.reviewer)).toEqual(["sec"]);
  });

  it("switches the prompt profile via the run option and per-route override", async () => {
    await mkdir(join(dir, "src/auth"), { recursive: true });
    await writeFile(join(dir, "src/auth/token.ts"), "export const t = 1;\n");
    await sh("git add -A && git commit -qm auth");

    const report = await runReview({
      cwd: dir,
      profile: "light",
      config: cfg({
        reviewers: [
          { name: "rec", type: "cli", command: `cat > ${dir}/plain.prompt && ${echo(APPROVE)}` },
          { name: "sec", type: "cli", command: `cat > ${dir}/sec2.prompt && ${echo(APPROVE)}` },
        ],
        routes: [{ match: ["src/auth/**"], reviewers: ["sec"], profile: "strict" }],
      }),
      base: "main",
    });

    const plainPrompt = await readFile(join(dir, "plain.prompt"), "utf8");
    expect(plainPrompt).toContain("Review mode: light");
    const secPrompt = await readFile(join(dir, "sec2.prompt"), "utf8");
    expect(secPrompt).toContain("Review mode: strict");
    expect(report.chunks.find((c) => c.route === "src/auth/**")!.profile).toBe("strict");
    expect(report.chunks.find((c) => c.route === null)!.profile).toBe("light");
  });

  it("light profile: REJECT without blocker findings becomes a warning, not a gate block", async () => {
    const lightReject = `{"verdict":"REJECT","summary":"minor stuff","findings":[{"file":"a.ts","line":2,"severity":"minor","message":"nit"},{"file":"a.ts","line":3,"severity":"major","message":"questionable but not blocking"}]}`;
    const report = await runReview({
      cwd: dir,
      profile: "light",
      config: cfg({ reviewers: [{ name: "r", type: "cli", command: echo(lightReject) }] }),
      base: "main",
    });
    expect(report.verdict).toBe("APPROVE");
    expect(report.reasons).toEqual([]);
    expect(report.warnings.join(" ")).toContain("light");
    expect(report.findings).toHaveLength(2);
  });

  it("light profile: REJECT with a blocker finding still gates", async () => {
    const blockerReject = `{"verdict":"REJECT","summary":"boom","findings":[{"file":"a.ts","line":2,"severity":"blocker","message":"data loss"}]}`;
    const report = await runReview({
      cwd: dir,
      profile: "light",
      config: cfg({ reviewers: [{ name: "r", type: "cli", command: echo(blockerReject) }] }),
      base: "main",
    });
    expect(report.verdict).toBe("REJECT");
    expect(report.warnings).toEqual([]);
  });

  it("light profile: REJECT with no findings still fails closed", async () => {
    const bareReject = `{"verdict":"REJECT","summary":"i just don't like it","findings":[]}`;
    const report = await runReview({
      cwd: dir,
      profile: "light",
      config: cfg({ reviewers: [{ name: "r", type: "cli", command: echo(bareReject) }] }),
      base: "main",
    });
    expect(report.verdict).toBe("REJECT");
    expect(report.reasons.join(" ")).toContain("reviewer rejected");
  });

  it("dismisses its own stale CHANGES_REQUESTED reviews after posting", async () => {
    const remote = join(dir, "remote3.git");
    await sh(`git init -q --bare '${remote}'`);
    await sh(`git remote add origin '${remote}' && git push -q origin main feat && git fetch -q origin`);
    const featSha = (await run("git rev-parse feat", { cwd: dir })).stdout.trim();
    const mainSha = (await run("git rev-parse main", { cwd: dir })).stdout.trim();
    await sh(`git -C '${remote}' update-ref refs/pull/9/head ${featSha}`);

    // Stale reviews: one ours on the old head (dismiss), one ours on the new
    // head (keep — it is the review we just posted), one human's (keep).
    const staleList = JSON.stringify([
      { id: 42, state: "CHANGES_REQUESTED", commit_id: mainSha, body: "ai-referee stuff <!-- ai-referee:review -->", user: { login: "bot" } },
      { id: 43, state: "CHANGES_REQUESTED", commit_id: featSha, body: "fresh <!-- ai-referee:review -->", user: { login: "bot" } },
      { id: 44, state: "CHANGES_REQUESTED", commit_id: mainSha, body: "human review, no marker", user: { login: "alice" } },
    ]);

    const fakebin = join(dir, "fakebin3");
    await mkdir(fakebin);
    const capDismissals = join(dir, "gh-dismissals.txt");
    const staleFile = join(dir, "gh-reviews.json");
    await writeFile(staleFile, staleList);
    await writeFile(
      join(fakebin, "gh"),
      `#!/bin/sh\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo main; exit 0; fi\n` +
        `if [ "$1" = "api" ]; then\n` +
        `  case "$*" in\n` +
        `    *" -X PUT"*) cat > /dev/null; echo "$2" >> '${capDismissals}'; echo '{}'; exit 0;;\n` +
        `    *" -X POST"*) cat > /dev/null; echo '{}'; exit 0;;\n` +
        `    *reviews* ) cat '${staleFile}'; exit 0;;\n` +
        `  esac\n` +
        `fi\n` +
        `exit 1`,
    );
    await chmod(join(fakebin, "gh"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakebin}:${savedPath}`;
    try {
      const report = await runReview({
        cwd: dir,
        pr: 9,
        postComments: true,
        config: cfg({ reviewers: [{ name: "ok", type: "cli", command: echo(APPROVE) }] }),
      });
      expect(report.comments.posted).toBe(true);
      expect(report.comments.detail).toContain("dismissed 1 superseded review(s)");
      const dismissals = (await readFile(capDismissals, "utf8")).trim();
      expect(dismissals).toContain("pulls/9/reviews/42/dismissals");
      expect(dismissals).not.toContain("reviews/43/dismissals");
      expect(dismissals).not.toContain("reviews/44/dismissals");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("only dismisses marker reviews from the account that posted", async () => {
    const remote = join(dir, "remote4.git");
    await sh(`git init -q --bare '${remote}'`);
    await sh(`git remote add origin '${remote}' && git push -q origin main feat && git fetch -q origin`);
    const featSha = (await run("git rev-parse feat", { cwd: dir })).stdout.trim();
    const mainSha = (await run("git rev-parse main", { cwd: dir })).stdout.trim();
    await sh(`git -C '${remote}' update-ref refs/pull/9/head ${featSha}`);

    // Stale reviews: one ours on the old head (dismiss), one ours on the new
    // head (keep — it is the review we just posted), one human's (keep).
    const staleList = JSON.stringify([
      { id: 42, state: "CHANGES_REQUESTED", commit_id: mainSha, body: "ai-referee stuff <!-- ai-referee:review -->", user: { login: "bot" } },
      { id: 43, state: "CHANGES_REQUESTED", commit_id: featSha, body: "fresh <!-- ai-referee:review -->", user: { login: "bot" } },
      { id: 44, state: "CHANGES_REQUESTED", commit_id: mainSha, body: "quoted <!-- ai-referee:review -->", user: { login: "alice" } },
    ]);

    const fakebin = join(dir, "fakebin4");
    await mkdir(fakebin);
    const capDismissals = join(dir, "gh-dismissals4.txt");
    const staleFile = join(dir, "gh-reviews4.json");
    await writeFile(staleFile, staleList);
    await writeFile(
      join(fakebin, "gh"),
      `#!/bin/sh\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo main; exit 0; fi\n` +
        `if [ "$1" = "api" ]; then\n` +
        `  case "$*" in\n` +
        `    *" -X PUT"*) cat > /dev/null; echo "$2" >> '${capDismissals}'; echo '{}'; exit 0;;\n` +
        `    *" -X POST"*) cat > /dev/null; echo '{"id":99,"user":{"login":"bot"}}'; exit 0;;\n` +
        `    *reviews* ) cat '${staleFile}'; exit 0;;\n` +
        `  esac\n` +
        `fi\n` +
        `exit 1`,
    );
    await chmod(join(fakebin, "gh"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakebin}:${savedPath}`;
    try {
      const report = await runReview({
        cwd: dir,
        pr: 9,
        postComments: true,
        config: cfg({ reviewers: [{ name: "ok", type: "cli", command: echo(APPROVE) }] }),
      });
      expect(report.comments.posted).toBe(true);
      expect(report.comments.detail).toContain("dismissed 1 superseded review(s)");
      const dismissals = (await readFile(capDismissals, "utf8")).trim();
      expect(dismissals).toContain("pulls/9/reviews/42/dismissals");
      expect(dismissals).not.toContain("reviews/43/dismissals");
      expect(dismissals).not.toContain("reviews/44/dismissals");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("second referee overrules a REJECT into a warning when --confirm", async () => {
    const report = await runReview({
      cwd: dir,
      config: cfg({
        reviewers: [
          { name: "judge", type: "cli", command: echo(REJECT) },
          { name: "appeals", type: "cli", command: echo(APPROVE) },
        ],
      }),
      base: "main",
      confirmRejections: true,
    });
    expect(report.verdict).toBe("APPROVE");
    expect(report.warnings.join(" ")).toContain("overruled");
    const chunk = report.chunks[0]!;
    expect(chunk.confirmation?.verdict).toBe("APPROVE");
    expect(chunk.confirmation?.reviewer).toBe("appeals");
    // The judge must not confirm itself: exactly one confirm-phase attempt.
    expect(chunk.attempts.filter((a) => a.phase === "confirm")).toHaveLength(1);
  });

  it("REJECT stands with a 'confirmed' reason when the second referee agrees", async () => {
    const report = await runReview({
      cwd: dir,
      config: cfg({
        reviewers: [
          { name: "judge", type: "cli", command: echo(REJECT) },
          { name: "appeals", type: "cli", command: echo(REJECT) },
        ],
      }),
      base: "main",
      confirmRejections: true,
    });
    expect(report.verdict).toBe("REJECT");
    expect(report.reasons.join(" ")).toContain("confirmed by appeals");
  });

  it("REJECT stands when no second referee exists — single reviewer chain", async () => {
    const report = await runReview({
      cwd: dir,
      config: cfg({ reviewers: [{ name: "lone", type: "cli", command: echo(REJECT) }] }),
      base: "main",
      confirmRejections: true,
    });
    expect(report.verdict).toBe("REJECT");
    expect(report.reasons.join(" ")).toContain("no second referee");
  });

  it("REJECT stands when the second referee cannot answer or parses garbage", async () => {
    const report = await runReview({
      cwd: dir,
      config: cfg({
        reviewers: [
          { name: "judge", type: "cli", command: echo(REJECT) },
          { name: "gone", type: "cli", command: "exit 1" },
        ],
      }),
      base: "main",
      confirmRejections: true,
    });
    expect(report.verdict).toBe("REJECT");
    expect(report.reasons.join(" ")).toContain("second referee unavailable");
  });

  it("skips confirmation entirely when the flag is off", async () => {
    const report = await runReview({
      cwd: dir,
      config: cfg({
        reviewers: [
          { name: "judge", type: "cli", command: echo(REJECT) },
          { name: "appeals", type: "cli", command: echo(APPROVE) },
        ],
      }),
      base: "main",
    });
    expect(report.verdict).toBe("REJECT");
    expect(report.chunks[0]!.confirmation).toBeUndefined();
    expect(report.chunks[0]!.attempts.filter((a) => a.phase === "confirm")).toHaveLength(0);
  });

  it("confirmation findings merge into the report", async () => {
    const second = `{"verdict":"REJECT","summary":"confirmed","findings":[{"file":"a.ts","line":3,"severity":"minor","message":"extra issue found by second referee"}]}`;
    const report = await runReview({
      cwd: dir,
      config: cfg({
        reviewers: [
          { name: "judge", type: "cli", command: echo(REJECT) },
          { name: "appeals", type: "cli", command: echo(second) },
        ],
      }),
      base: "main",
      confirmRejections: true,
    });
    expect(report.verdict).toBe("REJECT");
    expect(report.findings.some((f) => f.message.includes("second referee"))).toBe(true);
  });

});

import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    daemonIntervalSec: 120,
    workdir: null,
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

});

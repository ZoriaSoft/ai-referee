import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDaemon, pollDelayMs, runPool } from "../src/daemon.js";
import { run } from "../src/exec.js";
import type { Config } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/config.js";

let dir: string;
let savedPath: string | undefined;

function cfg(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

async function sh(cmd: string): Promise<void> {
  const res = await run(cmd, { cwd: dir });
  if (res.exitCode !== 0) throw new Error(`setup failed: ${cmd}\n${res.stderr}`);
}

/** Installs a fake `gh` on PATH whose `pr list` output comes from `body`. */
async function fakeGh(body: string | { script: string }): Promise<void> {
  const bin = join(dir, "fakebin");
  await mkdir(bin, { recursive: true });
  const contents =
    typeof body === "string"
      ? `#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf '%s' '${body.replace(/'/g, "'\\''")}'; exit 0; fi\nexit 1\n`
      : `#!/bin/sh\n${body.script}\n`;
  await writeFile(join(bin, "gh"), contents);
  await chmod(join(bin, "gh"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "air-daemon-"));
  await sh("git init -q -b main && git config user.email t@t && git config user.name t");
  await writeFile(join(dir, "a.ts"), "export const a = 0;\n");
  await sh("git add -A && git commit -qm init");
});

afterEach(async () => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("pollDelayMs", () => {
  it("keeps the base interval on success and first failure, then doubles to 8x", () => {
    const base = 120_000;
    expect(pollDelayMs(base, 0)).toBe(base);
    expect(pollDelayMs(base, 1)).toBe(base);
    expect(pollDelayMs(base, 2)).toBe(base * 2);
    expect(pollDelayMs(base, 3)).toBe(base * 4);
    expect(pollDelayMs(base, 4)).toBe(base * 8);
    expect(pollDelayMs(base, 9)).toBe(base * 8); // capped
  });
});

describe("runDaemon --once", () => {
  it("polls once and exits 0 with an empty PR list", async () => {
    await fakeGh("[]");
    const logs: string[] = [];
    const code = await runDaemon({
      cwd: dir,
      config: cfg(),
      intervalSec: 10,
      once: true,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(logs.join(" ")).toContain("0 open PR(s)");
  });

  it("survives a gh failure and reports the backoff", async () => {
    await fakeGh({ script: `echo "gh: boom" >&2; exit 1` });
    const logs: string[] = [];
    const code = await runDaemon({
      cwd: dir,
      config: cfg(),
      intervalSec: 10,
      once: true,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(logs.join(" ")).toContain("gh pr list failed");
    expect(logs.join(" ")).toContain("next poll in");
  });
});

describe("runPool", () => {
  it("caps in-flight work at the bound and drains every item once", async () => {
    const gate = Promise.withResolvers<void>();
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    const pool = runPool([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate.promise; // park workers: the bound must hold before release
      inFlight--;
      done.push(n);
    });
    // Workers run to the gate synchronously — exactly the bound is in flight.
    expect(inFlight).toBe(2);
    gate.resolve();
    await pool;
    expect(peak).toBe(2);
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never spawns more workers than items, and resolves an empty pool", async () => {
    const gate = Promise.withResolvers<void>();
    let inFlight = 0;
    const pool = runPool([1, 2], 8, async () => {
      inFlight++;
      await gate.promise;
    });
    expect(inFlight).toBe(2); // min(8 workers, 2 items)
    gate.resolve();
    await pool;
    await runPool([], 0, async () => {
      throw new Error("must never run");
    });
  });

  it("keeps draining when an item failure is caught inside fn (daemon contract)", async () => {
    const done: number[] = [];
    const errors: string[] = [];
    await runPool([1, 2, 3], 3, async (n) => {
      try {
        if (n === 2) throw new Error("boom");
        done.push(n);
      } catch (err) {
        errors.push((err as Error).message);
      }
    });
    expect(done.sort()).toEqual([1, 3]);
    expect(errors).toEqual(["boom"]);
  });

  it("propagates an uncaught failure", async () => {
    await expect(
      runPool([1], 1, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("daemon state file", () => {
  const statePath = (): string => join(dir, ".ai-referee", "daemon-state.json");

  it("recovers from a corrupt state file", async () => {
    await mkdir(join(dir, ".ai-referee"), { recursive: true });
    await writeFile(statePath(), "not json{", "utf8");
    await fakeGh("[]");
    const code = await runDaemon({ cwd: dir, config: cfg(), intervalSec: 10, once: true, log: () => {} });
    expect(code).toBe(0);
    // A failed poll must not rewrite (or tear) the existing file.
    expect(await readFile(statePath(), "utf8")).toBe("not json{");
  });

  it("writes no state and leaves no tmp files when every review fails", async () => {
    await fakeGh(`[{"number":7,"title":"x","headRefOid":"deadbeef"}]`);
    const logs: string[] = [];
    const code = await runDaemon({
      cwd: dir,
      config: cfg(),
      intervalSec: 10,
      once: true,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(logs.join(" ")).toContain("review failed");
    await expect(access(statePath())).rejects.toThrow(); // nothing persisted
    try {
      const leftovers = (await readdir(join(dir, ".ai-referee"))).filter((f) => f.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    } catch {
      // no .ai-referee dir at all — also correct
    }
  });
});

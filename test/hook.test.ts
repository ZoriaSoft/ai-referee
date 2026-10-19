import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installHook, mergeHook } from "../src/hook.js";

const dirs: string[] = [];
async function repo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "air-hook-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q", d]);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("mergeHook", () => {
  it("writes a fresh hook with a shebang", () => {
    const h = mergeHook(null);
    expect(h.startsWith("#!/bin/sh\n")).toBe(true);
    expect(h).toContain("ai-referee review </dev/null");
  });

  it("puts the gate before a foreign hook that exits early, and keeps it", () => {
    const foreign = "#!/bin/sh\necho lint\nexit 0\n";
    const h = mergeHook(foreign);
    expect(h.indexOf("ai-referee review")).toBeLessThan(h.indexOf("exit 0"));
    expect(h).toContain("echo lint");
  });

  it("refreshes its own block without dropping the foreign part", () => {
    const once = mergeHook("#!/bin/sh\necho lint\n");
    const twice = mergeHook(once);
    expect(twice).toBe(once);
    expect(twice.match(/ai-referee review/g)).toHaveLength(1);
  });

  it("upgrades the legacy block appended by older versions", () => {
    const legacy = "#!/bin/sh\necho lint\n\n# ai-referee hook \u2014 do not edit below this line\nai-referee review\ncode=$?\nexit $code\n";
    const h = mergeHook(legacy);
    expect(h).toContain("echo lint");
    expect(h).not.toContain("do not edit below");
    expect(h.match(/ai-referee review/g)).toHaveLength(1);
  });
});

describe("installHook", () => {
  it("installs into .git/hooks by default", async () => {
    const d = await repo();
    const { path, replaced } = await installHook(d);
    expect(path).toBe(join(d, ".git", "hooks", "pre-push"));
    expect(replaced).toBe(false);
    expect(await readFile(path, "utf8")).toContain("ai-referee review");
    expect((await installHook(d)).replaced).toBe(true);
  });

  it("honours core.hooksPath", async () => {
    const d = await repo();
    execFileSync("git", ["-C", d, "config", "core.hooksPath", ".githooks"]);
    const { path } = await installHook(d);
    expect(path).toBe(join(d, ".githooks", "pre-push"));
  });

  it("works from a linked worktree (where .git is a file)", async () => {
    const d = await repo();
    await writeFile(join(d, "f"), "x");
    execFileSync("git", ["-C", d, "add", "f"]);
    execFileSync("git", ["-C", d, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"]);
    const wt = join(d, "wt");
    execFileSync("git", ["-C", d, "worktree", "add", "-q", "--detach", wt]);
    const { path } = await installHook(wt);
    expect(path).toBe(join(d, ".git", "hooks", "pre-push"));
  });

  it("runs end to end: a failing gate blocks, the foreign hook still runs on success", async () => {
    const d = await repo();
    const bin = join(d, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "ai-referee"), "#!/bin/sh\nexit ${GATE:-0}\n", { mode: 0o755 });
    await writeFile(join(d, ".git", "hooks", "pre-push"), "#!/bin/sh\necho foreign-ran\n", { mode: 0o755 });
    const { path } = await installHook(d);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    expect(execFileSync("sh", [path], { env, encoding: "utf8" })).toContain("foreign-ran");
    expect(() => execFileSync("sh", [path], { env: { ...env, GATE: "1" }, stdio: "pipe" })).toThrow();
  });
});

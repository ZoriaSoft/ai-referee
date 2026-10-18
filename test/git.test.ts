import { access, appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dropPrRef, fetchPrHead } from "../src/git.js";
import { run } from "../src/exec.js";

let dir: string;
let origin: string;
const dirs: string[] = [];

async function sh(cmd: string, cwd = dir): Promise<string> {
  const res = await run(cmd, { cwd });
  if (res.exitCode !== 0) throw new Error(`setup failed: ${cmd}\n${res.stderr}`);
  return res.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Commits `content` to feat and publishes it as refs/pull/<n>/head on the bare origin. */
async function pushPr(pr: number, content: string): Promise<string> {
  await sh("git checkout -q feat");
  await appendFile(join(dir, "a.ts"), content);
  await sh("git add -A && git commit -qm change");
  const sha = await sh("git rev-parse HEAD");
  await sh(`git push -f origin HEAD:refs/pull/${pr}/head`);
  await sh("git checkout -q main");
  return sha;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "air-git-"));
  origin = await mkdtemp(join(tmpdir(), "air-origin-"));
  dirs.push(dir, origin);
  await sh("git init -q --bare .", origin);
  await sh("git init -q -b main && git config user.email t@t && git config user.name t");
  await sh("git remote add origin " + origin);
  await sh(`printf 'export const a = 0;\n' > a.ts && git add -A && git commit -qm init`);
  await sh("git push -q origin main");
  await sh("git checkout -qb feat");
});

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("fetchPrHead", () => {
  it("returns the PR head SHA via a scratch ref, leaving FETCH_HEAD alone", async () => {
    const sha = await pushPr(7, "// change\n");
    expect(await fetchPrHead(dir, 7)).toBe(sha);
    // FETCH_HEAD must never be written: parallel reviews share it otherwise.
    expect(await exists(join(dir, ".git", "FETCH_HEAD"))).toBe(false);
    expect(await sh("git rev-parse --verify refs/ai-referee/pr-7")).toBe(sha);
  });

  it("follows a force-pushed head instead of failing on non-fast-forward", async () => {
    const first = await pushPr(7, "// v1\n");
    expect(await fetchPrHead(dir, 7)).toBe(first);
    const second = await pushPr(7, "// v2\n");
    expect(await fetchPrHead(dir, 7)).toBe(second);
    expect(await sh("git rev-parse refs/ai-referee/pr-7")).toBe(second);
  });

  it("parallel fetches of different PRs return their own SHAs", async () => {
    const sha7 = await pushPr(7, "// pr7\n");
    const sha9 = await pushPr(9, "// pr9\n"); // new commit on feat → distinct SHA
    const [a, b] = await Promise.all([fetchPrHead(dir, 7), fetchPrHead(dir, 9)]);
    expect(a).toBe(sha7);
    expect(b).toBe(sha9);
    expect(await exists(join(dir, ".git", "FETCH_HEAD"))).toBe(false);
  });

  it("dropPrRef removes the scratch ref and never throws on repeats", async () => {
    await pushPr(7, "// change\n");
    await fetchPrHead(dir, 7);
    await dropPrRef(dir, 7);
    const res = await run("git rev-parse --verify refs/ai-referee/pr-7", { cwd: dir });
    expect(res.exitCode).not.toBe(0);
    await dropPrRef(dir, 7); // already gone — must not throw
    await dropPrRef(dir, 404); // never existed — must not throw
  });
});

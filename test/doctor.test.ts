import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/exec.js";
import { runDoctor } from "../src/doctor.js";

let dir: string;
let fakebin: string;
let savedPath: string | undefined;

async function fakeGh(script: string): Promise<void> {
  await mkdir(fakebin, { recursive: true });
  await writeFile(join(fakebin, "gh"), `#!/bin/sh\n${script}`);
  await chmod(join(fakebin, "gh"), 0o755);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "air-doc-"));
  fakebin = join(dir, "fakebin");
  savedPath = process.env.PATH;
  await run("git init -q -b main && git config user.email t@t && git config user.name t", { cwd: dir });
});

afterEach(async () => {
  process.env.PATH = savedPath;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("is healthy with a git repo, config, reachable reviewer and authenticated gh", async () => {
    await fakeGh('if [ "$1" = "auth" ]; then exit 0; fi\nexit 1');
    process.env.PATH = `${fakebin}:${process.env.PATH}`;
    await writeFile(
      join(dir, ".ai-referee.json"),
      JSON.stringify({
        testCommand: "true",
        reviewers: [{ name: "sh", type: "cli", command: "cat" }],
      }),
    );
    const lines: string[] = [];
    const res = await runDoctor({ cwd: dir, out: (l) => lines.push(l) });
    expect(res.healthy).toBe(true);
    expect(res.checks.every((c) => c.status !== "fail")).toBe(true);
    expect(lines.join("\n")).toContain("reviewer \"sh\"");
    expect(lines.join("\n")).toContain("authenticated");
  });

  it("fails when no config exists — no reviewers configured", async () => {
    await fakeGh('if [ "$1" = "auth" ]; then exit 0; fi\nexit 1');
    process.env.PATH = `${fakebin}:${process.env.PATH}`;
    const res = await runDoctor({ cwd: dir, out: () => {} });
    expect(res.healthy).toBe(false);
    expect(res.checks.find((c) => c.name === "reviewers")?.status).toBe("fail");
  });

  it("fails fast on invalid config JSON", async () => {
    await writeFile(join(dir, ".ai-referee.json"), "{ not json ");
    const res = await runDoctor({ cwd: dir, out: () => {} });
    expect(res.healthy).toBe(false);
    expect(res.checks.find((c) => c.name === "config")?.status).toBe("fail");
  });

  it("warns (not fails) when the reviewer binary is missing but another reviewer is ok", async () => {
    await fakeGh('if [ "$1" = "auth" ]; then exit 0; fi\nexit 1');
    process.env.PATH = `${fakebin}:${process.env.PATH}`;
    await writeFile(
      join(dir, ".ai-referee.json"),
      JSON.stringify({
        reviewers: [
          { name: "ghost", type: "cli", command: "no-such-referee-binary-xyz" },
          { name: "sh", type: "cli", command: "cat" },
        ],
      }),
    );
    const res = await runDoctor({ cwd: dir, out: () => {} });
    expect(res.healthy).toBe(true);
    expect(res.checks.find((c) => c.name === 'reviewer "ghost"')?.status).toBe("warn");
  });

  it("is unhealthy when every reviewer is unreachable", async () => {
    await fakeGh('if [ "$1" = "auth" ]; then exit 0; fi\nexit 1');
    process.env.PATH = `${fakebin}:${process.env.PATH}`;
    await writeFile(
      join(dir, ".ai-referee.json"),
      JSON.stringify({ reviewers: [{ name: "ghost", type: "cli", command: "no-such-referee-binary-xyz" }] }),
    );
    const res = await runDoctor({ cwd: dir, out: () => {} });
    expect(res.healthy).toBe(false);
  });

  it("warns when gh is not authenticated", async () => {
    await fakeGh("exit 1");
    process.env.PATH = `${fakebin}:${process.env.PATH}`;
    await writeFile(
      join(dir, ".ai-referee.json"),
      JSON.stringify({ reviewers: [{ name: "sh", type: "cli", command: "cat" }] }),
    );
    const res = await runDoctor({ cwd: dir, out: () => {} });
    const gh = res.checks.find((c) => c.name === "gh CLI");
    expect(gh?.status).toBe("warn");
    expect(gh?.detail).toContain("not authenticated");
  });
});

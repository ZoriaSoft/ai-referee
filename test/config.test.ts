import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

let dir: string | null = null;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

async function writeCfg(content: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "air-cfg-"));
  const path = join(dir, ".ai-referee.json");
  await writeFile(path, content);
  return dir;
}

describe("loadConfig", () => {
  it("returns defaults when no file exists", async () => {
    dir = await mkdtemp(join(tmpdir(), "air-cfg-"));
    const { config, path } = await loadConfig(dir);
    expect(path).toBeNull();
    expect(config.reviewers).toEqual([]);
    expect(config.chunkBudget).toBe(100_000);
  });

  it("parses lenient JSON with comments", async () => {
    const cwd = await writeCfg(`{
      // reviewer chain
      "testCommand": "make check",
      "reviewers": [{"name":"a","type":"cli","command":"cat"}],
    }`);
    const { config } = await loadConfig(cwd);
    expect(config.testCommand).toBe("make check");
    expect(config.reviewers).toHaveLength(1);
  });

  it("rejects a cli reviewer without command", async () => {
    const cwd = await writeCfg(`{"reviewers":[{"name":"x","type":"cli"}]}`);
    await expect(loadConfig(cwd)).rejects.toThrow(ConfigError);
  });

  it("rejects an api reviewer without url", async () => {
    const cwd = await writeCfg(`{"reviewers":[{"name":"x","type":"api"}]}`);
    await expect(loadConfig(cwd)).rejects.toThrow(ConfigError);
  });

  it("rejects invalid reviewer type", async () => {
    const cwd = await writeCfg(`{"reviewers":[{"name":"x","type":"magic"}]}`);
    await expect(loadConfig(cwd)).rejects.toThrow(/must be "cli" or "api"/);
  });

  it("rejects non-object config", async () => {
    const cwd = await writeCfg(`[1,2,3]`);
    await expect(loadConfig(cwd)).rejects.toThrow(ConfigError);
  });

  it("rejects tiny chunk budgets", async () => {
    const cwd = await writeCfg(`{"chunkBudget": 100}`);
    await expect(loadConfig(cwd)).rejects.toThrow(/chunkBudget/);
  });

  it("honours an explicit config path", async () => {
    const cwd = await writeCfg(`{"testCommand":"yes"}`);
    const { config } = await loadConfig(cwd, join(cwd, ".ai-referee.json"));
    expect(config.testCommand).toBe("yes");
  });
});

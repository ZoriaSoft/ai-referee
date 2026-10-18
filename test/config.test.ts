import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

let dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function writeCfg(content: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "air-cfg-"));
  dirs.push(d);
  const path = join(d, ".ai-referee.json");
  await writeFile(path, content);
  return d;
}

describe("loadConfig", () => {
  it("returns defaults when no file exists", async () => {
    dirs.push(await mkdtemp(join(tmpdir(), "air-cfg-")));
    const { config, path } = await loadConfig(dirs[dirs.length - 1]!);
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
    expect(config.confirmRejections).toBe(false); // default off
  });

  it("parses confirmRejections and jsonMode", async () => {
    const cwd = await writeCfg(`{
      "confirmRejections": true,
      "reviewers": [{"name":"a","type":"api","url":"https://x/v1/chat/completions","jsonMode":true}],
    }`);
    const { config } = await loadConfig(cwd);
    expect(config.confirmRejections).toBe(true);
    expect(config.reviewers[0]!.jsonMode).toBe(true);
  });

  it("parses commitStatus and prComments", async () => {
    const cwd = await writeCfg(`{ "commitStatus": true, "prComments": true }`);
    const { config } = await loadConfig(cwd);
    expect(config.commitStatus).toBe(true);
    expect(config.prComments).toBe(true);
    const none = await mkdtemp(join(tmpdir(), "air-cfg-none-"));
    dirs.push(none);
    const { config: def } = await loadConfig(none);
    expect(def.commitStatus).toBe(false);
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

  it("rejects out-of-range daemonConcurrency", async () => {
    await expect(loadConfig(await writeCfg(`{"daemonConcurrency": 0}`))).rejects.toThrow(/daemonConcurrency/);
    await expect(loadConfig(await writeCfg(`{"daemonConcurrency": 99}`))).rejects.toThrow(/daemonConcurrency/);
    const { config } = await loadConfig(await writeCfg(`{"daemonConcurrency": 3}`));
    expect(config.daemonConcurrency).toBe(3);
  });

  it("honours an explicit config path", async () => {
    const cwd = await writeCfg(`{"testCommand":"yes"}`);
    const { config } = await loadConfig(cwd, join(cwd, ".ai-referee.json"));
    expect(config.testCommand).toBe("yes");
  });

  it("parses profile and routes", async () => {
    const cwd = await writeCfg(`{
      "profile": "light",
      "reviewers": [{"name":"sec","type":"cli","command":"cat"}],
      "routes": [{
        "name": "security",
        "match": ["src/auth/**"],
        "reviewers": ["sec"],
        "profile": "strict",
        "instructions": "watch auth bypass"
      }]
    }`);
    const { config } = await loadConfig(cwd);
    expect(config.profile).toBe("light");
    expect(config.routes).toHaveLength(1);
    expect(config.routes[0]!.reviewers).toEqual(["sec"]);
    expect(config.routes[0]!.profile).toBe("strict");
  });

  it("rejects a bad profile value", async () => {
    const cwd = await writeCfg(`{"profile": "paranoid"}`);
    await expect(loadConfig(cwd)).rejects.toThrow(/"profile" must be "strict" or "light"/);
  });

  it("rejects a route referencing an unknown reviewer", async () => {
    const cwd = await writeCfg(`{
      "reviewers": [{"name":"a","type":"cli","command":"cat"}],
      "routes": [{"match": ["x/**"], "reviewers": ["ghost"]}]
    }`);
    await expect(loadConfig(cwd)).rejects.toThrow(/unknown reviewer "ghost"/);
  });

  it("rejects a route with no reviewers and a route with empty match", async () => {
    const cwd = await writeCfg(`{
      "reviewers": [{"name":"a","type":"cli","command":"cat"}],
      "routes": [{"match": [], "reviewers": ["a"]}]
    }`);
    await expect(loadConfig(cwd)).rejects.toThrow(/match must be a non-empty/);

    const cwd2 = await writeCfg(`{
      "reviewers": [{"name":"a","type":"cli","command":"cat"}],
      "routes": [{"match": ["x/**"], "reviewers": []}]
    }`);
    await expect(loadConfig(cwd2)).rejects.toThrow(/lists no reviewers/);
  });

  it("rejects duplicate reviewer names — routing resolves by name", async () => {
    const cwd = await writeCfg(`{
      "reviewers": [
        {"name":"a","type":"cli","command":"cat"},
        {"name":"a","type":"cli","command":"cat"}
      ]
    }`);
    await expect(loadConfig(cwd)).rejects.toThrow(/duplicate reviewer name "a"/);
  });
});

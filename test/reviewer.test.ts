import { describe, expect, it, vi } from "vitest";
import { buildReviewer, cliCommandBinary, invokeChain, type Reviewer } from "../src/reviewer.js";
import type { ReviewerConfig } from "../src/config.js";

const cli = (name: string, command: string, extra: Partial<ReviewerConfig> = {}): ReviewerConfig => ({
  name,
  type: "cli",
  command,
  ...extra,
});

describe("cliReviewer", () => {
  it("pipes the prompt to stdin by default", async () => {
    const reviewer = buildReviewer(cli("echo", "cat"));
    const res = await reviewer.invoke("hello prompt", process.cwd());
    expect(res.ok).toBe(true);
    expect(res.output.trim()).toBe("hello prompt");
  });

  it("substitutes {prompt} inline when present", async () => {
    const reviewer = buildReviewer(cli("echo", "echo {prompt}"));
    const res = await reviewer.invoke("inline-prompt-test", process.cwd());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("inline-prompt-test");
  });

  it("substitutes {prompt_file} with a real file path", async () => {
    const reviewer = buildReviewer(cli("cat", "cat {prompt_file}"));
    const res = await reviewer.invoke("via file content", process.cwd());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("via file content");
  });

  it("reports missing binary without spawning", async () => {
    const reviewer = buildReviewer(cli("missing", "definitely-not-a-binary-xyz --flag"));
    const res = await reviewer.invoke("p", process.cwd());
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("binary not found");
  });

  it("fails on non-zero exit", async () => {
    const reviewer = buildReviewer(cli("failer", "exit 3"));
    const res = await reviewer.invoke("p", process.cwd());
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("exit 3");
  });

  it("fails on empty output", async () => {
    const reviewer = buildReviewer(cli("silent", "true"));
    const res = await reviewer.invoke("p", process.cwd());
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("empty output");
  });

  it("times out", async () => {
    const reviewer = buildReviewer(cli("slow", "sleep 30", { timeoutMs: 500 }));
    const res = await reviewer.invoke("p", process.cwd());
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("timed out");
  });
});

describe("invokeChain", () => {
  it("returns the first successful reviewer", async () => {
    const reviewers = [
      buildReviewer(cli("bad", "exit 1")),
      buildReviewer(cli("good", "cat")),
    ];
    const { response, attempts } = await invokeChain(reviewers, "prompt", process.cwd());
    expect(response?.ok).toBe(true);
    expect(attempts.map((a) => a.reviewer)).toEqual(["bad", "good"]);
    expect(attempts[0]!.ok).toBe(false);
    expect(attempts[1]!.ok).toBe(true);
  });

  it("returns null response when every reviewer fails — no referee", async () => {
    const reviewers = [
      buildReviewer(cli("a", "exit 1")),
      buildReviewer(cli("b", "nope-no-such-bin")),
    ];
    const { response, attempts } = await invokeChain(reviewers, "prompt", process.cwd());
    expect(response).toBeNull();
    expect(attempts).toHaveLength(2);
  });
});

describe("apiReviewer", () => {
  it("fails fast when the API key env var is missing", async () => {
    const reviewer = buildReviewer({
      name: "api",
      type: "api",
      url: "http://127.0.0.1:1/v1/chat/completions",
      apiKeyEnv: "AI_REFEREE_TEST_MISSING_KEY",
    });
    const res = await reviewer.invoke("p", process.cwd());
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("AI_REFEREE_TEST_MISSING_KEY");
  });

  it("parses OpenAI-style responses", async () => {
    const body = { choices: [{ message: { content: '{"verdict":"APPROVE","summary":"ok","findings":[]}' } }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const reviewer = buildReviewer({ name: "api", type: "api", url: "https://api.test/v1/chat/completions", model: "m" });
    const res = await reviewer.invoke("p", process.cwd());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("APPROVE");
    vi.unstubAllGlobals();
  });

  it("captures token usage from the response", async () => {
    const body = {
      choices: [{ message: { content: '{"verdict":"APPROVE","summary":"ok","findings":[]}' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const reviewer = buildReviewer({ name: "api", type: "api", url: "https://api.test/v1/chat/completions" });
    const res = await reviewer.invoke("p", process.cwd());
    expect(res.ok).toBe(true);
    expect(res.tokens).toEqual({ prompt: 1200, completion: 80, total: 1280 });
    vi.unstubAllGlobals();
  });

  it("omits tokens when the endpoint reports none", async () => {
    const body = { choices: [{ message: { content: "x" } }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const reviewer = buildReviewer({ name: "api", type: "api", url: "https://api.test/v1/chat/completions" });
    const res = await reviewer.invoke("p", process.cwd());
    expect(res.tokens).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("reports HTTP errors as failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota exceeded", { status: 429 })));
    const reviewer = buildReviewer({ name: "api", type: "api", url: "https://api.test/v1/chat/completions", model: "m" });
    const res = await reviewer.invoke("p", process.cwd());
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("429");
    vi.unstubAllGlobals();
  });

});

describe("cliCommandBinary", () => {
  it("extracts the binary from plain and env-prefixed commands", () => {
    expect(cliCommandBinary("claude -p")).toBe("claude");
    expect(cliCommandBinary("FOO=1 claude -p")).toBe("claude");
    expect(cliCommandBinary("/opt/bin/referee --flag")).toBe("/opt/bin/referee");
  });

  it("returns null for compound or non-binary commands", () => {
    expect(cliCommandBinary("cat | jq .")).toBeNull();
    expect(cliCommandBinary("exit 1")).toBe("exit");
    expect(cliCommandBinary("")).toBeNull();
  });
});

describe("invokeChain token propagation", () => {
  it("carries token usage into the attempt log", async () => {
    const fake: Reviewer = {
      name: "metered",
      invoke: async () => ({
        ok: true,
        output: "x",
        detail: "",
        durationMs: 1,
        tokens: { prompt: 5, completion: 2, total: 7 },
      }),
    };
    const { attempts } = await invokeChain([fake], "p", process.cwd());
    expect(attempts[0]!.tokens).toEqual({ prompt: 5, completion: 2, total: 7 });
  });

});

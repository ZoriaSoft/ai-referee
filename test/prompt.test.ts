import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "../src/prompt.js";

const base = {
  index: 0,
  files: ["src/a.ts"],
  patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
  truncated: false,
  totalChunks: 1,
  base: "main",
  head: "feat",
  repoNote: null,
  nonce: "0123abcd",
};

describe("buildReviewPrompt profiles", () => {
  it("defaults to the strict profile", () => {
    const prompt = buildReviewPrompt(base);
    expect(prompt).toContain("Review mode: strict — full review.");
    expect(prompt).toContain("Judge correctness, security, data loss");
    expect(prompt).not.toContain("merge-blocking problems");
  });

  it("light profile narrows the verdict to merge-stoppers", () => {
    const prompt = buildReviewPrompt({ ...base, profile: "light" });
    expect(prompt).toContain("Review mode: light — only merge-blocking problems count.");
    expect(prompt).toContain("merge-blocking problems");
    expect(prompt).toContain("REJECT only for blocker severity");
    expect(prompt).not.toContain("Ignore style nits.");
  });

  it("injects route instructions before the rules", () => {
    const prompt = buildReviewPrompt({ ...base, instructions: ["watch auth bypass", "check crypto use"] });
    const instrIdx = prompt.indexOf("Additional instructions for this path:");
    const rulesIdx = prompt.indexOf("Rules:");
    expect(instrIdx).toBeGreaterThan(-1);
    expect(instrIdx).toBeLessThan(rulesIdx);
    expect(prompt).toContain("- watch auth bypass");
    expect(prompt).toContain("- check crypto use");
  });

  it("skips blank instructions", () => {
    const prompt = buildReviewPrompt({ ...base, instructions: ["  ", ""] });
    expect(prompt).not.toContain("Additional instructions");
  });

  it("contested mode relays the prior rejection and demands verification", () => {
    const prompt = buildReviewPrompt({
      ...base,
      contested: {
        reviewer: "judge",
        summary: "it breaks everything",
        findings: [{ file: "src/a.ts", line: 2, severity: "blocker", message: "npe on x" }],
      },
    });
    expect(prompt).toContain('Another referee ("judge") already REJECTED');
    expect(prompt).toContain("it breaks everything");
    expect(prompt).toContain("- [blocker] src/a.ts:2: npe on x");
    expect(prompt).toContain("APPROVE if the rejection is wrong");
  });
});

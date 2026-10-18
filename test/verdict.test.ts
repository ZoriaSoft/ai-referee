import { describe, expect, it } from "vitest";
import { parseVerdict, VerdictParseError } from "../src/verdict.js";

const OK = { verdict: "APPROVE", summary: "fine", findings: [] };

describe("parseVerdict", () => {
  it("parses a bare JSON object", () => {
    expect(parseVerdict(JSON.stringify(OK))).toEqual({
      verdict: "APPROVE",
      summary: "fine",
      findings: [],
    });
  });

  it("parses a fenced json block", () => {
    const out = `Here is my review:\n\`\`\`json\n${JSON.stringify({ verdict: "REJECT", summary: "bad", findings: [] })}\n\`\`\`\nDone.`;
    expect(parseVerdict(out).verdict).toBe("REJECT");
  });

  it("parses a generic fenced block", () => {
    const out = "```\n" + JSON.stringify(OK) + "\n```";
    expect(parseVerdict(out).verdict).toBe("APPROVE");
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const out = `I reviewed the diff carefully. Verdict: ${JSON.stringify(OK)} That is all.`;
    expect(parseVerdict(out).verdict).toBe("APPROVE");
  });

  it("prefers the last object when the model repeats itself", () => {
    const first = JSON.stringify({ verdict: "APPROVE", summary: "a", findings: [] });
    const last = JSON.stringify({ verdict: "REJECT", summary: "b", findings: [] });
    expect(parseVerdict(`${first}\nactually wait\n${last}`).summary).toBe("b");
  });

  it("accepts trailing commas and comments", () => {
    const out = `{
      "verdict": "APPROVE", // looks fine
      "summary": "ok",
      "findings": [],
    }`;
    expect(parseVerdict(out).verdict).toBe("APPROVE");
  });

  it("normalizes verdict synonyms", () => {
    for (const [input, expected] of [
      ["approve", "APPROVE"],
      ["LGTM", "APPROVE"],
      ["request_changes", "REJECT"],
      ["CHANGES REQUESTED", "REJECT"],
      ["fail", "REJECT"],
    ] as const) {
      expect(parseVerdict(`{"verdict":"${input}","summary":"x","findings":[]}`).verdict).toBe(expected);
    }
  });

  it("drops malformed findings but keeps valid ones", () => {
    const out = {
      verdict: "REJECT",
      summary: "issues",
      findings: [
        { file: "a.ts", line: 3, severity: "blocker", message: "sql injection" },
        { file: "b.ts" }, // no message — dropped
        "garbage",
        { file: "c.ts", line: "9", severity: "weird", message: "off-by-one" },
      ],
    };
    const parsed = parseVerdict(JSON.stringify(out));
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]!.severity).toBe("blocker");
    // string line and unknown severity are sanitized
    expect(parsed.findings[1]!.line).toBeNull();
    expect(parsed.findings[1]!.severity).toBe("minor");
  });

  it("rejects empty output", () => {
    expect(() => parseVerdict("")).toThrow(VerdictParseError);
    expect(() => parseVerdict("   ")).toThrow(VerdictParseError);
  });

  it("rejects output with no verdict field", () => {
    expect(() => parseVerdict(`{"summary":"x","findings":[]}`)).toThrow(VerdictParseError);
  });

  it("rejects unknown verdict strings — fail closed", () => {
    for (const v of ["COMMENT", "MAYBE", "looks good to me", ""]) {
      expect(() => parseVerdict(`{"verdict":"${v}","summary":"x","findings":[]}`)).toThrow(VerdictParseError);
    }
  });

  it("rejects a JSON array payload", () => {
    expect(() => parseVerdict(`[{"verdict":"APPROVE"}]`)).toThrow(VerdictParseError);
  });

  it("rejects pure prose", () => {
    expect(() => parseVerdict("The code looks fine, ship it!")).toThrow(VerdictParseError);
  });

  it("handles findings with braces inside strings", () => {
    const out = `{"verdict":"REJECT","summary":"x","findings":[{"file":"a.ts","line":1,"severity":"major","message":"missing } brace in template"}]}`;
    expect(parseVerdict(out).findings[0]!.message).toContain("}");
  });

  it("defaults missing summary to empty string", () => {
    expect(parseVerdict(`{"verdict":"APPROVE"}`).summary).toBe("");
  });
});

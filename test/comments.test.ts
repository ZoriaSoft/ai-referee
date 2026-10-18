import { describe, expect, it } from "vitest";
import { anchorLine, buildPrReview } from "../src/comments.js";
import { parseDiff } from "../src/diff.js";
import type { Finding, GateReport } from "../src/types.js";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 keep
-old
+new
+added
 ctx
@@ -10,2 +11,3 @@
 x
+y
 z
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 666..000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-bye2
`;

const files = parseDiff(PATCH);

function report(findings: Finding[], verdict: "APPROVE" | "REJECT" = "REJECT"): GateReport {
  return {
    tool: "ai-referee",
    version: "0.1.0",
    generatedAt: "2026-10-18T00:00:00Z",
    target: { kind: "pr", base: "origin/main", head: "abc123def456", pr: 7 },
    stats: { filesChanged: 2, insertions: 4, deletions: 3, chunks: 1 },
    tests: { ran: false, command: null, passed: true, outputTail: "" },
    verdict,
    summary: "found issues",
    findings,
    chunks: [],
    reasons: verdict === "REJECT" ? ["reviewer rejected"] : [],
    warnings: [],
    fix: { requested: false, ran: false, detail: null },
    comments: { requested: true, posted: false, detail: null },
  };
}

const finding = (file: string, line: number | null, severity: Finding["severity"] = "major"): Finding => ({
  file,
  line,
  severity,
  message: `problem in ${file}`,
});

describe("anchorLine", () => {
  it("anchors findings on added and context lines", () => {
    expect(anchorLine(finding("src/a.ts", 2), files)).toBe(2); // +new
    expect(anchorLine(finding("src/a.ts", 4), files)).toBe(4); // context ctx
    expect(anchorLine(finding("src/a.ts", 11), files)).toBe(11); // second hunk
  });

  it("rejects lines outside the diff", () => {
    expect(anchorLine(finding("src/a.ts", 99), files)).toBeNull();
    expect(anchorLine(finding("src/a.ts", null), files)).toBeNull();
    expect(anchorLine(finding("src/a.ts", 0), files)).toBeNull();
    expect(anchorLine(finding("src/a.ts", 2.5), files)).toBeNull();
  });

  it("rejects findings on files absent from or deleted in the diff", () => {
    expect(anchorLine(finding("src/other.ts", 1), files)).toBeNull();
    expect(anchorLine(finding("src/gone.ts", 1), files)).toBeNull();
  });

  it("rescues a unique suffix match but not an ambiguous one", () => {
    expect(anchorLine(finding("a.ts", 2), files)).toBe(2); // unique: src/a.ts
    const dup = parseDiff(PATCH + PATCH.replaceAll("src/a.ts", "lib/a.ts"));
    expect(anchorLine(finding("a.ts", 2), dup)).toBeNull(); // ambiguous
  });
});

describe("buildPrReview", () => {
  it("maps REJECT to REQUEST_CHANGES with anchored inline comments", () => {
    const r = buildPrReview(report([finding("src/a.ts", 2, "blocker")]), files);
    expect(r.event).toBe("REQUEST_CHANGES");
    expect(r.commit_id).toBe("abc123def456");
    expect(r.comments).toEqual([
      { path: "src/a.ts", line: 2, side: "RIGHT", body: expect.stringContaining("BLOCKER") },
    ]);
  });

  it("maps APPROVE to the APPROVE event", () => {
    const r = buildPrReview(report([], "APPROVE"), files);
    expect(r.event).toBe("APPROVE");
    expect(r.comments).toEqual([]);
  });

  it("moves unanchorable findings into the review body", () => {
    const r = buildPrReview(
      report([finding("src/a.ts", 2), finding("src/missing.ts", 5), finding("src/a.ts", 77)]),
      files,
    );
    expect(r.comments).toHaveLength(1);
    expect(r.body).toContain("Findings without a diff anchor");
    expect(r.body).toContain("src/missing.ts:5");
    expect(r.body).toContain("src/a.ts:77");
  });

  it("includes the verdict, summary and gate reasons in the body", () => {
    const r = buildPrReview(report([]), files);
    expect(r.body).toContain("REJECTED");
    expect(r.body).toContain("found issues");
    expect(r.body).toContain("reviewer rejected");
  });

  it("caps inline comments and overflows the rest into the body", () => {
    const many = Array.from({ length: 55 }, () => finding("src/a.ts", 2));
    const r = buildPrReview(report(many), files);
    expect(r.comments).toHaveLength(50);
    expect(r.body).toContain("Findings without a diff anchor");
  });
});

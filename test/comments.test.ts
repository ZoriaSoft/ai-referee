import { describe, expect, it } from "vitest";
import { anchorLine, anchorRange, buildPrReviewSet } from "../src/comments.js";
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
    status: { requested: false, state: null, detail: null },
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

describe("anchorRange", () => {
  const ranged = (file: string, startLine: number | null, line: number | null): Finding => ({
    file,
    line,
    startLine,
    severity: "major",
    message: "range problem",
  });

  it("keeps range starts that are diff lines strictly before the anchor", () => {
    expect(anchorRange(ranged("src/a.ts", 2, 4), files)).toEqual({ line: 4, start: 2 });
    expect(anchorRange(ranged("src/a.ts", 2, 11), files)).toEqual({ line: 11, start: 2 }); // across hunks
  });

  it("degrades to a single-line comment when the start misses the diff", () => {
    expect(anchorRange(ranged("src/a.ts", 9, 11), files)).toEqual({ line: 11, start: null });
    expect(anchorRange(ranged("src/a.ts", 11, 11), files)).toEqual({ line: 11, start: null });
    expect(anchorRange(ranged("src/a.ts", 12, 11), files)).toEqual({ line: 11, start: null });
  });

  it("refuses to anchor at all when the end line misses the diff", () => {
    expect(anchorRange(ranged("src/a.ts", 1, 99), files)).toBeNull();
    expect(anchorRange(ranged("src/a.ts", null, null), files)).toBeNull();
    expect(anchorRange(ranged("src/other.ts", 1, 2), files)).toBeNull();
  });
});

describe("buildPrReviewSet", () => {
  it("maps REJECT to REQUEST_CHANGES with anchored inline comments", () => {
    const { payload, fileComments } = buildPrReviewSet(report([finding("src/a.ts", 2, "blocker")]), files);
    expect(payload.event).toBe("REQUEST_CHANGES");
    expect(payload.commit_id).toBe("abc123def456");
    expect(payload.comments).toEqual([
      { path: "src/a.ts", line: 2, side: "RIGHT", body: expect.stringContaining("BLOCKER") },
    ]);
    expect(fileComments).toEqual([]);
  });

  it("posts start_line+start_side for findings spanning diff lines", () => {
    const f: Finding = { file: "src/a.ts", line: 4, startLine: 2, severity: "major", message: "spans" };
    const { payload } = buildPrReviewSet(report([f]), files);
    expect(payload.comments).toEqual([
      {
        path: "src/a.ts",
        line: 4,
        side: "RIGHT",
        start_line: 2,
        start_side: "RIGHT",
        body: expect.stringContaining("spans"),
      },
    ]);
  });

  it("maps APPROVE to the APPROVE event", () => {
    const { payload } = buildPrReviewSet(report([], "APPROVE"), files);
    expect(payload.event).toBe("APPROVE");
    expect(payload.comments).toEqual([]);
  });

  it("file-anchors findings on a changed file whose line misses the diff", () => {
    const { payload, fileComments } = buildPrReviewSet(
      report([finding("src/a.ts", 2), finding("src/a.ts", 77), finding("src/a.ts", null)]),
      files,
    );
    expect(payload.comments).toHaveLength(1); // line 2 anchors inline
    expect(fileComments).toHaveLength(2); // 77 and null anchor to the file
    expect(fileComments[0]).toMatchObject({ path: "src/a.ts" });
    expect(fileComments[0]!.body).toContain("src/a.ts:77");
    expect(payload.body).not.toContain("Findings without a diff anchor");
  });

  it("keeps file-level comments off deleted files and unknown paths", () => {
    const { payload, fileComments } = buildPrReviewSet(
      report([finding("src/gone.ts", null), finding("src/missing.ts", 5)]),
      files,
    );
    expect(fileComments).toHaveLength(0);
    expect(payload.body).toContain("Findings without a diff anchor");
    expect(payload.body).toContain("src/missing.ts:5");
    expect(payload.body).toContain("src/gone.ts");
  });

  it("includes the verdict, summary and gate reasons in the body", () => {
    const { payload } = buildPrReviewSet(report([]), files);
    expect(payload.body).toContain("REJECTED");
    expect(payload.body).toContain("found issues");
    expect(payload.body).toContain("reviewer rejected");
  });

  it("caps inline comments; overflow becomes file-level comments", () => {
    const many = Array.from({ length: 55 }, () => finding("src/a.ts", 2));
    const { payload, fileComments } = buildPrReviewSet(report(many), files);
    expect(payload.comments).toHaveLength(50);
    expect(fileComments.length).toBeGreaterThan(0);
  });
});

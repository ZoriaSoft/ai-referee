import { describe, expect, it } from "vitest";
import { chunkDiff, globMatch, parseDiff } from "../src/diff.js";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line
-old
+new
+added
 context
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/img.png b/img.png
index 444..555 100644
Binary files a/img.png and b/img.png differ
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 666..000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-bye2
`;

describe("parseDiff", () => {
  it("splits a multi-file diff into per-file blocks", () => {
    const files = parseDiff(SAMPLE);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "img.png", "src/gone.ts"]);
  });

  it("counts insertions and deletions, ignoring +++/--- headers", () => {
    const [a, b] = parseDiff(SAMPLE);
    expect(a!.insertions).toBe(2);
    expect(a!.deletions).toBe(1);
    expect(b!.insertions).toBe(2);
    expect(b!.deletions).toBe(0);
  });

  it("flags binary, new and deleted files", () => {
    const files = parseDiff(SAMPLE);
    expect(files[2]!.isBinary).toBe(true);
    expect(files[1]!.isNew).toBe(true);
    expect(files[3]!.isDeleted).toBe(true);
  });

  it("returns empty array for empty diff", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("no diff here")).toEqual([]);
  });

  it("uses the b/ path for renames", () => {
    const diff = `diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n`;
    expect(parseDiff(diff)[0]!.path).toBe("new.ts");
  });
});

describe("globMatch", () => {
  it("matches star patterns", () => {
    expect(globMatch("*.lock", "b/lockfile.lock")).toBe(false); // * doesn't cross /
    expect(globMatch("*.lock", "a.lock")).toBe(true);
    expect(globMatch("dist/**", "dist/a/b/c.js")).toBe(true);
    expect(globMatch("**/test/**", "x/test/y.ts")).toBe(true);
    expect(globMatch("*.snap", "x.snap")).toBe(true);
    expect(globMatch("*.ts", "a.js")).toBe(false);
  });
});

describe("chunkDiff", () => {
  const mkFile = (path: string, size: number) => ({
    path,
    patch: `diff --git a/${path} b/${path}\n${"x".repeat(size)}`,
    insertions: 0,
    deletions: 0,
    isBinary: false,
    isDeleted: false,
    isNew: false,
    rightLines: new Set<number>(),
  });

  it("packs small files into one chunk under budget", () => {
    const files = [mkFile("a", 100), mkFile("b", 100), mkFile("c", 100)];
    const chunks = chunkDiff(files, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.files.map((f) => f.path)).toEqual(["a", "b", "c"]);
    expect(chunks[0]!.truncated).toBe(false);
  });

  it("splits when the next file exceeds the remaining budget", () => {
    const files = [mkFile("a", 400), mkFile("b", 400), mkFile("c", 400)];
    const chunks = chunkDiff(files, 500);
    expect(chunks).toHaveLength(3);
  });

  it("emits an oversized file alone, truncated with a marker", () => {
    const files = [mkFile("huge", 10_000)];
    const chunks = chunkDiff(files, 1_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.truncated).toBe(true);
    expect(chunks[0]!.patch.length).toBeLessThanOrEqual(1_100);
    expect(chunks[0]!.patch).toContain("remainder omitted");
  });

  it("never merges an oversized file with its neighbor", () => {
    const files = [mkFile("small", 100), mkFile("huge", 10_000), mkFile("small2", 100)];
    const chunks = chunkDiff(files, 1_000);
    expect(chunks).toHaveLength(3);
    expect(chunks[1]!.truncated).toBe(true);
    expect(chunks[0]!.files[0]!.path).toBe("small");
    expect(chunks[2]!.files[0]!.path).toBe("small2");
  });

  it("assigns sequential indexes", () => {
    const files = [mkFile("a", 400), mkFile("b", 400), mkFile("c", 400)];
    expect(chunkDiff(files, 500).map((c) => c.index)).toEqual([0, 1, 2]);
  });
});

describe("parseDiff rightLines", () => {
  it("maps added and context lines to new-side line numbers", () => {
    const files = parseDiff(SAMPLE);
    const a = files.find((f) => f.path === "src/a.ts")!;
    // Hunk @@ -1,3 +1,4 @@: context 1, +new 2, +added 3, context 4.
    expect([...a.rightLines].sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
  });

  it("keeps numbering across multiple hunks", () => {
    const patch = `diff --git a/f.ts b/f.ts
index 1..2 100644
--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,3 @@
 a
+b
 c
@@ -5,3 +6,3 @@
 d
-e
+e2
 f
`;
    const f = parseDiff(patch)[0]!;
    expect([...f.rightLines].sort((x, y) => x - y)).toEqual([1, 2, 3, 6, 7, 8]);
  });

  it("leaves rightLines empty for deleted and binary files", () => {
    const files = parseDiff(SAMPLE);
    expect(files.find((f) => f.path === "src/gone.ts")!.rightLines.size).toBe(0);
    expect(files.find((f) => f.path === "img.png")!.rightLines.size).toBe(0);
  });
});

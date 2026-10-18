export interface FileDiff {
  path: string;
  /** Full raw patch text for this file (headers + hunks). */
  patch: string;
  insertions: number;
  deletions: number;
  isBinary: boolean;
  isDeleted: boolean;
  isNew: boolean;
  /**
   * New-side (RIGHT) line numbers visible in the diff: added lines plus
   * context lines inside hunks. GitHub accepts inline review comments only
   * on these; empty for binary and deleted files.
   */
  rightLines: Set<number>;
}

const FILE_HEADER = /^diff --git a\/.+? b\/(.+)$/;

/**
 * Splits a unified `git diff`/`git show` patch into per-file blocks.
 * Renames use the `b/` path. Text before the first `diff --git` is dropped.
 */
export function parseDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: { path: string; lines: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const text = current.lines.join("\n");
    let insertions = 0;
    let deletions = 0;
    const rightLines = new Set<number>();
    let newLine = 0;
    let inHunk = false;
    for (const line of current.lines) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        newLine = Number.parseInt(hunk[1]!, 10);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith("+")) {
        if (!line.startsWith("+++")) {
          insertions++;
          rightLines.add(newLine);
          newLine++;
        }
      } else if (line.startsWith("-")) {
        if (!line.startsWith("---")) deletions++;
        // '-' consumes an old-side line only; newLine is unchanged.
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file" — consumes no line number.
      } else if (line.startsWith(" ")) {
        // Context line: present on both sides. Anything else (empty
        // trailing lines, junk) consumes no line number.
        rightLines.add(newLine);
        newLine++;
      }
    }
    files.push({
      path: current.path,
      patch: text,
      insertions,
      deletions,
      isBinary: current.lines.some((l) => l.startsWith("Binary files") || l.startsWith("GIT binary patch")),
      isDeleted: current.lines.some((l) => l.startsWith("deleted file mode")),
      isNew: current.lines.some((l) => l.startsWith("new file mode")),
      rightLines,
    });
    current = null;
  };

  for (const line of patch.split("\n")) {
    const m = FILE_HEADER.exec(line);
    if (m) {
      flush();
      current = { path: m[1]!, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return files;
}

/** Minimal glob matcher: `*` any-run, `?` single char, `**` crosses `/`. */
export function globMatch(pattern: string, path: string): boolean {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++; // `**/` also matches zero dirs
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(re + "$").test(path);
}

export interface DiffChunk {
  index: number;
  files: FileDiff[];
  patch: string;
  /** True when a single file had to be cut mid-hunk to fit the budget. */
  truncated: boolean;
}

/**
 * Groups file diffs into chunks under `budget` chars, preserving file order.
 * A file larger than the budget is emitted alone and marked truncated — its
 * patch is cut at the last complete hunk boundary that fits, with a notice.
 */
export function chunkDiff(files: FileDiff[], budget: number): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let pending: FileDiff[] = [];
  let size = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    chunks.push({
      index: chunks.length,
      files: pending,
      patch: pending.map((f) => f.patch).join("\n"),
      truncated: false,
    });
    pending = [];
    size = 0;
  };

  for (const file of files) {
    if (file.patch.length > budget) {
      flush();
      chunks.push({
        index: chunks.length,
        files: [file],
        patch: cutAtHunkBoundary(file.patch, budget),
        truncated: true,
      });
      continue;
    }
    if (size + file.patch.length + 1 > budget && pending.length > 0) flush();
    pending.push(file);
    size += file.patch.length + 1;
  }
  flush();
  return chunks;
}

/** Cuts at the last complete line under the budget and appends a notice. */
function cutAtHunkBoundary(patch: string, budget: number): string {
  const marker = "\n[... file too large: remainder omitted for review ...]\n";
  if (patch.length <= budget) return patch;
  const limit = Math.max(0, budget - marker.length);
  const lastNewline = patch.lastIndexOf("\n", limit);
  return patch.slice(0, lastNewline > 0 ? lastNewline : limit) + marker;
}

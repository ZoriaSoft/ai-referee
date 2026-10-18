import type { FileDiff } from "./diff.js";
import type { Finding, GateReport } from "./types.js";

/** One inline comment in a GitHub PR review (line = new-file line number). */
export interface PrReviewComment {
  path: string;
  /** Anchor (right-side) line — the last line of a range comment. */
  line: number;
  side: "RIGHT";
  /** First line when the comment spans a range; requires start_side. */
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface PrReviewPayload {
  commit_id: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments: PrReviewComment[];
}

/** GitHub rejects reviews with too many inline comments; rest go to the body. */
const MAX_INLINE_COMMENTS = 50;

/** HTML marker embedded in posted review bodies — identifies reviews ai-referee
 *  owns, so stale CHANGES_REQUESTED reviews can be dismissed safely. */
export const REVIEW_MARKER = "<!-- ai-referee:review -->";

const SEVERITY_LABEL: Record<string, string> = {
  blocker: "BLOCKER",
  major: "MAJOR",
  minor: "MINOR",
  info: "INFO",
};

function findingBody(f: Finding): string {
  const label = SEVERITY_LABEL[f.severity] ?? f.severity.toUpperCase();
  const head = `**[${label}]** ${f.message}`;
  return f.suggestion ? `${head}\n\n_hint: ${f.suggestion}_` : head;
}

/** `file:start-line` when a finding spans a range, `file:line`, else `file`. */
function findingLoc(f: Finding): string {
  if (f.line === null) return f.file;
  return f.startLine ? `${f.file}:${f.startLine}-${f.line}` : `${f.file}:${f.line}`;
}

/** The diff file a finding anchors to: exact path, else unique suffix; never deleted/binary. */
function anchorableFile(f: Finding, files: FileDiff[]): FileDiff | null {
  let file = files.find((d) => d.path === f.file);
  if (!file) {
    const suffix = files.filter((d) => d.path.endsWith(`/${f.file}`) || f.file.endsWith(`/${d.path}`));
    if (suffix.length === 1) file = suffix[0]!;
  }
  return file && !file.isDeleted && !file.isBinary ? file : null;
}

/**
 * Anchors a finding to the new-file lines GitHub accepts for an inline
 * comment. The anchor `line` must always be in the diff; `start` is kept
 * only when it too is a diff line strictly before `line` — a range whose
 * start GitHub rejects degrades to a single-line comment.
 * Returns null when the finding cannot anchor at all (wrong file, line
 * outside the diff, ambiguity).
 */
export function anchorRange(f: Finding, files: FileDiff[]): { line: number; start: number | null } | null {
  if (f.line === null || !Number.isInteger(f.line) || f.line <= 0) return null;
  const file = anchorableFile(f, files);
  if (!file || !file.rightLines.has(f.line)) return null;
  const start =
    f.startLine != null && Number.isInteger(f.startLine) && f.startLine > 0 && f.startLine < f.line && file.rightLines.has(f.startLine)
      ? f.startLine
      : null;
  return { line: f.line, start };
}

/**
 * Anchors a finding to a new-file line that GitHub accepts for an inline
 * comment. Kept for single-line callers; see anchorRange for range support.
 */
export function anchorLine(f: Finding, files: FileDiff[]): number | null {
  return anchorRange(f, files)?.line ?? null;
}

/** One file-level PR review comment, posted via POST /pulls/{n}/comments. */
export interface PrFileComment {
  path: string;
  body: string;
}

export interface PrReviewSet {
  /** Payload for POST /pulls/{n}/reviews (event + line-anchored comments). */
  payload: PrReviewPayload;
  /** File-level comments GitHub rejects inside reviews — posted separately. */
  fileComments: PrFileComment[];
}

/** Separate POSTs for file-level comments stay cheap; the rest go to the body. */
const MAX_FILE_COMMENTS = 20;

/**
 * True when a finding's path resolves to a file in the diff unambiguously —
 * the bar for a subject_type:"file" comment (higher than inline anchoring).
 */
function resolveFile(f: Finding, files: FileDiff[]): FileDiff | null {
  const exact = files.find((d) => d.path === f.file);
  if (exact) return exact;
  const suffix = files.filter((d) => d.path.endsWith(`/${f.file}`) || f.file.endsWith(`/${d.path}`));
  return suffix.length === 1 ? suffix[0]! : null;
}

/**
 * Builds everything posted to a PR: the review payload plus file-level
 * comments for findings that cannot anchor to a diff line but do resolve to
 * a changed file. GitHub's bulk review endpoint has no file-level comments
 * (subject_type is only on POST /pulls/{n}/comments), so those post separately.
 * Findings that match no file at all go to the review body — a comment on the
 * wrong file is worse than one in the body.
 */
export function buildPrReviewSet(report: GateReport, files: FileDiff[]): PrReviewSet {
  const comments: PrReviewComment[] = [];
  const fileComments: PrFileComment[] = [];
  const unanchored: Finding[] = [];

  for (const f of report.findings) {
    const anchor = anchorRange(f, files);
    if (anchor !== null && comments.length < MAX_INLINE_COMMENTS) {
      comments.push({
        path: filePathFor(f, files),
        line: anchor.line,
        side: "RIGHT",
        ...(anchor.start !== null ? { start_line: anchor.start, start_side: "RIGHT" as const } : {}),
        body: findingBody(f),
      });
      continue;
    }
    const file = resolveFile(f, files);
    if (file !== null && !file.isDeleted && !file.isBinary && fileComments.length < MAX_FILE_COMMENTS) {
      fileComments.push({ path: file.path, body: `${findingBody(f)}\n\n_\`${findingLoc(f)}\`_` });
      continue;
    }
    unanchored.push(f);
  }

  const sha = report.target.head.replace(/\s+\(worktree\)$/, "").slice(0, 10);
  const body: string[] = [
    `**ai-referee: ${report.verdict === "APPROVE" ? "APPROVED" : "REJECTED"}** \`${sha}\``,
    REVIEW_MARKER,
    "",
    report.summary,
  ];
  if (report.tests.ran) {
    body.push("", `Tests: ${report.tests.passed ? "passed" : "FAILED"} — \`${report.tests.command}\``);
  }
  if (report.reasons.length) {
    body.push("", "Gate reasons:", ...report.reasons.map((r) => `- ${r}`));
  }
  if (unanchored.length) {
    body.push("", "Findings without a diff anchor:");
    for (const f of unanchored) {
      body.push(`- **${SEVERITY_LABEL[f.severity] ?? f.severity.toUpperCase()}** \`${findingLoc(f)}\` — ${f.message}`);
    }
  }


  return {
    payload: {
      commit_id: report.target.head,
      event: report.verdict === "APPROVE" ? "APPROVE" : "REQUEST_CHANGES",
      body: body.join("\n"),
      comments,
    },
    fileComments,
  };
}

/** Resolves the diff path a finding anchors to (exact or unique suffix). */
function filePathFor(f: Finding, files: FileDiff[]): string {
  if (files.some((d) => d.path === f.file)) return f.file;
  const suffix = files.filter((d) => d.path.endsWith(`/${f.file}`) || f.file.endsWith(`/${d.path}`));
  return suffix.length === 1 ? suffix[0]!.path : f.file;
}

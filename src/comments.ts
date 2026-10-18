import type { FileDiff } from "./diff.js";
import type { Finding, GateReport } from "./types.js";

/** One inline comment in a GitHub PR review (line = new-file line number). */
export interface PrReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
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

/**
 * Anchors a finding to a new-file line that GitHub accepts for an inline
 * comment. Exact-path match preferred; a unique path-suffix match rescues
 * findings where the model abbreviated the path. Returns null when the
 * finding cannot be anchored (wrong file, line outside the diff, ambiguity).
 */
export function anchorLine(f: Finding, files: FileDiff[]): number | null {
  if (f.line === null || !Number.isInteger(f.line) || f.line <= 0) return null;
  let file = files.find((d) => d.path === f.file);
  if (!file) {
    const suffix = files.filter((d) => d.path.endsWith(`/${f.file}`) || f.file.endsWith(`/${d.path}`));
    if (suffix.length === 1) file = suffix[0]!;
  }
  if (!file || file.isDeleted || file.isBinary) return null;
  return file.rightLines.has(f.line) ? f.line : null;
}

/**
 * Builds the GitHub `POST /pulls/{n}/reviews` payload: the gate verdict as
 * the review event, findings anchored to diff lines as inline comments, and
 * everything unanchorable listed in the review body instead — a comment
 * pinned to the wrong line is worse than one in the body.
 */
export function buildPrReview(
  report: GateReport,
  files: FileDiff[],
): PrReviewPayload {
  const comments: PrReviewComment[] = [];
  const unanchored: Finding[] = [];

  for (const f of report.findings) {
    const line = anchorLine(f, files);
    if (line !== null && comments.length < MAX_INLINE_COMMENTS) {
      comments.push({ path: filePathFor(f, files), line, side: "RIGHT", body: findingBody(f) });
    } else {
      unanchored.push(f);
    }
  }

  const sha = report.target.head.replace(/\s+\(worktree\)$/, "").slice(0, 10);
  const body: string[] = [
    `**ai-referee: ${report.verdict === "APPROVE" ? "APPROVED" : "REJECTED"}** \`${sha}\``,
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
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      body.push(`- **${SEVERITY_LABEL[f.severity] ?? f.severity.toUpperCase()}** \`${loc}\` — ${f.message}`);
    }
  }

  return {
    commit_id: report.target.head,
    event: report.verdict === "APPROVE" ? "APPROVE" : "REQUEST_CHANGES",
    body: body.join("\n"),
    comments,
  };
}

/** Resolves the diff path a finding anchors to (exact or unique suffix). */
function filePathFor(f: Finding, files: FileDiff[]): string {
  if (files.some((d) => d.path === f.file)) return f.file;
  const suffix = files.filter((d) => d.path.endsWith(`/${f.file}`) || f.file.endsWith(`/${d.path}`));
  return suffix.length === 1 ? suffix[0]!.path : f.file;
}

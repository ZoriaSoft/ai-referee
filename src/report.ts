import type { GateReport } from "./types.js";

const SEVERITY_BADGE: Record<string, string> = {
  blocker: "BLOCKER",
  major: "MAJOR",
  minor: "MINOR",
  info: "INFO",
};

export function toJson(report: GateReport): string {
  return JSON.stringify(report, null, 2);
}

export function toMarkdown(report: GateReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.verdict === "APPROVE" ? "APPROVED" : "REJECTED"} — ai-referee`);
  lines.push("");
  lines.push(
    `**Target:** ${report.target.kind === "pr" ? `PR #${report.target.pr}` : "local"} ` +
      `\`${report.target.base}…${report.target.head}\``,
  );
  lines.push(
    `**Diff:** ${report.stats.filesChanged} files, +${report.stats.insertions}/-${report.stats.deletions}, ` +
      `${report.stats.chunks} chunk(s)`,
  );
  if (report.tests.ran) {
    lines.push(
      `**Tests:** ${report.tests.passed ? "passed" : "FAILED"} — \`${report.tests.command}\``,
    );
  } else {
    lines.push(`**Tests:** ${report.tests.command ? "skipped" : "not configured"}`);
  }
  if (report.stats.tokens) {
    const t = report.stats.tokens;
    lines.push(`**Tokens:** ${t.total.toLocaleString("en-US")} total (${t.prompt} prompt / ${t.completion} completion)`);
  }
  if (report.comments.requested) {
    lines.push(`**PR review:** ${report.comments.posted ? "posted" : "FAILED"} — ${report.comments.detail ?? ""}`);
  }
  lines.push("");
  lines.push(`**Summary:** ${report.summary}`);

  if (report.reasons.length) {
    lines.push("", "## Gate reasons", "");
    for (const r of report.reasons) lines.push(`- ${r}`);
  }

  if (report.findings.length) {
    lines.push("", "## Findings", "");
    for (const f of report.findings) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`- **${SEVERITY_BADGE[f.severity] ?? f.severity.toUpperCase()}** \`${loc}\` — ${f.message}`);
      if (f.suggestion) lines.push(`  - hint: ${f.suggestion}`);
    }
  }

  const routed = report.chunks.some((c) => c.route !== null || c.profile !== "strict");
  const attempts = report.chunks.flatMap((c) =>
    c.attempts.map((a) => ({ chunk: c.index + 1, route: c.route, profile: c.profile, ...a })),
  );
  if (attempts.length) {
    lines.push("", "## Referee log", "");
    lines.push(routed ? "| chunk | route | referee | result | ms | detail |" : "| chunk | referee | result | ms | detail |");
    lines.push(routed ? "|---|---|---|---|---|---|" : "|---|---|---|---|---|");
    for (const a of attempts) {
      const routeCell = [a.route ?? "", a.profile !== "strict" ? `(${a.profile})` : ""].filter(Boolean).join(" ");
      const cells = routed
        ? [a.chunk, routeCell || "—", a.reviewer, a.ok ? "answered" : "failed", a.durationMs, a.detail]
        : [a.chunk, a.reviewer, a.ok ? "answered" : "failed", a.durationMs, a.detail];
      lines.push(`| ${cells.map((c) => String(c).replaceAll("|", "\\|")).join(" | ")} |`);
    }
  }

  if (report.tests.ran && !report.tests.passed && report.tests.outputTail) {
    lines.push("", "## Test output (tail)", "", "```", report.tests.outputTail, "```");
  }

  if (report.fix.ran) {
    lines.push("", "## Fix round", "", report.fix.detail ?? "ran");
  }

  lines.push("");
  return lines.join("\n");
}

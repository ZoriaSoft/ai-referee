const VERDICT_SCHEMA = `{
  "verdict": "APPROVE" | "REJECT",
  "summary": "one short paragraph: what this diff does and why it is or isn't safe to merge",
  "findings": [
    {
      "file": "path/from/repo/root",
      "line": 123,
      "severity": "blocker" | "major" | "minor" | "info",
      "message": "concrete problem, one or two sentences",
      "suggestion": "optional short fix hint"
    }
  ]
}`;

/** Prompt sent to a reviewer for one diff chunk. */
export function buildReviewPrompt(opts: {
  index: number;
  files: string[];
  patch: string;
  truncated: boolean;
  totalChunks: number;
  base: string;
  head: string;
  repoNote: string | null;
}): string {
  const { index, files, patch, truncated, totalChunks, base, head, repoNote } = opts;
  const parts: string[] = [
    "You are a strict code-review referee deciding whether a change may merge.",
    "",
    `Diff under review: ${base}...${head}` +
      (totalChunks > 1 ? ` — chunk ${index + 1}/${totalChunks}` : ""),
    `Files in this chunk: ${files.join(", ")}`,
  ];
  if (repoNote) parts.push("", "Repository context:", repoNote);
  if (truncated) {
    parts.push(
      "",
      "NOTE: at least one file in this chunk was truncated to fit the review budget.",
      "Review what is shown; do not invent findings about omitted lines.",
    );
  }
  parts.push(
    "",
    "Rules:",
    "- Judge correctness, security, data loss, and regression risk. Ignore style nits.",
    "- APPROVE only if you would let this merge without changes.",
    "- REJECT when you find a blocker/major issue you can point to; never reject on a hunch.",
    "- Findings must cite file and (when possible) the new-file line number in the diff.",
    "- Do not request changes outside this diff. Do not praise. Be terse.",
    "",
    "Respond with ONLY a JSON object (no markdown fence, no prose):",
    VERDICT_SCHEMA,
    "",
    "The diff follows:",
    "```diff",
    patch,
    "```",
  );
  return parts.join("\n");
}

/** Follow-up sent when the previous reviewer output failed to parse. */
export function buildParseRetryPrompt(previousError: string): string {
  return (
    `Your previous reply could not be parsed: ${previousError}. ` +
    `Reply again with ONLY the JSON object (no prose, no markdown fence) matching exactly this schema:\n` +
    VERDICT_SCHEMA
  );
}

/** Prompt sent to the fixer CLI after a REJECT, when --fix is enabled. */
export function buildFixPrompt(opts: {
  findingsText: string;
  base: string;
  head: string;
}): string {
  return [
    "A code-review gate rejected the current change. Apply minimal fixes in this",
    "working tree for the findings below. Do not refactor, do not touch unrelated",
    "code, do not commit. Fix only what a finding asks for; skip findings you",
    "believe are wrong and say why on stdout.",
    "",
    `Diff under review: ${opts.base}...${opts.head}`,
    "",
    "Findings:",
    opts.findingsText,
  ].join("\n");
}

/** Short repo context injected into prompts; kept dependency-free on purpose. */
export async function repoNoteSnippet(readme: string | null): Promise<string | null> {
  if (!readme) return null;
  const head = readme.split("\n").slice(0, 40).join("\n").trim();
  return head ? `README excerpt:\n${head.slice(0, 2_000)}` : null;
}

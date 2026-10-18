import { parseLooseJson } from "./loose-json.js";
import type { ChunkVerdict, Finding, Severity, Verdict } from "./types.js";

export class VerdictParseError extends Error {
  /** Where in the output extraction failed, for retry prompts and logs. */
  constructor(message: string) {
    super(message);
    this.name = "VerdictParseError";
  }
}

const SEVERITY_VALUES: Record<string, Severity> = {
  blocker: "blocker",
  major: "major",
  minor: "minor",
  info: "info",
};

/**
 * Extracts and validates the reviewer JSON verdict from raw model output.
 * Tolerates: prose around the JSON, markdown code fences, trailing commas,
 * comments, single extra keys. Rejects anything without a parseable
 * "verdict" of APPROVE/REJECT.
 */
export function parseVerdict(raw: string): ChunkVerdict {
  const text = raw.trim();
  if (!text) throw new VerdictParseError("empty reviewer output");

  for (const candidate of extractJsonCandidates(text)) {
    try {
      return validateVerdict(parseLooseJson(candidate));
    } catch (err) {
      if (err instanceof VerdictParseError) throw err;
      // not this candidate; try the next
    }
  }
  throw new VerdictParseError("no valid verdict JSON found in reviewer output");
}

/**
 * Yields JSON text candidates, most likely first:
 * the whole output → last ```json fence → last fenced block →
 * balanced-brace objects (last first).
 */
function extractJsonCandidates(text: string): string[] {
  const out: string[] = [text];

  const fenceRe = /```(?:json|JSON)?\s*\n([\s\S]*?)```/g;
  const fences: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) fences.push(m[1]!.trim());
  out.push(...fences.reverse());

  out.push(...braceObjects(text).reverse());
  return [...new Set(out)];
}

/** Finds top-level balanced {...} spans, tolerating strings inside. */
function braceObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}

function validateVerdict(parsed: unknown): ChunkVerdict {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new VerdictParseError("verdict payload is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  const verdict = normalizeVerdict(obj.verdict);
  if (!verdict) {
    throw new VerdictParseError(
      `field "verdict" must be "APPROVE" or "REJECT", got ${JSON.stringify(obj.verdict)}`,
    );
  }

  const findings = parseFindings(obj.findings);
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  return { verdict, summary, findings };
}

function normalizeVerdict(v: unknown): Verdict | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase().replace(/[\s_-]+/g, "_");
  if (s === "APPROVE" || s === "APPROVED" || s === "PASS" || s === "LGTM") return "APPROVE";
  if (
    s === "REJECT" || s === "REJECTED" || s === "FAIL" || s === "REQUEST_CHANGES" ||
    s === "CHANGES_REQUESTED" || s === "BLOCK"
  ) {
    return "REJECT";
  }
  return null;
}

function parseFindings(raw: unknown): Finding[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new VerdictParseError(`field "findings" must be an array, got ${typeof raw}`);
  }
  const out: Finding[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const f = item as Record<string, unknown>;
    const message = typeof f.message === "string" ? f.message.trim() : "";
    if (!message) continue; // a finding without a message carries no signal
    const severity: Severity =
      typeof f.severity === "string"
        ? (SEVERITY_VALUES[f.severity.toLowerCase()] ?? "minor")
        : "minor";
    const line =
      typeof f.line === "number" && Number.isFinite(f.line) && f.line > 0
        ? Math.floor(f.line)
        : null;
    const finding: Finding = {
      file: typeof f.file === "string" ? f.file : String(f.file ?? ""),
      line,
      severity,
      message,
    };
    if (typeof f.suggestion === "string" && f.suggestion.trim()) {
      finding.suggestion = f.suggestion.trim();
    }
    out.push(finding);
  }
  return out;
}

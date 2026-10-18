export type Severity = "blocker" | "major" | "minor" | "info";
export type Verdict = "APPROVE" | "REJECT";
/** Review prompt profile — how willing the reviewer is to approve. */
export type ReviewProfile = "strict" | "light";


export interface Finding {
  file: string;
  /** Diff/new-file line number when the model gave one; null when it did not. */
  line: number | null;
  severity: Severity;
  message: string;
  suggestion?: string;
}

/** Validated payload a reviewer must return for one chunk. */
export interface ChunkVerdict {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface ReviewerAttempt {
  reviewer: string;
  ok: boolean;
  /** Short human-readable reason on failure: exit code, timeout, HTTP status. */
  detail: string;
  durationMs: number;
  /** Token counts when an api reviewer reports usage; absent for cli. */
  tokens?: TokenUsage;
  /** "confirm" marks a second-referee call made to check a REJECT verdict. */
  phase?: "confirm";
}

export interface TestResult {
  ran: boolean;
  command: string | null;
  passed: boolean;
  /** Tail of combined output, kept for the report. */
  outputTail: string;
}

/** Per-chunk review outcome after retries. */
export interface ChunkResult {
  index: number;
  files: string[];
  parsed: ChunkVerdict | null;
  /** Set when the chunk could not be reviewed to a valid verdict. */
  failedReason: string | null;
  attempts: ReviewerAttempt[];
  /** 1 = initial review, 2 = re-review after the fix round. */
  round: number;
  /** Prompt profile used for this chunk. */
  profile: ReviewProfile;
  /** Labels of matching routes joined with "+" (e.g. "auth-security"); null when no route matched. */
  route: string | null;
  /** Set when a second referee checked this chunk's REJECT (confirmRejections). */
  confirmation?: {
    /** Reviewer that answered the confirmation prompt; null when nobody did. */
    reviewer: string | null;
    /** Second verdict; null when the check could not produce one. */
    verdict: Verdict | null;
    /** True when the second referee approved — the rejection is overruled. */
    overruled: boolean;
    /** Why the check was inconclusive, when verdict is null. */
    detail?: string;
    findings: Finding[];
  };
}

export interface GateReport {
  tool: "ai-referee";
  version: string;
  generatedAt: string;
  target: {
    kind: "local" | "pr";
    base: string;
    head: string;
    pr?: number;
  };
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    chunks: number;
    /** Summed token usage across api reviewer calls, when reported. */
    tokens?: TokenUsage;
  };
  tests: TestResult;
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  chunks: ChunkResult[];
  /** Human-readable gate reasons for REJECT. */
  reasons: string[];
  /** Non-blocking issues worth surfacing (e.g. light-profile REJECTs without blocker findings). */
  warnings: string[];
  fix: {
    requested: boolean;
    ran: boolean;
    detail: string | null;
  };
  /** Posting findings back to the PR as a GitHub review (PR targets). */
  comments: {
    requested: boolean;
    posted: boolean;
    detail: string | null;
  };
}

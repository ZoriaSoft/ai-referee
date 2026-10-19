import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseLooseJson } from "./loose-json.js";

export const CONFIG_FILENAME = ".ai-referee.json";

export interface ReviewerConfig {
  /** Short identifier used in reports and logs. */
  name: string;
  /** "cli": shell command; "api": OpenAI-compatible chat completions endpoint. */
  type: "cli" | "api";
  /**
   * cli: command line run via `bash -c`. Placeholders:
   *   {prompt}      — full prompt, shell-escaped inline
   *   {prompt_file} — path to a temp file containing the prompt
   * If `stdin` is true (default) the prompt is also piped to stdin.
   * api: e.g. "https://api.example.com/v1/chat/completions" or "http://localhost:11434/v1/chat/completions".
   */
  command?: string;
  url?: string;
  model?: string;
  /** Header name holding the API key. Default "Authorization" with "Bearer " prefix. */
  apiKeyEnv?: string;
  /** Extra request headers for api reviewers. */
  headers?: Record<string, string>;
  /** Send the prompt on stdin for cli reviewers. Default true unless {prompt} or {prompt_file} appears in command. */
  stdin?: boolean;
  /** api only: request response_format {type:"json_object"} — fewer parse failures on compatible endpoints. */
  jsonMode?: boolean;
  timeoutMs?: number;
}

/** Sends files matching globs to a named subset of the reviewer chain. */
export interface RouteConfig {
  /** Report label; defaults to the first glob. */
  name?: string;
  /** Path globs (same syntax as `exclude`); a file matching any glob takes this route. */
  match: string[];
  /** Names from the top-level `reviewers` list; tried in order for matching files. */
  reviewers: string[];
  /** Prompt profile override for this route; defaults to the run profile. */
  profile?: "strict" | "light";
  /** Extra review instructions injected into the prompt for matching files. */
  instructions?: string;
  /** Fixer command for findings on matching files; null disables the fixer. Absent → the global `fixerCommand` applies. */
  fixer?: string | null;
}

export interface Config {
  /** Repo test command run inside the target worktree. Null disables the gate's test step. */
  testCommand: string | null;
  testTimeoutMs: number;
  /** Max chars of diff per review chunk. */
  chunkBudget: number;
  /** Path patterns excluded from review (still counted in stats). */
  exclude: string[];
  reviewers: ReviewerConfig[];
  /** Default prompt profile for unflagged runs; routes may override it. */
  profile: "strict" | "light";
  /** Per-path reviewer routing; files matching no route use the default chain. */
  routes: RouteConfig[];
  /** Command that applies fixes; gets the findings on stdin, cwd = worktree. */
  fixerCommand: string | null;
  fixerTimeoutMs: number;
  /** Merge via `gh pr merge` when PR review approves. Default false. */
  autoMerge: boolean;
  /** Post verdicts + anchored findings as GitHub PR reviews. Default false. */
  prComments: boolean;
  /** Post a commit status (context "ai-referee") on the PR head SHA; branch protection can require it. Default false. */
  commitStatus: boolean;
  /** Chunks reviewed concurrently. Default 2. */
  reviewConcurrency: number;
  /** Max chars of changed-file bodies appended to prompts for context. 0 disables. */
  contextBudget: number;
  /** Seconds between daemon polls. */
  daemonIntervalSec: number;
  /** Open PRs the daemon may review at once. Default 1 (sequential). */
  daemonConcurrency: number;
  /** Verify every REJECT with a second reviewer; an overruled rejection warns instead of blocking. Default false. */
  confirmRejections: boolean;
  /** Working directory for test/fix commands relative to repo root. */
  workdir: string | null;
  /**
   * Require reviewers to echo the per-review nonce in their verdict JSON.
   * Verdict objects without it (e.g. JSON smuggled in through the diff and
   * echoed by the model) are ignored. Default true.
   */
  requireNonce: boolean;
  /**
   * Where cli reviewers run for PR targets: "isolated" (default) — an empty
   * temp dir, so agent CLIs cannot read or execute instruction files from the
   * PR (AGENTS.md, CLAUDE.md, hooks…); "worktree" — inside the PR checkout.
   * Local reviews always run in the repo.
   */
  reviewerWorkdir: "isolated" | "worktree";
  /**
   * PR targets only: pass credential-looking env vars (…TOKEN, …API_KEY,
   * …SECRET, …) to the test command. Default false — tests execute PR code.
   */
  passSecretsToTests: boolean;
}

export const DEFAULT_CONFIG: Config = {
  testCommand: null,
  testTimeoutMs: 10 * 60 * 1000,
  chunkBudget: 100_000,
  exclude: [
    "*.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "dist/**",
    "*.min.js",
    "*.snap",
  ],
  reviewers: [],
  profile: "strict",
  routes: [],
  fixerCommand: null,
  fixerTimeoutMs: 10 * 60 * 1000,
  autoMerge: false,
  prComments: false,
  commitStatus: false,
  reviewConcurrency: 2,
  contextBudget: 40_000,
  daemonIntervalSec: 120,
  daemonConcurrency: 1,
  confirmRejections: false,
  workdir: null,
  requireNonce: true,
  reviewerWorkdir: "isolated",
  passSecretsToTests: false,
};

export class ConfigError extends Error {}

/** Loads `.ai-referee.json` (lenient: comments + trailing commas allowed). */
export async function loadConfig(cwd: string, explicitPath?: string): Promise<{ config: Config; path: string | null }> {
  const path = explicitPath ?? join(cwd, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    if (explicitPath) throw new ConfigError(`config file not found: ${path}`);
    return { config: structuredClone(DEFAULT_CONFIG), path: null };
  }

  let parsed: unknown;
  try {
    parsed = parseLooseJson(raw);
  } catch (err) {
    throw new ConfigError(`invalid config JSON in ${path}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`config in ${path} must be a JSON object`);
  }
  const cfg = mergeConfig(parsed as Record<string, unknown>, path);
  validateConfig(cfg, path);
  return { config: cfg, path };
}

function mergeConfig(raw: Record<string, unknown>, path: string): Config {
  const cfg = structuredClone(DEFAULT_CONFIG);

  if ("testCommand" in raw) cfg.testCommand = raw.testCommand === null ? null : str(raw.testCommand, "testCommand", path);
  if ("testTimeoutMs" in raw) cfg.testTimeoutMs = num(raw.testTimeoutMs, "testTimeoutMs", path);
  if ("chunkBudget" in raw) cfg.chunkBudget = num(raw.chunkBudget, "chunkBudget", path);
  if ("exclude" in raw) {
    if (!Array.isArray(raw.exclude)) throw new ConfigError(`${path}: "exclude" must be an array`);
    cfg.exclude = raw.exclude.map((x) => str(x, "exclude[]", path));
  }
  if ("reviewers" in raw) {
    if (!Array.isArray(raw.reviewers)) throw new ConfigError(`${path}: "reviewers" must be an array`);
    cfg.reviewers = raw.reviewers.map((x, i) => parseReviewer(x, `reviewers[${i}]`, path));
  }
  if ("profile" in raw) {
    if (raw.profile !== "strict" && raw.profile !== "light") {
      throw new ConfigError(`${path}: "profile" must be "strict" or "light"`);
    }
    cfg.profile = raw.profile;
  }
  if ("routes" in raw) {
    if (!Array.isArray(raw.routes)) throw new ConfigError(`${path}: "routes" must be an array`);
    cfg.routes = raw.routes.map((x, i) => parseRoute(x, `routes[${i}]`, path));
  }
  if ("fixerCommand" in raw) cfg.fixerCommand = raw.fixerCommand === null ? null : str(raw.fixerCommand, "fixerCommand", path);
  if ("fixerTimeoutMs" in raw) cfg.fixerTimeoutMs = num(raw.fixerTimeoutMs, "fixerTimeoutMs", path);
  if ("autoMerge" in raw) cfg.autoMerge = raw.autoMerge === true;
  if ("prComments" in raw) cfg.prComments = raw.prComments === true;
  if ("commitStatus" in raw) cfg.commitStatus = raw.commitStatus === true;
  if ("reviewConcurrency" in raw) cfg.reviewConcurrency = num(raw.reviewConcurrency, "reviewConcurrency", path);
  if ("contextBudget" in raw) cfg.contextBudget = num(raw.contextBudget, "contextBudget", path);
  if ("daemonIntervalSec" in raw) cfg.daemonIntervalSec = num(raw.daemonIntervalSec, "daemonIntervalSec", path);
  if ("daemonConcurrency" in raw) cfg.daemonConcurrency = num(raw.daemonConcurrency, "daemonConcurrency", path);
  if ("confirmRejections" in raw) cfg.confirmRejections = raw.confirmRejections === true;
  if ("workdir" in raw) cfg.workdir = raw.workdir === null ? null : str(raw.workdir, "workdir", path);
  if ("requireNonce" in raw) cfg.requireNonce = raw.requireNonce !== false;
  if ("reviewerWorkdir" in raw) {
    if (raw.reviewerWorkdir !== "isolated" && raw.reviewerWorkdir !== "worktree") {
      throw new ConfigError(`${path}: "reviewerWorkdir" must be "isolated" or "worktree"`);
    }
    cfg.reviewerWorkdir = raw.reviewerWorkdir;
  }
  if ("passSecretsToTests" in raw) cfg.passSecretsToTests = raw.passSecretsToTests === true;
  return cfg;
}

function parseReviewer(raw: unknown, where: string, path: string): ReviewerConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${path}: ${where} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const name = str(r.name, `${where}.name`, path);
  const type = r.type;
  if (type !== "cli" && type !== "api") {
    throw new ConfigError(`${path}: ${where}.type must be "cli" or "api"`);
  }
  const reviewer: ReviewerConfig = { name, type };
  if (r.command !== undefined) reviewer.command = str(r.command, `${where}.command`, path);
  if (r.url !== undefined) reviewer.url = str(r.url, `${where}.url`, path);
  if (r.model !== undefined) reviewer.model = str(r.model, `${where}.model`, path);
  if (r.apiKeyEnv !== undefined) reviewer.apiKeyEnv = str(r.apiKeyEnv, `${where}.apiKeyEnv`, path);
  if (r.stdin !== undefined) reviewer.stdin = r.stdin === true;
  if (r.jsonMode !== undefined) reviewer.jsonMode = r.jsonMode === true;
  if (r.timeoutMs !== undefined) reviewer.timeoutMs = num(r.timeoutMs, `${where}.timeoutMs`, path);
  if (r.headers !== undefined) {
    if (typeof r.headers !== "object" || r.headers === null) {
      throw new ConfigError(`${path}: ${where}.headers must be an object`);
    }
    reviewer.headers = Object.fromEntries(
      Object.entries(r.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  }
  return reviewer;
}

function parseRoute(raw: unknown, where: string, path: string): RouteConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${path}: ${where} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.match) || r.match.length === 0) {
    throw new ConfigError(`${path}: ${where}.match must be a non-empty string array`);
  }
  const route: RouteConfig = {
    match: r.match.map((x) => str(x, `${where}.match[]`, path)),
    reviewers: [],
  };
  if (r.name !== undefined) route.name = str(r.name, `${where}.name`, path);
  if (r.reviewers !== undefined) {
    if (!Array.isArray(r.reviewers)) throw new ConfigError(`${path}: ${where}.reviewers must be an array`);
    route.reviewers = r.reviewers.map((x) => str(x, `${where}.reviewers[]`, path));
  }
  if (r.profile !== undefined) {
    if (r.profile !== "strict" && r.profile !== "light") {
      throw new ConfigError(`${path}: ${where}.profile must be "strict" or "light"`);
    }
    route.profile = r.profile;
  }
  if (r.instructions !== undefined) route.instructions = str(r.instructions, `${where}.instructions`, path);
  if (r.fixer !== undefined) route.fixer = r.fixer === null ? null : str(r.fixer, `${where}.fixer`, path);
  return route;
}

function validateConfig(cfg: Config, path: string): void {
  for (const r of cfg.reviewers) {
    if (r.type === "cli" && !r.command) {
      throw new ConfigError(`${path}: reviewer "${r.name}" is type "cli" but has no "command"`);
    }
    if (r.type === "api" && !r.url) {
      throw new ConfigError(`${path}: reviewer "${r.name}" is type "api" but has no "url"`);
    }
  }
  const names = new Set<string>();
  for (const r of cfg.reviewers) {
    if (names.has(r.name)) {
      throw new ConfigError(`${path}: duplicate reviewer name "${r.name}" — routes reference reviewers by name`);
    }
    names.add(r.name);
  }
  for (const route of cfg.routes) {
    const label = route.name ?? route.match[0]!;
    if (route.reviewers.length === 0) {
      throw new ConfigError(`${path}: route "${label}" lists no reviewers`);
    }
    for (const n of route.reviewers) {
      if (!names.has(n)) {
        throw new ConfigError(`${path}: route "${label}" references unknown reviewer "${n}"`);
      }
    }
  }
  if (cfg.workdir !== null && (isAbsolute(cfg.workdir) || cfg.workdir.split(/[\\/]/).includes(".."))) {
    throw new ConfigError(`${path}: "workdir" must be a relative path inside the repo`);
  }
  if (cfg.chunkBudget < 4_000) {
    throw new ConfigError(`${path}: "chunkBudget" must be at least 4000 chars`);
  }
  if (cfg.contextBudget < 0) {
    throw new ConfigError(`${path}: "contextBudget" must be >= 0`);
  }
  if (!Number.isInteger(cfg.reviewConcurrency) || cfg.reviewConcurrency < 1 || cfg.reviewConcurrency > 8) {
    throw new ConfigError(`${path}: "reviewConcurrency" must be an integer between 1 and 8`);
  }
  if (!Number.isInteger(cfg.daemonConcurrency) || cfg.daemonConcurrency < 1 || cfg.daemonConcurrency > 8) {
    throw new ConfigError(`${path}: "daemonConcurrency" must be an integer between 1 and 8`);
  }
}

function str(v: unknown, where: string, path: string): string {
  if (typeof v !== "string") throw new ConfigError(`${path}: "${where}" must be a string`);
  return v;
}

function num(v: unknown, where: string, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`${path}: "${where}" must be a number`);
  }
  return v;
}

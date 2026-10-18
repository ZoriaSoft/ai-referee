import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewerConfig } from "./config.js";
import { run, shellEscape, which } from "./exec.js";
import type { ReviewerAttempt, TokenUsage } from "./types.js";

export interface ReviewerResponse {
  ok: boolean;
  output: string;
  detail: string;
  durationMs: number;
  /** Token usage when the reviewer is an api endpoint that reports it. */
  tokens?: TokenUsage;
}

export interface Reviewer {
  name: string;
  invoke(prompt: string, cwd: string): Promise<ReviewerResponse>;
}

/**
 * First non-assignment word of a cli reviewer command — the binary to
 * preflight. Compound commands (env prefixes, pipes…) yield null; the
 * shell's own 127 then reports missing binaries at invoke time.
 */
export function cliCommandBinary(command: string): string | null {
  // Shell metacharacters mean the first word is not the whole story —
  // pipes, chains and redirects can hide missing binaries further right.
  if (/[|&;<>()`$]/.test(command)) return null;
  const firstWord = command
    .trim()
    .split(/\s+/)
    .find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) ?? "";
  return /^[A-Za-z0-9_./-]+$/.test(firstWord) ? firstWord : null;
}

const REVIEWER_TIMEOUT_DEFAULT = 10 * 60 * 1000;
const API_TIMEOUT_DEFAULT = 300_000;

export function buildReviewer(cfg: ReviewerConfig): Reviewer {
  return cfg.type === "cli" ? cliReviewer(cfg) : apiReviewer(cfg);
}

function cliReviewer(cfg: ReviewerConfig): Reviewer {
  const command = cfg.command!;
  const usesPromptFile = command.includes("{prompt_file}");
  const usesInline = command.includes("{prompt}");
  const pipeStdin = cfg.stdin ?? (!usesPromptFile && !usesInline);
  const bin = cliCommandBinary(command);

  return {
    name: cfg.name,
    async invoke(prompt, cwd) {
      const started = Date.now();
      // A missing binary is the most common "unavailable" cause; check cheaply.
      if (bin !== null) {
        const found = await which(bin, cwd);
        if (found === null) {
          return { ok: false, output: "", detail: `binary not found: ${bin}`, durationMs: 0 };
        }
      }

      let tmpDir: string | null = null;
      let cmd = command;
      try {
        if (usesPromptFile) {
          tmpDir = await mkdtemp(join(tmpdir(), "ai-referee-"));
          const file = join(tmpDir, "prompt.txt");
          await writeFile(file, prompt, "utf8");
          cmd = cmd.replaceAll("{prompt_file}", shellEscape(file));
        }
        if (usesInline) {
          cmd = cmd.replaceAll("{prompt}", shellEscape(prompt));
        }

        const res = await run(cmd, {
          cwd,
          stdin: pipeStdin ? prompt : undefined,
          timeoutMs: cfg.timeoutMs ?? REVIEWER_TIMEOUT_DEFAULT,
        });
        const durationMs = Date.now() - started;
        if (res.timedOut) {
          return { ok: false, output: res.stdout, detail: "timed out", durationMs };
        }
        if (res.exitCode !== 0) {
          const tail = (res.stderr.trim() || res.stdout.trim()).split("\n").slice(-3).join(" | ");
          return { ok: false, output: res.stdout, detail: `exit ${res.exitCode}: ${tail.slice(0, 300)}`, durationMs };
        }
        if (!res.stdout.trim()) {
          return { ok: false, output: "", detail: "empty output", durationMs };
        }
        return { ok: true, output: res.stdout, detail: "", durationMs };
      } finally {
        if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

function apiReviewer(cfg: ReviewerConfig): Reviewer {
  const url = cfg.url!;
  const model = cfg.model ?? "default";
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;

  return {
    name: cfg.name,
    async invoke(prompt) {
      const started = Date.now();
      if (cfg.apiKeyEnv && !apiKey) {
        return { ok: false, output: "", detail: `env ${cfg.apiKeyEnv} not set`, durationMs: 0 };
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(cfg.headers ?? {}),
      };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? API_TIMEOUT_DEFAULT);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
            // Opt-in: OpenAI-compatible JSON mode keeps verdicts parseable.
            ...(cfg.jsonMode ? { response_format: { type: "json_object" } } : {}),
          }),
        });
        const durationMs = Date.now() - started;
        const body = await res.text();
        if (!res.ok) {
          return {
            ok: false,
            output: "",
            detail: `HTTP ${res.status}: ${body.slice(0, 200)}`,
            durationMs,
          };
        }
        let content: string | null = null;
        let tokens: TokenUsage | undefined;
        try {
          const parsed = JSON.parse(body) as {
            choices?: { message?: { content?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          content = parsed.choices?.[0]?.message?.content ?? null;
          const u = parsed.usage;
          if (u && typeof u.total_tokens === "number") {
            tokens = {
              prompt: u.prompt_tokens ?? 0,
              completion: u.completion_tokens ?? 0,
              total: u.total_tokens,
            };
          }
        } catch {
          content = null;
        }
        if (!content) {
          return { ok: false, output: "", detail: "response had no choices[0].message.content", durationMs };
        }
        return { ok: true, output: content, detail: "", durationMs, tokens };
      } catch (err) {
        const durationMs = Date.now() - started;
        const msg = err instanceof Error && err.name === "AbortError" ? "timed out" : String(err);
        return { ok: false, output: "", detail: msg.slice(0, 300), durationMs };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Tries each reviewer in order until one produces output. Returns the winning
 * response plus the attempt log; response is null when every reviewer failed —
 * the caller must then refuse to approve ("no referee, no merge").
 */
export async function invokeChain(
  reviewers: Reviewer[],
  prompt: string,
  cwd: string,
): Promise<{ response: ReviewerResponse | null; attempts: ReviewerAttempt[] }> {
  const attempts: ReviewerAttempt[] = [];
  for (const reviewer of reviewers) {
    const res = await reviewer.invoke(prompt, cwd);
    attempts.push({
      reviewer: reviewer.name,
      ok: res.ok,
      detail: res.detail,
      durationMs: res.durationMs,
      ...(res.tokens ? { tokens: res.tokens } : {}),
    });
    if (res.ok) return { response: res, attempts };
  }

  return { response: null, attempts };
}

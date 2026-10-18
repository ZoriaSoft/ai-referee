import { spawn } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the process was killed because it exceeded timeoutMs. */
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  /** Max chars kept per stream; output is truncated beyond this. Default 8 MiB. */
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
const KILL_GRACE_MS = 5 * 1000;

/**
 * Runs a shell command line via `bash -c` and captures output.
 * Never rejects: every outcome is returned as a result object.
 */
export function run(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const { promise, resolve } = Promise.withResolvers<ExecResult>();
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const child = spawn("bash", ["-c", command], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;

  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, KILL_GRACE_MS).unref();
  }, timeoutMs);
  killTimer.unref();

  child.stdout.on("data", (c: Buffer) => {
    const next = stdout + c.toString("utf8");
    stdout = next.length > max ? next.slice(0, max) + "\n[output truncated]" : next;
  });
  child.stderr.on("data", (c: Buffer) => {
    const next = stderr + c.toString("utf8");
    stderr = next.length > max ? next.slice(0, max) + "\n[output truncated]" : next;
  });

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    resolve({ exitCode: 127, stdout, stderr: stderr + String(err), timedOut: false });
  });

  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
  });

  if (opts.stdin !== undefined) {
    child.stdin.on("error", () => {
      // EPIPE when the child exits early; the close handler reports it.
    });
    child.stdin.write(opts.stdin);
  }
  child.stdin.end();

  return promise;
}

/** Resolves a binary on PATH; returns the absolute path or null. */
export async function which(bin: string, cwd?: string): Promise<string | null> {
  const res = await run(`command -v -- ${shellEscape(bin)}`, { cwd, timeoutMs: 10_000 });
  const path = res.stdout.trim().split("\n")[0];
  return res.exitCode === 0 && path ? path : null;
}

/** Escapes a string for safe embedding in a bash command line. */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

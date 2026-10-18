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
 * Shell used to interpret command lines: `bash -c` on POSIX, `cmd /d /s /c`
 * on Windows. `platform` is injectable so the choice is unit-testable.
 * /d skips AutoRun registry commands; /s keeps the command line verbatim.
 */
export function shellCommand(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["cmd.exe", "/d", "/s", "/c"] : ["bash", "-c"];
}

/**
 * Runs a shell command line through the platform shell (see shellCommand)
 * and captures output. Never rejects: every outcome is a result object.
 */
export function run(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const { promise, resolve } = Promise.withResolvers<ExecResult>();
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const [shell, ...shellArgs] = shellCommand();
  const child = spawn(shell!, [...shellArgs, command], {
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

/**
 * Shell command that resolves a binary's path: `command -v` on POSIX,
 * `where` on Windows. `where` prints every match; callers keep line one.
 * Injectable platform for tests.
 */
export function locateCommand(bin: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `where ${cmdEscape(bin)}`;
  return `command -v -- ${shellEscape(bin, platform)}`;
}

/** Resolves a binary on PATH; returns the absolute path or null. */
export async function which(bin: string, cwd?: string): Promise<string | null> {
  const res = await run(locateCommand(bin), { cwd, timeoutMs: 10_000 });
  const path = res.stdout.trim().split("\n")[0]?.trim();
  return res.exitCode === 0 && path ? path : null;
}

/**
 * Escapes a string for safe embedding in a command line for the platform
 * shell: single quotes on POSIX, double quotes on Windows.
 * Windows caveat: cmd.exe expands %VAR% even inside quotes, so values
 * carrying % are not fully protectable — controlled call sites only.
 */
export function shellEscape(s: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return cmdEscape(s);
  // POSIX quoting: 'literal', with embedded quotes broken out as '\''.
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * cmd.exe argument quoting per CommandLineToArgvW: wrap in quotes, double
 * every run of backslashes before a quote or the closing quote, escape
 * inner quotes with a backslash. % characters stay expandable — see
 * shellEscape's caveat.
 */
function cmdEscape(s: string): string {
  let out = "";
  let backslashes = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  out += "\\".repeat(backslashes * 2);
  return '"' + out + '"';
}

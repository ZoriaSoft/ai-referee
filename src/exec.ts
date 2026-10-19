import { spawn, type ChildProcess } from "node:child_process";

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
  const [shell, ...shellArgs] = shellCommand();
  return spawnCapture(shell!, [...shellArgs, command], opts);
}

/**
 * Runs `file` with an explicit argv — no shell is involved, so arguments are
 * never re-parsed and cannot inject commands. Use this for every call whose
 * arguments carry data (PR numbers, refs, SHAs, paths). `run` is reserved for
 * command lines the user wrote in their own config (tests, reviewers, fixer).
 * Never rejects: a missing binary resolves with exit code 127.
 */
export function runArgv(file: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return spawnCapture(file, [...args], opts);
}

/**
 * Children still running. On POSIX each one leads its own process group
 * (spawned detached), so a timeout or a signal can take down the whole tree
 * — `bash -c "make test"` forks grandchildren that would otherwise outlive
 * the shell, keep the output pipes open and stall the gate past its timeout.
 */
const active = new Set<ChildProcess>();
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
let signalsHooked = false;

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      // taskkill /T walks the tree; best-effort, its own failure is ignored.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    }
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Detached children no longer share our terminal's process group, so Ctrl-C
 * would not reach them. Forward the common termination signals to every live
 * child group; when nothing else listens, re-raise so the default exit still
 * happens (the daemon installs its own graceful handlers).
 */
function hookSignals(): void {
  if (signalsHooked) return;
  signalsHooked = true;
  for (const sig of FORWARDED_SIGNALS) {
    const handler = (): void => {
      for (const c of active) killTree(c, sig);
      if (process.listenerCount(sig) === 1) {
        process.removeListener(sig, handler);
        process.kill(process.pid, sig);
      }
    };
    process.on(sig, handler);
  }
  process.on("exit", () => {
    for (const c of active) killTree(c, "SIGKILL");
  });
}

function spawnCapture(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const { promise, resolve } = Promise.withResolvers<ExecResult>();
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  if (child.pid !== undefined) {
    hookSignals();
    active.add(child);
  }

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;

  const finish = (result: ExecResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    active.delete(child);
    resolve(result);
  };

  const killTimer = setTimeout(() => {
    timedOut = true;
    killTree(child, "SIGTERM");
    setTimeout(() => {
      if (settled) return;
      killTree(child, "SIGKILL");
      // A descendant that escaped the group can still hold our pipes open;
      // stop waiting for it rather than stalling past the timeout.
      setTimeout(() => {
        if (settled) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ exitCode: child.exitCode ?? 1, stdout, stderr, timedOut: true });
      }, 1000).unref();
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
    finish({ exitCode: 127, stdout, stderr: stderr + String(err), timedOut: false });
  });

  child.on("close", (code) => {
    finish({ exitCode: code ?? 1, stdout, stderr, timedOut });
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

/**
 * Env var names that look like credentials. PR-mode test runs execute code
 * from the pull request, so these are stripped from their environment unless
 * the config opts back in (`passSecretsToTests`).
 */
const SECRET_ENV_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|SESSION|COOKIE)/i;

/** Copy of `env` without credential-looking variables (see SECRET_ENV_RE). */
export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!SECRET_ENV_RE.test(k)) out[k] = v;
  }
  return out;
}

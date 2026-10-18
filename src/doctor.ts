import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { run, which } from "./exec.js";
import { cliCommandBinary } from "./reviewer.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorResult {
  /** True when every hard check passed and at least one reviewer is reachable. */
  healthy: boolean;
  checks: DoctorCheck[];
}

const ICONS: Record<CheckStatus, string> = { ok: "ok", warn: "warn", fail: "FAIL" };

/**
 * One-command sanity pass: repo present, config valid, test command sane,
 * every reviewer reachable (binary on PATH / API key set), and `gh` usable
 * when PR mode is expected. Warnings never fail; hard problems do.
 */
export async function runDoctor(opts: {
  cwd: string;
  configPath?: string;
  out?: (line: string) => void;
}): Promise<DoctorResult> {
  const { cwd } = opts;
  const out = opts.out ?? ((l: string) => console.log(l));
  const checks: DoctorCheck[] = [];
  const push = (c: DoctorCheck): void => {
    checks.push(c);
    out(`[${ICONS[c.status]}] ${c.name} — ${c.detail}`);
  };

  const root = await run("git rev-parse --show-toplevel", { cwd, timeoutMs: 15_000 });
  push(
    root.exitCode === 0
      ? { name: "git repository", status: "ok", detail: root.stdout.trim() }
      : { name: "git repository", status: "fail", detail: "not inside a git repo" },
  );

  let config: Config;
  try {
    const loaded = await loadConfig(cwd, opts.configPath);
    config = loaded.config;
    push({
      name: "config",
      status: "ok",
      detail: loaded.path ? `loaded ${loaded.path}` : "no .ai-referee.json — using defaults",
    });
  } catch (err) {
    push({ name: "config", status: "fail", detail: (err as Error).message });
    return { healthy: false, checks }; // nothing else is meaningful without a config
  }

  if (config.testCommand === null) {
    push({ name: "testCommand", status: "warn", detail: "not set — the gate skips tests" });
  } else {
    const testCwd = config.workdir ? join(cwd, config.workdir) : cwd;
    const dirExists = await stat(testCwd).then((s) => s.isDirectory()).catch(() => false);
    if (!dirExists) {
      push({ name: "testCommand", status: "fail", detail: `workdir does not exist: ${config.workdir}` });
    } else {
      push({ name: "testCommand", status: "ok", detail: `\`${config.testCommand}\` in ${testCwd}` });
    }
  }

  let anyReviewerOk = false;
  if (config.reviewers.length === 0) {
    push({ name: "reviewers", status: "fail", detail: "none configured — the gate refuses to approve" });
  }
  for (const r of config.reviewers) {
    const check = await reviewerCheck(r, cwd);
    if (check.status === "ok") anyReviewerOk = true;
    push(check);
  }

  if (config.fixerCommand) {
    const bin = cliCommandBinary(config.fixerCommand);
    const found = bin === null ? null : await which(bin, cwd);
    push({
      name: "fixer",
      status: bin === null || found ? "ok" : "warn",
      detail: bin === null ? "compound command" : found ? `${bin} → ${found}` : `${bin} not on PATH`,
    });
  }

  const gh = await which("gh", cwd);
  if (!gh) {
    push({ name: "gh CLI", status: "warn", detail: "not found — needed only for --pr/daemon/comments" });
  } else {
    const auth = await run("gh auth status", { cwd, timeoutMs: 15_000 });
    push(
      auth.exitCode === 0
        ? { name: "gh CLI", status: "ok", detail: `authenticated (${gh})` }
        : { name: "gh CLI", status: "warn", detail: "installed but not authenticated — PR modes will fail" },
    );
  }

  const healthy = checks.every((c) => c.status !== "fail") && anyReviewerOk;
  out(healthy ? "doctor: ready — the gate can run" : "doctor: problems found — fix the FAIL lines");
  return { healthy, checks };
}

async function reviewerCheck(r: Config["reviewers"][number], cwd: string): Promise<DoctorCheck> {
  const name = `reviewer "${r.name}"`;
  if (r.type === "cli") {
    const bin = cliCommandBinary(r.command!);
    if (bin === null) {
      return { name, status: "warn", detail: "compound command; binary cannot be prechecked" };
    }
    const found = await which(bin, cwd);
    return found
      ? { name, status: "ok", detail: `${bin} → ${found}` }
      : { name, status: "warn", detail: `${bin} not on PATH` };
  }
  const missingKey = r.apiKeyEnv && !process.env[r.apiKeyEnv];
  return missingKey
    ? { name, status: "warn", detail: `env ${r.apiKeyEnv} not set` }
    : { name, status: "ok", detail: `${r.url} (model ${r.model ?? "default"})` };
}

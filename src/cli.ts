#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CONFIG_FILENAME, loadConfig, type Config } from "./config.js";
import { runDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { repoRoot } from "./git.js";
import { installHook } from "./hook.js";
import { toJson, toMarkdown } from "./report.js";
import { ReviewError, runReview } from "./review.js";
import type { GateReport } from "./types.js";

const VERSION = "0.1.0";

const USAGE = `ai-referee ${VERSION} — local merge gate for AI-era pull requests

USAGE
  ai-referee review [options]     review a diff and print a gate verdict
  ai-referee daemon [options]     poll open PRs and review each new head
  ai-referee hook install         install the pre-push git hook
  ai-referee doctor               check config, reviewers and gh in one pass
  ai-referee init                 write a starter ${CONFIG_FILENAME}
  ai-referee --version

REVIEW OPTIONS
  --pr <n>            review PR #n in an isolated worktree (needs git remote "origin")
  --base <ref>        diff base (default: upstream, else origin's default branch)
  --uncommitted       include uncommitted working-tree changes
  --fix               one fixer round on REJECT, then re-review (local only)
  --merge             gh pr merge when the verdict is APPROVE (PR only)
  --comment           post the verdict + findings as a GitHub PR review (PR only)
  --confirm           verify each REJECT with a second referee before blocking
  --strict            strict profile: full review (default)
  --light             light profile: only merge-blocking problems may reject
  --format <fmt>      markdown | json | both   (default: markdown on a TTY, json when piped)
  --out <path>        write the report to a file instead of stdout
  --config <path>     alternative config file

DAEMON OPTIONS
  --interval <sec>    poll interval (default: config or 120)
  --once              single poll, then exit
  --merge             auto-merge PRs that pass the gate
  --comment           post each verdict as a GitHub PR review
  --confirm           verify each REJECT with a second referee
  --fix               run one fixer round on REJECT (no-op for PR worktrees)

EXIT CODES
  0  APPROVE        1  REJECT        2  could not run (bad config, git error…)

The gate refuses to approve when no reviewer answered — no referee, no merge.
`;

const STARTER_CONFIG = `{
  // Command that must pass before a change may merge. Required for the gate.
  "testCommand": "npm test",

  // Ordered fallback chain: first reviewer that answers wins.
  // cli: {prompt} inline / {prompt_file} path / stdin (default) carries the prompt.
  // api: any OpenAI-compatible /chat/completions endpoint.
  "reviewers": [
    { "name": "claude", "type": "cli", "command": "claude -p" },
    { "name": "codex", "type": "cli", "command": "codex exec -" },
    {
      "name": "openai",
      "type": "api",
      "url": "https://api.example.com/v1/chat/completions",
      "model": "gpt-5-mini",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  ],

  // Optional: command that fixes findings on REJECT (prompt on stdin).
  // "fixerCommand": "claude -p --permission-mode acceptEdits",

  // Optional: post verdicts + anchored findings as GitHub PR reviews
  // (same as passing --comment; needs gh api access).
  // "prComments": true,

  // Chunks reviewed concurrently (1-8). Full changed-file bodies are
  // appended to prompts up to contextBudget chars (0 disables).
  // "reviewConcurrency": 2, "contextBudget": 40000,

  // Prompt profile: "strict" (default) reviews fully; "light" only rejects
  // on merge-stoppers. Routes send matching files to named reviewers only —
  // they never fall back to the default chain.
  // "profile": "strict",
  // "routes": [
  //   {
  //     "name": "security",
  //     "match": ["src/auth/**"],
  //     "reviewers": ["claude"],
  //     "instructions": "check auth bypass and secret handling"
  //   }
  // ],

  // Second referee: each REJECT is verified by the next reviewer in the
  // chain; an overruled rejection warns instead of blocking (needs 2+
  // reviewers). "jsonMode": true on api reviewers asks for strict JSON.
  // "confirmRejections": true,

  "chunkBudget": 100000,
  "exclude": ["*.lock", "package-lock.json", "dist/**", "*.min.js"]
}
`;

interface CliArgs {
  command: string;
  rest: string[];
}

function splitCommand(argv: string[]): CliArgs {
  const known = new Set(["review", "daemon", "hook", "init", "help", "doctor"]);
  const first = argv.find((a) => !a.startsWith("-"));
  if (first && known.has(first)) {
    return { command: first, rest: argv.filter((a) => a !== first) };
  }
  if (argv.includes("--version") || argv.includes("-v")) return { command: "version", rest: [] };
  return { command: argv.length === 0 || argv.includes("--help") || argv.includes("-h") ? "help" : "review", rest: argv };
}

async function main(): Promise<number> {
  const { command, rest } = splitCommand(process.argv.slice(2));

  switch (command) {
    case "version":
      console.log(VERSION);
      return 0;
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case "init":
      return cmdInit();
    case "doctor":
      return cmdDoctor(rest);
    case "hook":
      return cmdHook(rest);
    case "daemon":
      return cmdDaemon(rest);
    case "review":
      return cmdReview(rest);
    default:
      process.stderr.write(`unknown command: ${command}\n${USAGE}`);
      return 2;
  }
}

function parseCommon(rest: string[]) {
  return parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      pr: { type: "string" },
      base: { type: "string" },
      uncommitted: { type: "boolean", default: false },
      fix: { type: "boolean", default: false },
      merge: { type: "boolean", default: false },
      "skip-tests": { type: "boolean", default: false },
      format: { type: "string", default: "" },
      out: { type: "string" },
      config: { type: "string" },
      interval: { type: "string" },
      once: { type: "boolean", default: false },
      comment: { type: "boolean", default: false },
      confirm: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      light: { type: "boolean", default: false },
    },
  });
}

/** Maps --strict/--light to a profile; null means "use config". Errors on both. */
function profileFromFlags(v: { strict?: boolean; light?: boolean }): "strict" | "light" | null {
  if (v.strict && v.light) {
    process.stderr.write(`--strict and --light are mutually exclusive\n`);
    process.exit(2);
  }
  return v.light ? "light" : v.strict ? "strict" : null;
}

async function loadOrDie(cwd: string, path?: string): Promise<Config> {
  try {
    const { config } = await loadConfig(cwd, path);
    return config;
  } catch (err) {
    process.stderr.write(`config error: ${(err as Error).message}\n`);
    process.exit(2);
  }
}

async function cmdReview(rest: string[]): Promise<number> {
  const { values: v } = parseCommon(rest);
  const cwd = process.cwd();
  const config = await loadOrDie(cwd, v.config);
  const format = v.format || (process.stdout.isTTY ? "markdown" : "json");
  const pr = v.pr !== undefined ? Number.parseInt(v.pr, 10) : undefined;
  if (v.pr !== undefined && (!Number.isFinite(pr) || pr! <= 0)) {
    process.stderr.write(`invalid --pr value: ${v.pr}\n`);
    return 2;
  }
  let report: GateReport;
  try {
    report = await runReview({
      config,
      cwd,
      base: v.base,
      pr,
      includeUncommitted: v.uncommitted,
      skipTests: v["skip-tests"],
      fix: v.fix,
      autoMerge: v.merge,
      postComments: (v.comment || config.prComments) && pr !== undefined,
      confirmRejections: v.confirm || undefined,
      profile: profileFromFlags(v) ?? undefined,
    });
  } catch (err) {
    if (err instanceof ReviewError) {
      process.stderr.write(`ai-referee: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const markdown = format === "markdown" || format === "both";
  const json = format === "json" || format === "both";
  const output = [markdown ? toMarkdown(report) : "", json ? toJson(report) : ""]
    .filter(Boolean)
    .join("\n");

  if (v.out) {
    await writeFile(v.out, output, "utf8");
    process.stderr.write(`report written to ${v.out}\n`);
  } else {
    process.stdout.write(output + "\n");
  }
  return report.verdict === "APPROVE" ? 0 : 1;
}

async function cmdDaemon(rest: string[]): Promise<number> {
  const { values: v } = parseCommon(rest);
  const cwd = process.cwd();
  const config = await loadOrDie(cwd, v.config);
  return runDaemon({
    cwd,
    config,
    intervalSec: v.interval ? Number.parseInt(v.interval, 10) : config.daemonIntervalSec,
    once: v.once,
    autoMerge: v.merge,
    postComments: v.comment || config.prComments,
    fix: v.fix,
    confirmRejections: v.confirm || undefined,
    profile: profileFromFlags(v) ?? undefined,
  });
}

async function cmdDoctor(rest: string[]): Promise<number> {
  const { values: v } = parseCommon(rest);
  const result = await runDoctor({ cwd: process.cwd(), configPath: v.config });
  return result.healthy ? 0 : 2;
}

async function cmdHook(rest: string[]): Promise<number> {
  const sub = rest.find((a) => !a.startsWith("-"));
  if (sub !== "install") {
    process.stderr.write(`usage: ai-referee hook install\n`);
    return 2;
  }
  try {
    const root = await repoRoot(process.cwd());
    const { path, replaced } = await installHook(root);
    console.log(`pre-push hook ${replaced ? "updated" : "installed"} at ${path}`);
    console.log(`it runs: ai-referee review`);
    return 0;
  } catch (err) {
    process.stderr.write(`hook install failed: ${(err as Error).message}\n`);
    return 2;
  }
}

async function cmdInit(): Promise<number> {
  const path = `${process.cwd()}/${CONFIG_FILENAME}`;
  try {
    await writeFile(path, STARTER_CONFIG, { encoding: "utf8", flag: "wx" });
    console.log(`wrote ${path} — set testCommand and at least one reviewer`);
    return 0;
  } catch {
    process.stderr.write(`${CONFIG_FILENAME} already exists — not overwriting\n`);
    return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`ai-referee: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);

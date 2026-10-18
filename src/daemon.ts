import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import * as git from "./git.js";
import { toMarkdown } from "./report.js";
import { runReview } from "./review.js";
import type { GateReport } from "./types.js";

export interface DaemonOptions {
  cwd: string;
  config: Config;
  intervalSec: number;
  /** Run one poll cycle and exit — for smoke tests. */
  once: boolean;
  autoMerge?: boolean;
  /** Post each verdict as a GitHub PR review (needs `gh api` access). */
  postComments?: boolean;
  fix?: boolean;
  /** Written under <cwd>/.ai-referee/daemon-state.json */
  statePath?: string;
  log?: (msg: string) => void;
}

interface DaemonState {
  /** Last reviewed head SHA per PR number. */
  reviewed: Record<string, { sha: string; verdict: string; at: string }>;
}

/**
 * Polls `gh pr list` and reviews every open PR whose head moved since the
 * last check. One bad PR never kills the loop.
 */
export async function runDaemon(opts: DaemonOptions): Promise<number> {
  const { cwd, config } = opts;
  const log = opts.log ?? ((m: string) => console.log(`[daemon] ${m}`));
  const statePath = opts.statePath ?? join(cwd, ".ai-referee", "daemon-state.json");
  const state = await loadState(statePath);

  const poll = async (): Promise<void> => {
    let prs;
    try {
      prs = await git.ghListOpenPrs(cwd);
    } catch (err) {
      log(`gh pr list failed: ${(err as Error).message}`);
      return;
    }
    log(`${prs.length} open PR(s)`);

    for (const pr of prs) {
      const prev = state.reviewed[String(pr.number)];
      if (prev?.sha === pr.headRefOid) {
        log(`#${pr.number} unchanged (${pr.headRefOid.slice(0, 8)}) — skipping`);
        continue;
      }
      log(`#${pr.number} ${pr.title} — reviewing ${pr.headRefOid.slice(0, 8)}`);
      try {
        const report = await runReview({
          config,
          cwd,
          pr: pr.number,
          autoMerge: opts.autoMerge === true && config.autoMerge,
          postComments: opts.postComments === true,
          fix: opts.fix === true,
        });
        log(
          `#${pr.number} → ${report.verdict} (${report.findings.length} findings)` +
            (report.comments.requested ? `; review post: ${report.comments.detail ?? (report.comments.posted ? "ok" : "?")}` : ""),
        );
        await writeReport(cwd, pr.number, report);
        state.reviewed[String(pr.number)] = {
          sha: pr.headRefOid,
          verdict: report.verdict,
          at: new Date().toISOString(),
        };
        await saveState(statePath, state);
      } catch (err) {
        log(`#${pr.number} review failed: ${(err as Error).message}`);
      }
    }
  };

  await poll();
  if (opts.once) return 0;

  const interval = setInterval(poll, Math.max(10, opts.intervalSec) * 1000);
  const stop = (): void => {
    clearInterval(interval);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await Promise.withResolvers<never>().promise; // resolves only when a signal exits the process
  return 0;
}

async function loadState(path: string): Promise<DaemonState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as DaemonState;
    return { reviewed: parsed.reviewed ?? {} };
  } catch {
    return { reviewed: {} };
  }
}

async function saveState(path: string, state: DaemonState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

async function writeReport(cwd: string, pr: number, report: GateReport): Promise<void> {
  const dir = join(cwd, ".ai-referee", "reports");
  await mkdir(dir, { recursive: true });
  const base = join(dir, `pr-${pr}-${report.target.head.slice(0, 8)}`);
  await writeFile(`${base}.md`, toMarkdown(report), "utf8");
  await writeFile(`${base}.json`, JSON.stringify(report, null, 2), "utf8");
}

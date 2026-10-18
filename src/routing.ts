import type { RouteConfig } from "./config.js";
import { chunkDiff, globMatch, type DiffChunk, type FileDiff } from "./diff.js";
import type { ReviewProfile } from "./types.js";

/**
 * The review plan for one file or chunk: which reviewers may answer, which
 * prompt profile applies, and any route-supplied extra instructions.
 */
export interface ReviewPlan {
  /** Names from `config.reviewers`, deduped in route order. Empty → default chain. */
  reviewerNames: string[];
  profile: ReviewProfile;
  instructions: string[];
  /** Matching route labels joined with "+", or null when no route matched. */
  route: string | null;
  /** Stable grouping key — files with identical plans chunk together. */
  key: string;
}

export const DEFAULT_PLAN_KEY = "(default)";

/** Resolves which routes apply to one file and what they imply for its review. */
export function planForFile(routes: RouteConfig[], path: string, runProfile: ReviewProfile): ReviewPlan {
  const matched = routes.filter((r) => r.match.some((g) => globMatch(g, path)));
  if (matched.length === 0) {
    return {
      reviewerNames: [],
      profile: runProfile,
      instructions: [],
      route: null,
      key: DEFAULT_PLAN_KEY,
    };
  }

  const names: string[] = [];
  const seen: Record<string, true> = {};
  for (const r of matched) {
    for (const n of r.reviewers) {
      if (seen[n]) continue;
      seen[n] = true;
      names.push(n);
    }
  }

  const label = matched.map((r) => r.name ?? r.match[0]!).join("+");
  return {
    reviewerNames: names,
    // First matching route wins the profile override; later routes' instructions still apply.
    profile: matched.find((r) => r.profile)?.profile ?? runProfile,
    instructions: matched.map((r) => r.instructions).filter((s): s is string => !!s),
    route: label,
    key: `route:${label}:${names.join(",")}:${matched.find((r) => r.profile)?.profile ?? runProfile}`,
  };
}


/**
 * Groups files by their resolved plan first, then chunks each group under the
 * budget — a chunk never mixes routed and unrouted files. Chunk indices are
 * reassigned by first-file position afterwards, keeping diff order globally.
 */
export function chunkFilesByRoute(
  files: FileDiff[],
  opts: { routes: RouteConfig[]; chunkBudget: number },
  runProfile: ReviewProfile,
): {
  chunks: { chunk: DiffChunk; plan: ReviewPlan }[];
} {
  if (opts.routes.length === 0) {
    // Still derive the plan via planForFile so the "no route" shape has one source.
    return {
      chunks: chunkDiff(files, opts.chunkBudget).map((chunk) => ({
        chunk,
        plan: planForFile(opts.routes, chunk.files[0]?.path ?? "", runProfile),
      })),
    };
  }

  const groups = new Map<string, { plan: ReviewPlan; files: FileDiff[] }>();
  for (const f of files) {
    const plan = planForFile(opts.routes, f.path, runProfile);
    const existing = groups.get(plan.key);
    if (existing) {
      existing.files.push(f);
    } else {
      groups.set(plan.key, { plan, files: [f] });
    }
  }

  const out: { chunk: DiffChunk; plan: ReviewPlan }[] = [];
  for (const { plan, files: groupFiles } of groups.values()) {
    for (const chunk of chunkDiff(groupFiles, opts.chunkBudget)) {
      out.push({ chunk, plan });
    }
  }
  // Reorder chunks by where their first file sits in the diff, then renumber.
  const order = new Map(files.map((f, i) => [f.path, i]));
  out.sort((a, b) => (order.get(a.chunk.files[0]!.path) ?? 0) - (order.get(b.chunk.files[0]!.path) ?? 0));
  out.forEach((entry, i) => {
    entry.chunk.index = i;
  });
  return { chunks: out };
}

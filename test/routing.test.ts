import { describe, expect, it } from "vitest";
import type { RouteConfig } from "../src/config.js";
import type { FileDiff } from "../src/diff.js";
import { chunkFilesByRoute, planForFile } from "../src/routing.js";

const file = (path: string, patchLen = 10): FileDiff => ({
  path,
  patch: "x".repeat(patchLen),
  insertions: 1,
  deletions: 0,
  isBinary: false,
  isDeleted: false,
  isNew: false,
  rightLines: new Set([1]),
});

const sec: RouteConfig = {
  name: "security",
  match: ["src/auth/**"],
  reviewers: ["sec-model"],
  instructions: "watch for auth bypass",
};

describe("planForFile", () => {
  it("returns the default plan when no route matches", () => {
    const plan = planForFile([sec], "src/app.ts", "strict");
    expect(plan.reviewerNames).toEqual([]);
    expect(plan.route).toBeNull();
    expect(plan.profile).toBe("strict");
    expect(plan.instructions).toEqual([]);
  });

  it("resolves reviewer subset, instructions and label for a match", () => {
    const plan = planForFile([sec], "src/auth/login.ts", "strict");
    expect(plan.reviewerNames).toEqual(["sec-model"]);
    expect(plan.route).toBe("security");
    expect(plan.instructions).toEqual(["watch for auth bypass"]);
  });

  it("uses the route's profile override", () => {
    const light: RouteConfig = { ...sec, profile: "light" };
    expect(planForFile([light], "src/auth/login.ts", "strict").profile).toBe("light");
    // The override applies to the route only, not the default chain.
    expect(planForFile([light], "src/app.ts", "strict").profile).toBe("strict");
  });

  it("merges multiple matching routes: names deduped, labels joined, first profile wins", () => {
    const extra: RouteConfig = {
      match: ["src/auth/crypto.ts"],
      reviewers: ["sec-model", "crypto-model"],
      profile: "light",
    };
    const strictSec: RouteConfig = { ...sec, profile: "strict" };
    const plan = planForFile([strictSec, extra], "src/auth/crypto.ts", "light");
    expect(plan.reviewerNames).toEqual(["sec-model", "crypto-model"]);
    expect(plan.route).toBe("security+src/auth/crypto.ts");
    expect(plan.profile).toBe("strict"); // first matching route's override wins
  });

  it("falls back to the glob as label when the route has no name", () => {
    const anon: RouteConfig = { match: ["secrets/**"], reviewers: ["sec-model"] };
    expect(planForFile([anon], "secrets/keys.ts", "strict").route).toBe("secrets/**");
  });

  it("resolves the route fixer: string override, null opt-out, absent inherits", () => {
    const custom: RouteConfig = { ...sec, fixer: "auth-fixer --apply" };
    const blocked: RouteConfig = { match: ["docs/**"], reviewers: ["sec-model"], fixer: null };
    expect(planForFile([custom], "src/auth/login.ts", "strict").fixer).toBe("auth-fixer --apply");
    expect(planForFile([blocked], "docs/readme.md", "strict").fixer).toBeNull();
    // Absent fixer stays absent — the global fixerCommand decides at fix time.
    expect(planForFile([sec], "src/auth/login.ts", "strict").fixer).toBeUndefined();
    expect(planForFile([], "src/app.ts", "strict").fixer).toBeUndefined();
    // First route mentioning a fixer wins when several match.
    const second: RouteConfig = { ...sec, fixer: "other-fixer" };
    expect(planForFile([custom, second], "src/auth/login.ts", "strict").fixer).toBe("auth-fixer --apply");
    expect(planForFile([sec, second], "src/auth/login.ts", "strict").fixer).toBe("other-fixer");
  });
});

describe("chunkFilesByRoute", () => {
  it("never mixes routed and unrouted files in one chunk", () => {
    const files = [file("src/a.ts"), file("src/auth/x.ts"), file("src/b.ts")];
    const { chunks } = chunkFilesByRoute(
      files,
      { routes: [sec], chunkBudget: 100_000 },
      "strict",
    );
    expect(chunks).toHaveLength(2);
    const unrouted = chunks.find((c) => c.plan.route === null)!;
    const routed = chunks.find((c) => c.plan.route === "security")!;
    expect(unrouted.chunk.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(routed.chunk.files.map((f) => f.path)).toEqual(["src/auth/x.ts"]);
  });

  it("renumbers chunks by first-file position in the diff", () => {
    // Routed file sits between two unrouted files; the unrouted group still
    // sorts first because its earliest file comes first in the diff.
    const files = [file("src/a.ts"), file("src/auth/x.ts"), file("src/b.ts")];
    const { chunks } = chunkFilesByRoute(
      files,
      { routes: [sec], chunkBudget: 100_000 },
      "strict",
    );
    expect(chunks[0]!.chunk.index).toBe(0);
    expect(chunks[1]!.chunk.index).toBe(1);
    expect(chunks[0]!.plan.route).toBeNull();
    expect(chunks[1]!.plan.route).toBe("security");
  });

  it("keeps routed files under the same plan chunked together within budget", () => {
    const files = [file("src/auth/a.ts", 60), file("src/auth/b.ts", 60), file("src/auth/c.ts", 60)];
    const { chunks } = chunkFilesByRoute(
      files,
      { routes: [sec], chunkBudget: 120 },
      "strict",
    );
    // 60+1+60 > 120 forces a split, but every emitted chunk is routed.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.plan.route === "security")).toBe(true);
  });

  it("returns default plans when no routes are configured", () => {
    const { chunks } = chunkFilesByRoute(
      [file("a.ts"), file("b.ts")],
      { routes: [], chunkBudget: 100_000 },
      "light",
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.plan.route).toBeNull();
    expect(chunks[0]!.plan.profile).toBe("light");
    expect(chunks[0]!.plan.reviewerNames).toEqual([]);
  });
});

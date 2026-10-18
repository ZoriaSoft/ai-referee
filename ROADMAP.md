# ROADMAP

Vision: the merge gate for the AI-agent era — local-first, reviewer-agnostic,
fail-closed. If no referee answered, nothing merges.

## Name proposal

`ai-referee` — clear, no collisions found on GitHub search (checked 2026-10-18).
`mergegate`/`merge-gate` are taken. Alternatives if wanted: `prreferee`, `refgate`.
Owner decides.

## Done — round 1

- [x] Project scaffold: TS strict, zero runtime deps, `npx ai-referee` bin
- [x] `.ai-referee.json` config (lenient JSON, `init` command writes starter)
- [x] Unified-diff parsing, per-file splitting, exclude globs, budget chunking
      with mid-file truncation marker
- [x] Reviewer abstraction: `cli` (stdin / `{prompt}` / `{prompt_file}`) and
      OpenAI-compatible `api` adapters
- [x] Sequential fallback chain with per-attempt log; fail-closed when the
      chain is dead or unconfigured ("no referee, no merge")
- [x] Strict verdict extraction: prose-tolerant JSON extraction, fences,
      trailing commas, verdict synonyms; parse-retry nudge; malformed-output tests
- [x] Aggregation: deduped findings, severity sort, combined test+review verdict
- [x] Local target (`--base`, `--uncommitted`) and PR target via
      `refs/pull/<n>/head` in a throwaway git worktree
- [x] One fix round (`--fix`, local only) + single re-review (`round` field)
- [x] Optional `--merge` via `gh pr merge` on APPROVE
- [x] Modes: `review` CLI, `daemon` (polls `gh pr list`, SHA dedupe, writes
      reports to `.ai-referee/reports/`), `hook install` (pre-push, preserves
      foreign hooks)
- [x] Markdown + JSON reports, `--format`, `--out`, exit codes 0/1/2
- [x] 63 tests incl. end-to-end pipeline against fake reviewer scripts

## Done — round 2

- [x] **Findings → PR review comments**: `--comment`/`prComments` posts the
      verdict as a GitHub review (`APPROVE`/`REQUEST_CHANGES`) via `gh api`;
      daemon `--comment` for every polled PR
- [x] **Diff-aware line anchoring**: `FileDiff.rightLines` maps new-side line
      numbers; findings anchor only to lines GitHub accepts — the rest go to
      the review body (a comment on the wrong line is worse than no inline)
- [x] **Context enrichment**: `contextBudget` (default 40k) appends post-change
      file bodies to prompts
- [x] **Chunk-level parallelism**: `reviewConcurrency` (default 2, max 8)
      worker pool; deterministic chunk/result ordering preserved
- [x] **`ai-referee doctor`**: repo, config, workdir, reviewer binaries/API
      keys, gh auth — one command, exit 0/2
- [x] **Cost/token reporting**: api reviewer `usage` → per-attempt tokens +
      `stats.tokens` in reports
- [x] `cliCommandBinary` hardening: compound commands (pipes, redirects) now
      skip the precheck instead of masking missing binaries


## Done — round 3

- [x] **Review quality presets**: `strict`/`light` prompt profiles
      (`profile` config, `--strict`/`--light` on review + daemon).
- [x] **Per-path reviewer routing**: `routes` config — glob-matched files get
      their own named reviewer subset, optional route `profile` and
      `instructions`; routed chunks never mix with unrouted and fail closed
      when their own referees are down. Route/profile recorded per chunk in
      reports; doctor lists route mappings.


## Done — round 4

- [x] **Stale review dismissal**: every posted PR review carries an
      `ai-referee` marker; after posting a new verdict, superseded
      `CHANGES_REQUESTED` reviews on older commits are dismissed via
      `gh api .../dismissals`. Human reviews and foreign markers untouched —
      a fixed PR is no longer held back by ai-referee's own stale rejection.
- [x] **Daemon polish**: polls schedule via chained timeouts (a slow review
      pass can never overlap the next poll); consecutive `gh pr list` failures
      back off exponentially (2ⁿ⁻¹×, capped at 8×) and log the next delay.
      systemd user-unit example in README.
- [x] **Severity-aware light gate**: a `light`-profile REJECT that cites no
      `blocker` finding is downgraded to a `warnings[]` entry instead of
      blocking — the prompt contract now holds at the gate, not just in the
      prompt. Zero-finding REJECTs can't be reclassified: still fail closed.

## Done — round 5

- [x] **Second-referee rejection confirmation** (`confirmRejections`,
      `--confirm`): a REJECT is contested before the next reviewer in the
      chain — judge can't confirm itself. Overruled → warning; confirmed →
      reason names the confirmer; inconclusive → REJECT stands. Outcome
      recorded on `ChunkResult.confirmation`, confirmer findings merged.
- [x] **File-level PR comments**: unanchorable findings that resolve to a
      changed file post via `subject_type:"file"` comments (bulk review
      endpoint can't take them — separate best-effort calls).
- [x] **`jsonMode` for api reviewers**: opt-in
      `response_format:{type:"json_object"}` for compatible endpoints.

## Done — round 6

- [x] **Daemon concurrency**: `--concurrency`/`daemonConcurrency` (1–8) runs a
      bounded pool of PR reviews per poll. Races closed first: PR heads now
      fetch into per-PR scratch refs `refs/ai-referee/pr-<n>` with
      `--no-write-fetch-head` (FETCH_HEAD was the shared-write race), force-push
      safe via `+refspec`; worktrees were already per-PR `mkdtemp`; state saves
      are serialized through a queue and written atomically (tmp + rename).
- [x] **Multi-line inline comments**: findings may carry `start_line` (schema
      + prompt + parser; camelCase tolerated, bad ranges dropped). `anchorRange`
      keeps a range only when both ends are diff lines — otherwise it degrades
      to a single-line comment. Posted as `start_line`/`start_side` on the
      GitHub review; report/comment bodies render `file:start-end`.


## Done — round 7

- [x] **GitHub commit statuses** (`commitStatus`, `--status`): `pending` on
      the PR head when a review starts, `success`/`failure` with the verdict
      at the end (context `ai-referee`). Branch protection can require the
      context — the gate becomes enforceable, not just advisory. Best-effort:
      post failures land in `report.status.detail`, never flip the verdict;
      final state lands after auto-merge so a failed merge reads `failure`.

## Done — round 8

- [x] **Route-aware fixer**: `routes[].fixer` — a per-route fix command for
      matching files (first route's fixer wins; `null` opts files out),
      falling back to the global `fixerCommand`. Findings are partitioned by
      resolved fixer; each command runs once with its own subset and is
      labelled in `fix.detail`. Fix rounds now fire when *any* fixer
      resolves, so a route-only fixer works without a global one.
- [x] **Best-effort Windows support**: `cmd.exe /d /s /c` shell fallback,
      `where` for binary lookup, `CommandLineToArgvW`-style quoting; POSIX
      `2>/dev/null` and `command -v` idioms removed. Inline `{prompt}` stays
      fragile under cmd — docs steer to stdin/`{prompt_file}`.
- [x] **CLI flag fixes**: dead `--confirm` (review) and `--fix` (daemon) now
      forwarded; `--interval`/`--concurrency` validated; `splitCommand`
      no longer eats flag values equal to the command word; `--skip-tests`
      documented in `--help`; cli module importable without running main.

## Next (priority order)

- [ ] **Windows end-to-end verification**: the cmd.exe fallback is unit-tested
      but never exercised on a real Windows box — first public release should
      get a manual smoke pass before claiming full support.


Ideas surfaced during rounds, not scheduled: `--staged` review target,
`--stale <days>` daemon flag to re-review old approved heads, JSON schema
export for `.ai-referee.json`, review caching by chunk hash.


## Known limits

- Reviewer sees diff + README excerpt + file bodies under `contextBudget`;
  no cross-file symbol resolution.
- `cli` reviewer/test/fixer commands run via `bash` on POSIX and `cmd.exe` on
  Windows (best-effort; `%VAR%` expands inside quoted args under cmd).
- Daemon/PR modes require `gh` CLI + GitHub remote; plain-git hosting has no
  PR mode (local `--base` diffs still work everywhere).
- One fix round by design; no iterative fix loops.
- LLM verdicts are heuristics, not proofs — the gate blocks slop, it does not
  guarantee correctness.

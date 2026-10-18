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

## Next (priority order)

- [ ] **Route-aware fix round**: `fixerCommand` is global; findings could go
      to a route-matched fixer instead.
- [ ] **Daemon polish**: exponential backoff on `gh` failures, systemd unit
      example in docs.
- [ ] **Severity-based gate**: today any model REJECT fails; optionally let
      `light`-mode runs treat non-blocker REJECTs as warnings (needs verdict
      severity mapping, not just prompt wording).
- [ ] **Windows support**: reviewer/test commands via `cmd /c` fallback.
- [ ] **Review dismissal on new pushes**: daemon re-reviews after new commits,
      but the old REQUEST_CHANGES stays — dismiss superseded reviews via `gh api`.
- [ ] **Multi-line inline comments**: GitHub supports start_line+line ranges;
      models would need to report line ranges, not single lines.
- [ ] **Comment threading on unchanged code**: findings on unchanged lines
      adjacent to the diff could anchor via `subject_type: "file"`.

## Known limits

- Reviewer sees diff + README excerpt + file bodies under `contextBudget`;
  no cross-file symbol resolution.
- `cli` reviewers require bash (POSIX environments; Windows unsupported).
- Daemon/PR modes require `gh` CLI + GitHub remote; plain-git hosting has no
  PR mode (local `--base` diffs still work everywhere).
- One fix round by design; no iterative fix loops.
- LLM verdicts are heuristics, not proofs — the gate blocks slop, it does not
  guarantee correctness.

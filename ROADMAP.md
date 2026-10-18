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

## Next (priority order)

- [ ] **Findings → PR review comments**: post inline comments via `gh api` when
      reviewing `--pr`; daemon flag `--comment`.
- [ ] **Diff-aware line anchoring**: map model-reported lines to diff positions
      for accurate GitHub review placement.
- [ ] **Review quality presets**: `--strict`/`--light` prompt profiles;
      per-path reviewer routing (e.g. security reviewer for auth files).
- [ ] **Context enrichment**: include changed files' full bodies (or symbol
      snippets) when under a size cap — models review better with context.
- [ ] **Chunk-level parallelism**: review chunks concurrently with a cap
      (default 2) for large PRs; keep deterministic ordering of findings.
- [ ] **Fix round for PR targets**: push fixes to the PR branch when the user
      has push rights (`--fix --push`).
- [ ] **Daemon polish**: exponential backoff on `gh` failures, optional `gh pr
      comment` verdict posting, systemd unit example in docs.
- [ ] **Windows support**: reviewer/test commands via `cmd /c` fallback.
- [ ] **`ai-referee doctor`**: verify reviewer binaries resolve, api keys set,
      gh auth status, config sanity in one command.
- [ ] **Cost/token reporting**: capture token usage from api reviewers into the
      report (prompt/completion counts when the endpoint returns them).

## Known limits

- Reviewer sees diff + README excerpt only; no symbol-level codebase context.
- `cli` reviewers require bash (POSIX environments; Windows unsupported).
- Daemon requires `gh` CLI + GitHub remote; plain-git hosting has no PR mode.
- One fix round by design; no iterative fix loops.
- LLM verdicts are heuristics, not proofs — the gate blocks slop, it does not
  guarantee correctness.

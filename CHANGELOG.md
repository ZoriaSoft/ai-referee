# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — round 1 (2026-10-18)

### Added

- `ai-referee review`: runs the repo's test command, chunks the diff, sends each
  chunk through an ordered reviewer chain, aggregates findings into a fail-closed
  APPROVE/REJECT gate verdict. Exit codes: 0 approve, 1 reject, 2 error.
- Targets: local branch diff (`--base`, `--uncommitted`) and GitHub PRs
  (`--pr`, reviewed in a disposable git worktree via `refs/pull/<n>/head`).
- Reviewer adapters: `cli` (any agent CLI; prompt via stdin, `{prompt}` or
  `{prompt_file}`) and `api` (any OpenAI-compatible `/chat/completions`).
- Sequential fallback chain with per-attempt log; review refuses to approve
  when no reviewer answers or none are configured.
- Strict verdict parsing tolerant of prose, markdown fences, comments and
  trailing commas; one retry nudge per chunk; unparseable output → REJECT.
- One automatic fix round (`--fix`, local targets) with a single re-review;
  optional `--merge` via `gh pr merge` on APPROVE.
- `ai-referee daemon`: polls `gh pr list`, reviews each new PR head once
  (SHA dedupe), writes Markdown+JSON reports under `.ai-referee/reports/`.
- `ai-referee hook install`: pre-push hook that blocks pushes on REJECT;
  appends to an existing hook instead of clobbering it.
- `ai-referee init`: starter `.ai-referee.json` (lenient JSON: comments and
  trailing commas allowed).
- Reports in Markdown (default on TTY) and JSON (default when piped), `--format`,
  `--out`.
- 63 tests: diff parser/chunker, verdict parser (malformed-output matrix),
  loose JSON, reviewer adapters/chain, config validation, and an end-to-end
  pipeline suite that builds throwaway git repos with fake reviewer scripts.

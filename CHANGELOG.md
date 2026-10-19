# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Timeouts now kill the whole process tree. A test command or reviewer
  that forked grandchildren used to keep the pipes open, so a hung test
  suite hung the gate past `testTimeoutMs`. Ctrl-C is forwarded to
  running children.
- `hook install` installs into the directory git actually uses
  (`core.hooksPath`, linked worktrees), puts the gate before an existing
  hook instead of after it (a foreign `exit 0` skipped the gate), and a
  re-install no longer drops the merged foreign hook.
- Light profile: reviewer severities such as `critical`/`high` were read
  as `minor`, which downgraded real rejections to warnings. Common scales
  now map onto blocker/major/minor/info.
- `--format md` (and typos) printed an empty report; `md` is an alias for
  markdown and unknown values exit 2.
- Inline `{prompt}` commands above the Linux per-argument limit fail with
  a clear message instead of `spawn E2BIG`.
- Stale-review dismissal only touches reviews from the account that posted
  the new review, not any review containing the marker text.

### Changed

- vitest 5 (dev only) clears the npm audit advisories in the test
  toolchain. Added `SECURITY.md` and `CONTRIBUTING.md`.

## [0.1.0] - 2026-10-19

First public release.

### Added

**Review gate**
- `ai-referee review`: runs the repo's test command, chunks the diff, sends
  each chunk through an ordered reviewer chain and aggregates findings into a
  fail-closed APPROVE/REJECT verdict. Exit codes: 0 approve, 1 reject,
  2 error.
- Targets: local branch diff (`--base`, `--uncommitted`) and GitHub PRs
  (`--pr`, reviewed in a disposable git worktree).
- Reviewer adapters: `cli` (any coding-assistant CLI; prompt via stdin,
  `{prompt}` or `{prompt_file}`) and `api` (any OpenAI-compatible
  `/chat/completions`, optional `jsonMode`).
- Sequential fallback chain with a per-attempt log; the gate refuses to
  approve when no reviewer answers or none are configured.
- Strict verdict parsing that tolerates prose, markdown fences, comments
  and trailing commas; unparseable output is a REJECT.
- Review profiles: `strict` (default) and `light`, where only blocker
  findings gate and other rejections become `warnings`.
- Per-path reviewer routing (`routes`): matching files are chunked
  separately, reviewed only by the route's reviewers with optional
  `profile`, `instructions` and `fixer`; routed chunks fail closed.
- Second-referee confirmation (`confirmRejections`, `--confirm`): a REJECT
  is re-judged by the next reviewer in the chain; overruled rejections
  become warnings, inconclusive ones stand.
- Chunk-level parallelism (`reviewConcurrency`), context enrichment with
  post-change file bodies (`contextBudget`), token usage in reports.
- One automatic fix round (`--fix`, local targets) with a single re-review,
  route-aware fixers, and optional `--merge` via `gh pr merge` on APPROVE.

**GitHub integration**
- `--comment`: posts the verdict as a PR review with findings anchored to
  diff lines, multi-line ranges where both ends are in the diff, file-level
  comments otherwise; posting failures never flip the verdict.
- Stale `CHANGES_REQUESTED` reviews from ai-referee are dismissed after a
  new verdict.
- `--status` / `commitStatus`: `pending` and `success`/`failure` commit
  statuses (context `ai-referee`) so branch protection can require the gate.

**Modes and tooling**
- `ai-referee daemon`: polls `gh pr list`, reviews each new PR head once,
  writes Markdown and JSON reports; bounded parallel reviews
  (`--concurrency`), exponential backoff on `gh` failures, atomic state
  writes.
- `ai-referee hook install`: pre-push hook that blocks pushes on REJECT and
  keeps an existing hook.
- `ai-referee doctor`: checks the repo, config, reviewer binaries and API
  keys, routes and `gh` auth.
- `ai-referee init`: starter `.ai-referee.json` (comments and trailing
  commas allowed).
- Markdown (default on a TTY) and JSON (default when piped) reports,
  `--format`, `--out`.
- Best-effort Windows support: commands run through `cmd.exe /d /s /c`,
  `where` for binary lookup, `CommandLineToArgvW` quoting.

### Security

- Auto-merge is bound to the reviewed commit: the PR head SHA is pinned for
  the diff, prompt context and tests, `--merge` refuses if the head moved and
  passes `--match-head-commit`. Auto-merge is refused when tests did not run,
  and the gate rejects if the test run moved `HEAD` or edited tracked files.
- All git/gh calls use argv instead of shell strings; PR numbers, SHAs and
  refs are validated. Inline `{prompt}` is refused on Windows.
- Prompt-injection hardening: diff, file bodies, README and a first
  referee's text are wrapped in nonce-tagged untrusted-data blocks; verdicts
  must echo the nonce; contradictory verdicts fail closed.
- PR-mode tests run with credential-looking environment variables stripped
  (`passSecretsToTests` to opt in) and CLI reviewers run in an empty temp
  directory (`reviewerWorkdir: "isolated"`). A PR that edits
  `.ai-referee.json` gets a warning; the local config is always used.

[Unreleased]: https://github.com/ZoriaSoft/ai-referee/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ZoriaSoft/ai-referee/commits/v0.1.0

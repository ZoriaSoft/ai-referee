# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

## [Unreleased] — pre-public hardening (2026-10-19)

### Security

- **Auto-merge is bound to the reviewed commit.** The PR head SHA is pinned
  once; the diff (`base...<sha>`), prompt context (`git show <sha>:path`) and
  tests all use it. `--merge` re-reads the PR head, refuses if it moved, and
  passes `gh pr merge --match-head-commit <sha>`. Auto-merge is refused when
  tests did not run, and the gate rejects if the test run moved `HEAD` or
  edited tracked files. Reports carry `target.reviewedSha`; the daemon records
  the SHA actually reviewed.
- **No shell for data.** All git/gh calls use argv (`runArgv`) instead of
  shell strings; PR numbers, SHAs and refs are validated (no leading `-`, no
  metacharacters, no ranges); `--pr`/`--interval`/`--concurrency` accept
  digits only. Inline `{prompt}` is refused on Windows.
- **Prompt-injection hardening.** Diff, file bodies, README and the first
  referee's text travel inside nonce-tagged untrusted-data blocks; verdicts
  must echo the nonce (`requireNonce`, default true); contradictory verdicts
  in one answer fail closed; parse retries re-send the full prompt instead of
  a bare "reply again". README context comes from the trusted checkout.
- **Untrusted PR code.** PR-mode tests run with credential-looking env vars
  stripped (`passSecretsToTests` to opt in); PR-mode CLI reviewers run in an
  empty temp dir (`reviewerWorkdir: "isolated"`); a PR that edits
  `.ai-referee.json` gets a warning (the local config is always the one used);
  `workdir` must stay inside the repo.

### Fixed

- The installed `ai-referee` bin (npm symlink: `.bin`, global prefix,
  `npm link`) did nothing and exited 0 — the entry guard compared URLs
  instead of real paths. A pre-push hook read that silent exit as APPROVE.

### Changed

- Node.js ≥ 22 is required (`Promise.withResolvers`); `engines` was wrong.
- README: positioning, clean-install quickstart, Security model, comparison,
  limits. `package-lock.json` is committed; `prepare` builds `dist/`.

## round 8 (2026-10-18)

### Added

- Route-aware fixer: a route may carry `"fixer"` — a command that receives
  only the findings whose files matched that route (labelled in `fix.detail`),
  or `null` to opt those files out of fixing entirely. Unrouted findings keep
  using the global `fixerCommand`; a fix round now runs when any fixer
  resolves (route-only fixers count), and each distinct command runs once
  with its own finding subset. `doctor` reports each route's fixer binary.
- Best-effort Windows support: commands run through `cmd.exe /d /s /c`
  instead of `bash -c`, `where` replaces `command -v` for binary preflight,
  and escaping follows `CommandLineToArgvW` rules. POSIX-only shell syntax
  (`2>/dev/null`) was removed from git helpers. Inline `{prompt}` remains
  fragile under cmd — prefer stdin or `{prompt_file}` on Windows.
- `--skip-tests` is now listed in `ai-referee --help`.

### Fixed

- `review --confirm` was parsed but never forwarded — the flag had no effect.
- `daemon --fix` was parsed but never forwarded.
- `daemon --interval`/`--concurrency` non-numeric input was silently accepted
  (NaN interval would re-poll in a hot loop); both are now validated.
- `splitCommand` removed every argument equal to the command word, so
  `ai-referee review --out review` lost its `--out` value; only the
  positional occurrence is spliced now.

### Changed

- `package.json` gains `repository`, `keywords` and `author` metadata.
- `src/cli.ts` runs `main()` only when executed directly — the module is
  now importable in tests.


## [Unreleased] — round 7 (2026-10-18)

### Added

- GitHub commit statuses: `commitStatus` config and `--status` on
  `review`/`daemon` posts a `pending` status on the PR head SHA when the
  review starts and `success`/`failure` with the verdict when it finishes
  (context `ai-referee`, via `gh api .../statuses/<sha>`). Requiring that
  context in branch protection makes the gate enforceable — merges block
  until ai-referee approves. Posting is best-effort like PR comments:
  failures land in `report.status.detail`, never flip the verdict; the
  final state lands after auto-merge so a failed merge reads `failure`.
  Markdown reports show a "Commit status" line.

## [Unreleased] — round 6 (2026-10-18)

### Added

- Parallel PR reviews in the daemon: `daemonConcurrency` config (1–8, default
  1) and `daemon --concurrency <n>`. One poll pass can now review a bounded
  pool of PRs at once; each PR still gets its own temporary worktree and its
  verdict is persisted independently — a failed review never starves the pool.
- Multi-line inline comments: findings may report `start_line` (first line of
  a contiguous range) alongside `line`. The verdict parser accepts
  `start_line`/`startLine` and drops malformed or out-of-order ranges; a range
  is posted as a GitHub `start_line`/`start_side` comment only when both ends
  land on diff lines — otherwise it degrades to a single-line comment.
  Markdown reports and review bodies render ranges as `file:start-end`.

### Changed

- PR head fetches no longer write `FETCH_HEAD`: `fetchPrHead` fetches
  `+refs/pull/<n>/head` into a scratch ref `refs/ai-referee/pr-<n>`
  (`--no-write-fetch-head`), which is dropped after the worktree exists.
  Shared `FETCH_HEAD` was the race that blocked parallel reviews; the "+"
  refspec also follows force-pushed heads instead of failing.
- Daemon state saves are serialized through a queue and written atomically
  (tmp file + rename): parallel workers can never tear the JSON file.



## [Unreleased] — round 5 (2026-10-18)

### Added

- Second-referee rejection confirmation: `confirmRejections` config and
  `--confirm` on `review`/`daemon`. A chunk REJECT is re-judged by the *next*
  reviewer in that chunk's chain (the judge never confirms itself) with the
  original findings contested in the prompt. Second referee approves → the
  rejection downgrades to a `warnings[]` entry; rejects → the gate reason
  reads "confirmed by \<name\>"; no second reviewer or unparseable output →
  the REJECT stands (fail closed). `ChunkResult.confirmation` records the
  outcome; confirmer findings merge into the report; confirm-phase calls are
  marked "(2nd opinion)" in the referee log.
- File-level PR comments: findings that resolve to a changed file but not to
  a diff line now post via `POST /pulls/{n}/comments` with
  `subject_type:"file"` (GitHub's bulk review endpoint does not accept
  file-level comments, so they go one-by-one, best-effort). Deleted/binary
  files and ambiguous paths still fall back to the review body.
- `jsonMode` on `api` reviewers sends
  `response_format: {type: "json_object"}` — fewer unparseable verdicts on
  OpenAI-compatible endpoints that support JSON mode.

## [Unreleased] — round 4 (2026-10-18)
### Added

- Stale review dismissal: posted PR reviews carry an invisible
  `<!-- ai-referee:review -->` marker; after each new verdict post,
  ai-referee `CHANGES_REQUESTED` reviews on older commits are dismissed via
  `gh api .../reviews/{id}/dismissals`. Dismissal is best-effort (recorded in
  `comments.detail`), touches only marked reviews, and never flips the verdict.
- `GateReport.warnings`: non-blocking issues surfaced separately from gate
  `reasons`; rendered as a "Warnings" section in Markdown reports.
- `test/daemon.test.ts`: `pollDelayMs` backoff curve and `daemon --once`
  smoke tests against a fake `gh`.

### Changed

- Light-profile gate semantics: a `light` chunk REJECT that cites no
  `blocker` finding now downgrades to a warning instead of blocking — the
  profile's "only merge-stoppers gate" contract is enforced at the gate, not
  just in the prompt. Zero-finding REJECTs still fail closed (they cannot be
  reclassified).
- Daemon scheduling: chained `setTimeout` replaces `setInterval`, so a slow
  review pass can never overlap the next poll. Consecutive `gh pr list`
  failures back off exponentially (2ⁿ⁻¹× base, capped at 8×) with the next
  delay logged.

## [Unreleased] — round 3 (2026-10-18)

### Added

- Review profiles: `strict` (default) reviews fully; `light` only rejects on
  merge-stoppers (crashes, data loss, security holes) — smaller findings stay
  at minor/info. Set via `profile` config, `--strict`/`--light` on `review`
  and `daemon`.
- Per-path reviewer routing (`routes` config): files matching route globs are
  chunked separately and reviewed only by that route's named reviewers, with
  optional per-route `profile` and `instructions` injected into the prompt.
  Multiple matching routes merge (reviewer union, first route's profile, all
  instructions). Routed chunks fail closed — they never fall back to the
  default chain, so sensitive code can't be approved by the wrong referee.
- `doctor` now lists each route's glob → reviewer mapping.
- Markdown referee log gains a route/profile column when any chunk is routed
  or non-strict; `ChunkResult` records `route` and `profile` in JSON reports.
- Config validation: duplicate reviewer names, routes with empty `match`/`reviewers`,
  and routes referencing unknown reviewer names are rejected at load.
  (Reviewer names must be unique — routes resolve them by name.)

## [Unreleased] — round 2 (2026-10-18)

### Added

- `--comment` (and `prComments` config): posts the gate verdict as a GitHub
  PR review via `gh api` — `APPROVE`/`REQUEST_CHANGES` event with findings
  anchored to diff lines as inline comments; unanchorable findings land in
  the review body. Posting failures never flip the verdict.
- Diff-aware line anchoring: `parseDiff` now maps new-side (RIGHT) line
  numbers (`FileDiff.rightLines`), so only lines GitHub actually accepts get
  inline comments; ambiguous paths refuse to anchor.
- `ai-referee doctor`: one-pass sanity check — repo, config, test command
  workdir, reviewer binaries/API keys, `gh` auth. Exit 0 healthy, 2 problems.
- Chunk-level parallelism: `reviewConcurrency` (default 2, max 8) reviews
  chunks in a worker pool with deterministic result order.
- Context enrichment: `contextBudget` (default 40k chars) appends post-change
  file bodies to prompts; `0` disables.
- Token usage: `api` reviewers capture `usage` into per-attempt logs and the
  summed `stats.tokens` in reports.
- `daemon --comment` posts each verdict to its PR.

### Changed

- `cliCommandBinary` now returns null for compound commands containing shell
  metacharacters — a missing binary behind a pipe/redirect is no longer
  masked by the precheck.

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

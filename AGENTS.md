# ai-referee — agent notes

Local, self-hosted merge gate. TypeScript, Node 22+, zero runtime dependencies.
Entry point: `src/cli.ts` → `dist/cli.js` (bin: `ai-referee`).

## Layout

| File | Responsibility |
|---|---|
| `src/cli.ts` | arg parsing, subcommands (`review`, `daemon`, `hook install`, `doctor`, `init`), exit codes; `main()` runs only when executed directly (importable for tests) |
| `src/review.ts` | pipeline: resolve target → diff → chunk → tests → review → verdict → optional fix round → optional gh merge/review post |
| `src/reviewer.ts` | reviewer adapters (`cli`, `api`), sequential fallback chain, `cliCommandBinary`, token usage capture |
| `src/comments.ts` | finding→inline-comment anchoring (rightLines) + GitHub PR review payload builder |
| `src/doctor.ts` | `doctor` sanity checks: repo, config, reviewer binaries/keys, gh auth |
|`src/routing.ts`|per-file route resolution (`planForFile`: reviewers, profile, instructions, fixer) and plan-aware chunking — routed/unrouted files never share a chunk|
| `src/verdict.ts` | strict verdict extraction/validation from messy model output |
| `src/diff.ts` | unified-diff splitting, glob matching, budget chunking, right-side line map |
| `src/config.ts` | `.ai-referee.json` loading (lenient JSON: comments + trailing commas) |
| `src/daemon.ts` | `gh pr list` polling loop, per-PR head-SHA dedupe, report files |
| `src/hook.ts` | pre-push hook installer (preserves foreign hooks) |
| `src/git.ts` | git/gh wrappers (argv only, validated PR/SHA/ref inputs); PR review uses `refs/pull/<n>/head` + temp worktree; SHA-bound merge |
| `src/exec.ts` | platform shell runner (`bash -c` / `cmd /d /s /c`) with timeout + output caps; never throws |
| `src/loose-json.ts` | comment/trailing-comma-tolerant JSON.parse |
| `src/report.ts` | Markdown + JSON report rendering |
| `src/prompt.ts` | reviewer/fixer prompt templates |

## Invariants — do not break

- **Fail closed.** Any missing/invalid verdict, dead reviewer chain, or test failure
  yields REJECT. Nothing may approve without a live reviewer verdict.
- **Routes fail closed too.** A routed chunk uses only its route's reviewers;
  never fall back to the default chain or the gate approves unreviewed code.
- **One fix round max.** Never loop fix→review.
- Reviewer output is untrusted: always via `parseVerdict`, never `JSON.parse` directly.
- CLI reviewer commands run via the platform shell (`bash -c` POSIX, `cmd /c`
  Windows) with `{prompt}`/`{prompt_file}`/stdin prompt passing — keep all
  three paths working.
- Exit codes: 0 APPROVE, 1 REJECT, 2 operational error.
- PR review posting is best-effort: failures land in `report.comments.detail`,
  never flip the verdict. Inline comments only on right-side lines that the
  diff actually shows (`FileDiff.rightLines`).
- No runtime deps in `dependencies` — stdlib only.
- **Merge only the reviewed SHA.** Diff, context and tests are bound to the
  pinned head SHA; `ghMergePr` re-checks the head and passes
  `--match-head-commit`. Never merge without a test run on that SHA.
- **No shell for data.** git/gh go through `runArgv`; validate PR numbers,
  SHAs and refs (`assertPrNumber`/`assertSha`/`assertRef`). `run` (shell) is
  only for command lines from the user's own config.
- **Untrusted input stays data.** Diff/file/README text goes inside
  `untrustedBlock` with the per-review nonce; verdicts are parsed with the
  nonce; contradictory verdicts fail closed. Config and README are read from
  the trusted checkout, never the PR worktree.

## Build/test

Builds and tests run on the sandbox only:
`npm ci && npm run check && npm test && npm run build` (in an isolated sandbox).

Test suite: `test/` — pipeline tests spin up throwaway git repos with fake
reviewer shell scripts; keep them hermetic (tmpdir only, no network).

# ai-referee — agent notes

Local, self-hosted merge gate. TypeScript, Node 20+, zero runtime dependencies.
Entry point: `src/cli.ts` → `dist/cli.js` (bin: `ai-referee`).

## Layout

| File | Responsibility |
|---|---|
| `src/cli.ts` | arg parsing, subcommands (`review`, `daemon`, `hook install`, `doctor`, `init`), exit codes |
| `src/review.ts` | pipeline: resolve target → diff → chunk → tests → review → verdict → optional fix round → optional gh merge/review post |
| `src/reviewer.ts` | reviewer adapters (`cli`, `api`), sequential fallback chain, `cliCommandBinary`, token usage capture |
| `src/comments.ts` | finding→inline-comment anchoring (rightLines) + GitHub PR review payload builder |
| `src/doctor.ts` | `doctor` sanity checks: repo, config, reviewer binaries/keys, gh auth |
|`src/routing.ts`|per-file route resolution (`planForFile`) and plan-aware chunking — routed/unrouted files never share a chunk|
| `src/verdict.ts` | strict verdict extraction/validation from messy model output |
| `src/diff.ts` | unified-diff splitting, glob matching, budget chunking, right-side line map |
| `src/config.ts` | `.ai-referee.json` loading (lenient JSON: comments + trailing commas) |
| `src/daemon.ts` | `gh pr list` polling loop, per-PR head-SHA dedupe, report files |
| `src/hook.ts` | pre-push hook installer (preserves foreign hooks) |
| `src/git.ts` | git/gh shell wrappers; PR review uses `refs/pull/<n>/head` + temp worktree |
| `src/exec.ts` | `bash -c` runner with timeout + output caps; never throws |
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
- CLI reviewer commands run via `bash -c` with `{prompt}`/`{prompt_file}`/stdin
  prompt passing — keep all three paths working.
- Exit codes: 0 APPROVE, 1 REJECT, 2 operational error.
- PR review posting is best-effort: failures land in `report.comments.detail`,
  never flip the verdict. Inline comments only on right-side lines that the
  diff actually shows (`FileDiff.rightLines`).
- No runtime deps in `dependencies` — stdlib only.

## Build/test

Builds and tests run on the sandbox only:
`cirak-run "npx tsc -p tsconfig.json --noEmit && npx vitest run"`.

Test suite: `test/` — pipeline tests spin up throwaway git repos with fake
reviewer shell scripts; keep them hermetic (tmpdir only, no network).

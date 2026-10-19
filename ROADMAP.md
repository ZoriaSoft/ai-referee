# Roadmap

ai-referee is a local-first, reviewer-agnostic, fail-closed merge gate: if
no referee answered, nothing merges.

## Shipped in 0.1.0

Review gate with fallback reviewer chains, strict/light profiles, per-path
routing, second-referee confirmation and one fix round; GitHub PR reviews,
inline comments, stale-review dismissal and commit statuses; daemon,
pre-push hook, `doctor` and `init`; SHA-bound auto-merge and
prompt-injection hardening. See `CHANGELOG.md` for details.

## Next

- [ ] Windows end-to-end verification. The `cmd.exe` path is unit-tested;
      it needs a manual smoke pass on Windows before claiming full support.
- [ ] Publish to npm.

## Ideas (unscheduled)

- `--staged` review target.
- `--stale <days>` daemon flag to re-review old approved heads.
- JSON Schema export for `.ai-referee.json`.
- Review caching by chunk hash.

## Known limits

- Reviewers see the diff, a README excerpt and file bodies within
  `contextBudget`; there is no cross-file symbol resolution.
- `cli` reviewer, test and fixer commands run via `bash` on POSIX and
  `cmd.exe` on Windows (best-effort; `%VAR%` expands inside quoted
  arguments under cmd).
- Daemon and PR modes need the `gh` CLI and a GitHub remote; local `--base`
  diffs work anywhere.
- One fix round by design; no iterative fix loops.
- LLM verdicts are heuristics, not proofs: the gate blocks low-quality
  changes, it does not guarantee correctness.

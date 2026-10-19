# Contributing

Issues and pull requests are welcome. By contributing you agree that your
work is released under the MIT license.

## Development

```bash
npm ci            # also builds dist/ via the prepare script
npm run check     # type-check
npm test          # vitest; hermetic: temp git repos, fake reviewers, no network
npm run build
```

Node.js 22 or newer is required. There is no hosted CI, so please run the
three commands above before opening a PR and mention the test summary in
the description.

## Invariants

These are the product; changes that weaken them need a very good reason.

- **Fail closed.** A missing or invalid verdict, a dead reviewer chain, a
  failing test suite or a contradictory answer yields REJECT. Nothing
  approves without a live reviewer verdict, and routed chunks never fall
  back to the default chain.
- **Merge only the reviewed SHA.** Diff, file context and tests are bound to
  the pinned PR head; `--merge` re-checks the head and passes
  `--match-head-commit`.
- **No shell for data.** git and gh run through `runArgv` with validated
  PR numbers, SHAs and refs. The shell is only used for command lines from
  the user's own config.
- **Reviewer output is untrusted.** Always parse it with `parseVerdict`;
  diff, file and README text go inside `untrustedBlock` with the per-review
  nonce.
- **Exit codes:** 0 APPROVE, 1 REJECT, 2 operational error.
- **No runtime dependencies.**

Tests that touch git create throwaway repositories in a temp directory and
use small shell scripts as fake reviewers or a fake `gh`; keep new tests
the same way.

## Reporting security issues

See [SECURITY.md](SECURITY.md).

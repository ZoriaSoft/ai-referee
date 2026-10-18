# ai-referee

A local, self-hosted **merge gate** for the AI-agent era.

AI agents open more pull requests than anyone can review by hand, and merging
them blind is how regressions ship. Most review bots are advisory comments, a
SaaS, or glued to GitHub Actions. ai-referee is different: it is a **gate**.

It runs your tests, sends the diff to an LLM through *any* agent CLI
(`claude`, `codex`, `gemini`, …) or any OpenAI-compatible API, and returns a
verdict you can wire to an exit code:

```
APPROVE → exit 0      REJECT → exit 1      couldn't run → exit 2
```

And when no reviewer answers — quota, network, missing binary — it **refuses
to approve**. *No referee, no merge.*

## 30-second quickstart

```bash
cd your-repo
npx ai-referee@latest init        # writes .ai-referee.json
# edit it: set testCommand + at least one reviewer
npx ai-referee@latest review      # review current branch vs its base
```

Minimal config (`.ai-referee.json`, comments allowed):

```jsonc
{
  "testCommand": "npm test",
  "reviewers": [
    { "name": "claude", "type": "cli", "command": "claude -p" },
    { "name": "codex",  "type": "cli", "command": "codex exec -" }
  ]
}
```

Review a GitHub PR in an isolated worktree (no checkout, no `gh pr checkout`):

```bash
npx ai-referee review --pr 137 --format markdown
```

Post the verdict back to the PR as a GitHub review — findings that anchor to
diff lines become inline comments, the rest go in the review body. Each posted
review carries an invisible `ai-referee` marker; when a new head gets reviewed,
superseded ai-referee `CHANGES_REQUESTED` reviews are dismissed automatically
so an old rejection cannot block a fixed PR. Human reviews are never touched:

```bash
npx ai-referee review --pr 137 --comment
```

Sanity-check the whole setup in one pass (config, reviewer binaries, API
keys, `gh` auth):

```bash
npx ai-referee doctor
```

Block bad pushes locally:

```bash
npx ai-referee hook install       # pre-push hook: gate → push or stop
```

Run a polling daemon that reviews every new PR head:

```bash
npx ai-referee daemon --interval 120       # add --once for a single pass
```

Polls run back-to-back, never overlapping: a slow review pass simply delays the
next cycle. When `gh` fails, the poll interval backs off exponentially (up to
8×) until the API recovers. To run it under systemd:

```ini
# ~/.config/systemd/user/ai-referee.service
[Unit]
Description=ai-referee PR merge gate
After=network-online.target

[Service]
WorkingDirectory=/home/you/your-repo
ExecStart=/usr/bin/npx ai-referee daemon --interval 120 --comment
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

Enable with `systemctl --user enable --now ai-referee.service`.

## How it works

1. **Resolve the diff.** Local: `git diff <base>…` (base defaults to the
   upstream, else the remote default branch; `--uncommitted` folds in working
   tree changes). PR: `git fetch origin refs/pull/<n>/head` into a disposable
   `git worktree` — your checkout is never touched.
2. **Run tests.** `testCommand` runs inside the target worktree. Failure is an
   independent REJECT reason.
3. **Chunk the diff.** Files are grouped under `chunkBudget` chars (default
   100k). Excluded paths (`*.lock`, `dist/**`, …) are counted but not sent.
   Oversized single files are truncated at a line boundary with a marker.
   Full file bodies are appended under `contextBudget` (default 40k) so the
   reviewer sees surrounding code, not just hunks.
   Files matched by a `route` are chunked separately and reviewed only by
   that route's reviewers, profile and instructions (see below).
4. **Review.** Chunks run `reviewConcurrency` at a time (default 2) against
   the reviewer chain in order — the first reviewer that produces output
   wins. Garbage output gets one retry nudge; unparseable output → that
   chunk fails → REJECT.
5. **Decide.** REJECT if tests failed, any chunk failed, or any chunk verdict
   is REJECT; otherwise APPROVE. Findings are deduplicated and severity-sorted.
   With `confirmRejections`/`--confirm`, every REJECT is re-judged by the
   *next* reviewer in the chain — the judge never confirms itself. A second
   referee that approves downgrades the rejection to a warning; an
   inconclusive check leaves it standing.
6. **Report.** Markdown (TTY) or JSON (piped), `--format`, `--out`.
7. **Optional:** `--fix` runs `fixerCommand` once on REJECT and re-reviews
   (local targets only). `--merge` runs `gh pr merge` on APPROVE (PR only).
   `--comment` posts a GitHub PR review: APPROVE or REQUEST_CHANGES with
   findings anchored to diff lines as inline comments; findings that resolve
   to a changed file but no diff line are posted as file-level comments.

## Review profiles and path routing

Two prompt profiles: **strict** (default) reviews fully; **light** only
rejects on merge-stoppers (crashes, data loss, security holes) and treats
everything else as minor/info findings. The gate mirrors that contract: a
light-profile REJECT that cites no `blocker` finding is downgraded to a
warning in the report instead of blocking — a REJECT with zero findings can't
be reclassified, so it still fails closed. Per run:

```bash
npx ai-referee review --light       # or --strict; or "profile" in config
```

`routes` send matching files to a named subset of the chain — e.g. a strong
security model for auth code while everything else uses the cheap default.
Routed and unrouted files never share a chunk, and a routed chunk **fails
closed** if its own referees are down — it never falls back to the default
chain.

```jsonc
"routes": [
  {
    "name": "security",                  // label in reports
    "match": ["src/auth/**", "**/*.pem"], // globs, same syntax as exclude
    "reviewers": ["claude-opus"],        // names from the reviewers list
    "profile": "strict",                 // optional per-route override
    "instructions": "check auth bypass and secret handling"
  }
]
```

A file matching several routes gets the union of their reviewers (route
order), the first route's profile, and all their instructions.

## Second referee: rejection confirmation

LLM judges sometimes reject on hallucinated findings. Set
`"confirmRejections": true` (or pass `--confirm` to `review`/`daemon`) and
every REJECT is contested before the *next* reviewer in that chunk's chain:
the confirmer sees the diff, the rejection and its findings, and must verify
them independently. Three outcomes:

- **Overruled** (second referee approves) → the rejection becomes a
  `warnings[]` entry instead of blocking. The rejection is recorded — not
  silently dropped.
- **Confirmed** (second referee rejects) → gate reason reads
  `reviewer rejected — confirmed by <name>`.
- **Inconclusive** (no second reviewer, unparseable output) → the REJECT
  stands; the gate never fails open on its own bookkeeping.

Costs one extra review call per rejected chunk; only meaningful with 2+
reviewers in the chain.

## Reviewer config

Ordered fallback chain — put your cheapest/most available reviewer first.

```jsonc
"reviewers": [
  // CLI reviewer: prompt is piped to stdin by default.
  { "name": "claude", "type": "cli", "command": "claude -p" },
  // {prompt} inlines it; {prompt_file} substitutes a temp file path:
  { "name": "gemini", "type": "cli", "command": "gemini -p {prompt_file}" },
  // OpenAI-compatible API — works with OpenAI, Groq, vLLM, Ollama…
  {
    "name": "openai",
    "type": "api",
    "url": "https://api.example.com/v1/chat/completions",
    "model": "gpt-5-mini",
    "apiKeyEnv": "OPENAI_API_KEY",
    "jsonMode": true,   // ask the endpoint for strict JSON output
    "timeoutMs": 300000
  }
]
```

A reviewer "fails" on missing binary, non-zero exit, empty output, timeout, or
HTTP error — the chain just moves on, and every attempt is logged in the report.

When an `api` reviewer reports `usage`, token counts are summed into
`stats.tokens` in the report and shown in the Markdown header.

## Full config reference

| Key | Default | Meaning |
|---|---|---|
| `testCommand` | `null` | Command that must pass; `null` disables the test step |
| `testTimeoutMs` | 600000 | Test timeout |
| `chunkBudget` | 100000 | Max diff chars per review chunk |
| `contextBudget` | 40000 | Max chars of full file bodies appended to prompts; `0` disables |
| `exclude` | locks, dist, min.js, snaps | Path globs skipped in review |
| `reviewers` | `[]` | Ordered fallback chain (see above) |
| `reviewConcurrency` | 2 | Chunks reviewed in parallel (1–8) |
| `fixerCommand` | `null` | Fixer CLI; gets findings on stdin, cwd = worktree |
| `fixerTimeoutMs` | 600000 | Fixer timeout |
| `autoMerge` | `false` | Allow `--merge`/`daemon --merge` |
| `prComments` | `false` | Post verdict + anchored findings as a GitHub PR review |
| `daemonIntervalSec` | 120 | Daemon poll interval |
| `confirmRejections` | `false` | Second referee verifies each REJECT (overruled → warning); `--confirm` per run |
| `workdir` | `null` | Subdirectory for test/fix commands (monorepos) |
| `profile` | `"strict"` | Default prompt profile; `--light`/`--strict` override per run |
| `routes` | `[]` | Per-path reviewer routing (see above) |

## Commands

```
ai-referee review [--pr N] [--base REF] [--uncommitted] [--fix] [--merge]
                  [--comment] [--confirm] [--skip-tests] [--strict | --light]
                  [--format md|json|both] [--out FILE]
ai-referee daemon [--interval SEC] [--once] [--merge] [--comment] [--fix]
                  [--confirm] [--strict | --light]
ai-referee hook install
ai-referee doctor
ai-referee init
```

## How this differs from existing tools

| Tool | Difference |
|---|---|
| pr-agent / Qodo Merge | SaaS-or-CI bot that posts advisory comments; ai-referee is a local gate with an exit code and no GitHub dependency for local diffs |
| git-ai-review, local-review | Great *reviewers*; they advise but don't gate — no test run, no verdict enforcement, no fallback chain |
| ai-git-hooks | Claude-only pre-push review; ai-referee is reviewer-agnostic with a fallback chain, PR worktrees, daemon mode and a fix round |
| AI reviewers in CI | Require GitHub Actions/secrets in the repo; ai-referee runs wherever your shell and keys already are |

The core differentiator is the **fail-closed contract**: advisory output that
can't be parsed is a rejection, an unavailable reviewer is a rejection, and a
failed test suite is a rejection. Everything else is plumbing.

## Limits

- Reviewer sees the diff plus a README excerpt and full file bodies under
  `contextBudget` — no cross-file symbol resolution.
- Reviewer/test commands run via `bash`; Windows is unsupported for now.
- PR/daemon modes need `gh` CLI authenticated and a GitHub `origin` remote.
- `--fix` runs once and only on local targets; it will not push to a PR branch.
- LLM review is a heuristic gate, not a correctness proof — it catches slop,
  it does not replace judgment on high-risk changes.

## Requirements

- Node.js ≥ 20 (uses `Promise.withResolvers`, `fetch`)
- `git` ≥ 2.38 (`git worktree`), `gh` for PR/daemon modes
- One reviewer: any agent CLI or OpenAI-compatible endpoint

## License

MIT — see [LICENSE](LICENSE). Turkish README: [README.tr.md](README.tr.md).

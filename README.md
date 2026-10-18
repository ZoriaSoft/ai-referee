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

Block bad pushes locally:

```bash
npx ai-referee hook install       # pre-push hook: gate → push or stop
```

Run a polling daemon that reviews every new PR head:

```bash
npx ai-referee daemon --interval 120       # add --once for a single pass
```

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
4. **Review.** Each chunk goes to the reviewer chain in order — the first
   reviewer that produces output wins. Garbage output gets one retry nudge;
   unparseable output → that chunk fails → REJECT.
5. **Decide.** REJECT if tests failed, any chunk failed, or any chunk verdict
   is REJECT; otherwise APPROVE. Findings are deduplicated and severity-sorted.
6. **Report.** Markdown (TTY) or JSON (piped), `--format`, `--out`.
7. **Optional:** `--fix` runs `fixerCommand` once on REJECT and re-reviews
   (local targets only). `--merge` runs `gh pr merge` on APPROVE (PR only).

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
    "timeoutMs": 300000
  }
]
```

A reviewer "fails" on missing binary, non-zero exit, empty output, timeout, or
HTTP error — the chain just moves on, and every attempt is logged in the report.

## Full config reference

| Key | Default | Meaning |
|---|---|---|
| `testCommand` | `null` | Command that must pass; `null` disables the test step |
| `testTimeoutMs` | 600000 | Test timeout |
| `chunkBudget` | 100000 | Max diff chars per review chunk |
| `exclude` | locks, dist, min.js, snaps | Path globs skipped in review |
| `reviewers` | `[]` | Ordered fallback chain (see above) |
| `fixerCommand` | `null` | Fixer CLI; gets findings on stdin, cwd = worktree |
| `fixerTimeoutMs` | 600000 | Fixer timeout |
| `autoMerge` | `false` | Allow `--merge`/`daemon --merge` |
| `daemonIntervalSec` | 120 | Daemon poll interval |
| `workdir` | `null` | Subdirectory for test/fix commands (monorepos) |

## Commands

```
ai-referee review [--pr N] [--base REF] [--uncommitted] [--fix] [--merge]
                  [--skip-tests] [--format md|json|both] [--out FILE]
ai-referee daemon [--interval SEC] [--once] [--merge] [--fix]
ai-referee hook install
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

- Reviewer sees the diff plus a README excerpt — no deep symbol context yet.
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

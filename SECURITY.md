# Security policy

ai-referee sits in front of code you did not write, so security reports are
very welcome.

## Reporting a vulnerability

Please use GitHub's
[private vulnerability reporting](https://github.com/ZoriaSoft/ai-referee/security/advisories/new)
instead of a public issue. Include the version or commit, your config
(redact keys), and steps to reproduce. We aim to acknowledge reports within
a few days.

## What counts

- A way for a pull request to get APPROVE without a live reviewer verdict
  (fail-open), or to make `--merge` merge a commit other than the reviewed
  SHA.
- Command or option injection through PR data (numbers, refs, branch names,
  file paths, diff content).
- A PR changing which config, test command or reviewers are used.
- Prompt-injection bypasses of the nonce-fenced prompt or verdict parsing
  that work reliably across models.

## Known limits (not vulnerabilities by themselves)

See the README "Security model" section: PR tests execute the PR's code
(sandbox the daemon), environment scrubbing is a seatbelt rather than
isolation, and a model that is fully talked into approving can approve.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { runArgv } from "./exec.js";

const BEGIN = "# >>> ai-referee hook >>>";
const END = "# <<< ai-referee hook <<<";
/** Marker written by 0.1.0 installers: everything after it was ours. */
const LEGACY_MARKER = "# ai-referee hook \u2014 do not edit below this line";

/**
 * Our block. It only exits on failure, so commands after it (a foreign hook
 * we were merged into) still run when the gate approves. stdin is closed
 * for the review: git feeds the pushed refs on stdin and a foreign hook
 * further down may need them.
 */
const BLOCK = `${BEGIN}
ai-referee review </dev/null
code=$?
if [ $code -ne 0 ]; then
  echo "ai-referee: push blocked (exit $code). See report above." >&2
  exit $code
fi
${END}
`;

/** Directory git actually runs hooks from (honours core.hooksPath and worktrees). */
export async function hooksDir(repoRoot: string): Promise<string> {
  const res = await runArgv("git", ["rev-parse", "--git-path", "hooks"], { cwd: repoRoot, timeoutMs: 15_000 });
  const out = res.stdout.trim();
  if (res.exitCode !== 0 || !out) return join(repoRoot, ".git", "hooks");
  return isAbsolute(out) ? out : resolve(repoRoot, out);
}

/** Inserts or refreshes our block in `existing` hook text (null = no hook yet). */
export function mergeHook(existing: string | null): string {
  if (!existing || !existing.trim()) return `#!/bin/sh\n${BLOCK}`;
  let text = existing;
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b !== -1 && e > b) {
    return text.slice(0, b) + BLOCK + text.slice(e + END.length).replace(/^\r?\n/, "");
  }
  const legacy = text.indexOf(LEGACY_MARKER);
  if (legacy !== -1) text = text.slice(0, legacy).trimEnd() + "\n";
  // Put our block right after the shebang so a foreign `exit 0` cannot skip it.
  const lines = text.split("\n");
  if (lines[0]?.startsWith("#!")) {
    const rest = lines.slice(1).join("\n").replace(/^\n+/, "");
    return `${lines[0]}\n${BLOCK}${rest ? "\n" + rest : ""}`;
  }
  return `#!/bin/sh\n${BLOCK}\n${text}`;
}

/** Installs the pre-push hook. Returns the hook path and whether one of ours was refreshed. */
export async function installHook(repoRoot: string): Promise<{ path: string; replaced: boolean }> {
  const dir = await hooksDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const hookPath = join(dir, "pre-push");

  let existing: string | null = null;
  try {
    existing = await readFile(hookPath, "utf8");
  } catch {
    // no existing hook
  }
  const replaced = existing !== null && (existing.includes(BEGIN) || existing.includes(LEGACY_MARKER));
  await writeFile(hookPath, mergeHook(existing), "utf8");
  await chmod(hookPath, 0o755);
  return { path: hookPath, replaced };
}

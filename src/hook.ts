import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HOOK_MARKER = "# ai-referee hook";

const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER} — do not edit below this line
ai-referee review
code=$?
if [ $code -ne 0 ]; then
  echo "ai-referee: push blocked (exit $code). See report above." >&2
fi
exit $code
`;

/** Installs the pre-push hook. Returns the hook path and whether it was fresh. */
export async function installHook(repoRoot: string): Promise<{ path: string; replaced: boolean }> {
  const hooksDir = join(repoRoot, ".git", "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-push");

  let existing: string | null = null;
  try {
    existing = await readFile(hookPath, "utf8");
  } catch {
    // no existing hook
  }

  if (existing?.includes(HOOK_MARKER)) {
    await writeFile(hookPath, HOOK_SCRIPT, "utf8");
    await chmod(hookPath, 0o755);
    return { path: hookPath, replaced: true };
  }
  if (existing) {
    // Prepend our block to a foreign hook instead of clobbering it.
    const merged = existing.trimEnd() + "\n\n" + HOOK_SCRIPT.replace("#!/bin/sh\n", "");
    await writeFile(hookPath, merged, "utf8");
  } else {
    await writeFile(hookPath, HOOK_SCRIPT, "utf8");
  }
  await chmod(hookPath, 0o755);
  return { path: hookPath, replaced: false };
}

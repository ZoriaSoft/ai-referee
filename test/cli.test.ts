import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isEntrypoint, resolveFormat, splitCommand } from "../src/cli.js";

describe("splitCommand", () => {
  it("defaults to review for bare flags and help with no args", () => {
    expect(splitCommand([]).command).toBe("help");
    expect(splitCommand(["--base", "main"])).toEqual({ command: "review", rest: ["--base", "main"] });
  });

  it("detects known subcommands", () => {
    expect(splitCommand(["daemon", "--once"])).toEqual({ command: "daemon", rest: ["--once"] });
    expect(splitCommand(["hook", "install"]).command).toBe("hook");
    expect(splitCommand(["doctor"]).command).toBe("doctor");
    expect(splitCommand(["init"]).command).toBe("init");
  });

  it("maps --version/-v to version", () => {
    expect(splitCommand(["--version"]).command).toBe("version");
    expect(splitCommand(["-v"]).command).toBe("version");
  });

  it("maps --help/-h to help", () => {
    expect(splitCommand(["--help"]).command).toBe("help");
    expect(splitCommand(["-h"]).command).toBe("help");
  });

  it("keeps a flag value that equals the command word", () => {
    // `review --out review` must not lose the --out argument.
    const parsed = splitCommand(["review", "--out", "review"]);
    expect(parsed.command).toBe("review");
    expect(parsed.rest).toEqual(["--out", "review"]);
  });

  it("keeps later occurrences and flag values elsewhere", () => {
    const parsed = splitCommand(["review", "--format", "daemon", "--base", "main"]);
    expect(parsed.command).toBe("review");
    expect(parsed.rest).toEqual(["--format", "daemon", "--base", "main"]);
  });

  it("treats an unknown positional as a review arg, not a command", () => {
    const parsed = splitCommand(["frobnicate", "--light"]);
    expect(parsed.command).toBe("review");
    expect(parsed.rest).toEqual(["frobnicate", "--light"]);
  });
});

describe("isEntrypoint", () => {
  it("matches the module through an npm-style bin symlink", async () => {
    const d = await mkdtemp(join(tmpdir(), "air-bin-"));
    try {
      const real = join(d, "cli.js");
      await writeFile(real, "");
      const link = join(d, "ai-referee");
      await symlink(real, link);
      const url = pathToFileURL(real).href;
      expect(isEntrypoint(real, url)).toBe(true);
      expect(isEntrypoint(link, url)).toBe(true);
      expect(isEntrypoint(join(d, "other.js"), url)).toBe(false);
      expect(isEntrypoint(undefined, url)).toBe(false);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("resolveFormat", () => {
  it("defaults by TTY, accepts md as markdown, rejects unknown values", () => {
    expect(resolveFormat("", true)).toBe("markdown");
    expect(resolveFormat(undefined, false)).toBe("json");
    expect(resolveFormat("md", false)).toBe("markdown");
    expect(resolveFormat("both", false)).toBe("both");
    expect(resolveFormat("xml", true)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { splitCommand } from "../src/cli.js";

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

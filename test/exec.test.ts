import { describe, expect, it } from "vitest";
import { locateCommand, run, shellCommand, shellEscape, which } from "../src/exec.js";

describe("shellCommand", () => {
  it("uses bash -c on POSIX platforms", () => {
    for (const p of ["linux", "darwin", "freebsd"] as const) {
      expect(shellCommand(p)).toEqual(["bash", "-c"]);
    }
  });

  it("uses cmd /d /s /c on Windows", () => {
    expect(shellCommand("win32")).toEqual(["cmd.exe", "/d", "/s", "/c"]);
  });
});

describe("shellEscape", () => {
  it("single-quotes and breaks out embedded quotes on POSIX", () => {
    expect(shellEscape("plain", "linux")).toBe("'plain'");
    expect(shellEscape("it's", "linux")).toBe("'it'\\''s'");
    expect(shellEscape("", "linux")).toBe("''");
  });

  it("double-quotes and escapes per CommandLineToArgvW on Windows", () => {
    expect(shellEscape("plain", "win32")).toBe('"plain"');
    expect(shellEscape('say "hi"', "win32")).toBe('"say \\"hi\\""');
    // Trailing backslashes double so they cannot escape the closing quote.
    expect(shellEscape("C:\\dir\\", "win32")).toBe('"C:\\dir\\\\"');
    // Backslashes before a quote double, then the quote is escaped.
    expect(shellEscape('a\\"b', "win32")).toBe('"a\\\\\\"b"');
  });
});

describe("locateCommand", () => {
  it("uses command -v on POSIX and where on Windows", () => {
    expect(locateCommand("gh", "linux")).toBe("command -v -- 'gh'");
    expect(locateCommand("gh", "win32")).toBe('where "gh"');
  });
});

describe("run / which on this platform", () => {
  it("captures stdout and exit code", async () => {
    const res = await run("echo hello && exit 3");
    expect(res.exitCode).toBe(3);
    expect(res.stdout.trim()).toBe("hello");
    expect(res.timedOut).toBe(false);
  });

  it("delivers stdin to the child", async () => {
    const res = await run("cat", { stdin: "piped in" });
    expect(res.stdout).toBe("piped in");
  });

  it("flags timeouts and kills the child", async () => {
    const res = await run("sleep 30", { timeoutMs: 200 });
    expect(res.timedOut).toBe(true);
  });

  it("truncates oversized output", async () => {
    const res = await run("yes x | head -c 1000000", { maxOutputBytes: 100 });
    expect(res.stdout.length).toBeLessThanOrEqual(140);
    expect(res.stdout).toContain("[output truncated]");
  });

  it("which resolves a real binary and misses a fake one", async () => {
    expect(await which("sh")).toContain("/");
    expect(await which("ai-referee-no-such-bin")).toBeNull();
  });
});

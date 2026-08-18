import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "lib", "cli.js");

/**
 * Run the built entry point as a child process, as a cron job would.
 *
 * The output is captured through a pipe, which is the case that matters: writes
 * to a pipe are asynchronous, and `process.exit()` would abandon anything still
 * buffered.
 */
async function cliRun(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1_024 * 1_024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function configWith(document: unknown): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), "wo-shim-"));
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(document));
  return { WEB_OBSERVER_CONFIG: file };
}

describe("the built entry point", () => {
  it("prints usage and exits 0 with no arguments", async () => {
    const result = await cliRun([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("web-observer <command>");
  });

  it("prints the version", async () => {
    const result = await cliRun(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exits 2 for an unknown command, with the message on stderr", async () => {
    const result = await cliRun(["explode"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("is not a Web Observer command");
    // Usage guidance belongs on stderr: on a scheduled run stdout is delivered
    // to a chat, and a usage dump is not an alert.
    expect(result.stdout).toBe("");
  });

  it("exits 2 when there is no configuration, naming the file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wo-shim-"));
    const result = await cliRun(["watch"], { WEB_OBSERVER_CONFIG: path.join(dir, "config.json") });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no configuration at");
  });

  it("exits 2 for a configuration that does not parse, quoting the parser", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wo-shim-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{ not json");
    const result = await cliRun(["watch"], { WEB_OBSERVER_CONFIG: file });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("is not valid JSON");
  });

  it("exits 2 and says which setting is wrong", async () => {
    const env = configWith({ uptime: { watches: [{ id: "a", url: "not-a-url" }] } });
    const result = await cliRun(["watch"], env);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("uptime.watches[0].url");
  });

  // A watch with nothing to check is a configuration error, not a silent success.
  it("exits 2 when uptime is enabled with no watches", async () => {
    const env = configWith({ uptime: { enabled: true, watches: [] } });
    const result = await cliRun(["watch"], env);
    expect(result.code).toBe(2);
  });
});

describe("output is never truncated", () => {
  /**
   * A configuration whose diagnosis is larger than one megabyte.
   *
   * The size is the point. `process.exit()` delivers about 1 MiB to a pipe and
   * abandons the rest while still reporting success, which for this tool would
   * mean a cut-off alert that looks like it was delivered intact. Long watch ids
   * are used because they need no network to produce a large answer.
   */
  function hugeConfig(): Record<string, string> {
    const watches = Array.from({ length: 1_600 }, (_unused, index) => ({
      // Under the tick, so doctor lists every offending id in one finding.
      id: `${String(index).padStart(5, "0")}${"x".repeat(700)}`,
      url: `https://host${index}.example`,
      intervalMinutes: 1,
    }));
    return configWith({
      notify: { channel: "telegram", to: "telegram:1" },
      uptime: { tickMinutes: 10, watches },
    });
  }

  it("delivers more than a megabyte of stdout intact, with the right exit code", async () => {
    const result = await cliRun(["doctor", "--json"], hugeConfig());
    expect(result.stdout.length).toBeGreaterThan(1_048_576);
    // Valid JSON is the assertion that matters: a truncated document would not
    // parse, and that is exactly how the failure would present.
    const document = JSON.parse(result.stdout) as { blocked_on: string };
    expect(document.blocked_on).toBe("interval_shorter_than_tick");
    expect(result.code).toBe(2);
  }, 60_000);
});

describe("the shim itself", () => {
  const source = readFileSync(cli, "utf8");

  // Both halves matter. `process.exit()` truncates a piped write; setting
  // `exitCode` lets Node exit once the event loop drains, which flushes it.
  it("sets process.exitCode", () => {
    expect(source).toContain("process.exitCode");
  });

  it("never calls process.exit", () => {
    expect(source).not.toMatch(/process\.exit\(/);
  });

  it("delegates to main rather than holding logic of its own", () => {
    expect(source).toContain("main(process.argv.slice(2)");
  });
});

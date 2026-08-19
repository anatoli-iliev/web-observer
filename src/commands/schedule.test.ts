import { describe, expect, it } from "vitest";

import { captureStreams } from "../cli/render.js";
import { parseConfig, type Config } from "../config.js";
import { cronAddArgv, plannedJobs, plural, runScheduleCommand, shellQuote } from "./schedule.js";

const CLI = "/skills/web-observer/lib/cli.js";

function configOf(document: Record<string, unknown>): Config {
  return parseConfig({ notify: { channel: "telegram", to: "telegram:1" }, ...document });
}

const UPTIME = configOf({
  uptime: { tickMinutes: 5, watches: [{ id: "a", url: "https://a.example", intervalMinutes: 10 }] },
});

describe("which jobs a configuration calls for", () => {
  // The composability requirement: uptime alone means one job and no mention of
  // a credential for anything else.
  it("plans one job for uptime alone", () => {
    const jobs = plannedJobs(UPTIME);
    expect(jobs.map((job) => job.name)).toEqual(["web-observer-uptime"]);
  });

  it("plans nothing for a configuration with everything off", () => {
    expect(plannedJobs(parseConfig({}))).toEqual([]);
  });

  it("plans a separate job per enabled Vercel watch", () => {
    const config = configOf({
      vercel: {
        enabled: true,
        project: "p",
        errors: { intervalMinutes: 15 },
        budget: { metrics: { lcp: 2500 } },
      },
    });
    expect(plannedJobs(config).map((job) => job.name)).toEqual([
      "web-observer-vercel-errors",
      "web-observer-vercel-budget",
    ]);
  });

  it("plans a digest on a cron expression rather than an interval", () => {
    const config = configOf({ ga4: { enabled: true, property: "1", digest: { cron: "0 9 * * 1" } } });
    const job = plannedJobs(config)[0];
    expect(job?.schedule).toEqual({ kind: "cron", value: "0 9 * * 1" });
  });

  it("plans all four when everything is on", () => {
    const config = configOf({
      uptime: { watches: [{ id: "a", url: "https://a.example" }] },
      vercel: { enabled: true, project: "p", errors: {}, budget: { metrics: { lcp: 2500 } } },
      ga4: { enabled: true, property: "1", digest: {} },
    });
    expect(plannedJobs(config)).toHaveLength(4);
  });

  it("explains each job in words a person can check", () => {
    expect(plannedJobs(UPTIME)[0]?.why).toContain("every 5 minutes");
    expect(plannedJobs(UPTIME)[0]?.why).toContain("10 minutes");
  });
});

describe("the timeout on the generated job", () => {
  // Cron's default is 30 seconds, and one watch allowed two ten-second attempts
  // with a ten-second pause between them already reaches exactly that. Left at
  // the default, real rounds would be killed halfway through.
  it("is longer than OpenClaw's 30 second default", () => {
    expect(plannedJobs(UPTIME)[0]?.timeoutSeconds).toBeGreaterThan(30);
  });

  it("grows with a slower watch", () => {
    const slow = configOf({
      uptime: {
        watches: [
          { id: "a", url: "https://a.example", timeoutMs: 60_000, attempts: 3, retryDelayMs: 20_000 },
        ],
      },
    });
    expect(plannedJobs(slow)[0]?.timeoutSeconds).toBeGreaterThan(
      plannedJobs(UPTIME)[0]?.timeoutSeconds ?? 0,
    );
  });
});

describe("the cron add command", () => {
  const argv = cronAddArgv(plannedJobs(UPTIME)[0]!, UPTIME, CLI);

  it("names the job so it can be found again", () => {
    expect(argv).toContain("--name");
    expect(argv).toContain("web-observer-uptime");
  });

  // Announce is what delivers stdout. Without it the job runs, decides correctly
  // that a site is down, and tells nobody.
  it("asks for announce delivery to the configured target", () => {
    expect(argv).toContain("--announce");
    expect(argv).toContain("--channel");
    expect(argv).toContain("telegram");
    expect(argv).toContain("--to");
    expect(argv).toContain("telegram:1");
  });

  it("uses a command payload, not an agent message", () => {
    expect(argv).toContain("--command");
    expect(argv).not.toContain("--message");
  });

  // A cron job runs with the Gateway's working directory, verified as
  // the user's home directory rather than the skill's, so a relative path cannot work.
  it("embeds an absolute path to the entry point", () => {
    const command = argv[argv.indexOf("--command") + 1] ?? "";
    expect(command).toContain(CLI);
    expect(command.startsWith("node ")).toBe(true);
  });

  it("passes an explicit timeout", () => {
    expect(argv).toContain("--timeout-seconds");
  });
});

describe("shell quoting", () => {
  it("quotes a path with a space so it stays one argument", () => {
    expect(shellQuote("/a path/cli.js")).toBe("'/a path/cli.js'");
  });

  it("survives a single quote in a path", () => {
    expect(shellQuote("/it's/cli.js")).toBe(`'/it'\\''s/cli.js'`);
  });
});

describe("plural", () => {
  it("agrees in number", () => {
    expect(plural(1, "minute")).toBe("1 minute");
    expect(plural(2, "minute")).toBe("2 minutes");
    expect(plural(0, "minute")).toBe("0 minutes");
  });
});

describe("the schedule command", () => {
  const deps = (existing: string[] = []) => {
    const created: string[][] = [];
    return {
      created,
      runOpenclaw: async (argv: readonly string[]) => {
        created.push([...argv]);
        return { code: 0, stdout: "", stderr: "" };
      },
      existingJobNames: async () => existing,
    };
  };

  // Creating background jobs that message somebody should not be a side effect
  // of asking what would be created.
  it("prints without creating anything by default", async () => {
    const streams = captureStreams();
    const dependencies = deps();
    const code = await runScheduleCommand(
      { config: UPTIME, configFile: "/c.json", streams, cliPath: CLI },
      { apply: false, json: false },
      dependencies,
    );
    expect(code).toBe(0);
    expect(dependencies.created).toEqual([]);
    expect(streams.stdout()).toContain("openclaw cron add");
  });

  it("creates the jobs with --apply", async () => {
    const streams = captureStreams();
    const dependencies = deps();
    const code = await runScheduleCommand(
      { config: UPTIME, configFile: "/c.json", streams, cliPath: CLI },
      { apply: true, json: false },
      dependencies,
    );
    expect(code).toBe(0);
    expect(dependencies.created).toHaveLength(1);
    expect(dependencies.created[0]?.slice(0, 2)).toEqual(["cron", "add"]);
  });

  // Re-running --apply must not create a second job that alerts in parallel.
  it("skips a job that already exists rather than duplicating it", async () => {
    const streams = captureStreams();
    const dependencies = deps(["web-observer-uptime"]);
    await runScheduleCommand(
      { config: UPTIME, configFile: "/c.json", streams, cliPath: CLI },
      { apply: true, json: false },
      dependencies,
    );
    expect(dependencies.created).toEqual([]);
    expect(streams.stderr()).toContain("already exists");
  });

  it("says an existing job is already there when only printing", async () => {
    const streams = captureStreams();
    await runScheduleCommand(
      { config: UPTIME, configFile: "/c.json", streams, cliPath: CLI },
      { apply: false, json: false },
      deps(["web-observer-uptime"]),
    );
    expect(streams.stdout()).toContain("already exists");
  });

  it("refuses when nothing is enabled", async () => {
    const streams = captureStreams();
    const code = await runScheduleCommand(
      { config: parseConfig({}), configFile: "/c.json", streams, cliPath: CLI },
      { apply: false, json: false },
      deps(),
    );
    expect(code).toBe(2);
    expect(streams.stderr()).toContain("nothing to schedule");
  });

  // A job with no destination runs and decides correctly, and tells nobody.
  it("refuses when there is nowhere to deliver an alert", async () => {
    const streams = captureStreams();
    const code = await runScheduleCommand(
      {
        config: parseConfig({
          uptime: { watches: [{ id: "a", url: "https://a.example" }] },
        }),
        configFile: "/c.json",
        streams,
        cliPath: CLI,
      },
      { apply: false, json: false },
      deps(),
    );
    expect(code).toBe(2);
    expect(streams.stderr()).toContain("nowhere to deliver");
  });

  it("reports a creation failure as exit 1", async () => {
    const streams = captureStreams();
    const code = await runScheduleCommand(
      { config: UPTIME, configFile: "/c.json", streams, cliPath: CLI },
      { apply: true, json: false },
      {
        runOpenclaw: async () => ({ code: 1, stdout: "", stderr: "gateway not running" }),
        existingJobNames: async () => [],
      },
    );
    expect(code).toBe(1);
    expect(streams.stderr()).toContain("gateway not running");
  });

  it("emits machine-readable jobs with --json", async () => {
    const streams = captureStreams();
    await runScheduleCommand(
      { config: UPTIME, configFile: "/c.json", streams, cliPath: CLI },
      { apply: false, json: true },
      deps(),
    );
    const document = JSON.parse(streams.stdout()) as { jobs: Array<{ name: string; argv: string[] }> };
    expect(document.jobs[0]?.name).toBe("web-observer-uptime");
    expect(document.jobs[0]?.argv).toContain("--announce");
  });
});

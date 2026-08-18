import { describe, expect, it } from "vitest";

import { captureStreams } from "../cli/render.js";
import { parseConfig, type Config } from "../config.js";
import { freshState, saveState, type State } from "../state.js";
import type { RunResult } from "../bridge/delegate.js";
import type { CredentialResult } from "../bridge/credentials.js";
import type { VercelStatus } from "../bridge/vercel.js";
import { toSafeEntries } from "../bridge/vercel.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MAX_WINDOW_MINUTES,
  partitionNew,
  runVercelWatch,
  windowFor,
} from "./vercelWatch.js";

const MINUTE = 60_000;

function configOf(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({
    notify: { channel: "telegram", to: "telegram:1" },
    vercel: {
      enabled: true,
      project: "dobri-web",
      errors: { intervalMinutes: 15, windowMinutes: 20, threshold: 0 },
      ...overrides,
    },
  });
}

function entriesOf(ids: readonly string[], status = 500) {
  return toSafeEntries(
    {
      query: {},
      entries: ids.map((id) => ({
        requestId: id,
        timestamp: "2026-08-18T20:18:47Z",
        status,
        method: "GET",
        path: "/api/x",
        route: "/api/x",
        crashed: false,
        isError: true,
        level: "error",
        message: "boom",
      })),
      truncated: false,
      notes: [],
    },
    false,
  ).entries;
}

function okResult(ids: readonly string[]): RunResult {
  return {
    code: 0,
    stdout: JSON.stringify({
      query: { since: "x", until: "y" },
      entries: ids.map((id) => ({
        requestId: id,
        timestamp: "2026-08-18T20:18:47Z",
        status: 500,
        method: "GET",
        path: "/api/x",
        route: "/api/x",
        crashed: false,
        isError: true,
        level: "error",
        message: "boom",
      })),
      truncated: false,
      notes: [],
    }),
    stderr: "",
    timedOut: false,
    spawnFailed: false,
  };
}

const READY: VercelStatus = {
  kind: "ready",
  hasLogs: true,
  python: "python3",
  location: { slug: "vercel-insights", dir: "/skills/vercel-insights", source: "test", version: "1.1.0" },
};

const CREDENTIALS: CredentialResult = {
  env: { VERCEL_TOKEN: "t" },
  problems: [],
  sources: { VERCEL_TOKEN: "test" },
};

/** A scratch directory holding a state file, so persistence is real. */
function scratch(state: State = freshState()): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wo-vercel-"));
  const file = path.join(dir, "state.json");
  saveState(file, state);
  return file;
}

async function poll(
  stateFile: string,
  results: readonly RunResult[],
  nowMs: number,
  config = configOf(),
): Promise<{ message: string; code: number; state: State; stderr: string }> {
  const streams = captureStreams();
  let index = 0;
  const outcome = await runVercelWatch(
    {
      config,
      configFile: "/config.json",
      stateFile,
      streams,
      env: {},
      now: () => nowMs,
    },
    {
      status: READY,
      credentials: CREDENTIALS,
      invoke: async () => results[Math.min(index++, results.length - 1)] as RunResult,
    },
    { dryRun: false },
  );
  saveState(stateFile, outcome.state);
  return { message: outcome.message, code: outcome.code, state: outcome.state, stderr: streams.stderr() };
}

describe("the poll window", () => {
  it("asks for the configured window on a first poll", () => {
    expect(windowFor(20, 15, null)).toBe(20);
  });

  it("keeps the configured window when polls are on time", () => {
    expect(windowFor(20, 15, 15)).toBe(20);
  });

  // The gap case: the Gateway was off, so the next poll has to reach back over
  // the whole gap or the errors in it are never seen.
  it("widens to cover a gap, plus the configured overlap", () => {
    // Two hours missed, overlap of five minutes.
    expect(windowFor(20, 15, 120)).toBe(125);
  });

  it("never asks for less than the configured window", () => {
    expect(windowFor(20, 15, 1)).toBe(20);
  });

  // Widening without limit would eventually ask for a window that costs many
  // pages to fetch and can only return what retention still holds.
  it("caps how far back it will ever reach", () => {
    expect(windowFor(20, 15, 100_000)).toBe(MAX_WINDOW_MINUTES);
  });

  it("keeps at least a minute of overlap even when window equals interval", () => {
    // parseConfig refuses this combination; the function still must not produce
    // a window with no overlap if it is ever called with one.
    expect(windowFor(15, 15, 30)).toBeGreaterThan(30);
  });
});

describe("deduplicating across overlapping windows", () => {
  it("treats an unseen id as new", () => {
    const { fresh, repeated } = partitionNew(entriesOf(["a", "b"]), {});
    expect(fresh.map((entry) => entry.requestId)).toEqual(["a", "b"]);
    expect(repeated).toBe(0);
  });

  it("skips an id already reported", () => {
    const { fresh, repeated } = partitionNew(entriesOf(["a", "b"]), { a: 1 });
    expect(fresh.map((entry) => entry.requestId)).toEqual(["b"]);
    expect(repeated).toBe(1);
  });

  // A failing request is not less real for lacking an id, and dropping it would
  // undercount an incident.
  it("keeps an entry with no id, and counts it", () => {
    const { fresh, withoutId } = partitionNew(entriesOf([""]), {});
    expect(fresh).toHaveLength(1);
    expect(withoutId).toBe(1);
  });
});

describe("the error watch, end to end", () => {
  it("alerts on the first new errors, naming counts and routes", async () => {
    const file = scratch();
    const first = await poll(file, [okResult(["a", "b", "c"])], 1_000_000);
    expect(first.message).toContain("3 new errors");
    expect(first.message).toContain("3 x 500");
    expect(first.message).toContain("/api/x");
    expect(first.code).toBe(0);
    expect(first.state.vercel.alerting).toBe(true);
  });

  // The overlap is designed to re-report; the dedupe is what makes it silent.
  it("stays silent when an overlapping window returns the same errors", async () => {
    const file = scratch();
    await poll(file, [okResult(["a", "b"])], 1_000_000);
    const second = await poll(file, [okResult(["a", "b"])], 1_000_000 + 16 * MINUTE);
    expect(second.message).toBe("NO_REPLY");
  });

  it("alerts again for a genuinely new error after an overlap", async () => {
    const file = scratch();
    await poll(file, [okResult(["a"])], 1_000_000);
    const second = await poll(file, [okResult(["a", "b"])], 1_000_000 + 16 * MINUTE);
    expect(second.message).toContain("1 new error");
  });

  it("sends one recovery message when a window comes back clean", async () => {
    const file = scratch();
    await poll(file, [okResult(["a"])], 1_000_000);
    const clean = await poll(file, [okResult([])], 1_000_000 + 16 * MINUTE);
    expect(clean.message).toContain("no Vercel errors");
    const quiet = await poll(file, [okResult([])], 1_000_000 + 32 * MINUTE);
    expect(quiet.message).toBe("NO_REPLY");
  });

  it("does not poll again before the interval has passed", async () => {
    const file = scratch();
    await poll(file, [okResult(["a"])], 1_000_000);
    const tooSoon = await poll(file, [okResult(["b"])], 1_000_000 + MINUTE);
    expect(tooSoon.message).toBe("NO_REPLY");
  });

  it("honours a threshold above zero", async () => {
    const file = scratch();
    const config = configOf({ errors: { intervalMinutes: 15, windowMinutes: 20, threshold: 2 } });
    const under = await poll(file, [okResult(["a", "b"])], 1_000_000, config);
    expect(under.message).toBe("NO_REPLY");
    const over = await poll(file, [okResult(["a", "b", "c"])], 1_000_000 + 16 * MINUTE, config);
    expect(over.message).toContain("new error");
  });

  it("never puts application log text in the alert by default", async () => {
    const file = scratch();
    const result = okResult(["a"]);
    const parsed = JSON.parse(result.stdout) as { entries: Array<Record<string, unknown>> };
    parsed.entries[0]!["message"] = "SECRET-abc123";
    const alert = await poll(file, [{ ...result, stdout: JSON.stringify(parsed) }], 1_000_000);
    expect(alert.message).not.toContain("SECRET-abc123");
    // And it tells the reader how to look, rather than pretending there is
    // nothing more to see.
    expect(alert.message).toContain("web-observer vercel errors");
  });
});

describe("when the poll itself fails", () => {
  const failure: RunResult = {
    code: 1,
    stdout: "",
    stderr: "error: HTTP 403 forbidden",
    timedOut: false,
    spawnFailed: false,
  };

  // A monitor problem and a site problem need different words: the thing to look
  // at is the token, not the application.
  it("says the check failed rather than that the site is broken", async () => {
    const file = scratch();
    const result = await poll(file, [failure], 1_000_000);
    expect(result.message).toContain("could not check Vercel errors");
    expect(result.message).toContain("not necessarily with the site");
    expect(result.code).toBe(1);
  });

  it("reports a failure once rather than every poll", async () => {
    const file = scratch();
    await poll(file, [failure], 1_000_000);
    const second = await poll(file, [failure], 1_000_000 + 16 * MINUTE);
    expect(second.message).toBe("NO_REPLY");
  });

  it("says so when it can reach Vercel again", async () => {
    const file = scratch();
    await poll(file, [failure], 1_000_000);
    const recovered = await poll(file, [okResult([])], 1_000_000 + 16 * MINUTE);
    expect(recovered.message).toContain("can reach Vercel logs");
  });

  it("reports a configuration error as exit 2, not as a network failure", async () => {
    const file = scratch();
    const result = await poll(
      file,
      [{ code: 2, stdout: "", stderr: "error: --limit is out of range", timedOut: false, spawnFailed: false }],
      1_000_000,
    );
    expect(result.code).toBe(2);
  });

  it("does not treat unreadable output as a healthy site", async () => {
    const file = scratch();
    const result = await poll(
      file,
      [{ code: 0, stdout: "not json at all", stderr: "", timedOut: false, spawnFailed: false }],
      1_000_000,
    );
    expect(result.code).toBe(1);
    expect(result.message).toBe("");
    expect(result.stderr).toContain("could not read");
  });
});

describe("the budget watch", () => {
  const budgetConfig = parseConfig({
    notify: { channel: "telegram", to: "telegram:1" },
    vercel: {
      enabled: true,
      project: "p",
      errors: { enabled: false },
      budget: { intervalMinutes: 360, metrics: { lcp: 2500 } },
    },
  });

  // Exit 3 is the delegated skill's "worked, and the answer is bad news".
  it("alerts once on exit 3 and recovers once on exit 0", async () => {
    const file = scratch();
    const over: RunResult = {
      code: 3,
      stdout: "metric  p75\nlcp     3100",
      stderr: "",
      timedOut: false,
      spawnFailed: false,
    };
    const first = await poll(file, [over], 1_000_000, budgetConfig);
    expect(first.message).toContain("over budget");
    expect(first.message).toContain("lcp");

    const again = await poll(file, [over], 1_000_000 + 400 * MINUTE, budgetConfig);
    expect(again.message).toBe("NO_REPLY");

    const under: RunResult = { code: 0, stdout: "fine", stderr: "", timedOut: false, spawnFailed: false };
    const recovered = await poll(file, [under], 1_000_000 + 800 * MINUTE, budgetConfig);
    expect(recovered.message).toContain("back within budget");
  });
});

describe("configuration refusals", () => {
  it("refuses to run when the module is off, and says nothing to the chat", async () => {
    const streams = captureStreams();
    const outcome = await runVercelWatch(
      {
        config: parseConfig({}),
        configFile: "/config.json",
        stateFile: scratch(),
        streams,
        env: {},
        now: () => 1,
      },
      { status: READY, credentials: CREDENTIALS, invoke: async () => okResult([]) },
      { dryRun: false },
    );
    expect(outcome.code).toBe(2);
    // Nothing on stdout: a configuration problem belongs in the run log, not in
    // the chat where alerts about sites appear.
    expect(streams.stdout()).toBe("");
    expect(streams.stderr()).toContain("switched off");
  });

  it("refuses when no token can be read, naming the reason", async () => {
    const streams = captureStreams();
    const outcome = await runVercelWatch(
      {
        config: configOf(),
        configFile: "/config.json",
        stateFile: scratch(),
        streams,
        env: {},
        now: () => 1,
      },
      {
        status: READY,
        credentials: { env: {}, problems: [], sources: {} },
        invoke: async () => okResult([]),
      },
      { dryRun: false },
    );
    expect(outcome.code).toBe(2);
    expect(streams.stderr()).toContain("no Vercel token");
    expect(streams.stderr()).toContain("Gateway's");
  });
});

describe("a dry run", () => {
  it("prints the message to stderr, the silent token to stdout, and saves nothing", async () => {
    const file = scratch();
    const streams = captureStreams();
    const outcome = await runVercelWatch
      (
        {
          config: configOf(),
          configFile: "/config.json",
          stateFile: file,
          streams,
          env: {},
          now: () => 1_000_000,
        },
        { status: READY, credentials: CREDENTIALS, invoke: async () => okResult(["a"]) },
        { dryRun: true },
      );
    expect(streams.stdout().trim()).toBe("NO_REPLY");
    expect(streams.stderr()).toContain("new error");
    // The returned state is the one loaded, so a dry run cannot consume the one
    // alert a real incident is entitled to.
    expect(outcome.state.vercel.alerting).toBe(false);
  });
});

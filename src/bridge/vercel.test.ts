import { describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import {
  budgetArgv,
  errorsArgv,
  hasLogsSurface,
  LOGS_INSTALL_HINT,
  REQUIRED_LOGS_REF,
  rejectUnknownPreset,
  tally,
  toSafeEntries,
  VERCEL_LOG_PRESETS,
} from "./vercel.js";

/**
 * A row shaped like the live `errors --json` output.
 *
 * The unsafe fields carry a marker string. Every test that checks the redaction
 * boundary looks for that marker rather than for a field name, so a rename
 * cannot make the test pass by looking for something that no longer exists.
 */
const LEAK = "sk-live-DO-NOT-FORWARD-9f3a";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "abc-1787084327029-710ad73a2b68",
    timestamp: "2026-08-18T20:18:47.029000+00:00",
    status: 500,
    method: "GET",
    path: "/api/checkout",
    route: "/api/checkout",
    source: "serverless",
    environment: "production",
    deploymentId: "dpl_1",
    durationMs: 812,
    region: "fra1",
    errorCode: "",
    branch: "main",
    domain: "example.com",
    traceId: "t1",
    crashed: false,
    isError: true,
    level: "error",
    message: `Stripe call failed with key ${LEAK}`,
    lines: [{ level: "error", message: `token=${LEAK}`, truncated: false }],
    raw: { requestId: "abc", secretHeader: LEAK },
    ...overrides,
  };
}

function document(rows: Record<string, unknown>[], extra: Record<string, unknown> = {}): unknown {
  return {
    query: {
      project: "dobri-web",
      preset: "errors",
      since: "2026-08-18T20:00:00Z",
      until: "2026-08-18T20:20:00Z",
      filters: {},
      limit: 200,
    },
    entries: rows,
    truncated: false,
    pagesFetched: 1,
    notes: [],
    ...extra,
  };
}

describe("the redaction boundary", () => {
  // The single most important test in this file. The underlying skill scrubs only
  // its own Vercel token from log content, so anything the application printed
  // arrives verbatim. With includeMessages off, none of it may cross this seam.
  it("does not carry application log text out of the bridge by default", () => {
    const payload = toSafeEntries(document([row()]), false);
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(LEAK);
  });

  it("drops the message, the log lines and the raw row, not just the message", () => {
    const [entry] = toSafeEntries(document([row()]), false).entries;
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("message");
    expect(entry).not.toHaveProperty("lines");
    expect(entry).not.toHaveProperty("raw");
  });

  it("keeps every field that is safe to report", () => {
    const [entry] = toSafeEntries(document([row()]), false).entries;
    expect(entry).toEqual({
      requestId: "abc-1787084327029-710ad73a2b68",
      timestamp: "2026-08-18T20:18:47.029000+00:00",
      status: 500,
      method: "GET",
      path: "/api/checkout",
      route: "/api/checkout",
      level: "error",
      crashed: false,
      isError: true,
    });
  });

  it("carries the message only when the user opted in", () => {
    const payload = toSafeEntries(document([row()]), true);
    expect(payload.entries[0]?.message).toContain(LEAK);
    // Even opted in, the individual log lines and the raw row stay behind: the
    // opt-in is for a summary line, not for the whole row.
    expect(JSON.stringify(payload)).not.toContain("secretHeader");
  });
});

describe("reading the errors output", () => {
  it("refuses a document that is not an object rather than reporting no errors", () => {
    expect(() => toSafeEntries("not json", false)).toThrow(/not a JSON object/);
    expect(() => toSafeEntries(null, false)).toThrow(/not a JSON object/);
  });

  // A silently empty parse would report a healthy site, which is the worst
  // possible way to fail here.
  it("refuses a document with no entries array", () => {
    expect(() => toSafeEntries({ query: {} }, false)).toThrow(/no 'entries' array/);
  });

  it("accepts an empty result, which is a real answer", () => {
    const payload = toSafeEntries(document([]), false);
    expect(payload.entries).toEqual([]);
  });

  // Verified against a live row: this field arrives as null, not only absent.
  it("reads a null level as null", () => {
    expect(toSafeEntries(document([row({ level: null })]), false).entries[0]?.level).toBeNull();
  });

  it("reads a missing status as null rather than zero", () => {
    expect(toSafeEntries(document([row({ status: null })]), false).entries[0]?.status).toBeNull();
  });

  it("passes on the truncation flag and the notes", () => {
    const payload = toSafeEntries(
      document([row()], { truncated: true, notes: ["Runtime log retention is 1 hour on Hobby"] }),
      false,
    );
    expect(payload.truncated).toBe(true);
    expect(payload.notes[0]).toContain("retention");
  });

  it("skips a row that is not an object instead of failing the whole poll", () => {
    const payload = toSafeEntries(document([row(), "junk" as unknown as Record<string, unknown>]), false);
    expect(payload.entries).toHaveLength(1);
  });
});

describe("the error poll arguments", () => {
  const config = parseConfig({ vercel: { enabled: true, project: "dobri-web", errors: {} } });

  // Measured live: a window whose end is more than about an hour in the past is
  // refused with HTTP 400 ExceedsBillingLimitError, while any --since with the
  // end left at now succeeds. So there must be no way to express an end here.
  it("never asks for an end to the window", () => {
    expect(errorsArgv(config, 20)).not.toContain("--until");
  });

  it("asks only for a start, in minutes", () => {
    expect(errorsArgv(config, 45)).toEqual([
      "errors",
      "--since",
      "45m",
      "--json",
      "--limit",
      "200",
      "--project",
      "dobri-web",
    ]);
  });

  it("asks for the maximum rows, so a flood is not undercounted", () => {
    expect(errorsArgv(config, 20)).toContain("200");
  });
});

describe("the budget arguments", () => {
  it("passes one --budget per metric in NAME=VALUE form", () => {
    const config = parseConfig({
      vercel: { enabled: true, project: "p", budget: { metrics: { lcp: 2500, cls: 0.1 } } },
    });
    const argv = budgetArgv(config);
    expect(argv[0]).toBe("vitals");
    expect(argv).toContain("lcp=2500");
    expect(argv).toContain("cls=0.1");
    expect(argv.filter((part) => part === "--budget")).toHaveLength(2);
  });

  // The credential travels in the environment. A flag would put it in `ps` and
  // in any transcript a model can read.
  it("never puts a token on the command line", () => {
    const config = parseConfig({
      vercel: { enabled: true, project: "p", budget: { metrics: { lcp: 2500 } } },
    });
    expect(budgetArgv(config)).not.toContain("--token");
    expect(errorsArgv(config, 20)).not.toContain("--token");
  });
});

describe("the preset allowlist", () => {
  it("accepts a real preset", () => {
    expect(rejectUnknownPreset(["errors", "--since", "30m"])).toBeNull();
  });

  it("names the real presets when given a typo", () => {
    expect(rejectUnknownPreset(["erors"])).toContain("errors");
  });

  it("asks for a preset when given none", () => {
    expect(rejectUnknownPreset([])).toContain("name a preset");
  });

  it("refuses a flag in the preset position", () => {
    expect(rejectUnknownPreset(["--json"])).toContain("must be a preset");
  });

  it("knows which presets need the logs surface", () => {
    expect(VERCEL_LOG_PRESETS).toEqual(["logs", "errors", "error-summary"]);
  });
});

describe("feature detection", () => {
  // A feature test rather than a version comparison, so it keeps working when
  // the branch merges and the version changes, and cannot be fooled by a
  // version bumped without the feature.
  it("tests for the module that implements logs, not for a version", () => {
    expect(hasLogsSurface("/nonexistent")).toBe(false);
  });

  it("names the branch in the install hint, so the pin is visible to a user", () => {
    expect(LOGS_INSTALL_HINT).toContain(REQUIRED_LOGS_REF);
    expect(LOGS_INSTALL_HINT).toContain("openclaw skills install");
  });
});

describe("tallying", () => {
  it("counts by status, most frequent first", () => {
    const entries = toSafeEntries(
      document([row(), row({ requestId: "b", status: 502 }), row({ requestId: "c" })]),
      false,
    ).entries;
    expect(tally(entries).byStatus).toEqual([
      ["500", 2],
      ["502", 1],
    ]);
  });

  it("groups by route pattern rather than by concrete path", () => {
    const entries = toSafeEntries(
      document([
        row({ requestId: "a", route: "/api/user/[id]", path: "/api/user/1" }),
        row({ requestId: "b", route: "/api/user/[id]", path: "/api/user/2" }),
      ]),
      false,
    ).entries;
    expect(tally(entries).byRoute).toEqual([["/api/user/[id]", 2]]);
  });

  // A path is chosen by whoever made the request, so it is a fallback only.
  it("falls back to the path when no route was recorded", () => {
    const entries = toSafeEntries(document([row({ route: "", path: "/raw" })]), false).entries;
    expect(tally(entries).byRoute).toEqual([["/raw", 1]]);
  });

  it("reports a missing status as (none) rather than as 0", () => {
    const entries = toSafeEntries(document([row({ status: null })]), false).entries;
    expect(tally(entries).byStatus).toEqual([["(none)", 1]]);
  });
});

import { describe, expect, it } from "vitest";

import { captureStreams } from "../cli/render.js";
import { parseConfig, type Config } from "../config.js";
import { BLOCKED_ON_VALUES, diagnose, renderDoctor, type DoctorInput } from "./doctor.js";

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    config: parseConfig({}),
    configError: null,
    configFile: "/config.json",
    configExists: true,
    stateFile: "/state.json",
    // An empty environment means no skill is discoverable, which is what makes
    // the Vercel and GA4 branches testable without installing anything.
    env: { OPENCLAW_STATE_DIR: "/nonexistent" },
    cronJobNames: [],
    ...overrides,
  };
}

function uptimeConfig(document: Record<string, unknown> = {}): Config {
  return parseConfig({
    notify: { channel: "telegram", to: "telegram:1" },
    uptime: { watches: [{ id: "a", url: "https://a.example", intervalMinutes: 10 }], ...document },
  });
}

describe("blocking order", () => {
  // No point advising somebody to install a skill while the file does not parse.
  it("reports a missing configuration before anything else", () => {
    const report = diagnose(input({ configExists: false, config: null }));
    expect(report.blocked_on).toBe("no_config");
    expect(report.findings).toHaveLength(1);
  });

  it("reports an unparseable configuration and stops", () => {
    const report = diagnose(
      input({ config: null, configError: "config.uptime: must be an object" }),
    );
    expect(report.blocked_on).toBe("bad_config");
    expect(report.next).toContain("must be an object");
  });

  it("reports nothing enabled when every module is off", () => {
    expect(diagnose(input()).blocked_on).toBe("nothing_enabled");
  });

  it("says the modules are independent, so uptime alone is a real option", () => {
    const report = diagnose(input());
    expect(report.findings[1]?.detail).toContain("uptime needs no credentials");
  });
});

describe("a working uptime-only setup", () => {
  it("is ready once its job is scheduled", () => {
    const report = diagnose(
      input({ config: uptimeConfig(), cronJobNames: ["web-observer-uptime"] }),
    );
    expect(report.ok).toBe(true);
    expect(report.blocked_on).toBe("ok");
    expect(report.next).toBeNull();
  });

  // Nothing runs on its own without the cron job, which is the one step a person
  // is most likely to skip.
  it("is blocked when the cron job is missing", () => {
    const report = diagnose(input({ config: uptimeConfig(), cronJobNames: [] }));
    expect(report.blocked_on).toBe("no_cron_jobs");
    expect(report.next).toContain("web-observer schedule");
  });

  it("does not claim the schedule is wrong when it could not be read", () => {
    const report = diagnose(input({ config: uptimeConfig(), cronJobNames: null }));
    const finding = report.findings.find((entry) => entry.check === "scheduled jobs");
    expect(finding?.blocking).toBe(false);
    expect(finding?.detail).toContain("could not list");
  });

  it("is blocked without a delivery target", () => {
    const config = parseConfig({
      uptime: { watches: [{ id: "a", url: "https://a.example" }] },
    });
    expect(diagnose(input({ config })).blocked_on).toBe("no_notify_target");
  });
});

describe("cadence warnings", () => {
  // The one misconfiguration whose only symptom is a cadence silently different
  // from the one written down.
  it("blocks when a watch wants checking more often than the job runs", () => {
    const config = uptimeConfig({
      tickMinutes: 10,
      watches: [{ id: "fast", url: "https://a.example", intervalMinutes: 2 }],
    });
    const report = diagnose(input({ config, cronJobNames: ["web-observer-uptime"] }));
    expect(report.blocked_on).toBe("interval_shorter_than_tick");
    expect(report.next).toContain("fast");
  });

  it("warns without blocking when an interval is not a multiple of the tick", () => {
    const config = uptimeConfig({
      tickMinutes: 5,
      watches: [{ id: "odd", url: "https://a.example", intervalMinutes: 7 }],
    });
    const report = diagnose(input({ config, cronJobNames: ["web-observer-uptime"] }));
    expect(report.ok).toBe(true);
    const finding = report.findings.find((entry) => entry.check === "uptime cadence");
    expect(finding?.blocking).toBe(false);
    expect(finding?.detail).toContain("a little longer");
  });

  it("says nothing about cadence when every interval divides the tick", () => {
    const report = diagnose(
      input({ config: uptimeConfig({ tickMinutes: 5 }), cronJobNames: ["web-observer-uptime"] }),
    );
    expect(report.findings.some((entry) => entry.check === "uptime cadence")).toBe(false);
  });
});

describe("the optional skills", () => {
  it("blocks with an install command when the Vercel skill is absent", () => {
    const config = parseConfig({
      notify: { channel: "telegram", to: "telegram:1" },
      vercel: { enabled: true, project: "p" },
    });
    const report = diagnose(input({ config }));
    expect(report.blocked_on).toBe("vercel_skill_missing");
    expect(report.next).toContain("openclaw skills install");
  });

  it("blocks with an install command when the GA4 skill is absent", () => {
    const config = parseConfig({
      notify: { channel: "telegram", to: "telegram:1" },
      ga4: { enabled: true, property: "1" },
    });
    const report = diagnose(input({ config }));
    expect(report.blocked_on).toBe("ga4_skill_missing");
    expect(report.next).toContain("open-ga4");
  });

  // Uptime must not be held back by a skill it does not use.
  it("says nothing about either skill when only uptime is enabled", () => {
    const report = diagnose(
      input({ config: uptimeConfig(), cronJobNames: ["web-observer-uptime"] }),
    );
    const checks = report.findings.map((entry) => entry.check);
    expect(checks).not.toContain("vercel-insights skill");
    expect(checks).not.toContain("open-ga4 skill");
  });
});

describe("the report", () => {
  it("uses only declared blocked_on values", () => {
    const reports = [
      diagnose(input({ configExists: false, config: null })),
      diagnose(input()),
      diagnose(input({ config: uptimeConfig() })),
      diagnose(input({ config: uptimeConfig(), cronJobNames: ["web-observer-uptime"] })),
    ];
    for (const report of reports) {
      expect(BLOCKED_ON_VALUES).toContain(report.blocked_on);
    }
  });

  it("names exactly one next step, so a reader has one thing to do", () => {
    const report = diagnose(input({ config: uptimeConfig() }));
    expect(typeof report.next).toBe("string");
  });

  it("exits 2 when blocked and 0 when ready", () => {
    const blocked = diagnose(input());
    const ready = diagnose(input({ config: uptimeConfig(), cronJobNames: ["web-observer-uptime"] }));
    expect(renderDoctor(blocked, captureStreams(), { json: false })).toBe(2);
    expect(renderDoctor(ready, captureStreams(), { json: false })).toBe(0);
  });

  it("emits valid JSON with --json", () => {
    const streams = captureStreams();
    renderDoctor(diagnose(input()), streams, { json: true });
    const document = JSON.parse(streams.stdout()) as { blocked_on: string; findings: unknown[] };
    expect(document.blocked_on).toBe("nothing_enabled");
    expect(Array.isArray(document.findings)).toBe(true);
  });

  it("shows the config and state paths, so a reader knows which files matter", () => {
    const streams = captureStreams();
    renderDoctor(diagnose(input()), streams, { json: false });
    expect(streams.stdout()).toContain("/config.json");
    expect(streams.stdout()).toContain("/state.json");
  });
});

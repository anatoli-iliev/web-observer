import { describe, expect, it } from "vitest";

import { parseConfig, type Watch } from "../config.js";
import { formatEvents, humanDuration, SILENT_TOKEN, stamp } from "./format.js";
import type { UptimeEvent } from "./decide.js";

function watchOf(id: string, url = "https://example.com"): Watch {
  const config = parseConfig({ uptime: { watches: [{ id, url }] } });
  const watch = config.uptime.watches[0];
  if (!watch) throw new Error("test document produced no watch");
  return watch;
}

function downEvent(id: string, atMs = 1_700_000_000_000): UptimeEvent {
  return {
    kind: "down",
    watch: watchOf(id),
    atMs,
    result: {
      ok: false,
      reason: "timeout",
      detail: "no response before the timeout",
      status: null,
      durationMs: 10_000,
      attemptsUsed: 2,
      url: "https://example.com",
    },
  };
}

function upEvent(id: string, atMs = 1_700_000_060_000, downSinceMs: number | null = 1_700_000_000_000): UptimeEvent {
  return {
    kind: "recovered",
    watch: watchOf(id),
    atMs,
    downSinceMs,
    result: { ok: true, status: 200, durationMs: 120, attemptsUsed: 1, url: "https://example.com" },
  };
}

describe("silence", () => {
  // The whole notification mechanism: cron delivers stdout, and this exact token
  // is what suppresses that delivery. It must be the whole of the output.
  it("is exactly the silent token, with nothing alongside it", () => {
    expect(formatEvents([])).toBe(SILENT_TOKEN);
  });

  it("uses the token OpenClaw actually recognises", () => {
    expect(SILENT_TOKEN).toBe("NO_REPLY");
  });
});

describe("a down alert", () => {
  const message = formatEvents([downEvent("checkout")]);

  it("names the watch and the url", () => {
    expect(message).toContain("checkout");
    expect(message).toContain("https://example.com");
  });

  it("says it is down in words, not only with a colour", () => {
    expect(message).toContain("DOWN");
  });

  it("gives the reason in plain language and the detail behind it", () => {
    expect(message).toContain("timed out");
    expect(message).toContain("no response before the timeout");
  });

  it("says how many checks and requests it took to be sure", () => {
    expect(message).toMatch(/2 consecutive checks/);
    expect(message).toMatch(/2 requests/);
  });

  it("carries a timestamp", () => {
    expect(message).toMatch(/At: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}/);
  });

  // A single site failing should not be padded with a summary of itself.
  it("has no heading when there is only one event", () => {
    expect(message.startsWith("🔴")).toBe(true);
  });
});

describe("a recovery message", () => {
  it("says how long the outage lasted, measured from the first failure", () => {
    const message = formatEvents([upEvent("checkout")]);
    expect(message).toContain("back up");
    expect(message).toContain("1 minute");
  });

  it("omits the duration when the start of the outage is unknown", () => {
    const message = formatEvents([upEvent("checkout", 1_700_000_060_000, null)]);
    expect(message).not.toContain("Down for");
    expect(message).toContain("back up");
  });

  it("reports what the site returns now", () => {
    expect(formatEvents([upEvent("checkout")])).toContain("200");
  });
});

describe("several events in one run", () => {
  // A cron run produces exactly one delivery, so several events are one message.
  it("summarises the counts in a heading", () => {
    const message = formatEvents([downEvent("a"), downEvent("b"), upEvent("c")]);
    expect(message.split("\n")[0]).toBe("Web Observer: 2 down, 1 recovered");
  });

  it("includes every event's detail", () => {
    const message = formatEvents([downEvent("alpha"), upEvent("beta")]);
    expect(message).toContain("alpha");
    expect(message).toContain("beta");
  });

  it("mentions only the kinds that occurred", () => {
    expect(formatEvents([downEvent("a"), downEvent("b")]).split("\n")[0]).toBe(
      "Web Observer: 2 down",
    );
  });
});

describe("humanDuration", () => {
  it("reads in the units a person would use", () => {
    expect(humanDuration(500)).toBe("under a second");
    expect(humanDuration(1_000)).toBe("1 second");
    expect(humanDuration(45_000)).toBe("45 seconds");
    expect(humanDuration(60_000)).toBe("1 minute");
    expect(humanDuration(20 * 60_000)).toBe("20 minutes");
    expect(humanDuration(90 * 60_000)).toBe("1.5 hours");
    expect(humanDuration(72 * 3_600_000)).toBe("3 days");
  });

  it("agrees in number", () => {
    expect(humanDuration(3_600_000)).toBe("1 hour");
  });
});

describe("stamp", () => {
  it("includes the offset, so a time is unambiguous", () => {
    expect(stamp(1_700_000_000_000)).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/,
    );
  });
});

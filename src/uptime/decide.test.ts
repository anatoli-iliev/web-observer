import { describe, expect, it } from "vitest";

import { parseConfig, type Watch } from "../config.js";
import { freshWatchState, type WatchState } from "../state.js";
import { applyResult, dueWatches, isDue, type CheckResult, type UptimeEvent } from "./decide.js";

const MINUTE = 60_000;

function watchWith(overrides: Record<string, unknown> = {}): Watch {
  const config = parseConfig({
    uptime: { watches: [{ id: "site", url: "https://example.com", ...overrides }] },
  });
  const watch = config.uptime.watches[0];
  if (!watch) throw new Error("test document produced no watch");
  return watch;
}

function pass(url = "https://example.com"): CheckResult {
  return { ok: true, status: 200, durationMs: 12, attemptsUsed: 1, url };
}

function fail(reason: CheckResult extends { ok: false } ? never : "timeout" = "timeout"): CheckResult {
  return {
    ok: false,
    reason,
    detail: "no response within 10000 ms",
    status: null,
    durationMs: 10_000,
    attemptsUsed: 2,
    url: "https://example.com",
  };
}

/**
 * Feed a sequence of results through the state machine.
 *
 * Returns every event produced, which is exactly the list of messages a user
 * would have received, so a test can assert on "how many times was I told".
 */
function run(
  watch: Watch,
  results: readonly CheckResult[],
  startMs = 1_000_000,
): { events: UptimeEvent[]; state: WatchState } {
  let state = freshWatchState();
  const events: UptimeEvent[] = [];
  results.forEach((result, index) => {
    const applied = applyResult(watch, state, result, startMs + index * 5 * MINUTE);
    state = applied.state;
    if (applied.event) events.push(applied.event);
  });
  return { events, state };
}

describe("due-ness", () => {
  it("checks a watch that has never been checked", () => {
    expect(isDue(freshWatchState(), 0)).toBe(true);
  });

  it("waits until the interval has passed", () => {
    const state: WatchState = { ...freshWatchState(), nextDueAtMs: 1_000 };
    expect(isDue(state, 999)).toBe(false);
    expect(isDue(state, 1_000)).toBe(true);
    expect(isDue(state, 1_001)).toBe(true);
  });

  it("schedules the next check one interval out", () => {
    const watch = watchWith({ intervalMinutes: 7 });
    const { state } = applyResult(watch, freshWatchState(), pass(), 500);
    expect(state.nextDueAtMs).toBe(500 + 7 * MINUTE);
  });

  // Per-URL cadence from a single scheduled job is the whole point of ticking.
  it("selects only the watches that are due, at their own intervals", () => {
    const config = parseConfig({
      uptime: {
        watches: [
          { id: "fast", url: "https://fast.example", intervalMinutes: 1 },
          { id: "slow", url: "https://slow.example", intervalMinutes: 60 },
        ],
      },
    });
    const states: Record<string, WatchState> = {
      fast: { ...freshWatchState(), nextDueAtMs: 10 * MINUTE },
      slow: { ...freshWatchState(), nextDueAtMs: 60 * MINUTE },
    };
    const due = dueWatches(
      config.uptime.watches,
      (watch) => states[watch.id] ?? freshWatchState(),
      11 * MINUTE,
    );
    expect(due.map((watch) => watch.id)).toEqual(["fast"]);
  });

  it("never selects a disabled watch, however overdue", () => {
    const config = parseConfig({
      uptime: { watches: [{ id: "off", url: "https://off.example", enabled: false }] },
    });
    expect(dueWatches(config.uptime.watches, () => freshWatchState(), Number.MAX_SAFE_INTEGER)).toEqual(
      [],
    );
  });
});

describe("alerting", () => {
  it("stays quiet for a single failure below the threshold", () => {
    const { events, state } = run(watchWith({ failureThreshold: 2 }), [fail()]);
    expect(events).toEqual([]);
    expect(state.down).toBe(false);
    expect(state.consecutiveFailures).toBe(1);
  });

  // The boundary itself, which is the case a >= to > mutation would flip.
  it("alerts exactly at the threshold", () => {
    const { events, state } = run(watchWith({ failureThreshold: 2 }), [fail(), fail()]);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("down");
    expect(state.down).toBe(true);
  });

  it("alerts on the first failure when the threshold is one", () => {
    const { events } = run(watchWith({ failureThreshold: 1 }), [fail()]);
    expect(events).toHaveLength(1);
  });

  // Rule 3, and the reason state is persisted at all.
  it("alerts once and then stays silent while still down", () => {
    const { events } = run(watchWith({ failureThreshold: 2 }), [
      fail(),
      fail(),
      fail(),
      fail(),
      fail(),
      fail(),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("down");
  });

  it("resets the count when a check passes before the threshold", () => {
    const { events, state } = run(watchWith({ failureThreshold: 3 }), [
      fail(),
      fail(),
      pass(),
      fail(),
      fail(),
    ]);
    expect(events).toEqual([]);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.down).toBe(false);
  });

  it("carries the failure reason into the event", () => {
    const { events } = run(watchWith({ failureThreshold: 1 }), [fail()]);
    const event = events[0];
    if (event?.kind !== "down") throw new Error("expected a down event");
    expect(event.result.reason).toBe("timeout");
    expect(event.result.detail).toContain("10000");
  });

  it("records the reason in state, for a status table", () => {
    const { state } = run(watchWith(), [fail()]);
    expect(state.lastReason).toBe("timeout");
  });
});

describe("recovery", () => {
  it("sends exactly one recovery message", () => {
    const { events } = run(watchWith({ failureThreshold: 2 }), [
      fail(),
      fail(),
      pass(),
      pass(),
      pass(),
    ]);
    expect(events.map((event) => event.kind)).toEqual(["down", "recovered"]);
  });

  it("does not announce a recovery for a site that was never reported down", () => {
    const { events } = run(watchWith({ failureThreshold: 3 }), [fail(), pass()]);
    expect(events).toEqual([]);
  });

  it("waits for recoveryThreshold successes before announcing", () => {
    const watch = watchWith({ failureThreshold: 1, recoveryThreshold: 2 });
    const { events } = run(watch, [fail(), pass()]);
    expect(events.map((event) => event.kind)).toEqual(["down"]);
    const { events: more } = run(watch, [fail(), pass(), pass()]);
    expect(more.map((event) => event.kind)).toEqual(["down", "recovered"]);
  });

  // The recovery message reports the outage the user lived through, which
  // started at the first failure, not at the point this tool became sure.
  it("reports the outage as beginning at the first failure", () => {
    const start = 1_000_000;
    const { events } = run(watchWith({ failureThreshold: 3 }), [fail(), fail(), fail(), pass()], start);
    const recovered = events.find((event) => event.kind === "recovered");
    if (recovered?.kind !== "recovered") throw new Error("expected a recovery event");
    expect(recovered.downSinceMs).toBe(start);
  });

  it("clears the failure run so a later outage is timed afresh", () => {
    const { state } = run(watchWith({ failureThreshold: 1 }), [fail(), pass()]);
    expect(state.firstFailureAtMs).toBeNull();
    expect(state.down).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
  });

  it("can go down, recover and go down again, telling the user each time", () => {
    const { events } = run(watchWith({ failureThreshold: 1 }), [
      fail(),
      pass(),
      fail(),
      pass(),
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      "down",
      "recovered",
      "down",
      "recovered",
    ]);
  });
});

describe("a single check", () => {
  // A check cannot both break and fix a site, and a caller that assumed one
  // event per result would silently drop the second.
  it("never produces more than one event", () => {
    const watch = watchWith({ failureThreshold: 1 });
    let state = freshWatchState();
    for (const result of [fail(), pass(), fail(), pass(), pass()]) {
      const applied = applyResult(watch, state, result, 0);
      state = applied.state;
      expect(applied.event === null || typeof applied.event.kind === "string").toBe(true);
    }
  });

  it("leaves the input state untouched", () => {
    const before = freshWatchState();
    const snapshot = { ...before };
    applyResult(watchWith(), before, fail(), 42);
    expect(before).toEqual(snapshot);
  });
});

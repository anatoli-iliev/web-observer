import { describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import { freshState, type State } from "../state.js";
import type { CheckDeps } from "./check.js";
import { runRound } from "./run.js";

const MINUTE = 60_000;

/**
 * Dependencies with a clock the test drives, and a check that takes time.
 *
 * The time a check takes is the whole point of these tests: it is what pushes a
 * watch's next due time past the moment the following round arrives.
 */
function depsWith(clock: { value: number }, checkMs: number): CheckDeps {
  return {
    now: () => clock.value,
    sleep: async (ms) => {
      clock.value += ms;
    },
    fetch: async () => {
      clock.value += checkMs;
      return new Response("", { status: 200 });
    },
  };
}

/**
 * Run one scheduled round at `atMs`, the way the cron job does.
 *
 * Each round starts at the moment the scheduler fires, not at the moment the
 * previous round ended, because that is what a fixed cron interval means.
 */
async function round(
  config: ReturnType<typeof parseConfig>,
  state: State,
  clock: { value: number },
  atMs: number,
  checkMs: number,
): Promise<{ state: State; checked: string[] }> {
  clock.value = atMs;
  const outcome = await runRound(config, state, depsWith(clock, checkMs), {
    ignoreSchedule: false,
    only: [],
  });
  return { state: outcome.state, checked: outcome.outcomes.map(({ watch }) => watch.id) };
}

/** Deps whose every request fails the way an unreachable host does. */
function failingDeps(clock: { value: number }, checkMs: number): CheckDeps {
  return {
    now: () => clock.value,
    sleep: async (ms) => {
      clock.value += ms;
    },
    fetch: async () => {
      clock.value += checkMs;
      const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      throw Object.assign(new TypeError("fetch failed"), { cause });
    },
  };
}

describe("rounds on a cron tick", () => {
  // The bug this pins down: the next due time is stamped when a check finishes,
  // so a watch whose interval equals the tick came due a fraction of a second
  // after the next round arrived, was skipped, and ran at half its configured
  // rate. On the live install that turned a 5-minute watch into a 10-minute one.
  it("checks a watch whose interval equals the tick on every round", async () => {
    const config = parseConfig({
      uptime: { tickMinutes: 5, watches: [{ id: "site", url: "https://example.com", intervalMinutes: 5 }] },
    });
    const clock = { value: 1_000_000 };
    let state = freshState();
    const checkedIn: string[][] = [];

    for (let index = 0; index < 4; index += 1) {
      const outcome = await round(config, state, clock, 1_000_000 + index * 5 * MINUTE, 600);
      state = outcome.state;
      checkedIn.push(outcome.checked);
    }

    expect(checkedIn).toEqual([["site"], ["site"], ["site"], ["site"]]);
  });
  // What the cadence costs a person: two consecutive failed checks are needed
  // before anything is said, so a skipped round does not delay the check, it
  // delays the alert by a whole tick.
  it("reports an outage on the second round rather than the third", async () => {
    const config = parseConfig({
      uptime: {
        tickMinutes: 5,
        watches: [
          {
            id: "site",
            url: "https://example.com",
            intervalMinutes: 5,
            attempts: 1,
            failureThreshold: 2,
          },
        ],
      },
    });
    const clock = { value: 1_000_000 };
    let state = freshState();
    const downAt: number[] = [];

    for (let index = 0; index < 3; index += 1) {
      const atMs = 1_000_000 + index * 5 * MINUTE;
      clock.value = atMs;
      const outcome = await runRound(config, state, failingDeps(clock, 600), {
        ignoreSchedule: false,
        only: [],
      });
      state = outcome.state;
      if (outcome.events.some((event) => event.kind === "down")) downAt.push(index + 1);
    }

    expect(downAt).toEqual([2]);
  });
});

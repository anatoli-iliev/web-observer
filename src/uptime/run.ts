/**
 * Running a round of checks.
 *
 * Ties the pure decision logic to the network and the state file, and nothing
 * more: the rules live in decide.ts, the requests in check.ts, the wording in
 * format.ts. What this module owns is which watches run, in what order, and what
 * is persisted afterwards.
 *
 * Checks run concurrently, with a small limit. Sequentially, a dozen watches
 * each allowed two ten-second attempts and a pause between them could take six
 * minutes, and a cron command job's default timeout is thirty seconds. Running
 * them together makes the round cost roughly one watch's worst case rather than
 * the sum of all of them.
 */

import type { Config, Watch } from "../config.js";
import { allowlistOf } from "../config.js";
import { freshWatchState, type State, watchStateOf } from "../state.js";
import { performCheck, type CheckDeps } from "./check.js";
import { applyResult, isDue, type CheckResult, type UptimeEvent } from "./decide.js";

/** How many checks are in flight at once. */
export const CONCURRENCY = 4;

export type RunOptions = {
  /**
   * Check every enabled watch regardless of when it is next due.
   *
   * What `check` uses: somebody verifying a configuration should not be told to
   * wait four minutes.
   */
  ignoreSchedule: boolean;
  /** Limit the round to these watch ids. Empty means every watch. */
  only: readonly string[];
};

export type WatchOutcome = { watch: Watch; result: CheckResult };

export type RunOutcome = {
  /** Every check that ran, in configuration order. */
  outcomes: WatchOutcome[];
  /** Events worth telling somebody about. */
  events: UptimeEvent[];
  /** The state after the round. The caller decides whether to persist it. */
  state: State;
  /** Watches that were skipped because they were not yet due. */
  skipped: Watch[];
};

/**
 * The longest a round can take, in milliseconds.
 *
 * Used to set an explicit timeout on the generated cron job. A job killed
 * halfway through a round would leave some watches unchecked while looking, in
 * the run log, like a job that failed for its own reasons.
 */
export function worstCaseRoundMs(watches: readonly Watch[]): number {
  const perWatch = watches
    .filter((watch) => watch.enabled)
    .map((watch) => watch.attempts * watch.timeoutMs + (watch.attempts - 1) * watch.retryDelayMs);
  if (perWatch.length === 0) return 0;
  // Ceiling rather than maximum: with a concurrency limit, a long queue of slow
  // watches still has to drain in batches.
  const batches = Math.ceil(perWatch.length / CONCURRENCY);
  const slowest = Math.max(...perWatch);
  return batches * slowest;
}

/** Run `tasks` with at most `limit` in flight, preserving input order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Check the watches that are due and fold the outcomes into state.
 *
 * @param config The whole configuration; only `uptime` is read.
 * @param state State as loaded. Not mutated: a new state is returned.
 * @param deps Injected clock, sleep and fetch.
 * @param options Which watches to run.
 * @returns The outcomes, the events, and the new state.
 */
export async function runRound(
  config: Config,
  state: State,
  deps: CheckDeps,
  options: RunOptions,
): Promise<RunOutcome> {
  const allowlist = allowlistOf(config.uptime.watches);
  const requested =
    options.only.length === 0
      ? config.uptime.watches
      : config.uptime.watches.filter((watch) => options.only.includes(watch.id));

  const runnable: Watch[] = [];
  const skipped: Watch[] = [];
  for (const watch of requested) {
    // A disabled watch is skipped even when named explicitly: `enabled: false`
    // is a statement about the watch, not a default to be overridden by asking.
    if (!watch.enabled) {
      skipped.push(watch);
      continue;
    }
    if (options.ignoreSchedule || isDue(watchStateOf(state, watch.id), deps.now())) {
      runnable.push(watch);
    } else {
      skipped.push(watch);
    }
  }

  const results = await mapWithLimit(runnable, CONCURRENCY, (watch) =>
    performCheck(watch, allowlist, deps),
  );

  const watches: Record<string, (typeof state)["watches"][string]> = { ...state.watches };
  const events: UptimeEvent[] = [];
  const outcomes: WatchOutcome[] = [];

  runnable.forEach((watch, index) => {
    const result = results[index] as CheckResult;
    outcomes.push({ watch, result });
    // The completion time is read once per watch, after its own check, so a
    // long round does not stamp every watch with the moment the round started.
    const applied = applyResult(watch, watches[watch.id] ?? freshWatchState(), result, deps.now());
    watches[watch.id] = applied.state;
    if (applied.event) events.push(applied.event);
  });

  return { outcomes, events, state: { ...state, watches }, skipped };
}

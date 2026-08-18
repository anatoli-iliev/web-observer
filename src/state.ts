/**
 * Durable state, and the atomic write that keeps it trustworthy.
 *
 * State exists for exactly one reason: to know, across separate runs, whether a
 * URL was already reported as down. Without it every failed check would alert
 * again, which is the behaviour that teaches people to mute a monitor.
 *
 * It is therefore written atomically, to a temporary file in the same directory
 * followed by a rename. A partially written file would fail to parse on the next
 * run, be treated as absent, and re-alert everything that was already down: the
 * exact failure state is designed to prevent.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** What one watch's history amounts to. */
export type WatchState = {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Whether a down alert has been sent and no recovery message has followed. */
  down: boolean;
  /** When the current run of failures began, for the recovery message. */
  firstFailureAtMs: number | null;
  lastCheckAtMs: number | null;
  /** When this watch next comes due. Null means "never checked, check now". */
  nextDueAtMs: number | null;
  /** The last failure reason, for a status table. */
  lastReason: string | null;
};

/**
 * A poller's memory of which items it has already reported.
 *
 * Ids are kept with the time they were seen so the set can be pruned by age
 * rather than growing without limit.
 */
export type SeenIds = Record<string, number>;

export type VercelWatchState = {
  /** Request ids already reported, so an overlapping window cannot re-alert. */
  seenRequestIds: SeenIds;
  /** Whether an error alert is outstanding. */
  alerting: boolean;
  lastPollAtMs: number | null;
  /** Whether a monitor-side failure (not a site failure) is outstanding. */
  failing: boolean;
  /** Whether a budget alert is outstanding. */
  budgetAlerting: boolean;
  lastBudgetPollAtMs: number | null;
};

export type State = {
  version: 1;
  watches: Record<string, WatchState>;
  vercel: VercelWatchState;
};

export function freshWatchState(): WatchState {
  return {
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    down: false,
    firstFailureAtMs: null,
    lastCheckAtMs: null,
    nextDueAtMs: null,
    lastReason: null,
  };
}

export function freshVercelState(): VercelWatchState {
  return {
    seenRequestIds: {},
    alerting: false,
    lastPollAtMs: null,
    failing: false,
    budgetAlerting: false,
    lastBudgetPollAtMs: null,
  };
}

export function freshState(): State {
  return { version: 1, watches: {}, vercel: freshVercelState() };
}

function readNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Rebuild state from a decoded document, defaulting anything unreadable.
 *
 * Deliberately forgiving, and the opposite of how configuration is treated. A
 * configuration file is written by a person and a surprise in it is a mistake
 * worth reporting; this file is written by this program, and the only thing to
 * do with a corrupt field is carry on from a sane value. Refusing to run
 * because the state file is odd would turn a bookkeeping problem into an
 * outage in the monitoring.
 *
 * The one field that matters to preserve exactly is `down`: getting it wrong in
 * either direction either re-alerts or stays silent about a real outage.
 */
export function parseState(document: unknown): State {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return freshState();
  }
  const object = document as Record<string, unknown>;
  const state = freshState();

  const watches = object["watches"];
  if (typeof watches === "object" && watches !== null && !Array.isArray(watches)) {
    for (const [id, raw] of Object.entries(watches as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      state.watches[id] = {
        consecutiveFailures: readCount(entry["consecutiveFailures"]),
        consecutiveSuccesses: readCount(entry["consecutiveSuccesses"]),
        down: entry["down"] === true,
        firstFailureAtMs: readNumberOrNull(entry["firstFailureAtMs"]),
        lastCheckAtMs: readNumberOrNull(entry["lastCheckAtMs"]),
        nextDueAtMs: readNumberOrNull(entry["nextDueAtMs"]),
        lastReason: typeof entry["lastReason"] === "string" ? entry["lastReason"] : null,
      };
    }
  }

  const vercel = object["vercel"];
  if (typeof vercel === "object" && vercel !== null && !Array.isArray(vercel)) {
    const entry = vercel as Record<string, unknown>;
    const seen: SeenIds = {};
    const rawSeen = entry["seenRequestIds"];
    if (typeof rawSeen === "object" && rawSeen !== null && !Array.isArray(rawSeen)) {
      for (const [id, at] of Object.entries(rawSeen as Record<string, unknown>)) {
        const stamp = readNumberOrNull(at);
        if (stamp !== null) seen[id] = stamp;
      }
    }
    state.vercel = {
      seenRequestIds: seen,
      alerting: entry["alerting"] === true,
      lastPollAtMs: readNumberOrNull(entry["lastPollAtMs"]),
      failing: entry["failing"] === true,
      budgetAlerting: entry["budgetAlerting"] === true,
      lastBudgetPollAtMs: readNumberOrNull(entry["lastBudgetPollAtMs"]),
    };
  }

  return state;
}

/** The state for one watch, creating a blank one on first sight. */
export function watchStateOf(state: State, id: string): WatchState {
  return state.watches[id] ?? freshWatchState();
}

/**
 * Forget request ids older than `keepMs`.
 *
 * The seen set exists to stop an overlapping poll window re-alerting the same
 * error. An id older than the window can never appear again, so keeping it
 * would grow the file without bound.
 *
 * @param cap Hard ceiling on entries, applied after the age prune. A window
 *   wide enough to hold more errors than this is a flood, and forgetting the
 *   oldest of them risks one duplicate alert rather than an unbounded file.
 */
export function pruneSeenIds(seen: SeenIds, nowMs: number, keepMs: number, cap = 5_000): SeenIds {
  const kept = Object.entries(seen).filter(([, at]) => nowMs - at <= keepMs);
  if (kept.length > cap) {
    kept.sort((a, b) => b[1] - a[1]);
    kept.length = cap;
  }
  return Object.fromEntries(kept);
}

/** Read state from disk, returning a blank one when it is absent or unreadable. */
export function loadState(file: string): State {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return freshState();
  }
  try {
    return parseState(JSON.parse(text) as unknown);
  } catch {
    // Unparseable is treated as absent, and deliberately not reported as an
    // error: see parseState. The cost is one repeated alert, once.
    return freshState();
  }
}

/**
 * Write state atomically: temporary file in the same directory, then rename.
 *
 * Same directory matters, because rename is only atomic within a filesystem.
 * The temporary name carries the process id so two runs cannot collide on it.
 */
export function saveState(file: string, state: State): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

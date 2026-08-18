/**
 * The scheduled Vercel poll: error logs, and the performance budget.
 *
 * Two watches share one command because two cron jobs call it, each on its own
 * interval, and each run does whichever parts are due. That keeps the alert-once
 * and recover-once rules in one place, and it means an error poll and a budget
 * check never disagree about what has already been reported.
 *
 * The three decisions worth knowing about:
 *
 * **The window widens to cover a gap.** Each poll asks for `windowMinutes`, or
 * for however long it has been since the last successful poll plus the
 * configured overlap, whichever is longer. If the Gateway was off for two hours,
 * the next poll looks back over those two hours instead of the usual twenty
 * minutes. This is safe only because the end of the window is never specified:
 * a window ending in the past is refused by the API with HTTP 400, while any
 * `--since` with the end left at now succeeds. Both facts were measured.
 *
 * **Deduplication is by request id.** Overlapping windows re-report the same
 * errors by construction, so an id already alerted about is not alerted about
 * again. That is what makes the overlap free.
 *
 * **An empty answer is not proof of health.** Runtime logs are retained for one
 * hour on Hobby, so a window longer than that can come back empty because the
 * logs aged out. The underlying skill says so in its notes, and those notes are
 * passed on rather than dropped.
 */

import { EXIT_CONFIG, EXIT_FAILURE, EXIT_OK } from "../cli/exit.js";
import { line, note, type Streams } from "../cli/render.js";
import type { Config } from "../config.js";
import type { Env } from "../paths.js";
import { loadState, pruneSeenIds, type State } from "../state.js";
import { SILENT_TOKEN, stamp } from "../uptime/format.js";
import {
  budgetArgv,
  errorsArgv,
  prepare,
  runVercel,
  tally,
  toSafeEntries,
  type ErrorsPayload,
  type SafeErrorEntry,
  type VercelStatus,
} from "../bridge/vercel.js";
import type { CredentialResult } from "../bridge/credentials.js";
import type { RunResult } from "../bridge/delegate.js";

/** The longest window one poll will ask for. */
export const MAX_WINDOW_MINUTES = 1_440;

export type VercelWatchContext = {
  config: Config;
  configFile: string;
  stateFile: string;
  streams: Streams;
  env: Env;
  now: () => number;
};

export type VercelWatchDeps = {
  /** Runs the delegated skill. Injected so tests need no Python. */
  invoke: (argv: readonly string[]) => Promise<RunResult>;
  status: VercelStatus;
  credentials: CredentialResult;
};

/**
 * How far back this poll should look.
 *
 * @param windowMinutes The configured window.
 * @param intervalMinutes The configured interval; the difference between the two
 *   is the overlap the user asked for.
 * @param sinceLastPollMinutes Minutes since the last successful poll, or null
 *   when there has never been one.
 * @returns Minutes to ask for, never below the configured window and never above
 *   {@link MAX_WINDOW_MINUTES}.
 */
export function windowFor(
  windowMinutes: number,
  intervalMinutes: number,
  sinceLastPollMinutes: number | null,
): number {
  const overlap = Math.max(1, windowMinutes - intervalMinutes);
  const needed =
    sinceLastPollMinutes === null ? windowMinutes : Math.ceil(sinceLastPollMinutes) + overlap;
  return Math.min(MAX_WINDOW_MINUTES, Math.max(windowMinutes, needed));
}

/** Whether enough time has passed for a part of this watch to run again. */
function isDue(lastAtMs: number | null, intervalMinutes: number, nowMs: number): boolean {
  if (lastAtMs === null) return true;
  // A minute of slack, because a cron job fires a moment early as often as late,
  // and a poll skipped for being two seconds early would halve the cadence.
  return nowMs - lastAtMs >= intervalMinutes * 60_000 - 60_000;
}

/** Split a poll's entries into those already reported and those not. */
export function partitionNew(
  entries: readonly SafeErrorEntry[],
  seen: Readonly<Record<string, number>>,
): { fresh: SafeErrorEntry[]; repeated: number; withoutId: number } {
  const fresh: SafeErrorEntry[] = [];
  let repeated = 0;
  let withoutId = 0;
  for (const entry of entries) {
    if (entry.requestId === "") {
      // Nothing to deduplicate on. Counted and reported rather than dropped: a
      // failing request is not less real for lacking an id, and silently
      // ignoring it would undercount an incident.
      withoutId += 1;
      fresh.push(entry);
      continue;
    }
    if (Object.hasOwn(seen, entry.requestId)) {
      repeated += 1;
      continue;
    }
    fresh.push(entry);
  }
  return { fresh, repeated, withoutId };
}

/** The alert text for a batch of new errors. */
export function formatErrorAlert(
  project: string,
  fresh: readonly SafeErrorEntry[],
  payload: ErrorsPayload,
  windowMinutes: number,
  includeMessages: boolean,
  atMs: number,
): string {
  const counts = tally(fresh);
  const statuses = counts.byStatus.map(([status, count]) => `${count} x ${status}`).join(", ");
  const lines = [
    `🟠 ${project}: ${counts.total} new error${counts.total === 1 ? "" : "s"} on Vercel ` +
      `in the last ${windowMinutes} minutes`,
    `- By status: ${statuses}`,
  ];
  const routes = counts.byRoute.slice(0, 5);
  if (routes.length > 0) {
    lines.push(
      `- Routes: ${routes.map(([route, count]) => `${route} (${count})`).join(", ")}` +
        (counts.byRoute.length > routes.length
          ? ` and ${counts.byRoute.length - routes.length} more`
          : ""),
    );
  }
  const crashed = fresh.filter((entry) => entry.crashed).length;
  if (crashed > 0) {
    lines.push(`- ${crashed} of them crashed the function`);
  }
  if (includeMessages) {
    // Only reachable when the user set includeMessages, and even then only the
    // distinct leading lines, capped. The underlying skill does not redact log
    // content, so this is application output verbatim.
    const messages = [...new Set(fresh.map((entry) => entry.message ?? "").filter((m) => m !== ""))];
    for (const message of messages.slice(0, 3)) {
      lines.push(`- Logged: ${message.length > 300 ? `${message.slice(0, 300)}…` : message}`);
    }
    if (messages.length > 3) lines.push(`- and ${messages.length - 3} other messages`);
  }
  if (payload.truncated) {
    lines.push(
      "- More errors matched than were fetched, so this is a sample rather than a full count",
    );
  }
  lines.push(`- At: ${stamp(atMs)}`);
  if (!includeMessages) {
    lines.push(
      `- Run: web-observer vercel errors --project ${project} --since ${windowMinutes}m`,
    );
  }
  return lines.join("\n");
}

/** Why a delegated call failed, as a sentence, plus whether it is our fault. */
function describeFailure(result: RunResult, what: string): string {
  if (result.spawnFailed) {
    return `${what} could not be started: ${result.stderr.trim()}`;
  }
  if (result.timedOut) {
    return `${what} did not finish in time`;
  }
  const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(0, 4).join(" ");
  return `${what} exited ${result.code}: ${detail}`;
}

/**
 * Run whichever parts of the Vercel watch are due.
 *
 * @returns The exit code, and the message that was printed.
 */
export async function runVercelWatch(
  context: VercelWatchContext,
  deps: VercelWatchDeps,
  options: { dryRun: boolean },
): Promise<{ code: number; message: string; state: State }> {
  const { config, streams } = context;
  const nowMs = context.now();
  const state = loadState(context.stateFile);
  const vercel = { ...state.vercel, seenRequestIds: { ...state.vercel.seenRequestIds } };
  const blocks: string[] = [];
  let code = EXIT_OK;

  if (!config.vercel.enabled) {
    note(
      streams,
      `error: the vercel module is switched off in ${context.configFile}. ` +
        "Set vercel.enabled to true, or remove the scheduled job with " +
        "`openclaw cron rm web-observer-vercel-errors`.",
    );
    return { code: EXIT_CONFIG, message: "", state };
  }

  if (deps.status.kind === "absent") {
    note(streams, `error: ${deps.status.message}`);
    return { code: EXIT_CONFIG, message: "", state };
  }

  if (deps.credentials.problems.length > 0) {
    for (const problem of deps.credentials.problems) {
      note(streams, `error: ${problem}`);
    }
    return { code: EXIT_CONFIG, message: "", state };
  }
  if (deps.credentials.env["VERCEL_TOKEN"] === undefined) {
    note(
      streams,
      "error: no Vercel token is configured. A scheduled cron job runs with the Gateway's " +
        "environment, so the token has to be readable from openclaw.json: set it with " +
        "`openclaw config set skills.entries.vercel-insights.apiKey YOUR_TOKEN`.",
    );
    return { code: EXIT_CONFIG, message: "", state };
  }

  const project = config.vercel.project ?? "(default project)";

  // ---- error logs -------------------------------------------------------
  if (config.vercel.errors.enabled && isDue(vercel.lastPollAtMs, config.vercel.errors.intervalMinutes, nowMs)) {
    if (deps.status.kind === "no-logs") {
      // Reported once rather than every poll: an installed copy without the
      // logs surface will not fix itself, and a message every fifteen minutes
      // about it would be worse than the missing feature.
      if (!vercel.failing) {
        blocks.push(`⚠️ Vercel error watch cannot run: ${deps.status.message}`);
        vercel.failing = true;
      } else {
        note(streams, `error: ${deps.status.message}`);
      }
      code = EXIT_CONFIG;
    } else {
      const sinceLastPoll =
        vercel.lastPollAtMs === null ? null : (nowMs - vercel.lastPollAtMs) / 60_000;
      const windowMinutes = windowFor(
        config.vercel.errors.windowMinutes,
        config.vercel.errors.intervalMinutes,
        sinceLastPoll,
      );
      const result = await deps.invoke(errorsArgv(config, windowMinutes));

      if (result.code !== 0) {
        const failure = describeFailure(result, "the Vercel errors query");
        if (!vercel.failing) {
          vercel.failing = true;
          // A monitor problem, distinguished from a site problem in the text: the
          // thing to look at is the token or the network, not the application.
          blocks.push(
            `⚠️ Web Observer could not check Vercel errors for ${project}: ${failure}. ` +
              "This is a problem with the check, not necessarily with the site.",
          );
        } else {
          note(streams, `error: ${failure}`);
        }
        code = result.code === 2 ? EXIT_CONFIG : EXIT_FAILURE;
      } else {
        let payload: ErrorsPayload;
        try {
          payload = toSafeEntries(
            JSON.parse(result.stdout) as unknown,
            config.vercel.errors.includeMessages,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          note(streams, `error: could not read the Vercel errors output: ${reason}`);
          return { code: EXIT_FAILURE, message: "", state };
        }

        if (vercel.failing) {
          blocks.push(`✅ Web Observer can reach Vercel logs for ${project} again.`);
          vercel.failing = false;
        }

        const { fresh, repeated } = partitionNew(payload.entries, vercel.seenRequestIds);
        vercel.lastPollAtMs = nowMs;

        if (fresh.length > config.vercel.errors.threshold) {
          if (!vercel.alerting) vercel.alerting = true;
          // Ids are remembered only once they have actually been reported. A
          // batch that stayed under the threshold is deliberately left
          // unremembered, so it is counted again next time and a slow trickle
          // still adds up to an alert. Marking everything seen on every poll
          // would make any threshold above zero unreachable by a steady drip:
          // two errors per poll would each be new once and never again.
          for (const entry of fresh) {
            if (entry.requestId !== "") vercel.seenRequestIds[entry.requestId] = nowMs;
          }
          blocks.push(
            formatErrorAlert(
              project,
              fresh,
              payload,
              windowMinutes,
              config.vercel.errors.includeMessages,
              nowMs,
            ),
          );
        } else if (vercel.alerting && payload.entries.length === 0) {
          // Recovery needs the whole window clean, not merely free of anything
          // new. Errors already reported are still in an overlapping window, and
          // announcing "no errors in the last 20 minutes" while 20 minutes still
          // holds two of them would be a false statement.
          vercel.alerting = false;
          blocks.push(
            `✅ ${project}: no Vercel errors in the last ${windowMinutes} minutes.` +
              (payload.notes.some((note_) => note_.includes("retention"))
                ? " Note: the window is longer than this plan's log retention, so this is " +
                  "not proof that nothing failed."
                : ""),
          );
        }

        // Kept for twice the window: an id cannot reappear in a window that no
        // longer reaches it, and holding them forever would grow the file.
        vercel.seenRequestIds = pruneSeenIds(
          vercel.seenRequestIds,
          nowMs,
          windowMinutes * 2 * 60_000,
        );

        if (repeated > 0) {
          note(
            streams,
            `note: ${repeated} error(s) in this window were already reported and were skipped.`,
          );
        }
        for (const payloadNote of payload.notes) {
          note(streams, `note: ${payloadNote}`);
        }
      }
    }
  }

  // ---- performance budget ----------------------------------------------
  if (
    config.vercel.budget.enabled &&
    isDue(vercel.lastBudgetPollAtMs, config.vercel.budget.intervalMinutes, nowMs)
  ) {
    const result = await deps.invoke(budgetArgv(config));
    // Exit 3 is that skill's "the query worked and a threshold was exceeded",
    // which is the whole reason it exists and is not a failure.
    if (result.code === 3) {
      vercel.lastBudgetPollAtMs = nowMs;
      if (!vercel.budgetAlerting) {
        vercel.budgetAlerting = true;
        const thresholds = Object.entries(config.vercel.budget.metrics)
          .map(([metric, value]) => `${metric} ${value}`)
          .join(", ");
        blocks.push(
          [
            `🟠 ${project}: Core Web Vitals are over budget (${thresholds}).`,
            // Speed Insights percentiles only. No part of this output is text a
            // visitor or an application wrote, so it is safe to pass on whole.
            ...result.stdout.trimEnd().split("\n").slice(0, 14),
            `- At: ${stamp(nowMs)}`,
          ].join("\n"),
        );
      }
    } else if (result.code === 0) {
      vercel.lastBudgetPollAtMs = nowMs;
      if (vercel.budgetAlerting) {
        vercel.budgetAlerting = false;
        blocks.push(`✅ ${project}: Core Web Vitals are back within budget.`);
      }
    } else {
      const failure = describeFailure(result, "the Vercel speed query");
      note(streams, `error: ${failure}`);
      code = result.code === 2 ? EXIT_CONFIG : EXIT_FAILURE;
    }
  }

  const message = blocks.length === 0 ? SILENT_TOKEN : blocks.join("\n\n");
  const nextState: State = { ...state, vercel };

  if (options.dryRun) {
    note(streams, "dry run: the message below would have been delivered.");
    note(streams, message);
    note(streams, "dry run: state was not written, so nothing was consumed.");
    line(streams, SILENT_TOKEN);
    return { code, message, state };
  }

  line(streams, message);
  return { code, message, state: nextState };
}

/**
 * When a human gets woken up, and when they do not.
 *
 * Every function here is pure: state and a check result go in, new state and at
 * most one event come out. Nothing here performs I/O, reads a clock or formats
 * a message, which is what makes the alerting rules testable without a network
 * or a filesystem, and is why this file rather than the network code carries the
 * tests that matter most.
 *
 * The rules, in the order they bite:
 *
 * 1. A watch is checked only when it is due, so per-URL intervals work from a
 *    single scheduled job.
 * 2. A watch alerts once it has failed `failureThreshold` consecutive checks,
 *    and not before, so one dropped connection is not an alert.
 * 3. It then stays silent for as long as it remains down. An alert repeated
 *    every interval is what teaches people to mute the monitor that was right.
 * 4. It sends exactly one recovery message when it passes again.
 */
import type { Watch } from "../config.js";
import type { WatchState } from "../state.js";
/**
 * Why a check failed, as a fixed vocabulary.
 *
 * Typed rather than free text because every one of these has a different cause
 * and a different fix, and "the check failed" is not something anybody can act
 * on at three in the morning.
 */
export type FailureReason = "timeout" | "dns" | "connection-refused" | "tls" | "status-mismatch" | "body-mismatch" | "redirect-off-allowlist" | "network";
/** Every reason, for documentation tests and for rendering a legend. */
export declare const FAILURE_REASONS: readonly FailureReason[];
/** How each reason reads in an alert. */
export declare const REASON_TEXT: Record<FailureReason, string>;
/** The outcome of one check, after any in-check retries have been spent. */
export type CheckResult = {
    ok: true;
    status: number;
    durationMs: number;
    /** Requests spent, so a success on the second attempt is visible. */
    attemptsUsed: number;
    url: string;
} | {
    ok: false;
    reason: FailureReason;
    /** One line naming the observed value. Never carries a secret. */
    detail: string;
    status: number | null;
    durationMs: number;
    attemptsUsed: number;
    url: string;
};
/** What a check changed, if anything worth telling somebody about. */
export type UptimeEvent = {
    kind: "down";
    watch: Watch;
    result: Extract<CheckResult, {
        ok: false;
    }>;
    atMs: number;
} | {
    kind: "recovered";
    watch: Watch;
    result: Extract<CheckResult, {
        ok: true;
    }>;
    atMs: number;
    /** When the outage began, when known, for a duration in the message. */
    downSinceMs: number | null;
};
/**
 * Whether a watch should be checked now.
 *
 * A watch never checked before is due immediately, which is what makes a first
 * run report on everything rather than waiting an interval to say anything.
 *
 * @param state That watch's saved state.
 * @param nowMs The current time.
 */
export declare function isDue(state: WatchState, nowMs: number): boolean;
/**
 * Which of a set of watches a tick should check.
 *
 * Disabled watches are skipped here rather than filtered by the caller, so
 * there is one place that decides what a tick does.
 */
export declare function dueWatches(watches: readonly Watch[], states: (watch: Watch) => WatchState, nowMs: number): Watch[];
/**
 * Fold one check result into a watch's state.
 *
 * @param watch The watch that was checked, for its thresholds and interval.
 * @param previous Its state before this check.
 * @param result What the check found.
 * @param nowMs The time the check completed.
 * @returns The new state, and the event this check caused, if any. At most one
 *   event: a single check cannot both break and fix a site.
 */
export declare function applyResult(watch: Watch, previous: WatchState, result: CheckResult, nowMs: number): {
    state: WatchState;
    event: UptimeEvent | null;
};

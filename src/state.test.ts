import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  freshState,
  loadState,
  parseState,
  pruneSeenIds,
  saveState,
  watchStateOf,
} from "./state.js";

function scratchFile(name = "state.json"): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "wo-state-")), name);
}

describe("reading state", () => {
  it("returns a blank state when the file does not exist", () => {
    expect(loadState(scratchFile()).watches).toEqual({});
  });

  // Deliberately forgiving, and the opposite of how config is treated: this file
  // is written by the program, so the only useful response to a corrupt field is
  // to carry on. Refusing to run would turn bookkeeping into an outage in the
  // monitoring itself.
  it("returns a blank state for unparseable content rather than failing", () => {
    const file = scratchFile();
    writeFileSync(file, "{not json");
    expect(loadState(file).watches).toEqual({});
  });

  it("ignores a document that is not an object", () => {
    expect(parseState([1, 2, 3]).watches).toEqual({});
    expect(parseState("nope").watches).toEqual({});
  });

  // The one field that must survive exactly: getting it wrong either re-alerts
  // or stays silent about a real outage.
  it("preserves whether a watch is down", () => {
    const state = parseState({ watches: { a: { down: true } } });
    expect(state.watches["a"]?.down).toBe(true);
  });

  it("treats anything but true as not down", () => {
    expect(parseState({ watches: { a: { down: "yes" } } }).watches["a"]?.down).toBe(false);
  });

  it("defaults a corrupt counter to zero instead of NaN", () => {
    const state = parseState({ watches: { a: { consecutiveFailures: "many" } } });
    expect(state.watches["a"]?.consecutiveFailures).toBe(0);
  });

  it("drops a watch entry that is not an object", () => {
    expect(parseState({ watches: { a: 5 } }).watches["a"]).toBeUndefined();
  });

  it("gives an unseen watch a blank state", () => {
    expect(watchStateOf(freshState(), "never-seen").down).toBe(false);
  });

  it("reads the vercel poller's memory back", () => {
    const state = parseState({
      vercel: { seenRequestIds: { a: 5 }, alerting: true, lastPollAtMs: 7 },
    });
    expect(state.vercel.seenRequestIds).toEqual({ a: 5 });
    expect(state.vercel.alerting).toBe(true);
    expect(state.vercel.lastPollAtMs).toBe(7);
  });

  it("drops a seen id whose timestamp is not a number", () => {
    expect(parseState({ vercel: { seenRequestIds: { a: "soon" } } }).vercel.seenRequestIds).toEqual(
      {},
    );
  });
});

describe("writing state", () => {
  it("round-trips through the filesystem", () => {
    const file = scratchFile();
    const state = freshState();
    state.watches["a"] = { ...watchStateOf(state, "a"), down: true, consecutiveFailures: 3 };
    saveState(file, state);
    expect(loadState(file).watches["a"]?.down).toBe(true);
    expect(loadState(file).watches["a"]?.consecutiveFailures).toBe(3);
  });

  it("creates the directory when it is missing", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "wo-state-")), "nested", "state.json");
    saveState(file, freshState());
    expect(loadState(file)).toBeDefined();
  });

  // A half-written file would parse as absent on the next run and re-alert
  // everything already known to be down, which is the exact failure state
  // exists to prevent. A rename is what makes that impossible.
  it("leaves no temporary file behind", () => {
    const file = scratchFile();
    saveState(file, freshState());
    expect(() => statSync(`${file}.${process.pid}.tmp`)).toThrow();
  });

  it("writes a file only the owner can read", () => {
    const file = scratchFile();
    saveState(file, freshState());
    // The file holds URLs and outage history, not secrets, but it is written
    // into a shared state directory, so the narrow mode is still correct.
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("writes readable JSON, so a human can inspect it", () => {
    const file = scratchFile();
    saveState(file, freshState());
    expect(readFileSync(file, "utf8")).toContain("\n  ");
  });
});

describe("pruning seen request ids", () => {
  it("keeps an id inside the retention window", () => {
    expect(pruneSeenIds({ a: 1_000 }, 2_000, 5_000)).toEqual({ a: 1_000 });
  });

  it("forgets an id older than the window", () => {
    expect(pruneSeenIds({ a: 1_000 }, 10_000, 5_000)).toEqual({});
  });

  it("keeps an id exactly at the boundary", () => {
    expect(pruneSeenIds({ a: 1_000 }, 6_000, 5_000)).toEqual({ a: 1_000 });
  });

  // A flood must cost a duplicate alert at worst, never an unbounded file.
  it("caps the total, keeping the most recent", () => {
    const seen = Object.fromEntries(
      Array.from({ length: 20 }, (_unused, index) => [`id${index}`, index]),
    );
    const pruned = pruneSeenIds(seen, 20, 1_000, 5);
    expect(Object.keys(pruned)).toHaveLength(5);
    expect(pruned["id19"]).toBe(19);
    expect(pruned["id0"]).toBeUndefined();
  });
});

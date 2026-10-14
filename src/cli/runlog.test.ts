import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { captureStreams } from "./render.js";
import { deferErr, releaseErr, runLogPath } from "./runlog.js";

function scratchLog(): string {
  return runLogPath(path.join(mkdtempSync(path.join(tmpdir(), "wo-runlog-")), "state.json"));
}

describe("a scheduled run's diagnostics", () => {
  // OpenClaw delivers stderr with stdout, so a NO_REPLY run that also wrote a
  // note would arrive in the chat as "stdout: NO_REPLY / stderr: note: ...".
  it("stay off stderr when the run succeeds, and land in the run log", () => {
    const streams = captureStreams();
    const quiet = deferErr(streams);
    quiet.out("NO_REPLY\n");
    quiet.err("note: 1 error in 20 minutes: 1 x 200.\n");
    const log = scratchLog();
    releaseErr(streams, quiet.held(), 0, log, "vercel-watch", Date.UTC(2026, 9, 14, 15, 25));
    expect(streams.stdout()).toBe("NO_REPLY\n");
    expect(streams.stderr()).toBe("");
    expect(readFileSync(log, "utf8")).toBe(
      "2026-10-14T15:25:00.000Z vercel-watch note: 1 error in 20 minutes: 1 x 200.\n",
    );
  });

  it("go to stderr when the run fails, because then they are the explanation", () => {
    const streams = captureStreams();
    const log = scratchLog();
    releaseErr(streams, "error: no Vercel token\n", 2, log, "vercel-watch", 0);
    expect(streams.stderr()).toBe("error: no Vercel token\n");
    expect(existsSync(log)).toBe(false);
  });

  it("write nothing at all when there was nothing to say", () => {
    const streams = captureStreams();
    const log = scratchLog();
    releaseErr(streams, "", 0, log, "watch", 0);
    expect(existsSync(log)).toBe(false);
  });
});

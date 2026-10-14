import { describe, expect, it } from "vitest";

import type { RunResult } from "../bridge/delegate.js";
import type { Ga4Status } from "../bridge/ga4.js";
import { captureStreams } from "../cli/render.js";
import { parseConfig } from "../config.js";
import { runDigestCommand } from "./delegate.js";

const READY: Ga4Status = {
  kind: "ready",
  location: { slug: "open-ga4", dir: "/skills/open-ga4", source: "test", version: "1.0.0" },
  entry: "/skills/open-ga4/dist/cli.js",
};

function result(code: number, stdout: string, stderr = ""): RunResult {
  return { code, stdout, stderr, timedOut: false, spawnFailed: false };
}

async function digest(ga4: Record<string, unknown>, answer: (argv: readonly string[]) => RunResult) {
  const streams = captureStreams();
  const calls: string[][] = [];
  const code = await runDigestCommand(
    { config: parseConfig({ ga4: { enabled: true, ...ga4 } }), configFile: "/c", streams, env: {} },
    {
      status: READY,
      credentials: { env: { GA4_CREDENTIALS: "x" }, problems: [], sources: {} },
      invoke: async (argv) => {
        calls.push([...argv]);
        return answer(argv);
      },
    },
    { dryRun: false },
  );
  return { code, calls, stdout: streams.stdout(), stderr: streams.stderr() };
}

describe("the GA4 digest", () => {
  it("keeps the plain heading for one property", async () => {
    const run = await digest({ property: "111" }, () => result(0, "visitors 10"));
    expect(run.calls).toEqual([["report", "--since", "7d", "--property", "111"]]);
    expect(run.stdout).toContain("📈 Traffic digest, last 7d");
  });

  it("sends one section per property, each naming its property", async () => {
    const run = await digest({ properties: ["111", "222"] }, (argv) =>
      result(0, `visitors for ${argv[argv.length - 1]}`),
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Traffic digest for property 111");
    expect(run.stdout).toContain("visitors for 222");
  });

  // One broken property must not cost the other sites their digest, but the
  // run still fails so cron's own failure notice reports it.
  it("delivers the properties that worked when one fails", async () => {
    const run = await digest({ properties: ["111", "222"] }, (argv) =>
      argv.includes("222") ? result(1, "", "permission denied") : result(0, "visitors 10"),
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("property 111");
    expect(run.stderr).toContain("for property 222 failed: permission denied");
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { childEnv, collectCredentials, skillDisabled, skillEntry } from "./credentials.js";

const SPEC = {
  slug: "vercel-insights",
  primaryEnv: "VERCEL_TOKEN",
  optional: ["VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
} as const;

/** A state directory holding an openclaw.json, so the read is real. */
function stateDirWith(document: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wo-creds-"));
  writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify(document));
  return dir;
}

function envWith(document: unknown, extra: Record<string, string> = {}) {
  return { OPENCLAW_STATE_DIR: stateDirWith(document), ...extra };
}

describe("reading a skill entry", () => {
  it("finds the entry for a slug", () => {
    const env = envWith({ skills: { entries: { "vercel-insights": { apiKey: "k" } } } });
    expect(skillEntry("vercel-insights", env)?.apiKey).toBe("k");
  });

  it("returns null when there is no config at all", () => {
    expect(skillEntry("vercel-insights", { OPENCLAW_STATE_DIR: "/nonexistent" })).toBeNull();
  });

  it("returns null for a slug that is not configured", () => {
    expect(skillEntry("other", envWith({ skills: { entries: {} } }))).toBeNull();
  });

  it("reports an explicitly disabled skill", () => {
    const env = envWith({ skills: { entries: { "vercel-insights": { enabled: false } } } });
    expect(skillDisabled("vercel-insights", env)).toBe(true);
  });
});

describe("collecting credentials", () => {
  // The reason this module exists: a cron command job runs with the Gateway's
  // environment, verified to have no VERCEL_TOKEN in it, so the value has to
  // come from the delegated skill's own configuration.
  it("reads the primary variable from the skill's apiKey", () => {
    const env = envWith({ skills: { entries: { "vercel-insights": { apiKey: "secret" } } } });
    const result = collectCredentials(SPEC, env);
    expect(result.env["VERCEL_TOKEN"]).toBe("secret");
    expect(result.problems).toEqual([]);
  });

  it("records where a value came from, and never the value", () => {
    const env = envWith({ skills: { entries: { "vercel-insights": { apiKey: "secret" } } } });
    const result = collectCredentials(SPEC, env);
    expect(result.sources["VERCEL_TOKEN"]).toBe("skills.entries.vercel-insights.apiKey");
    expect(JSON.stringify(result.sources)).not.toContain("secret");
  });

  it("prefers a variable already in the environment", () => {
    const env = envWith(
      { skills: { entries: { "vercel-insights": { apiKey: "from-config" } } } },
      { VERCEL_TOKEN: "from-env" },
    );
    const result = collectCredentials(SPEC, env);
    expect(result.env["VERCEL_TOKEN"]).toBe("from-env");
    expect(result.sources["VERCEL_TOKEN"]).toBe("inherited from the environment");
  });

  it("forwards the optional variables the skill is configured with", () => {
    const env = envWith({
      skills: {
        entries: {
          "vercel-insights": { apiKey: "k", env: { VERCEL_TEAM_ID: "team_1" } },
        },
      },
    });
    expect(collectCredentials(SPEC, env).env["VERCEL_TEAM_ID"]).toBe("team_1");
  });

  it("forwards nothing that is not configured", () => {
    const env = envWith({ skills: { entries: { "vercel-insights": { apiKey: "k" } } } });
    expect(collectCredentials(SPEC, env).env["VERCEL_PROJECT_ID"]).toBeUndefined();
  });

  it("resolves a ${VAR} interpolation from the environment", () => {
    const env = envWith(
      { skills: { entries: { "vercel-insights": { env: { VERCEL_TEAM_ID: "${MY_TEAM}" } } } } },
      { MY_TEAM: "team_9" },
    );
    expect(collectCredentials(SPEC, env).env["VERCEL_TEAM_ID"]).toBe("team_9");
  });

  // This is the live failure on the machine this was built on: a skill entry
  // interpolates a variable the Gateway does not have, so the value is empty. An
  // empty token produces a confusing 403; a named missing variable is a fix.
  it("reports an interpolation with nothing to interpolate, rather than passing an empty value", () => {
    const env = envWith({
      skills: { entries: { "vercel-insights": { env: { VERCEL_TEAM_ID: "${ABSENT_VAR}" } } } },
    });
    const result = collectCredentials(SPEC, env);
    expect(result.env["VERCEL_TEAM_ID"]).toBeUndefined();
    expect(result.problems[0]).toContain("ABSENT_VAR");
    expect(result.problems[0]).toContain("Gateway's environment");
  });

  // A SecretRef needs the Gateway's providers, which are not reachable here.
  it("reports a secret reference as unresolvable instead of guessing", () => {
    const env = envWith({
      skills: {
        entries: {
          "vercel-insights": { apiKey: { provider: "default", source: "env", id: "VERCEL_TOKEN" } },
        },
      },
    });
    const result = collectCredentials(SPEC, env);
    expect(result.env["VERCEL_TOKEN"]).toBeUndefined();
    expect(result.problems[0]).toContain("secret reference");
    expect(result.problems[0]).toContain("web-observer");
  });

  it("returns nothing, and no problem, when nothing is configured anywhere", () => {
    const result = collectCredentials(SPEC, { OPENCLAW_STATE_DIR: "/nonexistent" });
    expect(result.env).toEqual({});
    expect(result.problems).toEqual([]);
  });

  it("reports an empty configured value", () => {
    const env = envWith({
      skills: { entries: { "vercel-insights": { env: { VERCEL_TEAM_ID: "" } } } },
    });
    expect(collectCredentials(SPEC, env).problems[0]).toContain("is empty");
  });
});

describe("the child environment", () => {
  it("keeps the parent's environment and overlays the credentials", () => {
    const merged = childEnv({ PATH: "/bin", HOME: "/home/x" }, { VERCEL_TOKEN: "k" });
    expect(merged["PATH"]).toBe("/bin");
    expect(merged["HOME"]).toBe("/home/x");
    expect(merged["VERCEL_TOKEN"]).toBe("k");
  });

  it("lets the overlay win, so a resolved value beats a stale inherited one", () => {
    expect(childEnv({ VERCEL_TOKEN: "old" }, { VERCEL_TOKEN: "new" })["VERCEL_TOKEN"]).toBe("new");
  });
});

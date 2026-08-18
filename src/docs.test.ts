/**
 * Tests that fail when the documentation stops describing the code.
 *
 * Documentation drifts silently and a careful reader is not a control. Every
 * assertion here exists because the corresponding claim would otherwise be able
 * to become false without anything failing: a command renamed, an exit code
 * added, an environment variable read but never declared, a security claim that
 * outlived the code enforcing it.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COMMANDS } from "./cli/args.js";
import { EXIT_CODES } from "./cli/exit.js";
import { ALL_ENV_VARS } from "./env.js";
import { parseConfig, SAFE_METHODS } from "./config.js";
import { diagnose } from "./commands/doctor.js";
import { FAILURE_REASONS } from "./uptime/decide.js";
import { SILENT_TOKEN } from "./uptime/format.js";
import { LOGS_INSTALL_HINT, REQUIRED_LOGS_REF } from "./bridge/vercel.js";
import { VERSION } from "./version.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

const SKILL = read("SKILL.md");
const README = read("README.md");
const SETUP = read("SETUP.md");
const packageJson = JSON.parse(read("package.json")) as {
  name: string;
  version: string;
  license: string;
  dependencies?: Record<string, string>;
  repository: { url: string };
};

/** Every source file that ships, excluding tests. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  walk(path.join(repoRoot, "src"));
  return out;
}

/**
 * Text with every run of whitespace collapsed to one space.
 *
 * Prose assertions run against this, because markdown wraps sentences at a
 * column and a test that expected a literal space would fail on the wrap rather
 * than on the sentence being absent.
 */
function prose(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The YAML frontmatter block of SKILL.md, as text. */
function frontmatter(): string {
  const end = SKILL.indexOf("\n---", 3);
  expect(SKILL.startsWith("---")).toBe(true);
  expect(end).toBeGreaterThan(0);
  return SKILL.slice(4, end);
}

describe("SKILL.md frontmatter", () => {
  const front = frontmatter();

  // `openclaw skills list` renders this in a table cell. A keyword-stuffed
  // paragraph wraps over many lines and reads as noise.
  it("keeps the description short enough to render in one table cell", () => {
    const match = /description: >-\n([\s\S]*?)\nversion:/.exec(front);
    expect(match).not.toBeNull();
    const description = (match?.[1] ?? "").split("\n").map((l) => l.trim()).join(" ").trim();
    expect(description.length).toBeGreaterThan(80);
    expect(description.length).toBeLessThan(320);
  });

  it("gives the description real trigger phrasings", () => {
    expect(front).toMatch(/is my site up/);
  });

  it("declares name, directory and repository as the same string", () => {
    expect(front).toMatch(/^name: web-observer$/m);
    expect(packageJson.name).toBe("web-observer");
    expect(path.basename(repoRoot)).toBe("web-observer");
    expect(packageJson.repository.url).toContain("web-observer");
  });

  it("declares the same version as package.json and the code", () => {
    expect(front).toMatch(new RegExp(`^version: ${VERSION.replace(/\./g, "\\.")}$`, "m"));
    expect(packageJson.version).toBe(VERSION);
  });

  it("requires node and nothing else", () => {
    const requires = /requires:\n([\s\S]*?)\n    envVars:/.exec(front)?.[1] ?? "";
    expect(requires).toContain("bins: [node]");
    expect(requires).not.toContain("python");
  });

  // requires.env is an unconditional gate: anything listed there leaves the
  // skill in "needs setup" until it is present. Uptime watching needs no
  // credential, so listing one would hold back the module that needs nothing.
  it("requires nothing in requires.env, so an uptime-only install is ready", () => {
    expect(front).not.toMatch(/^\s*env:\s*\[/m);
  });

  it("declares every environment variable the code reads, and reads every one it declares", () => {
    const declared = [...front.matchAll(/^ {6}- name: (\S+)$/gm)].map((match) => match[1] as string);
    expect([...declared].sort()).toEqual([...ALL_ENV_VARS].sort());
  });

  // A variable read but not declared is a publishing problem as well as a
  // documentation one: ClawHub's review compares declared metadata to behaviour.
  it("reads no environment variable outside the declared set", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/env\["([A-Z][A-Z0-9_]*)"\]/g)) {
        const name = match[1] as string;
        if (!ALL_ENV_VARS.includes(name)) {
          offenders.push(`${path.relative(repoRoot, file)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("documented commands", () => {
  const documented = new Set(
    [...SKILL.matchAll(/^\| `?(check|watch|vercel-watch|digest|vercel|ga4|doctor|schedule)\b/gm)].map(
      (match) => match[1] as string,
    ),
  );

  it("documents every command the CLI accepts", () => {
    for (const command of Object.keys(COMMANDS)) {
      if (command === "help" || command === "version") continue;
      expect(documented.has(command)).toBe(true);
    }
  });

  it("invents no command the CLI does not accept", () => {
    for (const command of documented) {
      expect(Object.hasOwn(COMMANDS, command)).toBe(true);
    }
  });

  it("documents exactly the flags each command accepts", () => {
    const flagSection = SKILL.slice(SKILL.indexOf("### Flags"));
    for (const [command, flags] of Object.entries(COMMANDS)) {
      for (const flag of flags) {
        // The flag must be documented against the command that accepts it.
        // A row may name a value placeholder, as in `--only ID`, so the match
        // is on the flag followed by a space or the closing backtick.
        const row = flagSection
          .split("\n")
          .find((candidate) => new RegExp(`^\\| \`${flag}( [A-Z]+)?\``).test(candidate));
        expect(row, `${flag} is accepted by ${command} but not in the flag table`).toBeDefined();
        expect(row).toContain(command);
      }
    }
  });

  it("names no flag that no command accepts", () => {
    const accepted = new Set<string>(Object.values(COMMANDS).flat());
    const flagSection = SKILL.slice(SKILL.indexOf("### Flags"));
    for (const match of flagSection.matchAll(/^\| `(--[a-z-]+)/gm)) {
      expect(accepted.has(match[1] as string)).toBe(true);
    }
  });

  // A hardcoded path would be wrong for every install but the author's.
  it("writes the invocation as node <skill-dir>/lib/cli.js", () => {
    expect(SKILL).toContain("node <skill-dir>/lib/cli.js");
    expect(SKILL).not.toMatch(/\/home\/[a-z]+\//);
    expect(README).not.toMatch(/\/home\/[a-z]+\//);
  });
});

describe("documented exit codes", () => {
  it("documents exactly the codes the CLI can return", () => {
    const table = SKILL.slice(SKILL.indexOf("### What the exit codes mean"));
    const documented = [...table.matchAll(/^\| (\d+) \|/gm)].map((match) => Number(match[1]));
    expect(documented.sort((a, b) => a - b)).toEqual([...EXIT_CODES].sort((a, b) => a - b));
  });

  // The most consequential instruction in the file: a monitoring tool reporting
  // "nothing is wrong" must not be read as having failed.
  it("tells the agent that a healthy result and an empty result are successes", () => {
    expect(SKILL).toMatch(/finds everything healthy is a success/i);
    expect(SKILL).toMatch(/empty/i);
  });

  it("distinguishes a failed check from a site being down", () => {
    expect(SKILL).toMatch(/not the same as the site being down/i);
  });
});

describe("the guidance an agent needs", () => {
  it("tells it never to state a number that was not measured", () => {
    expect(SKILL).toMatch(/Never state a number that was not measured/);
  });

  it("tells it an empty error log is not proof of health, with the retention figures", () => {
    expect(SKILL).toMatch(/not proof of a healthy site/i);
    expect(SKILL).toContain("one hour on Hobby");
  });

  // The caveat that makes the whole Vercel module safe to run unattended.
  it("tells it never to forward raw log text without being asked", () => {
    expect(SKILL).toMatch(/Never quote raw Vercel log text/);
    expect(SKILL).toMatch(/scrubs only its own Vercel token/);
  });

  it("tells it not to ask for a pasted token", () => {
    expect(SKILL).toMatch(/paste a token/i);
  });

  it("tells it to list and ask rather than guess", () => {
    expect(prose(SKILL)).toMatch(/List them and ask; do not pick one/);
    expect(prose(SKILL)).toMatch(/do not invent a URL/i);
  });

  it("reserves --json for figures that must be computed", () => {
    expect(prose(SKILL)).toMatch(/has to be \*\*computed\*\*/);
  });

  it("warns that the scheduled commands consume an alert", () => {
    expect(SKILL).toMatch(/consumes the one alert/);
  });
});

describe("the notification mechanism", () => {
  it("names the silent token the code actually uses", () => {
    expect(SKILL).toContain(SILENT_TOKEN);
    expect(README).toContain(SILENT_TOKEN);
  });

  it("explains that stdout is what gets delivered", () => {
    expect(SKILL).toMatch(/stdout.*is sent to the user|delivers the command's \*\*stdout\*\*/s);
  });

  // The trap that would double-notify on every outage.
  it("explains why a scheduled run exits 0 even when it alerts", () => {
    expect(SKILL).toMatch(/exits \*\*0 even when it alerts\*\*/);
    expect(SKILL).toMatch(/reported twice/);
  });

  it("states that this skill holds no bot token of its own", () => {
    expect(SKILL).toMatch(/holds no bot token/);
  });
});

describe("the security claims", () => {
  it("documents every failure reason the code can report, and no others", () => {
    const section = SKILL.slice(SKILL.indexOf("## Failure reasons"));
    for (const reason of FAILURE_REASONS) {
      expect(section).toContain(`\`${reason}\``);
    }
    for (const match of section.matchAll(/`([a-z-]+)`/g)) {
      expect(FAILURE_REASONS).toContain(match[1] as never);
    }
  });

  it("names exactly the HTTP methods the code permits", () => {
    for (const method of SAFE_METHODS) {
      expect(SKILL).toContain(method);
    }
    expect(SKILL).toMatch(/`GET`, `HEAD` and `OPTIONS` are ever issued/);
    // A claim about methods must not survive the list changing.
    expect(SAFE_METHODS).toEqual(["GET", "HEAD", "OPTIONS"]);
  });

  it("claims the allowlist is enforced per redirect hop, which the code does", () => {
    expect(SKILL).toMatch(/every redirect hop/i);
    const source = read("src/uptime/check.ts");
    // The check sits inside the hop loop, not before it.
    expect(source).toMatch(/for \(let hop = 0[\s\S]*?allowedUrl\(url, allowlist\)/);
  });

  it("states that redirects are not followed by default", () => {
    expect(SKILL).toMatch(/not followed at all by default/);
  });

  it("states that a body is measured and never quoted", () => {
    expect(SKILL).toMatch(/measured, never quoted/);
  });

  it("states that credentials never reach a command line", () => {
    expect(SKILL).toMatch(/never put on a command line/);
    // And the code has no --token anywhere.
    for (const file of sourceFiles()) {
      expect(readFileSync(file, "utf8")).not.toContain('"--token"');
    }
  });
});

describe("runtime dependencies", () => {
  it("ships none", () => {
    expect(packageJson.dependencies).toBeUndefined();
  });

  // The claim "zero runtime dependencies" is only true while this holds.
  it("imports nothing outside node: builtins", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from "([^"]+)"/g)) {
        const specifier = match[1] as string;
        if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
        offenders.push(`${path.relative(repoRoot, file)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("says so in the documentation", () => {
    expect(README).toMatch(/zero runtime dependencies/i);
  });
});

describe("the logs-surface pin", () => {
  // Left deliberately findable, in code and in prose, so re-pinning is one edit
  // and checking the branch's status is one click.
  it("is marked with a TODO in the code", () => {
    const source = read("src/bridge/vercel.ts");
    expect(source).toContain("TODO(logs-surface)");
    expect(source).toContain("tree/logs-surface");
  });

  it("is explained in README.md, with the branch link", () => {
    expect(README).toContain(REQUIRED_LOGS_REF);
    expect(README).toContain("TODO");
    expect(README).toMatch(/tree\/logs-surface/);
  });

  it("gives the same install command everywhere it appears", () => {
    expect(README).toContain(LOGS_INSTALL_HINT);
    expect(SETUP).toContain(LOGS_INSTALL_HINT);
  });
});

describe("the shipped example configuration", () => {
  // The first thing a new user copies. A broken example is a first-run failure,
  // and this is the cheapest possible guard against one.
  it("parses", () => {
    expect(() => parseConfig(JSON.parse(read("examples/config.json")) as unknown)).not.toThrow();
  });

  it("passes its own doctor, apart from not being scheduled yet", () => {
    const config = parseConfig(JSON.parse(read("examples/config.json")) as unknown);
    const report = diagnose({
      config,
      configError: null,
      configFile: "/config.json",
      configExists: true,
      stateFile: "/state.json",
      env: { OPENCLAW_STATE_DIR: "/nonexistent" },
      // Pretend the job exists, since the example cannot schedule itself.
      cronJobNames: ["web-observer-uptime"],
    });
    expect(report.blocked_on).toBe("ok");
  });

  it("demonstrates per-URL intervals, which is the point of the design", () => {
    const config = parseConfig(JSON.parse(read("examples/config.json")) as unknown);
    const intervals = new Set(config.uptime.watches.map((watch) => watch.intervalMinutes));
    expect(intervals.size).toBeGreaterThan(1);
  });

  it("leaves the optional modules off, so a first run needs no credentials", () => {
    const config = parseConfig(JSON.parse(read("examples/config.json")) as unknown);
    expect(config.vercel.enabled).toBe(false);
    expect(config.ga4.enabled).toBe(false);
    expect(config.uptime.enabled).toBe(true);
  });

  it("makes the placeholders obviously placeholders", () => {
    expect(read("examples/config.json")).toContain("REPLACE_WITH");
  });
});

describe("files the documentation points at", () => {
  it("all exist", () => {
    const referenced = new Set<string>();
    for (const text of [README, SETUP, SKILL, read("CONTRIBUTING.md")]) {
      for (const match of text.matchAll(/\((examples\/[A-Za-z0-9._-]+)\)/g)) {
        referenced.add(match[1] as string);
      }
      for (const match of text.matchAll(/`(examples\/[A-Za-z0-9._-]+)`/g)) {
        referenced.add(match[1] as string);
      }
    }
    // The guard against a vacuous pass: if the extraction stops working, this
    // test would otherwise assert nothing at all.
    expect(referenced.size).toBeGreaterThan(0);
    for (const relative of referenced) {
      expect(() => read(relative), `${relative} is referenced but missing`).not.toThrow();
    }
  });

  it("ships the systemd fallback both documents promise", () => {
    expect(() => read("examples/web-observer-monitor.service")).not.toThrow();
    expect(() => read("examples/web-observer-monitor.timer")).not.toThrow();
    expect(README).toContain("web-observer-monitor.service");
  });
});

describe("the changelog", () => {
  it("has an entry for the current version", () => {
    expect(read("CHANGELOG.md")).toContain(`## [${VERSION}]`);
  });
});

describe("project identity", () => {
  it("is licensed MIT-0, and says so consistently", () => {
    expect(packageJson.license).toBe("MIT-0");
    expect(read("LICENSE")).toContain("MIT No Attribution");
    expect(README).toContain("MIT-0");
  });

  it("carries the same copyright line as the reference skills", () => {
    expect(read("LICENSE")).toContain("Copyright 2026 Anatoli Iliev");
  });

  it("documents that the three modules are independent", () => {
    expect(SKILL).toMatch(/three modules are independent/i);
    expect(README).toMatch(/independent/i);
  });
});

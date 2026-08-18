import { describe, expect, it } from "vitest";

import { ConfigError } from "../config.js";
import { COMMANDS, parseArgs, USAGE } from "./args.js";

describe("parsing a command", () => {
  it("defaults to help with no arguments", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  it("understands --help and -h", () => {
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(parseArgs(["-h"]).command).toBe("help");
  });

  it("understands --version and -V", () => {
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["-V"]).command).toBe("version");
  });

  it("names the available commands when given an unknown one", () => {
    expect(() => parseArgs(["wach"])).toThrow(/is not a Web Observer command/);
    expect(() => parseArgs(["wach"])).toThrow(/watch/);
  });

  it("accepts every command it advertises", () => {
    for (const command of Object.keys(COMMANDS)) {
      expect(parseArgs([command]).command).toBe(command);
    }
  });
});

describe("flags", () => {
  it("reads the boolean flags a command accepts", () => {
    const args = parseArgs(["check", "--json", "--strict", "--dry-run"]);
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);
    expect(args.dryRun).toBe(true);
  });

  // Ignoring an unknown flag is how somebody comes to believe they ran a dry
  // run when they did not.
  it("refuses a flag the command does not accept", () => {
    expect(() => parseArgs(["watch", "--strict"])).toThrow(/not a flag watch accepts/);
    expect(() => parseArgs(["watch", "--strict"])).toThrow(/rather than ignored/);
  });

  it("refuses a flag no command accepts", () => {
    expect(() => parseArgs(["check", "--wat"])).toThrow(ConfigError);
  });

  it("refuses a stray positional argument", () => {
    expect(() => parseArgs(["watch", "now"])).toThrow(/is not expected after watch/);
  });

  it("reads --only as a value flag, in both forms", () => {
    expect(parseArgs(["check", "--only", "a"]).only).toEqual(["a"]);
    expect(parseArgs(["check", "--only=a"]).only).toEqual(["a"]);
  });

  it("splits a comma separated --only", () => {
    expect(parseArgs(["check", "--only", "a,b , c"]).only).toEqual(["a", "b", "c"]);
  });

  it("accepts a repeated --only", () => {
    expect(parseArgs(["check", "--only", "a", "--only", "b"]).only).toEqual(["a", "b"]);
  });

  it("refuses --only with nothing after it", () => {
    expect(() => parseArgs(["check", "--only"])).toThrow(/needs a value/);
  });

  // Otherwise `--only --json` would silently take "--json" as the watch id.
  it("refuses --only followed by another flag", () => {
    expect(() => parseArgs(["check", "--only", "--json"])).toThrow(/needs a value/);
  });

  it("refuses a value on a boolean flag", () => {
    expect(() => parseArgs(["check", "--json=yes"])).toThrow(/does not take a value/);
  });
});

describe("the delegating commands", () => {
  // Their flags belong to the other skill's command line.
  it("forward everything after the command untouched", () => {
    expect(parseArgs(["vercel", "errors", "--since", "30m", "--json"]).passthrough).toEqual([
      "errors",
      "--since",
      "30m",
      "--json",
    ]);
  });

  it("forward flags this tool would otherwise refuse", () => {
    expect(parseArgs(["ga4", "report", "--anything-at-all"]).passthrough).toEqual([
      "report",
      "--anything-at-all",
    ]);
  });

  it("forward nothing when nothing was given", () => {
    expect(parseArgs(["vercel"]).passthrough).toEqual([]);
  });
});

describe("the usage text", () => {
  it("mentions every command", () => {
    for (const command of Object.keys(COMMANDS)) {
      if (command === "help" || command === "version") continue;
      expect(USAGE).toContain(command);
    }
  });

  // The one mechanism a reader has to understand to trust a quiet monitor.
  it("explains that NO_REPLY is what keeps a scheduled run silent", () => {
    expect(USAGE).toContain("NO_REPLY");
  });
});

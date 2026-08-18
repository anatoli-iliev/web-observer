import { describe, expect, it } from "vitest";

import {
  allowedUrl,
  allowlistOf,
  ConfigError,
  describeStatusExpectations,
  emptyConfig,
  parseConfig,
  statusMatches,
  WATCH_DEFAULTS,
  type Watch,
} from "./config.js";

/** A minimal valid document with one watch, for tests that vary one thing. */
function documentWith(watch: Record<string, unknown>): unknown {
  return { uptime: { watches: [{ id: "site", url: "https://example.com", ...watch }] } };
}

function watchOf(document: unknown): Watch {
  const config = parseConfig(document);
  const watch = config.uptime.watches[0];
  if (!watch) throw new Error("test document produced no watch");
  return watch;
}

describe("an absent configuration", () => {
  it("leaves every module off rather than guessing", () => {
    const config = emptyConfig();
    expect(config.uptime.enabled).toBe(false);
    expect(config.vercel.enabled).toBe(false);
    expect(config.ga4.enabled).toBe(false);
    expect(config.uptime.watches).toEqual([]);
  });
});

describe("unknown keys", () => {
  it("are refused rather than ignored", () => {
    expect(() => parseConfig({ uptmie: {} })).toThrow(ConfigError);
  });

  it("name the offending key and what is accepted", () => {
    expect(() => parseConfig(documentWith({ intervalMinute: 3 }))).toThrow(
      /intervalMinute.*Did you mean intervalMinutes/s,
    );
  });

  // The whole point of refusing a near-miss: a dropped key would leave the
  // default cadence running with nothing in the output to say the configured
  // number was never read.
  it("explains why an unrecognised key is not simply dropped", () => {
    expect(() => parseConfig(documentWith({ timeoutMS: 500 }))).toThrow(/rather than ignored/);
  });
});

describe("a watch", () => {
  it("inherits every default it does not override", () => {
    const watch = watchOf(documentWith({}));
    expect(watch).toEqual({ id: "site", url: "https://example.com", ...WATCH_DEFAULTS });
  });

  it("takes defaults from uptime.defaults over the built-in ones", () => {
    const config = parseConfig({
      uptime: {
        defaults: { intervalMinutes: 30, timeoutMs: 2_000 },
        watches: [{ id: "a", url: "https://a.example" }],
      },
    });
    expect(config.uptime.watches[0]?.intervalMinutes).toBe(30);
    expect(config.uptime.watches[0]?.timeoutMs).toBe(2_000);
    // Untouched defaults survive the override.
    expect(config.uptime.watches[0]?.failureThreshold).toBe(WATCH_DEFAULTS.failureThreshold);
  });

  it("lets a single watch override the shared defaults", () => {
    const config = parseConfig({
      uptime: {
        defaults: { intervalMinutes: 30 },
        watches: [
          { id: "a", url: "https://a.example" },
          { id: "b", url: "https://b.example", intervalMinutes: 1 },
        ],
      },
    });
    expect(config.uptime.watches[0]?.intervalMinutes).toBe(30);
    expect(config.uptime.watches[1]?.intervalMinutes).toBe(1);
  });

  it("requires an id, because the id keys saved state", () => {
    expect(() => parseConfig({ uptime: { watches: [{ url: "https://a.example" }] } })).toThrow(
      /id.*required/s,
    );
  });

  it("refuses two watches sharing one id", () => {
    expect(() =>
      parseConfig({
        uptime: {
          watches: [
            { id: "same", url: "https://a.example" },
            { id: "same", url: "https://b.example" },
          ],
        },
      }),
    ).toThrow(/repeats the id/);
  });

  it("refuses a url with no scheme", () => {
    expect(() => parseConfig(documentWith({ url: "example.com" }))).toThrow(/is not a URL/);
  });

  it("refuses a non-http scheme", () => {
    expect(() =>
      parseConfig({ uptime: { watches: [{ id: "a", url: "ftp://example.com" }] } }),
    ).toThrow(/http and https only/);
  });

  // A credential in the URL would be echoed by any alert that names the URL.
  it("refuses credentials embedded in the url", () => {
    expect(() =>
      parseConfig({ uptime: { watches: [{ id: "a", url: "https://user:pw@example.com" }] } }),
    ).toThrow(/credentials in the URL/);
  });

  it("refuses a method that could change something", () => {
    expect(() => parseConfig(documentWith({ method: "POST" }))).toThrow(/only issues GET, HEAD/);
  });

  it("accepts a safe method in any case", () => {
    expect(watchOf(documentWith({ method: "head" })).method).toBe("HEAD");
  });

  it("refuses a body expectation on HEAD, which returns no body", () => {
    expect(() => parseConfig(documentWith({ method: "HEAD", expectBody: "hello" }))).toThrow(
      /returns no body/,
    );
  });

  it("refuses both body tests at once", () => {
    expect(() =>
      parseConfig(documentWith({ expectBody: "a", expectBodyRegex: "b" })),
    ).toThrow(/Use one/);
  });

  // Caught at load time on purpose: a bad pattern found mid-check would look
  // exactly like the site failing, and would alert as one.
  it("refuses an invalid regular expression at load time", () => {
    expect(() => parseConfig(documentWith({ expectBodyRegex: "([" }))).toThrow(
      /not a valid regular expression/,
    );
  });

  it("refuses a header value containing a newline", () => {
    expect(() =>
      parseConfig(documentWith({ headers: { "X-A": "one\r\nX-Injected: two" } })),
    ).toThrow(/carriage return or newline/);
  });

  it("names the range when a number is out of bounds", () => {
    expect(() => parseConfig(documentWith({ timeoutMs: 5 }))).toThrow(
      /is 5, outside the accepted range 100 to 120000/,
    );
  });

  it("refuses a non-integer where a whole number is required", () => {
    expect(() => parseConfig(documentWith({ intervalMinutes: 1.5 }))).toThrow(
      /must be a whole number/,
    );
  });
});

describe("expectStatus", () => {
  it("accepts an exact code, a class and a range", () => {
    expect(watchOf(documentWith({ expectStatus: [200, "2xx", [300, 399]] })).expectStatus).toEqual([
      200,
      "2xx",
      [300, 399],
    ]);
  });

  it("accepts a bare value rather than requiring a list", () => {
    expect(watchOf(documentWith({ expectStatus: 204 })).expectStatus).toEqual([204]);
  });

  it("refuses an empty list, which nothing could satisfy", () => {
    expect(() => parseConfig(documentWith({ expectStatus: [] }))).toThrow(/no response could/);
  });

  // "200" is the mistake this message exists for.
  it("tells a quoted code apart from a class", () => {
    expect(() => parseConfig(documentWith({ expectStatus: "200" }))).toThrow(
      /200 rather than/,
    );
  });

  it("refuses a backwards range", () => {
    expect(() => parseConfig(documentWith({ expectStatus: [[399, 200]] }))).toThrow(/is empty/);
  });

  it("matches an exact code only exactly", () => {
    expect(statusMatches(200, [200])).toBe(true);
    expect(statusMatches(201, [200])).toBe(false);
  });

  it("matches a class across its hundred", () => {
    expect(statusMatches(204, ["2xx"])).toBe(true);
    expect(statusMatches(302, ["2xx"])).toBe(false);
    expect(statusMatches(500, ["5xx"])).toBe(true);
  });

  // Both ends inclusive, and the boundary is the case a mutation would flip.
  it("matches a range at both boundaries", () => {
    expect(statusMatches(200, [[200, 399]])).toBe(true);
    expect(statusMatches(399, [[200, 399]])).toBe(true);
    expect(statusMatches(199, [[200, 399]])).toBe(false);
    expect(statusMatches(400, [[200, 399]])).toBe(false);
  });

  it("passes when any expectation matches", () => {
    expect(statusMatches(301, [200, [301, 302]])).toBe(true);
  });

  it("reads back the way it was written", () => {
    expect(describeStatusExpectations([200, "2xx", [200, 399]])).toBe("200, 2xx, 200-399");
  });
});

describe("the allowlist", () => {
  const watches = parseConfig({
    uptime: {
      watches: [
        { id: "a", url: "https://a.example/health" },
        { id: "b", url: "https://b.example:8443/" },
        { id: "off", url: "https://disabled.example", enabled: false },
      ],
    },
  }).uptime.watches;
  const allowlist = allowlistOf(watches);

  it("holds one host per configured url", () => {
    expect([...allowlist].sort()).toEqual(["a.example", "b.example:8443", "disabled.example"]);
  });

  // Enabling a watch must not require a second edit somewhere else.
  it("includes a disabled watch's host", () => {
    expect(allowlist.has("disabled.example")).toBe(true);
  });

  it("allows a different path on an allowlisted host", () => {
    expect(allowedUrl("https://a.example/other", allowlist)?.host).toBe("a.example");
  });

  it("refuses a host nobody configured", () => {
    expect(allowedUrl("https://evil.example/", allowlist)).toBeNull();
  });

  // A port is part of the authority, so one port does not authorise another.
  it("treats a port as part of the host", () => {
    expect(allowedUrl("https://b.example:8443/", allowlist)).not.toBeNull();
    expect(allowedUrl("https://b.example/", allowlist)).toBeNull();
    expect(allowedUrl("https://b.example:9999/", allowlist)).toBeNull();
  });

  it("matches a host case-insensitively", () => {
    expect(allowedUrl("https://A.EXAMPLE/", allowlist)).not.toBeNull();
  });

  it("refuses a scheme that is not http or https", () => {
    expect(allowedUrl("file:///etc/passwd", allowlist)).toBeNull();
  });

  // A redirect Location can be anything at all, including unparseable.
  it("returns null rather than throwing for an unparseable url", () => {
    expect(allowedUrl("://nonsense", allowlist)).toBeNull();
  });
});

describe("the vercel module", () => {
  it("requires a project when enabled, since every query names one", () => {
    expect(() => parseConfig({ vercel: { enabled: true } })).toThrow(/project.*is required/s);
  });

  it("defaults includeMessages to off", () => {
    const config = parseConfig({ vercel: { enabled: true, project: "p", errors: {} } });
    expect(config.vercel.errors.includeMessages).toBe(false);
  });

  // The overlap is what stops an error arriving mid-poll from falling between
  // two windows, so a window that does not exceed the interval is refused.
  it("refuses a window that does not overlap the interval", () => {
    expect(() =>
      parseConfig({
        vercel: {
          enabled: true,
          project: "p",
          errors: { intervalMinutes: 15, windowMinutes: 15 },
        },
      }),
    ).toThrow(/must overlap the interval/);
  });

  it("derives an overlapping window when only the interval is given", () => {
    const config = parseConfig({
      vercel: { enabled: true, project: "p", errors: { intervalMinutes: 30 } },
    });
    expect(config.vercel.errors.windowMinutes).toBeGreaterThan(30);
  });

  it("refuses an enabled budget with no thresholds", () => {
    expect(() =>
      parseConfig({ vercel: { enabled: true, project: "p", budget: { enabled: true } } }),
    ).toThrow(/no threshold to test/);
  });

  it("enables the budget when thresholds are present", () => {
    const config = parseConfig({
      vercel: { enabled: true, project: "p", budget: { metrics: { lcp: 2500 } } },
    });
    expect(config.vercel.budget.enabled).toBe(true);
  });
});

describe("the ga4 module", () => {
  it("refuses a cron expression that is not five fields", () => {
    expect(() => parseConfig({ ga4: { digest: { cron: "0 9 * *" } } })).toThrow(/five/);
  });

  it("keeps a five-field expression", () => {
    expect(parseConfig({ ga4: { digest: { cron: "0 9 * * 1" } } }).ga4.digest.cron).toBe("0 9 * * 1");
  });
});

describe("uptime.enabled", () => {
  it("turns itself on when watches are configured", () => {
    expect(parseConfig(documentWith({})).uptime.enabled).toBe(true);
  });

  it("refuses to be enabled with nothing to check", () => {
    expect(() => parseConfig({ uptime: { enabled: true, watches: [] } })).toThrow(
      /nothing to check/,
    );
  });

  it("allows watches to be kept while the module is off", () => {
    const config = parseConfig({
      uptime: { enabled: false, watches: [{ id: "a", url: "https://a.example" }] },
    });
    expect(config.uptime.enabled).toBe(false);
    expect(config.uptime.watches).toHaveLength(1);
  });
});

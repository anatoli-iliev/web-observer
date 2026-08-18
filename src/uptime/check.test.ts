import { describe, expect, it } from "vitest";

import { allowlistOf, parseConfig, type Watch } from "../config.js";
import { classifyError, liveDeps, MAX_BODY_BYTES, performCheck, type CheckDeps } from "./check.js";

function configWith(watches: Record<string, unknown>[]): { watches: Watch[]; allowlist: ReadonlySet<string> } {
  const config = parseConfig({ uptime: { watches } });
  return { watches: config.uptime.watches, allowlist: allowlistOf(config.uptime.watches) };
}

function watchOf(overrides: Record<string, unknown> = {}, extra: Record<string, unknown>[] = []) {
  const { watches, allowlist } = configWith([
    { id: "site", url: "https://example.com/health", ...overrides },
    ...extra,
  ]);
  const watch = watches[0];
  if (!watch) throw new Error("test document produced no watch");
  return { watch, allowlist };
}

/** A recorded request, so a test can assert what was actually sent. */
type Sent = { url: string; method: string; headers: unknown; redirect: string | undefined };

/**
 * Dependencies backed by a scripted list of responses.
 *
 * `sleep` records rather than waits, so a retry delay is asserted as a number
 * instead of slowing the suite down.
 */
function depsFor(
  responses: readonly (Response | Error)[],
): CheckDeps & { sent: Sent[]; slept: number[]; clock: { value: number } } {
  const sent: Sent[] = [];
  const slept: number[] = [];
  const clock = { value: 1_000 };
  let index = 0;
  return {
    sent,
    slept,
    clock,
    now: () => clock.value,
    sleep: async (ms) => {
      slept.push(ms);
      clock.value += ms;
    },
    fetch: async (url, init) => {
      sent.push({
        url,
        method: String(init.method),
        headers: init.headers,
        redirect: init.redirect,
      });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      clock.value += 5;
      if (next instanceof Error) throw next;
      if (!next) throw new Error("no scripted response");
      return next;
    },
  };
}

function ok(body = "", status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function redirect(location: string, status = 302): Response {
  return new Response("", { status, headers: { location } });
}

/** A Node-shaped fetch failure: an outer TypeError wrapping a system error. */
function systemFailure(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

describe("classifying a transport failure", () => {
  it("reads the code out of the wrapped cause, not the useless outer message", () => {
    expect(classifyError(systemFailure("ECONNREFUSED")).reason).toBe("connection-refused");
  });

  it("recognises a name that never resolved", () => {
    expect(classifyError(systemFailure("ENOTFOUND")).reason).toBe("dns");
    expect(classifyError(systemFailure("EAI_AGAIN")).reason).toBe("dns");
  });

  it("recognises a transport timeout", () => {
    expect(classifyError(systemFailure("UND_ERR_CONNECT_TIMEOUT")).reason).toBe("timeout");
    expect(classifyError(systemFailure("ETIMEDOUT")).reason).toBe("timeout");
  });

  it("recognises an abort as a timeout", () => {
    expect(classifyError(Object.assign(new Error("aborted"), { name: "AbortError" })).reason).toBe(
      "timeout",
    );
  });

  it("recognises a certificate problem", () => {
    expect(classifyError(systemFailure("CERT_HAS_EXPIRED")).reason).toBe("tls");
    expect(classifyError(systemFailure("UNABLE_TO_VERIFY_LEAF_SIGNATURE")).reason).toBe("tls");
  });

  it("falls back to a network error that still names what happened", () => {
    const classified = classifyError(systemFailure("ESOMETHINGNEW"));
    expect(classified.reason).toBe("network");
    expect(classified.detail).toContain("ESOMETHINGNEW");
  });

  // A cyclic cause chain is not a reason to throw from the classifier.
  it("survives a cause chain that loops", () => {
    const a = new Error("a");
    const b = new Error("b");
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });
    expect(classifyError(a).reason).toBe("network");
  });

  it("survives a non-error being thrown", () => {
    expect(classifyError("just a string").reason).toBe("network");
  });
});

describe("a passing check", () => {
  it("reports the status and the attempts it took", async () => {
    const { watch, allowlist } = watchOf();
    const deps = depsFor([ok()]);
    const result = await performCheck(watch, allowlist, deps);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.attemptsUsed).toBe(1);
  });

  it("sends the configured method and headers", async () => {
    const { watch, allowlist } = watchOf({ method: "HEAD", headers: { "X-Probe": "1" } });
    const deps = depsFor([ok()]);
    await performCheck(watch, allowlist, deps);
    expect(deps.sent[0]?.method).toBe("HEAD");
    expect(deps.sent[0]?.headers).toEqual({ "X-Probe": "1" });
  });

  // Redirects are handled here, never by fetch, or the allowlist would bind
  // only the first hop.
  it("never lets fetch follow a redirect on its own", async () => {
    const { watch, allowlist } = watchOf({ followRedirects: 3 });
    const deps = depsFor([ok()]);
    await performCheck(watch, allowlist, deps);
    expect(deps.sent[0]?.redirect).toBe("manual");
  });

  it("stops retrying as soon as an attempt succeeds", async () => {
    const { watch, allowlist } = watchOf({ attempts: 3 });
    const deps = depsFor([systemFailure("ECONNRESET"), ok(), ok()]);
    const result = await performCheck(watch, allowlist, deps);
    expect(result.ok).toBe(true);
    expect(result.attemptsUsed).toBe(2);
    expect(deps.sent).toHaveLength(2);
  });
});

describe("retries within one check", () => {
  it("waits the configured delay between attempts, and not before the first", async () => {
    const { watch, allowlist } = watchOf({ attempts: 3, retryDelayMs: 7_000 });
    const deps = depsFor([systemFailure("ECONNREFUSED")]);
    await performCheck(watch, allowlist, deps);
    expect(deps.slept).toEqual([7_000, 7_000]);
  });

  it("spends every attempt before calling a site down", async () => {
    const { watch, allowlist } = watchOf({ attempts: 3 });
    const deps = depsFor([systemFailure("ECONNREFUSED")]);
    const result = await performCheck(watch, allowlist, deps);
    expect(result.ok).toBe(false);
    expect(result.attemptsUsed).toBe(3);
    expect(deps.sent).toHaveLength(3);
  });

  it("makes exactly one request when attempts is one", async () => {
    const { watch, allowlist } = watchOf({ attempts: 1 });
    const deps = depsFor([systemFailure("ECONNREFUSED")]);
    await performCheck(watch, allowlist, deps);
    expect(deps.sent).toHaveLength(1);
    expect(deps.slept).toEqual([]);
  });

  it("measures the whole check, retries included", async () => {
    const { watch, allowlist } = watchOf({ attempts: 2, retryDelayMs: 1_000 });
    const deps = depsFor([systemFailure("ECONNREFUSED")]);
    const result = await performCheck(watch, allowlist, deps);
    // Two requests at 5 ms each plus one 1000 ms pause.
    expect(result.durationMs).toBe(1_010);
  });
});

describe("the status expectation", () => {
  it("fails a status outside it, naming both sides", async () => {
    const { watch, allowlist } = watchOf({ attempts: 1 });
    const deps = depsFor([ok("", 503)]);
    const result = await performCheck(watch, allowlist, deps);
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("status-mismatch");
    expect(result.detail).toBe("returned 503, expected 200");
    expect(result.status).toBe(503);
  });

  it("passes a status the watch accepts", async () => {
    const { watch, allowlist } = watchOf({ expectStatus: [[200, 399]], attempts: 1 });
    const result = await performCheck(watch, allowlist, depsFor([ok("", 301)]));
    expect(result.ok).toBe(true);
  });
});

describe("the body expectation", () => {
  it("passes when the substring is present", async () => {
    const { watch, allowlist } = watchOf({ expectBody: "healthy", attempts: 1 });
    const result = await performCheck(watch, allowlist, depsFor([ok("status: healthy")]));
    expect(result.ok).toBe(true);
  });

  // The case a 200 cannot catch: the page renders an error.
  it("fails a 200 whose body is wrong", async () => {
    const { watch, allowlist } = watchOf({ expectBody: "healthy", attempts: 1 });
    const result = await performCheck(watch, allowlist, depsFor([ok("database unavailable")]));
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("body-mismatch");
    expect(result.status).toBe(200);
  });

  it("matches a regular expression", async () => {
    const { watch, allowlist } = watchOf({ expectBodyRegex: "ok|healthy", attempts: 1 });
    expect((await performCheck(watch, allowlist, depsFor([ok("all ok")]))).ok).toBe(true);
    expect((await performCheck(watch, allowlist, depsFor([ok("all bad")]))).ok).toBe(false);
  });

  // The body is a stranger's text and this detail is delivered into a chat.
  it("never quotes the body back, only measures it", async () => {
    const { watch, allowlist } = watchOf({ expectBody: "healthy", attempts: 1 });
    const secret = "SUPER_SECRET_TOKEN_abcdef";
    const result = await performCheck(watch, allowlist, depsFor([ok(secret)]));
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).not.toContain(secret);
    expect(result.detail).toContain(`${secret.length} characters read`);
  });

  it("bounds how much of a body it will read", async () => {
    const { watch, allowlist } = watchOf({ expectBody: "needle", attempts: 1 });
    const haystack = "x".repeat(MAX_BODY_BYTES + 2_048);
    const result = await performCheck(watch, allowlist, depsFor([ok(haystack)]));
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).toContain("only the first");
  });

  it("does not read a body when nothing tests it", async () => {
    const { watch, allowlist } = watchOf({ attempts: 1 });
    const response = ok("a body nobody asked about");
    await performCheck(watch, allowlist, depsFor([response]));
    // Cancelled rather than consumed: the check wanted only the status.
    expect(response.bodyUsed || response.body === null).toBe(true);
  });
});

describe("redirects and the allowlist", () => {
  it("does not follow a redirect by default, reporting the status instead", async () => {
    const { watch, allowlist } = watchOf({ attempts: 1 });
    const deps = depsFor([redirect("https://example.com/moved")]);
    const result = await performCheck(watch, allowlist, deps);
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("status-mismatch");
    expect(deps.sent).toHaveLength(1);
  });

  it("follows a redirect within the allowlist when permitted", async () => {
    const { watch, allowlist } = watchOf({ followRedirects: 2, attempts: 1 });
    const deps = depsFor([redirect("https://example.com/moved"), ok()]);
    const result = await performCheck(watch, allowlist, deps);
    expect(result.ok).toBe(true);
    expect(deps.sent.map((sent) => sent.url)).toEqual([
      "https://example.com/health",
      "https://example.com/moved",
    ]);
  });

  it("resolves a relative Location against the current url", async () => {
    const { watch, allowlist } = watchOf({ followRedirects: 1, attempts: 1 });
    const deps = depsFor([redirect("/elsewhere"), ok()]);
    await performCheck(watch, allowlist, deps);
    expect(deps.sent[1]?.url).toBe("https://example.com/elsewhere");
  });

  // The reason this module checks the allowlist per hop rather than once.
  it("refuses a redirect to a host no watch configures", async () => {
    const { watch, allowlist } = watchOf({ followRedirects: 3, attempts: 1 });
    const deps = depsFor([redirect("https://evil.example/steal"), ok()]);
    const result = await performCheck(watch, allowlist, deps);
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("redirect-off-allowlist");
    expect(result.detail).toContain("evil.example");
    // The decisive assertion: the off-allowlist host was never contacted.
    expect(deps.sent).toHaveLength(1);
  });

  it("quotes only the host of an off-allowlist redirect, never the whole target", async () => {
    const { watch, allowlist } = watchOf({ followRedirects: 1, attempts: 1 });
    const deps = depsFor([redirect("https://evil.example/?token=SECRETVALUE")]);
    const result = await performCheck(watch, allowlist, deps);
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).not.toContain("SECRETVALUE");
  });

  it("does not retry an off-allowlist redirect", async () => {
    const { watch, allowlist } = watchOf({ followRedirects: 1, attempts: 3 });
    const deps = depsFor([redirect("https://evil.example/")]);
    await performCheck(watch, allowlist, deps);
    expect(deps.sent).toHaveLength(1);
    expect(deps.slept).toEqual([]);
  });

  it("follows a redirect to another configured watch's host", async () => {
    const { watch, allowlist } = watchOf({ followRedirects: 1, attempts: 1 }, [
      { id: "other", url: "https://other.example/" },
    ]);
    const deps = depsFor([redirect("https://other.example/landing"), ok()]);
    const result = await performCheck(watch, allowlist, deps);
    expect(result.ok).toBe(true);
  });

  it("stops following once the hop budget is spent and judges what it has", async () => {
    const { watch, allowlist } = watchOf({ followRedirects: 1, attempts: 1 });
    const deps = depsFor([
      redirect("https://example.com/one"),
      redirect("https://example.com/two"),
    ]);
    const result = await performCheck(watch, allowlist, deps);
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("status-mismatch");
    expect(deps.sent).toHaveLength(2);
  });

  it("reports a redirect with no Location rather than looping", async () => {
    const { watch, allowlist } = watchOf({ followRedirects: 2, attempts: 1 });
    const deps = depsFor([new Response("", { status: 302 })]);
    const result = await performCheck(watch, allowlist, deps);
    if (result.ok) throw new Error("expected a failure");
    expect(result.detail).toContain("no Location header");
  });

  // 304 is a cache answer with no Location, not a relocation.
  it("treats 304 as a status, not a redirect", async () => {
    const { watch, allowlist } = watchOf({ followRedirects: 2, attempts: 1, expectStatus: [304] });
    const result = await performCheck(watch, allowlist, depsFor([new Response(null, { status: 304 })]));
    expect(result.ok).toBe(true);
  });
});

describe("the live dependencies", () => {
  // Mistake 17 in the project notes: a delay that was never observed. An
  // unref'd timer would let Node exit mid-await, skipping the retry entirely.
  it("actually waits when asked to sleep", async () => {
    const before = Date.now();
    await liveDeps.sleep(25);
    expect(Date.now() - before).toBeGreaterThanOrEqual(20);
  });

  it("reads a real clock", () => {
    expect(Math.abs(liveDeps.now() - Date.now())).toBeLessThan(1_000);
  });
});

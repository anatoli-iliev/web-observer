# Web Observer

An OpenClaw skill that watches websites and tells you when something breaks.

Three things, each independently switchable:

1. **Uptime.** Check a list of URLs, each on its own interval. One alert when a
   site goes down, one when it comes back, and nothing in between.
2. **Vercel.** Error logs, request logs, and Core Web Vitals against a budget.
   Ad hoc questions, and a scheduled poll that alerts on new errors.
3. **GA4 traffic.** Ad hoc questions, and a scheduled digest.

Node, TypeScript, **zero runtime dependencies**. Uptime needs no credentials at
all, so a Web Observer installed only to watch a URL is ready the moment it is
installed.

The Vercel and GA4 parts are delegated to two existing skills,
[openclaw-vercel-insights](https://github.com/anatoli-iliev/openclaw-vercel-insights)
and [open-ga4](https://github.com/anatoli-iliev/open-ga4). Nothing about either
API is reimplemented here.

## How it alerts you, and why there is no bot token

OpenClaw's scheduler can run a command and deliver that command's **stdout** to
a chat channel. Printing the exact token `NO_REPLY` suppresses the delivery.

So an alert is a scheduled command printing text, and silence is the same command
printing `NO_REPLY`. Web Observer opens no connection to Telegram or anywhere
else and holds no credential for one: alerts travel over the channel the cron job
names, which is the channel OpenClaw is already configured with.

Two consequences worth internalising before editing anything:

- On a scheduled run, **anything on stdout is sent to the user.** Diagnostics go
  to stderr, where the cron run log keeps them without delivering them.
- A scheduled run **exits 0 even when it alerts.** An alert is the tool working.
  A non-zero exit would additionally trigger OpenClaw's own cron failure
  notification, so a single outage would be announced twice by two different
  mechanisms, and repeated failures would back the job off.

## Install

```bash
openclaw skills install git:https://github.com/anatoli-iliev/web-observer --as web-observer
node ~/.openclaw/workspace/skills/web-observer/lib/cli.js doctor
```

`doctor` names the configuration file it expects. Copy the example there and
edit it:

```bash
cp ~/.openclaw/workspace/skills/web-observer/examples/config.json \
   ~/.openclaw/web-observer/config.json
```

Then check it works, and schedule it:

```bash
node ~/.openclaw/workspace/skills/web-observer/lib/cli.js check
node ~/.openclaw/workspace/skills/web-observer/lib/cli.js schedule
node ~/.openclaw/workspace/skills/web-observer/lib/cli.js schedule --apply
```

`schedule` prints the `openclaw cron add` commands your configuration needs and
changes nothing; `--apply` runs them. See [SETUP.md](SETUP.md) for the
click-by-click version and a troubleshooting table.

## Commands

| Command | What it does |
| --- | --- |
| `check` | Run every watch once, now, and print a table. Changes no alert state. |
| `watch` | The scheduled uptime round. For cron, not for you. |
| `vercel-watch` | The scheduled Vercel error and budget poll. For cron. |
| `digest` | The scheduled GA4 digest. For cron. |
| `vercel <preset> …` | Ask vercel-insights: `errors`, `error-summary`, `vitals`, `top-pages`, … |
| `ga4 <preset> …` | Ask open-ga4: `report`, `compare`, `live`, `query`, … |
| `doctor` | What is configured, what is missing, and the one next thing to do. |
| `schedule` | Print (or with `--apply`, create) the cron jobs. |

Every command that sends a request or an alert takes `--dry-run`.

## Configuration

One JSON file, by default `~/.openclaw/web-observer/config.json`, overridable
with `WEB_OBSERVER_CONFIG`. It is not kept in `openclaw.json` because every
install route replaces the skill directory, and a list of watches is awkward to
edit through `openclaw config set`.

```json
{
  "notify": { "channel": "telegram", "to": "telegram:123456789" },
  "uptime": {
    "enabled": true,
    "tickMinutes": 5,
    "defaults": { "timeoutMs": 10000, "failureThreshold": 2 },
    "watches": [
      { "id": "site", "url": "https://example.com", "intervalMinutes": 5 },
      {
        "id": "health",
        "url": "https://example.com/health",
        "intervalMinutes": 1,
        "expectBody": "\"ok\":true",
        "failureThreshold": 1
      }
    ]
  }
}
```

`notify` is read only when generating the cron commands. Nothing in this skill
sends anything itself.

### One tick, many intervals

A marketing page and a payment webhook want different cadences, and one cron job
per URL would multiply gateway wakeups. Instead a single job runs every
`tickMinutes`, and each round checks only the watches that have come due. An
interval is therefore honoured to within one tick, and `doctor` warns when an
interval is shorter than the tick or not a multiple of it, because otherwise the
real cadence would quietly differ from the configured one.

### Two thresholds, because there are two kinds of blip

- `attempts` (default 2, `retryDelayMs` apart) retries **inside one round**,
  seconds later. This catches a dropped packet.
- `failureThreshold` (default 2) counts consecutive failed **rounds**, minutes
  apart. This catches a flaky minute.

The defaults mean four failed requests spread over about five minutes before
anybody is woken.

### Every watch setting

See the table in [SKILL.md](SKILL.md#a-watch). The ones worth knowing about:
`expectBody` catches a 200 that renders an error page, `expectStatus` accepts a
code, a class such as `"2xx"`, or a range such as `[200, 399]`, and
`followRedirects` is 0 by default.

## The Vercel module, and the branch it needs

> **TODO: re-pin this dependency.** Request-log support currently lives on the
> [`logs-surface` branch](https://github.com/anatoli-iliev/openclaw-vercel-insights/tree/logs-surface)
> of openclaw-vercel-insights, version 1.1.0, and is expected to merge to `main`.
> When it does, change `REQUIRED_LOGS_REF` in `src/bridge/vercel.ts` to `"main"`
> or to a release tag, and drop the `#logs-surface` from the install command
> below and in SETUP.md. Nothing else changes: every log-related call already
> goes through that one module, and the capability check tests for the presence
> of `vercel_insights/logs.py` rather than for a version number, so it keeps
> working either way.

Traffic and speed work with any version. Errors need that branch:

```bash
openclaw skills install "git:https://github.com/anatoli-iliev/openclaw-vercel-insights#logs-surface" --as vercel-insights --force
```

If the installed copy is older, Web Observer says exactly that, names the
version it found and where, and points at the command above. It does not fail
opaquely, and the traffic and speed presets keep working.

### The error watch

```json
{
  "vercel": {
    "enabled": true,
    "project": "my-project",
    "errors": { "intervalMinutes": 15, "windowMinutes": 20, "threshold": 0, "includeMessages": false },
    "budget": { "intervalMinutes": 360, "metrics": { "lcp": 2500, "inp": 200, "cls": 0.1 } }
  }
}
```

Every fifteen minutes it asks for the last twenty. The overlap matters: without
it, an error arriving while a poll is in flight can fall into the gap between two
windows and never be reported. The overlap costs nothing because errors are
deduplicated by `requestId`, and if a poll has been missed the window widens to
cover the whole gap.

`threshold` is how many new errors a poll tolerates before alerting; `0` means
alert on any. Errors below the threshold are deliberately **not** marked as
seen, so a slow trickle still adds up to an alert rather than being forgotten one
poll at a time.

Three facts about the underlying API shape this, all measured against a live
account rather than read from a document:

- **A window that ends in the past can fail.** With `--until` more than about an
  hour ago, the API answers `HTTP 400 ExceedsBillingLimitError`. With the end
  left at now, every `--since` succeeds, from 30 minutes to 7 days. So the poller
  never specifies an end, which removes the failure mode instead of handling it.
- **An empty answer is a success, not a clean bill of health.** Runtime logs are
  retained for 1 hour on Hobby, 1 day on Pro, 3 days on Enterprise, 30 days with
  Observability Plus. An empty result over a longer window can mean the logs aged
  out, and the alert says so.
- **There is no live tail** that a request/response client can use, so this is a
  polling loop by necessity, not by preference.

### Raw log text is not forwarded by default

The underlying skill scrubs only its own Vercel token from log content. Whatever
your application printed, which can include secrets, tokens and customer data,
arrives verbatim. So alerts carry counts, statuses and affected routes, and the
message text is dropped **at the bridge**, not at the formatter: with
`includeMessages` off, the message, the log lines and the raw row are never
copied out of `src/bridge/vercel.ts` at all, so no downstream formatting mistake
can leak them. Set `includeMessages: true` only having decided that is fine.

## The GA4 module

```json
{ "ga4": { "enabled": true, "property": "123456789", "digest": { "cron": "0 9 * * 1", "since": "7d" } } }
```

Needs [open-ga4](https://github.com/anatoli-iliev/open-ga4):

```bash
openclaw skills install git:https://github.com/anatoli-iliev/open-ga4 --as open-ga4
```

Absent, the two GA4 commands say so and exit 2. Uptime and Vercel are unaffected.

## Credentials

Web Observer has no credential of its own, and declares no `primaryEnv`, because
there is no key to save.

The delegated skills do have credentials, and a scheduled run cannot inherit
them: an OpenClaw cron job with a command payload runs with the **Gateway's**
environment, which does not carry a skill's configured variables. Verified by
probe: a cron command sees no `VERCEL_TOKEN`.

So Web Observer reads what the delegated skill is already configured with, from
`skills.entries.<slug>` in `openclaw.json`, and passes it in that skill's own
subprocess environment. The secret keeps living in exactly one place. It is never
put on a command line, never printed, never written to a file, and `doctor`
reports only where it came from.

A `SecretRef` cannot be resolved outside the Gateway. When one is configured,
Web Observer says so rather than guessing, and suggests giving it its own copy:

```bash
openclaw config set skills.entries.web-observer.env.VERCEL_TOKEN \
  --ref-provider default --ref-source env --ref-id VERCEL_TOKEN
```

## What this skill contacts

Exactly the URLs configured under `uptime.watches`, and nothing else. Enforced in
code rather than asserted in prose:

- The allowlist is derived from the configured watch URLs. That function is its
  only constructor, and no flag extends it.
- The host is checked before every request and again on **every redirect hop**.
  A redirect leaving the allowlist fails the check with `redirect-off-allowlist`,
  naming the host, and is never followed. `fetch` is never allowed to follow a
  redirect itself, which is what keeps the allowlist binding on every hop rather
  than only the first.
- Only `GET`, `HEAD` and `OPTIONS` are issued.
- A response body is measured, never quoted into an alert, and at most 1 MiB is
  read.

Everything Vercel and GA4 happens in a subprocess, invoked as an argument vector
with no shell, using those skills' own allowlists and credentials.

## Scheduling

OpenClaw's `cron` is the scheduler; there is no manifest field for scheduling, so
`schedule` exists to write the commands for you. The generated job sets an
explicit `--timeout-seconds`, because the default is 30 seconds and one watch
allowed two ten-second attempts with a pause between them already reaches
exactly that.

If you run with cron disabled (`cron.enabled: false` or `OPENCLAW_SKIP_CRON=1`),
there is a systemd fallback in
[`examples/web-observer-monitor.service`](examples/web-observer-monitor.service)
and its timer. It is a fallback: with cron available, use cron, because that is
what makes delivery work without a bot token.

## Development

```bash
npm install
npm run check     # typecheck, test, rebuild lib/
```

`lib/` is committed, because no install route runs a build: ClawHub copies files,
`openclaw skills install git:…` clones, and a local install is a directory copy.
`npm run check:lib` fails if the committed output no longer matches `src/`.

Tests include a set that fail when the documentation stops describing the code:
the declared environment variables against those the code reads, the documented
exit codes against those it returns, the flag table against the parser, and each
security claim against the code enforcing it.

## Licence

MIT-0. See [LICENSE](LICENSE). Do what you like with it; no attribution needed.

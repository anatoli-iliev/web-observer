# Web Observer: design

One OpenClaw skill that watches a site three ways: is it up, is Vercel
reporting errors and slowdowns, and where is the traffic coming from. Uptime is
implemented here. Vercel and GA4 are delegated to two existing skills and never
reimplemented.

Written 2026-08-18, after inspecting a live OpenClaw 2026.7.1-2 install and
reading both reference skills from source.

## What is verified, and what is assumed

Everything in the next section was checked against the running install or a live
API on 2026-08-18. That distinction is the most useful thing in this document:
the reference skills' own retrospective records that most of their damage came
from stating an assumption in the confident voice of a fact.

### OpenClaw, verified

| Fact | How it was checked |
| --- | --- |
| `openclaw cron` is a Gateway-owned scheduler, persisted to SQLite | `openclaw cron status` reports `storage: sqlite`, `sqlitePath`, `jobs: 6` |
| Schedules are `--at`, `--every`, `--cron` with `--tz` | `openclaw cron add --help`, and five live jobs use them |
| A cron job can run a command, not only an agent turn | `--command <shell>` runs `sh -lc`; a live job's payload is `{kind: "command", argv: ["sh","-lc",...]}` |
| A command job's **stdout becomes the announce text**, delivered to the channel | A probe job printing one line returned `delivered: true, deliveryStatus: "delivered"` to `telegram:5173520412`, then was deleted |
| The exact token `NO_REPLY` suppresses delivery **and** the fallback queued summary | `docs/automation/cron-jobs.md` and `docs/concepts/messages.md`; plus 225 consecutive `delivered: false` runs on an existing job whose script prints `NO_REPLY` when the site is up |
| Cron has its own failure alerting: `failureAlert: {after, cooldownMs}` | Present on a live job; `--no-failure-alert` exists on `cron edit` |
| Skill frontmatter has **no** skill-to-skill dependency field | `docs/tools/skills.md` lists the complete `metadata.openclaw` set: `always`, `emoji`, `homepage`, `os`, `requires.{bins,anyBins,env,config}`, `primaryEnv`, `install`. `install` installs binaries (brew/node/go/uv/download), not sibling skills |
| A skill can be installed from a git ref | `openclaw skills install "git:<url>#logs-surface" --as wo-refprobe` produced version 1.1.0 including `vercel_insights/logs.py`. Removed afterwards. Source (`dist/git-install-*.js`) parses `#ref` or `@ref`, full-clones, then `git checkout --detach <ref>` |
| Secrets can be references rather than values | `openclaw config set skills.entries.<slug>.apiKey --ref-provider default --ref-source env --ref-id VAR` |

Consequences for this design:

- **No scheduler needs to be written, and no systemd unit is needed.** Cron is
  the scheduler. A systemd fallback is documented in README.md for the case
  where someone runs with `cron.enabled: false` or `OPENCLAW_SKIP_CRON=1`, but
  it is a fallback, not the shipped path.
- **No notification system needs to be written.** Module 4 is satisfied by
  printing to stdout, which is the requirement that alerts travel over
  OpenClaw's own mechanism rather than a bespoke bot token.
- **The dependency on the other two skills cannot be declared in the
  manifest.** It is documented, and detected at runtime, and that is the whole
  of what is available.

### Vercel request logs, verified live

The `logs-surface` branch of `openclaw-vercel-insights` (version 1.1.0) was
cloned and `vercel_insights/logs.py` read in full, along with the presets, the
JSON renderer and the six-entry HTTP allowlist. Then it was run against a real
account.

| Fact | How it was checked |
| --- | --- |
| `entries[].requestId` is a stable per-request id, suitable as a dedupe key | Live `logs --json` returned 50 rows each carrying one, for example `jmx7f-1787084327029-710ad73a2b68` |
| The safe fields are `requestId`, `timestamp`, `status`, `method`, `path`, `route`, `source`, `environment`, `region`, `crashed`, `isError`, `level` | Read from `render._log_entry_json` |
| The unsafe fields are `message`, `lines[].message` and `raw` | Same function. `logs.normalize` scrubs only the tool's own Vercel token from them; whatever the application printed passes through |
| `level` can be `null`, not only `""` | A live row carried `"level": null` |
| Preset default windows are 1h (`logs`), 1h (`errors`), 6h (`error-summary`) | `presets.py`, `default_since` |
| An empty result is exit 0 | Live `errors --since 1h` printed "No request logs" and exited 0 |
| A **window ending more than about an hour in the past fails with HTTP 400 `{"name":"ExceedsBillingLimitError"}`**, which is exit 1 | Measured: `--since 70m --until 60m` fails, `--since 61m --until 55m` succeeds, `--since 3h --until 2h` fails |
| With `until` left at its default of now, **every** `--since` succeeds | Measured at 30m, 1h, 2h, 6h, 24h and 7d |
| This account's retention behaves as 1 hour | Implied by the boundary above, matching the published Hobby figure |

The last three rows are not in that skill's documentation and they change the
design:

- **The error watch never passes `--until`.** It varies `--since` only. That
  removes an entire failure mode rather than handling it, which is why it is a
  design rule and not a caveat.
- An `ExceedsBillingLimitError` is still detected and explained, because a
  future window default or a user-supplied flag could reintroduce it.

### Assumed, and marked as such

- That `dist/git-install-*.js` serves `skills install` as well as plugin
  installs. The parser and checkout were read there; the observable behaviour of
  `skills install ...#logs-surface` matches it exactly, which is the evidence
  that matters, but the code path was not traced end to end.
- That request-log retention on other plans matches Vercel's published figures
  (1 day Pro, 3 days Enterprise, 30 days Observability Plus). Only the 1 hour
  case was measured.

## Shape

Node and TypeScript, sources in `src/`, built to a committed `lib/`, zero
runtime dependencies, vitest for tests. This mirrors `open-ga4` rather than
`openclaw-vercel-insights` because zero dependencies is a requirement here and
Node's built-in `fetch` plus `AbortSignal` covers uptime checking with nothing
added.

```
bin/web-observer          launcher, resolves its own location
lib/                      built output, committed, what SKILL.md tells the agent to run
src/cli/                  argument parsing, dispatch, exit codes, rendering
src/config.ts             load and validate config; the URL allowlist is built here
src/uptime/               check one URL, classify a failure, decide when to alert
src/state.ts              durable per-watch state, atomic writes
src/bridge/vercel.ts      the only module that knows vercel-insights exists
src/bridge/ga4.ts         the only module that knows open-ga4 exists
src/schedule.ts           emit or apply the openclaw cron add commands
```

### Commands

| Command | What it does |
| --- | --- |
| `check` | Run every configured watch once, now, and print a table. The verify-my-config command. `--strict` exits 3 if anything is down |
| `watch` | The cron entry point for uptime. Checks only watches that are due, updates state, prints an alert or `NO_REPLY` |
| `vercel-watch` | The cron entry point for the Vercel budget and error-log polls |
| `digest` | The cron entry point for the GA4 traffic digest |
| `vercel <preset> [flags]` | Ad hoc passthrough to vercel-insights, preset allowlisted |
| `ga4 <preset> [flags]` | Ad hoc passthrough to open-ga4, preset allowlisted |
| `doctor` | Config, dependency and cron-wiring diagnostics. `--json` names one next step |
| `schedule` | Print the `openclaw cron add` commands for the current config; `--apply` runs them |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Worked. Includes "everything is up", "no new errors", and an empty result |
| 1 | A check or a delegated call failed for a network or API reason |
| 2 | Configuration or usage error |
| 3 | Worked, and the answer is bad news. Only from `check --strict` |
| 130 | Interrupted |

**`watch` exits 0 even when it alerts.** An alert is this tool's normal output,
not a malfunction. Exiting non-zero would make cron's own `failureAlert` fire
alongside the alert already printed, so the user would be told twice by two
different mechanisms. This is the single easiest mistake to make here and it is
therefore a test.

## Module 1: uptime

### Configuration

One file, `~/.openclaw/web-observer/config.json`, honouring `OPENCLAW_STATE_DIR`
so profiles stay isolated, and overridable with `WEB_OBSERVER_CONFIG`. Not
`openclaw.json`: a list of watches is hostile to `openclaw config set`, and the
skill directory is replaced on reinstall so nothing durable may live there.

Per watch: `id`, `url`, `intervalMinutes`, `method` (default GET),
`expectStatus` (default `[200]`, accepts numbers, `"2xx"` classes and
`[min, max]` ranges), `expectBody` (substring) or `expectBodyRegex`,
`timeoutMs` (default 10000), `failureThreshold` (default 2),
`recoveryThreshold` (default 1), `followRedirects` (default 0), `headers`,
`enabled`.

Defaults live in `uptime.defaults` and each watch overrides them, so a
twelve-URL config is not twelve copies of the same four numbers.

### The allowlist is structural

The requirement is that any host Web Observer contacts itself is enforced by an
allowlist in code, not merely documented. So:

- The allowlist is derived from the configured watch URLs at load time. There is
  no other source and no flag that extends it.
- The HTTP layer takes a watch, not a URL string, and re-checks the parsed
  host against the allowlist before the request.
- Redirects are not followed by default. A 3xx is reported as the status it is,
  which is honest and keeps the allowlist binding on every hop.
- With `followRedirects > 0`, **each hop is re-checked against the same
  allowlist**. A hop leaving it fails the check with reason
  `redirect-off-allowlist`, naming the host, so the user can add it if they
  meant it. A redirect can therefore never take a request to a host the user did
  not configure.

### Failure classification

Typed reasons, because "it failed" is not an alert anybody can act on:
`timeout`, `dns`, `connection-refused`, `tls`, `status-mismatch`,
`body-mismatch`, `redirect-off-allowlist`, `network`. Each alert names the
reason, the URL, the observed value and the time.

### Alert once, recover once

State per watch: `consecutiveFailures`, `consecutiveSuccesses`, `down`,
`lastCheckAt`, `nextDueAt`, `lastReason`, `alertedAt`.

- A watch alerts when `consecutiveFailures >= failureThreshold` **and** it is
  not already `down`. It then stays quiet however long it remains down.
- It sends exactly one recovery message when `consecutiveSuccesses >=
  recoveryThreshold` while `down`.
- Several watches failing on the same tick produce one message, not one each.

State is a single JSON file written atomically, temporary file then rename, so a
crash mid-write cannot leave a half-parsed file that would re-alert everything.

### Per-URL intervals from one cron job

A marketing page and a payment webhook want different cadences, and one cron job
per URL would multiply gateway wakeups. Instead one job ticks at
`uptime.tickMinutes` (default 5) and `watch` checks only the watches whose
`nextDueAt` has passed. An interval is therefore honoured to within one tick,
and `doctor` warns when an interval is smaller than the tick or not a multiple
of it, because otherwise the effective cadence would silently differ from the
configured one.

## Module 2: Vercel

Everything Vercel-related is delegated. `src/bridge/vercel.ts` is the only
module that knows the other skill exists, so re-pinning it later is a change in
one file.

- **Locating it**: `WEB_OBSERVER_VERCEL_SKILL_DIR`, else the workspace and
  shared skill directories.
- **Invoking it**: the skill's own `.venv/bin/python` when present, else
  `python3`, as `-m vercel_insights` with the skill directory as the working
  directory. Argument vectors, never a shell string.
- **Capability detection**: read `version:` from its `SKILL.md` and check for
  `vercel_insights/logs.py`. Three outcomes are reported distinctly: absent,
  present without the logs surface, present with it. The installed copy on this
  machine is 0.2.0 and has no logs surface, so the middle case is the one a real
  user hits today.
- **The pin**: `REQUIRED_LOGS_REF = "logs-surface"` with a TODO naming the
  branch URL, repeated in README.md. When it merges, that constant and the
  documented install command change and nothing else does.

### The error watch

1. Read the seen-request-id set from state.
2. Run `errors --project P --since <windowMinutes>m --json --limit 200`. Never
   `--until`.
3. Exit 1 is a monitor problem, not a site problem, and is reported as such,
   once, with the same debounce. Exit 2 is a configuration problem and says so.
4. Drop entries whose `requestId` is already seen. Add the rest. Prune ids older
   than twice the window.
5. Alert when the count of new errors exceeds `threshold`, alert-once.
6. Send one recovery message when a polling cycle finds no new errors while
   alerting.
7. `truncated: true` is surfaced as "more errors matched than were shown", so a
   flood is never understated as exactly the row limit.

The window overlaps the interval (20 minutes of window on a 15 minute interval)
so a slow cycle cannot let an error fall between two windows, and the dedupe by
`requestId` is what makes that overlap free of double alerts.

### Never forwarding raw log text

`includeMessages` defaults to false, and it is enforced at the adapter boundary:
with it off, `message`, `lines` and `raw` are **not carried out of
`bridge/vercel.ts` at all**. The alert formatter cannot leak what it was never
given, which makes this a structural guarantee rather than a formatting
convention. A test asserts the boundary, not the format.

### The budget watch

`--budget` exists only for Speed Insights metrics and exit 3 means exceeded.
That maps onto the same alert-once/recover-once machinery as everything else.

## Module 3: GA4

The same delegation shape, `src/bridge/ga4.ts`, invoking
`node <skill-dir>/lib/cli.js`. `open-ga4` is not installed on this machine, so
the graceful-degradation path is the one that can actually be tested here, and
it is: a clear sentence naming the skill and how to install it, exit 2.

A recurring digest runs a preset and prints its table for cron to announce.

## Module 4: notifications

Print to stdout, print `NO_REPLY` for silence. Verified above. `config.notify`
exists only so `schedule` can emit `--channel` and `--to`; nothing in this skill
opens a socket to Telegram.

## Composability

`requires` names `bins: [node]` and nothing else, and `requires.env` is empty.
An unconditional gate on a credential is what makes a skill permanently unready,
and uptime watching needs no credential at all, so a uptime-only install is
ready the moment it is installed. Each of the three blocks has its own
`enabled`, every command checks only the block it needs, and the two bridges
report absence rather than failing.

## Testing

Unit tests for the logic that decides whether a human gets woken up:

- The debounce state machine: alerts at the threshold and not before, once while
  down, one recovery, and the interaction with `recoveryThreshold`.
- Due-ness: which watches a tick selects.
- Failure classification for each reason.
- Allowlist enforcement, including a redirect to an off-allowlist host.
- Dedupe across overlapping windows by `requestId`.
- The message-redaction boundary: with `includeMessages` off, no unsafe field
  crosses it.
- Config validation, and that every error names the offending value.

Docs-consistency tests, mirroring both reference repos, so documentation cannot
drift from code without a test failing:

- The description renders in one table cell.
- `name`, directory and repository are the same string.
- `requires` names node only, and `requires.env` is empty.
- Every command in the decision table exists and parses; none is invented.
- Documented exit codes are exactly those the CLI returns.
- Every environment variable the code reads is declared, and every declared one
  is read.
- Zero runtime dependencies, and imports only `node:` builtins.
- The licence is MIT-0.
- The guidance sentences an agent needs are present: an empty result is exit 0,
  never state a number that was not measured, and never forward raw log text.
- The `logs-surface` pin and its TODO appear in both code and README.

Mutation checks on the tests that matter: flipping the threshold comparison,
removing the alert-once guard, and widening the allowlist must each fail a test.

## Deliverables

`SKILL.md`, `README.md`, `SETUP.md`, `LICENSE` (MIT-0), `CONTRIBUTING.md`,
`CHANGELOG.md`, an example config, and the systemd unit as a documented fallback
for the case where OpenClaw's cron is disabled.

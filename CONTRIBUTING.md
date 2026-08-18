# Contributing

## Getting set up

```bash
npm install
npm run check     # typecheck, then tests, then rebuild lib/
```

Node 22.22.3 or later. There are no runtime dependencies and there should not
be: everything uses `node:` builtins. A test enforces that, so adding an import
from anywhere else will fail the suite rather than quietly changing what this
skill installs.

## lib/ is committed, and must match src/

No install route runs a build. ClawHub copies files, `openclaw skills install
git:…` clones, and a local path install is a directory copy. So the compiled
output is committed, and `npm run check:lib` fails if it no longer matches a
fresh build of `src/`. Run `npm run build` before committing, and never hand-edit
anything under `lib/`.

## Things this project has decided, and why

Please read these before changing the behaviour they describe. Each one is a
decision with a reason, not an accident.

### Stdout is the notification channel

A scheduled run's stdout is delivered to the user's chat by OpenClaw's cron.
Therefore:

- **Never print to stdout on a scheduled path unless it is the message.**
  Progress, warnings and diagnostics go to stderr, via `note()`. A stray
  `console.log` becomes a chat message every five minutes.
- **Silence is the exact token `NO_REPLY`**, and it must be the whole of stdout.
- **A scheduled command exits 0 even when it alerts.** An alert is this tool
  working. A non-zero exit additionally triggers OpenClaw's own cron failure
  notification, so one outage would be reported twice and the job would be
  backed off after a few rounds.

### Alert once, recover once

The rules live in `src/uptime/decide.ts`, and everything there is pure: state and
a result in, new state and at most one event out. Keep it that way. It is the
part of this project whose bugs wake people up at three in the morning, and it is
testable without a network only because it does no I/O.

If you change a threshold comparison, mutate it deliberately and confirm a test
fails. Several tests exist specifically to pin the boundary cases, because a
`>=` quietly becoming `>` is invisible in review and delays every alert by one
interval.

### The allowlist is structural, not documentary

`allowlistOf` is the only constructor for the set of hosts this skill may
contact, its only input is the configured watch URLs, and the check runs before
every request **including every redirect hop**. Do not add a flag that extends
it, do not hoist the check out of the hop loop, and do not let `fetch` follow a
redirect itself: any of those three would leave the allowlist binding only the
first hop.

### Raw Vercel log text does not leave the bridge

The underlying skill scrubs only its own Vercel token from log content;
everything an application printed arrives verbatim, which can include secrets and
customer data. So with `includeMessages` off, `toSafeEntries` does not copy the
message, the log lines or the raw row into its result at all.

That is deliberately a boundary rather than a formatting choice: downstream code
cannot leak what it was never given. If you find yourself needing the text
further along, that is the signal to reconsider, not to widen the type.

### Credentials

Web Observer has no credential of its own. It reads the delegated skills'
configured credentials so it can pass them to those same skills, because a cron
job runs with the Gateway's environment rather than a skill's. Rules:

- Into a subprocess environment only. Never a command line, never a log line,
  never a file.
- `doctor` may report **where** a value came from, never the value.
- A `SecretRef` is reported as unresolvable rather than guessed at.

### Errors name the offending value

Compare `--limit 500 is outside the API bounds of 1 to 100` with `invalid limit`.
The first ends the interaction; the second starts a search. Every configuration
error carries the dotted path it was found at, and an unknown key suggests the
nearest real one.

An unknown key or flag is **refused, never ignored**. A dropped setting leaves a
default in force with nothing in the output to say the configured value was never
read, and that is how somebody comes to believe they ran a dry run when they did
not.

## Testing

```bash
npm test
```

### Mutation-check anything you add

After writing a test, break the code deliberately and confirm something fails. A
test that cannot fail is decoration. The mutations worth trying on this codebase:

- Flip a threshold comparison from `>=` to `>`.
- Remove the "already alerted" guard.
- Hoist the allowlist check out of the redirect loop.
- Change the shim to `process.exit()`.

Each of those is currently caught. That last one is caught by a test that pushes
more than a megabyte through a pipe: `process.exit()` abandons buffered output
while still reporting success, which for this tool would mean a truncated alert
that looks delivered.

### Documentation is pinned to the code

`src/docs.test.ts` fails when the documentation stops describing the code: the
declared environment variables against those actually read, the documented exit
codes against those returned, the flag table against the parser, the failure
reasons against the enum, and each security claim against the code enforcing it.

If a test there fails, fix whichever of the two is wrong. Do not relax the test
to match prose that has become false.

### Live calls

Mocked tests do not find the things that break. Before trusting a change to the
Vercel bridge, run it against a real account:

```bash
node lib/cli.js vercel errors --since 30m
node lib/cli.js vercel-watch --dry-run
```

The three most useful facts in this project were measured, not read: that a
command payload's stdout is delivered, that a cron job sees none of a skill's
environment, and that a log window ending in the past fails with HTTP 400. None
of them was in any document.

## Style

- British spelling in prose. No em dashes.
- Comments explain **why**, not what. If a line needs a comment saying what it
  does, rename something instead.
- Document the reasoning behind a decision at the point where somebody would
  otherwise undo it.

## Reporting a problem

Include the output of:

```bash
node <skill-dir>/lib/cli.js doctor --json
```

It names the configuration file, what is missing and what to do next, and it
contains no credentials.

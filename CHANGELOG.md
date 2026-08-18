# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-19

First release. Three things a website owner asks, answered from one command
line, with the first of them implemented here and the other two delegated.

### Added

- **Uptime watching.** A list of URLs, each with its own interval, checked by a
  single scheduled job that runs only what is due. One alert when a site goes
  down, one when it recovers, and silence in between. Status, body-substring and
  regular-expression expectations, so a 200 that renders an error page still
  fails. Typed failure reasons: `timeout`, `dns`, `connection-refused`, `tls`,
  `status-mismatch`, `body-mismatch`, `redirect-off-allowlist`, `network`.
- **Two independent blip guards.** `attempts` retries within one round, seconds
  apart, which catches a dropped packet. `failureThreshold` counts consecutive
  failed rounds, minutes apart, which catches a flaky minute.
- **A Vercel bridge.** Ad hoc traffic, speed and error-log questions, plus a
  scheduled poll that alerts on new errors and a performance budget check on
  Core Web Vitals. Errors are deduplicated across overlapping windows by request
  id, and the poll window widens to cover a missed cycle.
- **A GA4 bridge.** Ad hoc traffic questions and a scheduled digest.
- `check`, for verifying a configuration immediately without consuming the one
  alert a real outage is entitled to.
- `doctor`, which names one next step at a time, and `doctor --json` for an
  agent walking somebody through setup.
- `schedule`, which prints the `openclaw cron add` commands a configuration
  needs, and creates them with `--apply`.
- `--dry-run` on every command that would send a request or an alert.
- A systemd unit and timer, as a fallback for installs running with OpenClaw's
  cron disabled.

### Notes on how this works, all verified against a live OpenClaw 2026.7.1-2

- **Alerts travel over OpenClaw's own mechanism, and this skill holds no bot
  token.** A cron job with a `command` payload delivers the command's stdout to
  the configured chat channel, and the exact token `NO_REPLY` suppresses that
  delivery. So an alert is a scheduled command printing text, and silence is the
  same command printing `NO_REPLY`.
- **A scheduled run exits 0 even when it alerts**, because a non-zero exit would
  additionally fire OpenClaw's own cron failure notification and report one
  outage twice.
- **A cron command payload runs with the Gateway's environment**, which carries
  none of a skill's configured variables. Web Observer therefore reads the
  delegated skills' credentials from `openclaw.json` and passes them into those
  skills' own subprocess environment, rather than asking for them to be
  configured twice.
- **Vercel request logs must not be queried with an end in the past.** A window
  ending more than about an hour ago is answered `HTTP 400
  ExceedsBillingLimitError`; with the end left at now, every `--since` succeeds.
  The poller therefore never specifies an end.
- **An empty error log is not evidence of a healthy site**, because runtime logs
  are retained for one hour on Hobby. That is said in the alert rather than
  smoothed over.

### Security

- **Only user-configured hosts are contacted, enforced in code.** The allowlist
  is derived from the configured watch URLs by one function with no other input
  and no flag that extends it, and the host is re-checked before every request
  including every redirect hop. A redirect off the allowlist fails the check
  naming the host and is never followed. Redirects are not followed at all by
  default.
- Only `GET`, `HEAD` and `OPTIONS` are ever issued.
- **Raw Vercel log text is never forwarded into an alert unless the user opts
  in**, and that is enforced at the bridge rather than in the formatter: with
  `includeMessages` off, the message, the log lines and the raw row are not
  copied out of the bridge at all. The underlying skill scrubs only its own
  Vercel token from log content, so anything an application printed, including
  secrets and customer data, would otherwise arrive verbatim.
- A response body is measured, never quoted into an alert, and at most 1 MiB of
  it is read.
- Credentials travel only in a subprocess environment, never on a command line,
  never in output, never to a file.
- `requires.env` is empty, so uptime watching, which needs no credential, is
  never held in "needs setup" for one.

### Known limitations

- The Vercel error watch needs `openclaw-vercel-insights` 1.1.0, which currently
  lives on its `logs-surface` branch. An older copy is detected and reported by
  version and location, with the install command; traffic and speed keep
  working. See the TODO in README.md and in `src/bridge/vercel.ts`.
- There is no history: this tool alerts on change and does not keep a record of
  past outages beyond the current state.
- Retention figures for plans other than Hobby are taken from Vercel's
  documentation rather than measured.

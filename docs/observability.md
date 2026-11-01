# Observability

Logs, traces and the in-app log viewer. All of it applies to the web server
and the desktop app alike.

## OpenTelemetry

The server is instrumented with OpenTelemetry around the sync engine: every
reload tick, git operation, conflict auto-resolution, drift import, Automerge
document write, and websocket sync event produces spans and log records.
Export is off by default and opt-in through the standard OTEL environment
variables ([src/server/telemetry.ts](../src/server/telemetry.ts)):

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 bun run dev
```

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
override per signal (naming just one exports only that signal),
`OTEL_SERVICE_NAME` renames the service (default `specdriven`), and
`OTEL_SDK_DISABLED=true` is a hard off switch. Without an endpoint the
instrumentation is a no-op.

## Console

Console logging is unaffected by OTEL: sync activity always prints as
`[reload] …` / `[netsync] …` / `[git] …` lines. Set `SPECDRIVEN_DEBUG=1` to
also print the debug-level detail (per-file drift decisions, chunk saves,
document announcements) that otherwise skips the console.

## Log files

Every entry — debug included — also lands in a rotating log file, on by
default, so the packaged desktop app (whose stdout goes nowhere) still leaves
a trail. Files live in `~/.specdriven/logs/` (`$SPECDRIVEN_HOME/logs` when
that override is set): `specdriven.log` is current, `specdriven.log.1 … .4`
are older. Lines carry a timestamp, level, component, attributes, and —
when a trace is being exported — the `trace=`/`span=` ids to jump from a log
line to its trace.

| variable | meaning |
| --- | --- |
| `SPECDRIVEN_LOG_DIR` | moves the directory |
| `SPECDRIVEN_LOG_MAX_BYTES` | size per file before rotation (default 5 MB) |
| `SPECDRIVEN_LOG_MAX_FILES` | files kept (default 5) |
| `SPECDRIVEN_LOG_FILE=0` | turns file logging off |
| `SPECDRIVEN_LOG_LEVEL` | starting minimum level when nothing is saved (default `debug`, everything) |

## The Observability page

**Observability** in the user menu (or `g o`, at `/observability`) browses
those files in the app, newest first. You can search them as text or as a
regular expression, filter by level and component, and use Follow to watch
new entries arrive. With the file sink off, it shows the latest 2000 entries
kept in memory.

The page's Verbosity tab sets the log verbosity: a default minimum level plus
per-component overrides. An entry below its level is written nowhere (not
the file, the console or OTEL). Changes apply at once and are saved to the
settings file (`logLevel`, `logLevels`). The page is not offered in the
hosted demo.

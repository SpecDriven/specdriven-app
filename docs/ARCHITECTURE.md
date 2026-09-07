# TL;DR

Electron app built using Bun, just like how Claude Code and Codex.

## Language: TypeScript

## Storage: GitHub
(initially using 'data' folder in this repo)

The system of record inside the data repo is a set of Automerge (CRDT)
documents, one per feature, stored as content-addressed binary chunks under
`.specdriven/automerge/` and synced through the same git pull/push as
everything else. The `.feature.md` files are deterministic projections of
those documents — still the human-readable, PR-reviewable artifact on
GitHub. Concurrent edits merge at the CRDT level (character-level for
scenario bodies) instead of surfacing as git conflicts; markdown edited
outside the app (an older app version, a GitHub PR) is reconciled back into
the documents on the next sync tick. Optionally, Settings can name a
websocket sync server (e.g. wss://sync.automerge.org) that delivers the
same operations in near-real time — off by default, git stays the source of
record. See specs/automerge-store.spec.md.

## Authorized users:
Users that have read/write access to the repo that stores data. 

## Local state

`.specdriven/settings.json`, in the project root or in `$HOME`
(specs/app-start.spec.md)

# Integration with AI coding agents

"Start session" builds one prompt from the selected specs and hands it to an
agent — Claude Code Desktop, or the app's own pane driven by Claude, by Pi or
by Codex (src/server/agent.ts). Desktop: the full prompt and a `session.json` record are
written under
`<settings dir>/sessions/<uuid>/` — beside `.specdriven/settings.json`, never
in the auto-pushed data repo — and the app opens
`claude://code/new?q=<bootstrap>&folder=<data repo>`, a short prompt that tells
the new Claude Code Desktop session to title itself with the session name and
work from the prompt file. The deep link and its limits (`q` capped at 14336
chars) were read from the shipped Claude.app bundle, not from public docs, so
they are version-coupled.

Pane: for developers with the Claude CLI but not Claude Code Desktop, the app
drives a live Claude Code session itself (src/server/agentChat.ts,
src/frontend/AgentPane.tsx). One long-lived `query()` from
`@anthropic-ai/claude-agent-sdk` per chat, in streaming-input mode, spawns the
developer's own `claude` binary with the project's `code-repo` (else the data
repo) as its working directory and Claude Code's own system prompt and
settings. The SDK's messages become an in-memory event log with sequence
numbers; the browser reads it over a one-way NDJSON stream from the same route
table (no WebSocket, so it works over Electron's `app://` too) and reopens the
stream from the last sequence it saw. Permission requests and clarifying
questions round-trip through cards in the pane; the "/" popup lists whatever
`supportedCommands()` reports for the session. A `session.json` with
`agent: "pane"` and Claude's own session id (`agentSessionId`) goes under
`<settings dir>/sessions/<uuid>/`, so resuming a past pane session is a cheap
follow-up. When a project names a
`code-repo`, the session runs there and the data repo is an additional
directory, so Claude can read the specs the prompt points at.

Pi: the same pane, driven by pi.dev's agent instead (src/server/piChat.ts,
specs/agents/integration-with-pi-dev-agent.feature.md), offered when the `pi`
binary is on PATH. `pi --mode rpc` speaks JSON lines on stdin/stdout: commands
out (`prompt`, `abort`, `get_state`, `get_commands`), a `response` per command
correlated by id, and a stream of events in. Those events are translated into
the very same event log Claude's messages fill, so the transcript, the browser
stream and the session record are shared; the record says `agent: "pi-pane"`.
Framing is strict JSONL — split on `\n` only, strip a trailing `\r`, never a
generic line reader, since U+2028 is legal inside JSON strings. Pi's RPC mode
has no permission protocol: it runs its own tools, so those sessions raise no
permission cards, offer no permission mode, and say so in the transcript.
Extension dialogs, which would otherwise block pi forever, are cancelled with
a note.

Codex: the same pane, driven by OpenAI's Codex CLI (src/server/codexChat.ts),
offered when the `codex` binary is on PATH. `codex app-server` speaks
JSON-RPC-shaped lines on stdin/stdout: requests out (`initialize`,
`thread/start`, `turn/start`, `turn/interrupt`, `turn/steer`), a response per
request correlated by id, notifications in (`item/started`,
`item/agentMessage/delta`, `item/completed`, `turn/completed`, `error`) and —
unlike pi — requests *from* the server that block the turn until answered:
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/tool/requestUserInput`. The notifications are translated into the shared
event log (a command or file change is a tool row, an agent message a streamed
reply, `turn/completed` the turn footer); the server requests become the same
permission and question cards Claude raises, answered with Codex's decisions
(`accept`, `acceptForSession` for "Allow always", `decline`, `cancel` on a
Stop). Codex has no permission modes but an approval policy and a sandbox, so
the pane's modes map onto those (default → on-request + workspace-write,
acceptEdits → on-failure, plan → read-only, bypass → never + full access) and
travel with every `turn/start`; a change applies from the next turn. The
protocol shapes were read out of `codex app-server generate-ts` for Codex CLI
0.141, so they are version-coupled. The record says `agent: "codex-pane"` and
carries Codex's thread id as `agentSessionId`; the thread is named after the
session, so `codex resume` lists it by that name.

The feature spec lives in the spec repo as
`specs/agents/coding-agent-ui.feature.md`; the spec repo is never edited from
this one.

# Decisions

## Why not RDBMS for data ?

We want to make this application very easy to adopt.
Provisioning an RDBMS server maybe a source of friction in some
environments.

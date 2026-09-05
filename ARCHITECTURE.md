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

"Start session" builds one prompt from the selected specs and hands it to
Claude in one of three ways (src/server/agent.ts). Headless: `claude -p <prompt>`
runs in the data repo and its output is shown when it exits. Desktop: the full
prompt and a `session.json` record are written under
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
`agent: "pane"` and Claude's own session id goes under
`<settings dir>/sessions/<uuid>/`, so resuming a past pane session
(`resume: claudeSessionId`) is a cheap follow-up. When a project names a
`code-repo`, the session runs there and the data repo is an additional
directory, so Claude can read the specs the prompt points at.

The feature spec lives in the spec repo as
`specs/agents/coding-agent-ui.feature.md`; the spec repo is never edited from
this one.

# Decisions

## Why not RDBMS for data ?

We want to make this application very easy to adopt.
Provisioning an RDBMS server maybe a source of friction in some
environments.

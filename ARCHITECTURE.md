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
Claude in one of two ways (src/server/agent.ts). Headless: `claude -p <prompt>`
runs in the data repo and its output is shown when it exits. Desktop: the full
prompt and a `session.json` record are written under
`<settings dir>/sessions/<uuid>/` — beside `.specdriven/settings.json`, never
in the auto-pushed data repo — and the app opens
`claude://code/new?q=<bootstrap>&folder=<data repo>`, a short prompt that tells
the new Claude Code Desktop session to title itself with the session name and
work from the prompt file. The deep link and its limits (`q` capped at 14336
chars) were read from the shipped Claude.app bundle, not from public docs, so
they are version-coupled.

# Decisions

## Why not RDBMS for data ?

We want to make this application very easy to adopt.
Provisioning an RDBMS server maybe a source of friction in some
environments.

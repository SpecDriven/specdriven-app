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
the documents on the next sync tick. See specs/automerge-store.spec.md.

## Authorized users:
Users that have read/write access to the repo that stores data. 

## Local state

`.specdriven/settings.json`, in the project root or in `$HOME`
(specs/app-start.spec.md)

# Integration with AI coding agents

We will use the MCP protocol

# Decisions

## Why not RDBMS for data ?

We want to make this application very easy to adopt.
Provisioning an RDBMS server maybe a source of friction in some
environments.

## Why MCP server

We want coding agents to use an MCP server to get ready for growth.
MCP will provide tools for the agent to work with specs efficiently.

# TL;DR

Electron app built using Bun, just like how Claude Code and Codex.

## Language: TypeScript

## Storage: GitHub
(initially using 'data' folder in this repo)

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

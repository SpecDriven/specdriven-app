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
record. See specs/datastore/automerge-store.feature.md.

## Authorized users:
Users that have read/write access to the repo that stores data. 

## Local state

`.specdriven/settings.yaml`, in the project root or in `$HOME`
(specs/ui/app-start.feature.md)

## Local trust boundary

The API has no login of its own: it serves whoever owns the machine, with
that person's git credentials and agent CLIs. Behind it sit routes that
write the data repo (which then auto-pushes to GitHub), change settings,
install plugins and start coding agents — up to `bypassPermissions` — that
run commands. So the web server (`src/index.ts`) treats everything beyond
the machine's own user as untrusted:

- **Loopback only.** `Bun.serve` binds `127.0.0.1` (Bun's default is every
  interface). `SPECDRIVEN_HOST` opens it up — not plain `HOST`, which shells
  set to the machine's name.
- **Every request passes `rejectRequest`** (`src/server/requestGuard.ts`)
  before the route table, plugin routes included:
  - *Host* must be a loopback name (`localhost`, `127.0.0.1`, `[::1]`,
    `*.localhost`, any port) or listed in `SPECDRIVEN_ALLOWED_HOSTS`
    (comma-separated; `*` turns the check off). This stops DNS rebinding,
    where a hostile domain re-pointed at 127.0.0.1 would otherwise read and
    drive the API as same-origin. → 403
  - *Origin* on a POST/PUT/DELETE must have the request's own host (the
    scheme is not compared, so a TLS-terminating proxy works). Without an
    Origin, `Sec-Fetch-Site: cross-site` is refused; a request with neither
    header is a non-browser client (curl, a script) and passes. This stops
    any other website open in the same browser from posting to localhost.
    → 403
  - *Content-Type* of a write body must be `application/json` or
    `multipart/form-data` (image upload). Handlers parse JSON whatever the
    header says, and text/plain or form posts are the kinds a browser sends
    cross-origin without a CORS preflight; this backs up the Origin check.
    Body-less writes need no type. → 415
- **The desktop app is outside it.** Electron serves the same `handleApi`
  over its own `app://` scheme, which no web page can reach, so the guard
  sits in the web server's `fetch`, not in `handleApi`.
- **The demo image** (`Dockerfile`) sets `SPECDRIVEN_HOST=0.0.0.0` and
  `SPECDRIVEN_ALLOWED_HOSTS=*`: it must answer on its public interface under
  whatever domain the platform assigns, and its dataset is a throwaway copy.
  The Origin and Content-Type checks still apply.

What it does not cover: other processes and accounts on the same machine
can still reach loopback. A per-launch token in a `SameSite=Strict` cookie
would close that if the app ever runs on shared hosts.

- **The hosted gateway** (`src/gateway`, [deployment-railway.md](deployment-railway.md))
  is the multi-user deployment: it signs people in, applies the same checks
  to every request, and forwards a signed-in person's requests to their own
  app server on a private unix socket. That server runs in hosted mode
  (`SPECDRIVEN_HOSTED=1`, `src/server/hostedMode.ts`), which refuses agents,
  plugin installs, local paths and everything else that would run code on
  the shared host.

# Integration with AI coding agents

"Start session" builds one prompt from the selected specs and hands it to an
agent — Claude Code Desktop, or the app's own pane driven by Claude, by Pi or
by Codex (src/server/agent.ts). Desktop: the full prompt and a `session.json` record are
written under
`<settings dir>/sessions/<uuid>/` — beside `.specdriven/settings.yaml`, never
in the auto-pushed data repo — and the app opens
`claude://code/new?q=<bootstrap>&folder=<data repo>`, a short prompt that tells
the new Claude Code Desktop session to title itself with the session name and
work from the prompt file. The deep link and its limits (`q` capped at 14336
chars) were read from the shipped Claude.app bundle, not from public docs, so
they are version-coupled.

Pane: for developers with a coding agent's CLI but not Claude Code Desktop,
the app drives a live session itself (src/server/agentChat.ts,
src/frontend/AgentPane.tsx). Which agent is a provider's business
(specs/agents/agent-plugins.feature.md): a plugin's host half registers an
`AgentProvider` on the kernel's `agents` registry (src/plugins/host/agents.ts)
— its label, rank, CLI, permission modes and capabilities, plus `start()`;
the engine lends each session an `AgentHost` (emit output, ready/update,
turn started/ended, request a permission, ended/failed) and gets back an
`AgentSession` (send, interrupt, set the mode, close). The engine owns what
every session shares: the in-memory event log with sequence numbers, the
permission cards and their answers, the turn count, the `session.json`
record and the routes' API. The browser reads the log over a one-way NDJSON
stream from the same route table (no WebSocket, so it works over Electron's
`app://` too) and reopens the stream from the last sequence it saw. The core
names no agent: `/api/state` lists the providers' descriptors (`agents`), the
session dialog and the pane read those, a session asked for without an agent
runs on the first available by rank, and the record's `agent` is the
provider id (`agentLegacy.ts` reads the pre-plugin record values "pane",
"pi-pane" and "codex-pane" as ids). The three providers are marketplace plugins
(`plugins/agent-claude`, `agent-codex` and `agent-pi` in the
SpecDriven/plugins repository), not part of this tree: at start the app
reads the cached marketplace indexes and, for each row carrying `agent:
{ id, command }` whose command is on PATH, installs the plugin the way
Settings → Plugins would — once, remembered in `plugins.autoInstalled` so a
plugin the user removed stays removed (src/plugins/host/autoInstall.ts,
called from `applyStartupState` without being awaited; the pane learns of
the new plugin through `/api/plugins/events`). The pane's empty state offers
the rest from the same indexes. Their manifests `autoEnable`: they go on in
every data folder the first time it is opened with them installed, since
they have no tab, and a switch-off in Settings → Plugins is kept per folder
(`plugins.repos[<folder>].autoEnabled`). Each is mounted with a `HostConfig`:
`settings`, the plugin's own section of settings.yaml
(`pluginSettings[<id>]`, src/plugins/host/pluginSettings.ts, patched through
the service or `PUT /api/state`), and `secrets(name)`, a named store kept
apart from the settings file (src/server/secrets.ts: a 0600 file under the
home, or Electron safeStorage on the desktop; the Claude plugin's token
store keeps the `claude-token.json` file it had while Claude was built in).
The Claude plugin keeps how Claude signs in under its section — adopted
once from the old top-level keys — and changes it through its own `PUT
/api/claude/settings`; its Settings section comes from the client's
`settings` registry (src/plugins/client/settings.ts), the page's extension
point, which puts a plugin's section where its `order` says among the core
ones. The demo registers a scripted provider of its own under Claude's id
(src/server/demoAgent.ts) and installs no agent plugin. The hosted app runs
no plugin folders, so it has no agent.

Claude (`plugins/agent-claude/src/provider.ts`): one long-lived `query()` from
`@anthropic-ai/claude-agent-sdk` per chat, in streaming-input mode, spawns
the developer's own `claude` binary with the project's `code-repo` (else the
data repo) as its working directory and Claude Code's own system prompt and
settings. Permission requests and clarifying questions round-trip through
cards in the pane; the "/" popup lists whatever `supportedCommands()` reports
for the session. The provider also owns the account chip and the
first-response watchdog for a proxy that does not answer, and answers the
one-shot turn the task estimate asks for. When a project names a
`code-repo`, the session runs there and the data repo is an additional
directory, so Claude can read the specs the prompt points at.

Pi: the same pane, driven by pi.dev's agent instead (`plugins/agent-pi/src/provider.ts`
over its piChat.ts,
specs/agents/integration-with-pi-dev-agent.feature.md), offered when the `pi`
binary is on PATH. `pi --mode rpc` speaks JSON lines on stdin/stdout: commands
out (`prompt`, `abort`, `get_state`, `get_commands`), a `response` per command
correlated by id, and a stream of events in. Those events are translated into
the very same event log Claude's messages fill, so the transcript, the browser
stream and the session record are shared; the record says `agent: "pi"`.
Framing is strict JSONL — split on `\n` only, strip a trailing `\r`, never a
generic line reader, since U+2028 is legal inside JSON strings. Pi's RPC mode
has no permission protocol: it runs its own tools, so those sessions raise no
permission cards, offer no permission mode, and say so in the transcript.
Extension dialogs, which would otherwise block pi forever, are cancelled with
a note.

Codex: the same pane, driven by OpenAI's Codex CLI (`plugins/agent-codex/src/provider.ts`
over its codexChat.ts),
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
0.141, so they are version-coupled. The record says `agent: "codex"` and
carries Codex's thread id as `agentSessionId`; the thread is named after the
session, so `codex resume` lists it by that name.

The feature specs live in the spec repo as
`specs/agents/agent-pane.feature.md` and
`specs/agents/agent-plugins.feature.md`; the spec repo is never edited from
this one.

# Decisions

## Why not RDBMS for data ?

We want to make this application very easy to adopt.
Provisioning an RDBMS server maybe a source of friction in some
environments.

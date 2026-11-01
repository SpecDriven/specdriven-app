# Running the app from source

How to run, configure and debug a checkout of SpecDriven. Installing a
release is covered in [installation.md](installation.md); building binaries
and desktop installers in [building.md](building.md).

## Prerequisites

- [Bun](https://bun.sh) 1.3 or later (the only build tool).
- `git` on PATH: the data repo is a git repository, and every save is a
  commit. The GitHub CLI (`gh`) is optional; without it the app signs in to
  GitHub itself.

```sh
bun install
```

## Scripts

```sh
bun run dev            # bun --hot src/index.ts — HMR on, restarts on change
bun run dev:debug      # under Bun's inspector, no --hot (see "Debugging")
bun run start          # no hot reload
bun run dev:electron   # desktop shell; expects `bun run dev` in another terminal
bun run demo           # public self-resetting demo, see deployment-modes.md
bun run dev:hosted     # multi-user gateway, see deployment-modes.md
bun test               # the test suite
bun run typecheck      # tsc --noEmit
```

The server listens on <http://localhost:3000>, loopback only; set `PORT` to
move it. The API has no login, so it refuses requests from other machines,
from other websites open in your browser, and for host names that are not
this machine — see "Local trust boundary" in [ARCHITECTURE.md](ARCHITECTURE.md)
for `SPECDRIVEN_HOST` and `SPECDRIVEN_ALLOWED_HOSTS`, which open it up for a
deployment. Setting `NODE_ENV=production` disables HMR and serves the
pre-bundled frontend, which is what the compiled binary does. `dev:electron`
points the desktop window at the running dev server, so edits hot-reload
inside the desktop shell too.

## First start and the data repo

On first start the app asks for a data repo, because no settings file names
one yet. Give it a GitHub url like
`https://github.com/SpecDriven/data-insurance`; it is cloned into a sibling
directory of this repo (`../data-insurance`). A plain relative path to an
existing local clone works too.

## Settings

Settings are read from `./.specdriven/settings.json` (git-ignored,
per-checkout) and fall back to `~/.specdriven/settings.json`, so one settings
file can serve every checkout; `SPECDRIVEN_HOME` overrides that home
directory. Settings are saved back to whichever file was read.

Besides the data repo, the file holds the reload interval, the editor
autosave interval, the scenario preview length, the git engine, the
test-links toggle and the external-links toggle (whether Jira/Linear ticket
links are written into the `.feature.md` files). All of them are editable
from the Settings dialog, which also reports what the GitHub CLI is signed in
as and holds the app's own GitHub sign-in (device flow) for machines without
`gh`.

### A throwaway profile

To try the app on a clean slate — the first-run screen, cloning with a
personal access token — without touching your real settings, GitHub token or
clones, give it a folder of its own:

```sh
PORT=3100 bun run dev --profile /tmp/specdriven-try
```

`--profile <dir>` keeps settings in `<dir>/.specdriven/`, the home folder
(GitHub token, logs) in `<dir>/home` and GitHub clones in `<dir>/repos`; it
creates the folders, and `SPECDRIVEN_ROOT`, `SPECDRIVEN_HOME` or
`SPECDRIVEN_REPOS_DIR` set explicitly still win. Delete the folder to start
over.

## Debugging

The server code runs on two runtimes, each with its own debugger:

- **Web app (Bun):** `bun run dev:debug` starts the server under Bun's
  inspector (no `--hot`, which fights with breakpoints) and prints a
  `https://debug.bun.sh/#…` link to debug it from the browser. The VS Code
  Bun extension (`oven.bun-vscode`) can launch or attach too. Bun speaks the
  WebKit inspector protocol, so Chrome DevTools and `chrome://inspect` cannot
  attach.
- **Desktop app (Electron main process, Node):** in an unpackaged run
  (`bun run dev:electron`), the **Debug → Main-Process Debugger…** menu opens
  Node's inspector on `127.0.0.1:9229` (or a free port if that one is taken)
  and offers its urls to copy. Attach from `chrome://inspect`, a VS Code
  `"type": "node"` attach configuration, or paste the DevTools url into
  Chrome. A paused breakpoint freezes the window until you resume. Packaged
  builds have no Debug menu.
- **Frontend:** the browser's DevTools, or **Debug → Toggle Window DevTools**
  in the desktop app.

Logs, tracing and the in-app log viewer are described in
[observability.md](observability.md).

## Tests

```sh
bun test                      # whole suite
bun test tests/parser.test.ts # one file
```

Tests live under [tests/](../tests) and run against the server and frontend
modules directly — no browser. The git tests do start a server: a loopback
git smart-HTTP fixture ([tests/helpers/gitHttpServer.ts](../tests/helpers/gitHttpServer.ts))
serves bare origin repos, so pushes and pulls go over the transport a real
remote uses. Every test process runs on a pinned PATH holding git and no `gh`
([tests/helpers/binPath.ts](../tests/helpers/binPath.ts), preloaded via
[bunfig.toml](../bunfig.toml)), so your own GitHub CLI can never decide which
engine the suite exercises or authenticate anything; the gh-engine tests put
a stub `gh` on PATH themselves.

The desktop restart crash test (`bun run test:desktop`) is described in
[building.md](building.md#checking-that-a-build-starts).

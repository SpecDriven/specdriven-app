# SpecdrivenApp

Desktop application in support of Enterprise Spec-driven Development — see [PRD.md](PRD.md)
for the problem it solves and [ARCHITECTURE.md](ARCHITECTURE.md) for the shape of
the solution.

A local Electron / React app built by [Bun](https://bun.sh); specs live as
markdown feature files in a separate **data repo** on GitHub, which the app
clones and git-pulls on a timer. One backend serves it two ways: a web app via
`Bun.serve()` for development testing, and a packaged Electron desktop app that serves the same routes
over its `app://` protocol and registers `specdriven://` deep links with the
OS.

# Development

## Prerequisites

- [Bun](https://bun.sh) — currently developed against 1.3.14. It is the runtime,
  the bundler, and the test runner; there is no npm, vite, or jest here, and no
  Node.js to install. (The server code does stick to Node APIs so it can also
  run inside Electron's main process — on the Node that Electron bundles.)
- Access to the data repo you intend to open. Git itself is built in (a bundled
  JavaScript implementation over HTTPS); a system `git` binary is optional and
  only used when selected in Settings or as automatic fallback. Running the
  test suite does require `git` (fixtures are built with it).

## Install dependencies

```sh
bun install
```

## Run the app

```sh
bun run dev            # bun --hot src/index.ts — HMR on, restarts on change
bun run start          # no hot reload
bun run dev:electron   # desktop shell; expects `bun run dev` in another terminal
```

The server listens on <http://localhost:3000>; set `PORT` to move it. Setting
`NODE_ENV=production` disables HMR and serves the pre-bundled frontend, which is
what the compiled binary does. `dev:electron` points the desktop window at the
running dev server, so edits hot-reload inside the desktop shell too.

On first start the app asks for a data repo, because no settings file names one
yet. Give it a GitHub url like `https://github.com/SpecDriven/data-insurance`; it
is cloned into a sibling directory of this repo (`../data-insurance`). A plain
relative path to an existing local clone works too. The same file also holds the
reload interval, the scenario preview length, the git engine, and the test-links
toggle — all editable from the Settings dialog, which also holds the GitHub
sign-in (device flow) used to authenticate pushes.

Settings are read from `./.specdriven/settings.json` (git-ignored, per-checkout)
and fall back to `~/.specdriven/settings.json`, so one settings file can serve
every checkout; `SPECDRIVEN_HOME` overrides that home directory. Settings are saved
back to whichever file was read.

## Tests

```sh
bun test                      # whole suite
bun test tests/parser.test.ts # one file
```

Tests are colocated under [tests/](tests) and run against the server and frontend
modules directly — no browser. The git tests do start a server: a loopback git
smart-HTTP fixture ([tests/helpers/gitHttpServer.ts](tests/helpers/gitHttpServer.ts))
serves bare origin repos to both engines, since the built-in engine cannot talk
to local-path remotes.

## Build a binary

`bun build --compile` embeds the Bun runtime, so each binary is a standalone
60–95 MB executable with no runtime dependency.

```sh
bun run build       # host platform only -> dist/specdriven
bun run build:all   # full cross-compile matrix -> dist/specdriven-<os>-<arch>
```

`build:all` wipes `dist/`, cross-compiles all six targets, and writes
`dist/SHASUMS256.txt`:

| asset | bun target |
| --- | --- |
| `specdriven-darwin-arm64` | `bun-darwin-arm64` |
| `specdriven-darwin-x64` | `bun-darwin-x64` |
| `specdriven-linux-arm64` | `bun-linux-arm64` |
| `specdriven-linux-x64` | `bun-linux-x64` |
| `specdriven-linux-x64-baseline` | `bun-linux-x64-baseline` |
| `specdriven-windows-x64.exe` | `bun-windows-x64` |

The suffixed names double as the release asset names — [install.sh](install.sh)
fetches exactly these and verifies them against `SHASUMS256.txt`. The baseline
Linux build exists for CPUs without AVX2, where the default x64 build dies with
an illegal instruction. See [scripts/build.ts](scripts/build.ts).

## Build the desktop app

```sh
bun run build:desktop   # -> release/SpecDriven-<version>-arm64.dmg (+ .zip)
```

Three steps: bundle the frontend into static files (served over the `app://`
protocol), bundle the Electron main process for Node, then hand both to
electron-builder. See [scripts/build-desktop.ts](scripts/build-desktop.ts); add
`x64` to the arch lists under `"build"` in package.json for Intel artifacts.
The bundle registers the `specdriven://` url scheme with the OS, so spec links
launch or focus the installed app. Builds are unsigned for now — first launch
needs Gatekeeper approval.

## Distribution

Users install with:

```sh
curl -fsSL https://specdriven.app/install.sh | sh
```

The installer detects os/arch, downloads `$BASE_URL/$VERSION/$asset`, verifies
the checksum, installs to `~/.specdriven/bin/specdriven`, and prints PATH setup.
It fails closed: a mismatch, a missing `SHASUMS256.txt`, or a 404 aborts without
writing anything. Override with `SPECDRIVEN_VERSION`, `SPECDRIVEN_BASE_URL`, or
`SPECDRIVEN_HOME`.

Asset hosting and versioning are not wired up yet —
[roadmap/deployment.md](roadmap/deployment.md) tracks what is left.

## Layout

```
src/index.ts        web entry — Bun.serve() over the shared route table
src/server/         api (routes shared by web + desktop), features, parser, search,
                    git/ (js + cli engines), auth, github, tokenStore, repo, state, user, reload
src/electron/       desktop shell — main, app:// static serving, deep links, token encryption
src/frontend/       React app (App.tsx, markdown editor, scenario table, search, routing)
specs/*.spec.md     specifications for this app's own behavior
tests/              bun test suite
scripts/            build.ts (binaries), build-desktop.ts (dmg), dev-electron.ts
roadmap/            work not started yet
```

# Workflow

This app is built the way it asks you to build: the spec is written first, and
the code and its tests point back at it.

1. **Write or update the spec.** Behavior lives in [specs/](specs) as
   `<area>.spec.md` — plain markdown, with `## Scenario: …` sections stating
   `When` / `Then`. If a change has no home in an existing spec, add one.
2. **Implement, and reference the spec from the code.** Modules carry a comment
   naming the spec that governs them, e.g.
   `// Per specs/app-start.spec.md, the data repo may be given as a GitHub url`.
   That reference is how the next reader (human or agent) finds the authority for
   the behavior.
3. **Cover it with a test that names the same spec.** Each test file opens with a
   comment citing the spec it automates; assertions follow the scenarios.
4. **Run `bun test`** — the suite is fast and expected to be green before commit.
5. **Commit with the spec in the subject** when a change is driven by one:
   `feat: links to automated tests per scenario (specs/traceability.spec.md)`.

Specs written *in* the app (in a data repo) go further: a scenario is atomic,
immutable, and versioned — `## <name> v<n> [proposed | published | deleted |
archived]` — and carries a `### Tests` table of GitHub urls linking to the tests
that automate it. Published scenarios never change; a new version supersedes
them. That link is bidirectional: the test carries a `@Spec` annotation naming
`file#scenario@version`, so tooling can flag a spec that moved without its test.
PMs publish spec versions; developers own the tests.

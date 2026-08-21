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
- Optionally a `git` binary. Git operations shell out to it when it is there;
  when it is not, the built-in engine ([just-git](https://github.com/blindmansion/just-git),
  git implemented in JavaScript and bundled with the app) does the same work
  in-process, against the same on-disk repositories.
- Optionally the [GitHub CLI](https://cli.github.com) (`gh`). When it is
  installed the app uses it by default for GitHub credentials and clones, so
  `gh auth login` is all the authentication setup there is; without it, sign in
  from the Settings dialog instead. All three are switchable in Settings.
- Access to the data repo you intend to open.

## Clone the spec repo

This app's own specs live in a separate repo, [SpecDriven/specs-specdriven](https://github.com/SpecDriven/specs-specdriven),
and `specs/` here is a checked-in symlink to `../specs-specdriven`. Clone it as a
sibling of this checkout, or `specs/` dangles:

```sh
gh repo clone SpecDriven/specs-specdriven ../specs-specdriven
```

Without `gh`, `git clone https://github.com/SpecDriven/specs-specdriven.git ../specs-specdriven`
does the same. Nothing at runtime reads `specs/` — it is there for the workflow
below — so a dangling symlink breaks neither the build nor the tests, only the
links in this README and the spec references in the code.

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
reload interval, the editor autosave interval, the scenario preview length, the
git engine, and the test-links
toggle — all editable from the Settings dialog, which also reports what the
GitHub CLI is signed in as and holds the app's own GitHub sign-in (device flow)
for machines without `gh`.

Settings are read from `./.specdriven/settings.json` (git-ignored, per-checkout)
and fall back to `~/.specdriven/settings.json`, so one settings file can serve
every checkout; `SPECDRIVEN_HOME` overrides that home directory. Settings are saved
back to whichever file was read.

## Observability

The server (web and desktop) is instrumented with OpenTelemetry around the
sync engine: every reload tick, git operation, conflict auto-resolution,
drift import, Automerge document write, and websocket sync event produces
spans and log records. Export is off by default and opt-in through the
standard OTEL environment variables ([src/server/telemetry.ts](src/server/telemetry.ts)):

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 bun run dev
```

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
override per signal (naming just one exports only that signal),
`OTEL_SERVICE_NAME` renames the service (default `specdriven`), and
`OTEL_SDK_DISABLED=true` is a hard off switch. Without an endpoint the
instrumentation is a no-op.

Console logging is unaffected by OTEL: sync activity always prints as
`[reload] …` / `[netsync] …` / `[git] …` lines. Set `SPECDRIVEN_DEBUG=1` to
also print the debug-level detail (per-file drift decisions, chunk saves,
document announcements) that otherwise skips the console.

Every entry — debug included — also lands in a rotating log file, on by
default, so the packaged desktop app (whose stdout goes nowhere) still leaves
a trail. Files live in `~/.specdriven/logs/` (`$SPECDRIVEN_HOME/logs` when
that override is set): `specdriven.log` is current, `specdriven.log.1 … .4`
are older. Lines carry a timestamp, level, component, attributes, and —
when a trace is being exported — the `trace=`/`span=` ids to jump from a log
line to its trace. `SPECDRIVEN_LOG_DIR` moves the directory,
`SPECDRIVEN_LOG_MAX_BYTES` (default 5 MB) and `SPECDRIVEN_LOG_MAX_FILES`
(default 5) tune rotation, and `SPECDRIVEN_LOG_FILE=0` turns file logging
off.

## Tests

```sh
bun test                      # whole suite
bun test tests/parser.test.ts # one file
```

Tests are colocated under [tests/](tests) and run against the server and frontend
modules directly — no browser. The git tests do start a server: a loopback git
smart-HTTP fixture ([tests/helpers/gitHttpServer.ts](tests/helpers/gitHttpServer.ts))
serves bare origin repos, so pushes and pulls go over the transport a real remote
uses. Every test process runs on a pinned PATH holding git and no `gh`
([tests/helpers/binPath.ts](tests/helpers/binPath.ts), preloaded via
[bunfig.toml](bunfig.toml)), so your own GitHub CLI can never decide which engine
the suite exercises or authenticate anything; the gh-engine tests put a stub `gh`
on PATH themselves.

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
bun run build:desktop           # this machine's platform
bun run build:desktop --mac     # dmg + zip
bun run build:desktop --linux   # AppImage + deb, x64 and arm64
bun run build:desktop --all     # both
```

| platform | artifacts in `release/` |
| --- | --- |
| macOS | `SpecDriven-<version>-arm64.dmg`, `SpecDriven-<version>-arm64-mac.zip` |
| Linux | `SpecDriven-<version>-{x86_64,arm64}.AppImage`, `specdriven_<version>_{amd64,arm64}.deb` |

Three steps: bundle the frontend into static files (served over the `app://`
protocol), bundle the Electron main process for Node, then hand both to
electron-builder. See [scripts/build-desktop.ts](scripts/build-desktop.ts);
targets and architectures live under `"build"` in package.json — add `x64` to
the mac arch list for Intel artifacts. Linux cross-builds from macOS, so one
machine can cut a full release; macOS artifacts need macOS.

The bundle registers the `specdriven://` url scheme with the OS — through
`Info.plist` on macOS, through the desktop entry's `MimeType` on Linux — so
spec links launch or focus the installed app. Builds are unsigned for now:
first launch needs Gatekeeper approval on macOS, and the `.deb` is installed
with `sudo apt install ./specdriven_<version>_amd64.deb` (the AppImage just
needs `chmod +x`).

Two Linux settings are load-bearing and easy to lose, both verified by
installing the artifacts in bare Debian and Ubuntu containers:
`deb.depends` adds `libasound2t64 | libasound2` (Electron loads ALSA;
electron-builder's default list omits it, and the t64 name has to come first
or apt picks an OSS stub with missing symbols), and `toolsets.appimage` pins
the static AppImage runtime — the legacy default builds an arm64 runtime
linked against `libz.so`, which no ordinary desktop has.

## Versioning

`package.json`'s `version` is the one place the release version lives — it is
what electron-builder names the desktop artifacts after, and what the installer
looks for under `$BASE_URL/$VERSION`.

```sh
bun run bump patch    # 0.1.4 -> 0.1.5
bun run bump minor    # 0.1.4 -> 0.2.0
bun run bump major    # 0.1.4 -> 1.0.0
bun run bump 1.2.3    # an explicit version
```

The bump rewrites that one line in `package.json`, commits it, and tags
`v<version>`. It refuses a dirty tree — so the release commit is the bump
alone — a tag that already exists, and a version that does not come after the
current one, since a released version names artifacts people already have.
`--dry-run` shows the move without making it; `--no-git` writes `package.json`
and stops there. See [scripts/bump-version.ts](scripts/bump-version.ts).

Pushing is deliberately left to you, because pushing the tag is what publishes
the release:

```sh
git push origin main --follow-tags
```

Build the desktop artifacts from the tagged commit, not from whatever is
checked out — electron-builder reads the version out of `package.json`, so a
build from any other commit is mislabelled.

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

Asset hosting is not wired up yet — nothing uploads the build matrix, so there
is nothing at `$BASE_URL` for the installer to fetch.
[roadmap/deployment.md](roadmap/deployment.md) tracks what is left.

## Layout

```
src/index.ts        web entry — Bun.serve() over the shared route table
src/server/         api (routes shared by web + desktop), features, parser, search,
                    git/ (gh + cli + js engines), auth, github, tokenStore, repo, state, user, reload
src/electron/       desktop shell — main, app:// static serving, deep links, token encryption
src/frontend/       React app (App.tsx, markdown editor, scenario table, search, routing)
specs/*.spec.md     specifications for this app's own behavior — a symlink to the
                    ../specs-specdriven clone, see "Clone the spec repo"
tests/              bun test suite
scripts/            build.ts (binaries), build-desktop.ts (dmg/AppImage/deb), dev-electron.ts,
                    bump-version.ts (version, commit, tag)
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

# Specdriven App

Desktop application designed to enable the practice of evolutionary spec-driven development.
All data -- including the database -- is stored in git on a default installation. No other dependencies are required.
A premium version may use a server database.

## Installing

We distribute the app as a source zip, so customers can apply their own
security protocols to the code — and their own supply chain to the
dependencies — before building their own binaries. Releases live on
[SpecDriven/specdriven-app-release](https://github.com/SpecDriven/specdriven-app-release).

The installer fetches the latest one:

```sh
curl -fsSL https://raw.githubusercontent.com/SpecDriven/specdriven-app-release/main/install.sh | sh
```

It downloads `specdriven-<version>-src.zip`, verifies it against the release's
`SHASUMS256.txt`, unpacks it to `~/.specdriven/app/specdriven-<version>` with
`~/.specdriven/app/current` pointing at it, installs the dependencies, builds
the desktop app and starts it. To read the code before any of it runs, take
the zip from the releases page and unpack it yourself — that is the reviewing
path, and the source is shipped for exactly that. See "Distribution" below.

Build tool: [Bun](https://bun.sh). If it is missing, the installer offers to
fetch it — with a yes it runs Bun's own installer as you, into `~/.bun`; with
anything else it stops after unpacking and prints the steps below, which is
also what you want after unzipping a release by hand. Any AI coding agent
should be able to help you build and run the application from here:

```sh
cd ~/.specdriven/app/current
bun install
bun run start            # web app at http://localhost:3000
bun run build:desktop    # desktop installer in release/ — dmg on macOS, AppImage + deb on Linux
```

## Install dependencies

```sh
bun install
```

## Run the app

```sh
bun run dev            # bun --hot src/index.ts — HMR on, restarts on change
bun run dev:debug      # under Bun's inspector, no --hot (see "Debugging" below)
bun run start          # no hot reload
bun run dev:electron   # desktop shell; expects `bun run dev` in another terminal
```

The server listens on <http://localhost:3000>; set `PORT` to move it. Setting
`NODE_ENV=production` disables HMR and serves the pre-bundled frontend, which is
what the compiled binary does. `dev:electron` points the desktop window at the
running dev server, so edits hot-reload inside the desktop shell too.

### Debugging

The server code runs on two runtimes, each with its own debugger:

- **Web app (Bun):** `bun run dev:debug` starts the server under Bun's
  inspector (no `--hot`, which fights with breakpoints) and prints a
  `https://debug.bun.sh/#…` link to debug it from the browser. The VS Code Bun
  extension (`oven.bun-vscode`) can launch or attach too. Bun speaks the WebKit
  inspector protocol, so Chrome DevTools and `chrome://inspect` cannot attach.
- **Desktop app (Electron main process, Node):** in an unpackaged run
  (`bun run dev:electron`), the **Debug → Main-Process Debugger…** menu opens
  Node's inspector on `127.0.0.1:9229` (or a free port if that one is taken)
  and offers its urls to copy. Attach from `chrome://inspect`, a VS Code
  `"type": "node"` attach configuration, or paste the DevTools url into
  Chrome. A paused breakpoint freezes the window until you resume. Packaged
  builds have no Debug menu.
- **Frontend:** the browser's DevTools, or **Debug → Toggle Window DevTools**
  in the desktop app.

On first start the app asks for a data repo, because no settings file names one
yet. Give it a GitHub url like `https://github.com/SpecDriven/data-insurance`; it
is cloned into a sibling directory of this repo (`../data-insurance`). A plain
relative path to an existing local clone works too. The same file also holds the
reload interval, the editor autosave interval, the scenario preview length, the
git engine, the test-links toggle, and the external-links toggle (whether
Jira/Linear ticket links are written into the `.feature.md` files) — all
editable from the Settings dialog, which also reports what the
GitHub CLI is signed in as and holds the app's own GitHub sign-in (device flow)
for machines without `gh`.

Settings are read from `./.specdriven/settings.json` (git-ignored, per-checkout)
and fall back to `~/.specdriven/settings.json`, so one settings file can serve
every checkout; `SPECDRIVEN_HOME` overrides that home directory. Settings are saved
back to whichever file was read.

## Using the app

The user guides live in [docs/user-guide](docs/user-guide):
[Features and specs](docs/user-guide/specs.md) covers the Specs tab, the
draft → proposed → published lifecycle, saving, syncing and links to tests;
[AI sessions](docs/user-guide/ai-sessions.md) covers handing selected specs to
Claude Code Desktop, or to Claude, Codex or Pi in the app's own coding agent
pane; [Pomodoro](docs/user-guide/pomodoro.md) covers timing
your own work with the Pomodoro timer; [Engineering
notebook](docs/user-guide/engineering-notebook.md) covers the shared, dated
log of observations and decisions about your process. Implementers should read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Demo mode

`DEMO_MODE=1` (`bun run demo`) runs the app as a public, self-resetting demo of
the checked-in `demo-data/` dataset (a snapshot of the specs-insurance repo,
refreshed with `cp -R ../specs-insurance demo-data && rm -rf demo-data/.git`):

- Every page load copies `demo-data/` to a fresh working directory under
  `SPECDRIVEN_ROOT` (default `/tmp/specdriven-demo`) — editing works in full,
  and a browser refresh returns the demo to the default dataset. The snapshot
  itself is never written.
- The copy has no `.git`, so every git operation takes the existing
  plain-directory path: saves land locally, pull/push are skipped, and nothing
  talks to GitHub. Sign-in, the folder picker, and data-directory changes are
  refused server-side (403/501) and hidden in the UI.
- All state — settings, token file, logs — is confined under the demo root
  (`SPECDRIVEN_HOME` is pointed inside it), away from `~/.specdriven`.

`Dockerfile` + `fly.toml` deploy it as a container (`fly deploy`); everything is
ephemeral, so no volume is needed. Keep it to one machine — each machine holds
an independent demo copy.

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

**Observability** in the user menu (or `g o`, at `/observability`) browses
those files in the app, newest first. You can search them as text or as a
regular expression, filter by level and component, and use Follow to watch
new entries arrive. With the file sink off, it shows the latest 2000 entries
kept in memory. The page's Verbosity tab sets the log verbosity: a default minimum level
plus per-component overrides. An entry below its level is written nowhere
(not the file, the console or OTEL). Changes apply at once and are saved to
the settings file (`logLevel`, `logLevels`). `SPECDRIVEN_LOG_LEVEL` sets the
starting level when nothing is saved (default `debug`, everything). The page
is not offered in the hosted demo.

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

The suffixed names are the asset names a binary release would use, and
`SHASUMS256.txt` is what an installer would verify them against — but nothing
publishes them yet; [install.sh](install.sh) installs the source zip release
instead (see "Distribution"). The baseline Linux build exists for CPUs without
AVX2, where the default x64 build dies with an illegal instruction. See
[scripts/build.ts](scripts/build.ts).

## Build the desktop app

```sh
bun run build:desktop           # this machine's platform
bun run build:desktop --mac     # dmg + zip
bun run build:desktop --linux   # AppImage + deb, x64 and arm64
bun run build:desktop --all     # both
bun run build:desktop --local   # this machine's arch only: AppImage on Linux, dmg on macOS
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

`--local` is what [install.sh](install.sh) runs. It skips the `.deb`, whose
packager (fpm) runs a bundled Ruby that needs `libcrypt.so.1` — missing on
Arch and other non-Debian distros unless `libxcrypt-compat` is installed — and
the other architecture, which nobody on that machine would start.

To check that a build actually starts — and starts again — run the restart
crash test:

```sh
bun run test:desktop                # build, package the unpacked app, launch it 3 times
bun run test:desktop --no-build     # the same against what release/ already holds
bun run test:desktop --unpackaged   # skip electron-builder: node_modules' electron on dist/
```

Each launch runs on a throwaway profile, waits for the window to render,
holds a few seconds, then asks the app to quit (SIGTERM, which Electron
treats as `app.quit()`); a launch fails on a crash, an uncaught exception in
the main process, a window that never renders, or a quit that hangs. Logs, a screenshot per launch and
`summary.json` land in `dist/crash-test/`. Headless Linux gets an Xvfb of its
own. The details, and how to read a failure, are in
[.claude/skills/electron-crash-test/SKILL.md](.claude/skills/electron-crash-test/SKILL.md).

Two Linux settings are load-bearing and easy to lose, both verified by
installing the artifacts in bare Debian and Ubuntu containers:
`deb.depends` adds `libasound2t64 | libasound2` (Electron loads ALSA;
electron-builder's default list omits it, and the t64 name has to come first
or apt picks an OSS stub with missing symbols), and `toolsets.appimage` pins
the static AppImage runtime — the legacy default builds an arm64 runtime
linked against `libz.so`, which no ordinary desktop has.

## Versioning

`package.json`'s `version` is the one place the release version lives — it is
what electron-builder names the desktop artifacts after, what the release is
tagged as, and what the installer looks for under `releases/download/v<version>`.

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

The tag push runs [.github/workflows/release.yml](.github/workflows/release.yml),
which checks the tag against `package.json`, zips the tagged tree with
`git archive` (tracked files only — no `node_modules`, `dist`, or `.env`), and
creates a `v<version>` release on
[SpecDriven/specdriven-app-release](https://github.com/SpecDriven/specdriven-app-release)
with the zip, its `SHASUMS256.txt`, and `install.sh` attached. Just before
that it pushes this repository's [install.sh](install.sh) to the root of
`specdriven-app-release` whenever the two differ — that is the copy the
`curl | sh` line fetches, so it is never newer or older than the releases it
installs. Writing to another repository needs the `RELEASE_REPO_TOKEN`
Actions secret: a fine-grained personal access token with *Contents: read and
write* on `specdriven-app-release` alone. A release that already exists is not
overwritten — re-running on the same tag fails, on purpose.

Build the desktop artifacts from the tagged commit, not from whatever is
checked out — electron-builder reads the version out of `package.json`, so a
build from any other commit is mislabelled.

## Distribution

Users install with:

```sh
curl -fsSL https://raw.githubusercontent.com/SpecDriven/specdriven-app-release/main/install.sh | sh
```

[install.sh](install.sh) (POSIX sh; curl or wget; unzip, bsdtar or python3)
follows the redirect from the releases page's `latest` to find the newest
`v<version>`, downloads `specdriven-<version>-src.zip` and `SHASUMS256.txt`
from that release, verifies the checksum, unpacks the zip to
`~/.specdriven/app/specdriven-<version>`, points `~/.specdriven/app/current`
at it, keeps the verified zip and its checksum alongside, then `bun install`s
the dependencies, runs `bun run build:desktop --local`, and starts what
electron-builder leaves beside the installer — the `.app` on macOS, the
`.AppImage` on Linux, which it makes executable first and starts only when
there is a display to start it on
([specs/app/installation.feature.md](specs/app/installation.feature.md)).
Reviewing the source before it runs means taking the zip from the releases
page instead; this script is the unattended path.

Building needs Bun, so a machine without it is offered one: the
question goes to `/dev/tty` (`curl | sh` has already spent stdin on the pipe),
and only a `y` runs Bun's own installer — downloaded first, then run with
bash under the invoking user, into `BUN_INSTALL` (default `~/.bun`). No sudo,
nothing system-wide, and a refusal to run as root. With no terminal to ask at
— a build step, a provisioning script — the question is skipped rather than
answered for you, and `SPECDRIVEN_INSTALL_BUN=1` or `=0` settles it in
advance. With no Bun, the run stops at the unpacked source and prints the
build steps rather than guessing; a failed `bun install` or build is an error,
with the verified checkout left in place.

It fails closed: a checksum mismatch, a missing or incomplete `SHASUMS256.txt`,
a 404, or a machine with no sha256 tool aborts without writing anything, and a
version that is already unpacked is not re-extracted — someone may have edited
or built in it — though the build then runs on it as it stands. A Bun install
that fails is reported and left at that. Overrides: `SPECDRIVEN_VERSION`
(`0.1.40` or `v0.1.40`; default `latest`), `SPECDRIVEN_HOME` (the same prefix
the settings live under), `SPECDRIVEN_INSTALL_BUN`, `BUN_INSTALL`, and
`SPECDRIVEN_RELEASES_URL` (anything serving GitHub's
`/latest` → `/tag/v<version>` redirect and `/download/v<version>/<asset>`
layout, which is what [tests/install.test.ts](tests/install.test.ts) stands up
on loopback). Windows shells are sent to the releases page: `curl | sh` needs
a Unix shell.

Two things the release repository has to be for this to work: **public** —
GitHub answers a private repository's release assets and raw files with a 404,
not a login prompt — and carrying `install.sh` at its root, which the release
workflow keeps in step (see "Versioning"). `install.sh` is also attached to
every release, so
`https://github.com/SpecDriven/specdriven-app-release/releases/latest/download/install.sh`
serves the copy that shipped with the latest one. The compiled-binary
distribution behind `specdriven.app` in
[roadmap/deployment.md](roadmap/deployment.md) is still to come.

## Layout

```
src/index.ts        web entry — Bun.serve() over the shared route table
src/server/         api (routes shared by web + desktop), features, parser, search, entities,
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
archived]` — and ends with `[test: <test name> : <url> ]` lines, one per GitHub
url of a test that automates it (older files carry a `### Tests` table, still
read, and a `[test: <url> ]` line without a name is still fine). The url names
a line (`…Test.java#L32`); when the link is added the app reads the test
function declared there from GitHub — Java, Kotlin, TypeScript, JavaScript,
Python and Go — and stores its name in the token. A single rule inside a
scenario can name its test on its own line the same way, and the app shows
every reference as a link named after the test (`quotesAHomeownersPolicy`, or
the file name `QuoteHomeownersPolicyTest` when no name is stored). Published
scenarios never change; a new version
supersedes them. That link is bidirectional: the test carries a `@Spec` annotation naming
`file#scenario@version`, so tooling can flag a spec that moved without its test.
PMs publish spec versions; developers own the tests.

## License

specdriven.app is source-available under the unmodified
[PolyForm Perimeter 1.0.1](https://polyformproject.org/licenses/perimeter/1.0.1)
license, not unrestricted open source. Internal business use, including
commercial and production use, is permitted, and you may change and
distribute the software; using it to provide a product that competes with
specdriven.app is restricted. Read [LICENSE.md](LICENSE.md) and
[NOTICE.md](NOTICE.md). For anything beyond that, contact
info@specdriven.app.

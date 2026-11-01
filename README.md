# SpecDriven

**A workspace for evolutionary spec-driven development.**

[![Test](https://github.com/SpecDriven/specdriven-app/actions/workflows/test.yml/badge.svg)](https://github.com/SpecDriven/specdriven-app/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/SpecDriven/specdriven-app-release?label=release)](https://github.com/SpecDriven/specdriven-app-release/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE.md)

SpecDriven is a desktop and web app for writing software specifications as
versioned, testable scenarios, and for handing those scenarios to people and
coding agents to implement. Specs are plain markdown files in a git
repository you own; there is no server, no database and no account to
create.

- **Specs as markdown in git.** Every feature is a `.feature.md` file with
  Given / When / Then scenarios. The app commits, pushes and pulls for you,
  and the files stay readable and reviewable on GitHub without the app.
- **A lifecycle, not a wiki.** Scenarios move from draft to proposed to
  published. Published scenarios are immutable and versioned; a change is a
  new version that supersedes the old one.
- **Traceable to tests.** A scenario links to the automated tests that prove
  it, by name and line, and tests carry a `@Spec` annotation pointing back.
- **Built for AI agents.** Select the scenarios to implement and start a
  session in Claude Code, Codex or Pi, from the app's own agent pane or your
  desktop.
- **Conflict-free collaboration.** Edits are merged at the CRDT level
  (Automerge), so concurrent changes to the same scenario merge instead of
  becoming git conflicts.
- **Integrations.** Jira, Confluence, Aha!, qTest and GitHub issues, plus a
  plugin system for module tabs of your own.

Try it without installing anything at
[specdrivenapp-demo.up.railway.app](https://specdrivenapp-demo.up.railway.app).
Product information is at [specdriven.app](https://specdriven.app).

## Install

SpecDriven ships as a source zip so you can review the code and bring your
own supply chain before building. One command fetches the latest release,
verifies its checksum, builds the desktop app with [Bun](https://bun.sh) and
starts it.

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/SpecDriven/specdriven-app-release/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/SpecDriven/specdriven-app-release/main/install.ps1 | iex
```

Releases are published on
[SpecDriven/specdriven-app-release](https://github.com/SpecDriven/specdriven-app-release).
What the installers do, how to review the source first, and how to build by
hand are in [docs/installation.md](docs/installation.md).

## Run from source

```sh
bun install
bun run dev            # web app at http://localhost:3000, hot reload
bun run dev:electron   # desktop shell on top of the running dev server
bun test               # test suite
```

On first start the app asks for a data repo: a GitHub url to clone, or a
path to a local clone. See [docs/running.md](docs/running.md) for settings,
throwaway profiles and debugging.

## Documentation

| For users | |
| --- | --- |
| [Features and specs](docs/user-guide/specs.md) | The Specs tab, the draft → proposed → published lifecycle, syncing, links to tests, specs as a submodule of a code repo |
| [AI sessions](docs/user-guide/ai-sessions.md) | Handing specs to Claude Code, Codex or Pi |
| [Engineering notebook](docs/user-guide/engineering-notebook.md) | The shared, dated log of observations and decisions |
| [Pomodoro](docs/user-guide/pomodoro.md) | Timing your own work |

| For developers and operators | |
| --- | --- |
| [Running from source](docs/running.md) | Scripts, settings, profiles, debugging, tests |
| [Architecture](docs/ARCHITECTURE.md) | Storage model, the Automerge store, the local trust boundary |
| [Development](docs/DEVELOPMENT.md) | The spec-first workflow, repository layout, writing a plugin |
| [Building](docs/building.md) | Standalone binaries and the Electron desktop app |
| [Installation](docs/installation.md) | What `install.sh` and `install.ps1` do |
| [Releasing](docs/releasing.md) | Versioning, tagging and the release workflow |
| [Deployment modes](docs/deployment-modes.md) | Demo mode, the spec-proposals site, hosted multi-user |
| [Hosted on Railway](docs/deployment-railway.md) | The multi-user gateway deployment |
| [Observability](docs/observability.md) | OpenTelemetry export, log files, the in-app log viewer |

## Contributing

We do not accept pull requests: every line we ship is code we answer for,
and we cannot take on the review and supply-chain cost of outside changes.
Forks are welcome under the license.

What we do welcome is **specs**. This app is built from the specifications in
[SpecDriven/specs-specdriven](https://github.com/SpecDriven/specs-specdriven),
and a proposed feature with Given / When / Then scenarios is the most useful
thing you can send us. [CONTRIBUTING.md](CONTRIBUTING.md) says how; report
bugs on the
[release repository's issues](https://github.com/SpecDriven/specdriven-app-release/issues)
and vulnerabilities as [SECURITY.md](SECURITY.md) describes.

## License

[Apache License 2.0](LICENSE.md). You may use, change and share SpecDriven,
including in closed-source work, as long as you keep the license and
notices; see [NOTICE.md](NOTICE.md). The app's **Source code** menu item
points at the source of the running version; a modified copy should set
`SPECDRIVEN_SOURCE_URL` to its own. No trademark rights are granted.

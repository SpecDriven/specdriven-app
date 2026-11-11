# Specdriven.app

**A tool for evolutionary spec-driven development.**

[![Test](https://github.com/SpecDriven/specdriven-app/actions/workflows/test.yml/badge.svg)](https://github.com/SpecDriven/specdriven-app/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/SpecDriven/specdriven-app?label=release)](https://github.com/SpecDriven/specdriven-app/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE.md)

Specdriven.app is a desktop and a web application for managing multi-modal software specifications.
The driving vision of the project is to make it pleasant and effective for the *whole team* (including your AI agents)
to maintain detailed functional specifications with traceability to the tests that automate them,
aka "executable specifications".

The specifications are presented as Markdown files with optional images.

For ease of adoption, the "database" is also stored in git in the form of [automerge](https://automerge.org) binary files.

## Architecture

The app is built by [Bun](https://bun.com/) and is entirely written in TypeScript.

A lightweight plugin capability with support for remote plugin marketplaces extends the core application.

## Integrations

The app is developed with the intention of supporting large, mature enterprises, and thus we aim to provide built-in
integrations with many of the most popular SDLC tools such as Aha!, Figma, Jira, Confluence (wiki),qTest, GitHub Issues, 
and many more.


## Install

Specdriven.app ships as a zip file containing the source and is built on your machine using Bun. This allows our users to run the source
via their security infrastructure and avoid trust issues associated with a binary distribution.

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.ps1 | iex
```

Releases are published on
[SpecDriven/specdriven-app](https://github.com/SpecDriven/specdriven-app).
What the installers do, how to review the source first, and how to build by
hand are in [docs/installation.md](docs/installation.md).

## Run from source

```sh
bun install
bun test               # run the test suite
bun run dev            # web app at http://localhost:3000, hot reload
bun run dev:electron   # (run in a separate shell instance) Electron-based desktop shell on top of the running dev server

```

On first start the app asks for a data repo: a GitHub url to clone, or a
path to a local clone. See [docs/running.md](docs/running.md) for settings,
throwaway profiles and debugging.

## [Documentation](docs/index.md)


## Contributing

We are unable to accept pull requests this time due to lack of resources to review them appropriately.
Forks are welcome under the license.

What we do welcome is **specs**. This app is built from the specifications in
[SpecDriven/specs-specdriven](https://github.com/SpecDriven/specs-specdriven),
and a proposed feature with Given / When / Then scenarios is the most useful
thing you can send us. [CONTRIBUTING.md](CONTRIBUTING.md) says how; report
bugs on the
[issues](https://github.com/SpecDriven/specdriven-app/issues)
and vulnerabilities as [SECURITY.md](SECURITY.md) describes.

## License

[Apache License 2.0](LICENSE.md). You may use, change and share SpecDriven,
including in closed-source work, as long as you keep the license and
notices; see [NOTICE.md](NOTICE.md). The app's **Source code** menu item
points at the source of the running version; a modified copy should set
`SPECDRIVEN_SOURCE_URL` to its own. No trademark rights are granted.

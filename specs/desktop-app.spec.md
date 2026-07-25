# Desktop app

SpecDriven also runs as a native desktop app (Electron), installed from a
macOS dmg or a Linux AppImage or deb. It is the same application as the web
version: one React frontend, one API, one git-backed data store. The desktop
shell serves the frontend and the API over an internal `app://` protocol — no
localhost port is opened, so nothing else on the machine can reach the API.

The web version keeps working unchanged (`bun run dev`, the compiled binary).
Server code is written against Node APIs only, so the same modules run under
Bun on the web and under Electron's runtime on the desktop.

# Packaging

One command builds the installable artifacts, for the platform the build runs
on unless told otherwise (`bun run build:desktop [--mac | --linux | --all]`):

- macOS: a dmg and a zip.
- Linux: an AppImage and a deb, for x64 and arm64. Both cross-build from
  macOS, so a release can be cut from one machine.

The macOS artifacts need macOS tooling, so `--mac` off a Linux machine stops
with that as the reason rather than producing a broken build.

A Linux artifact has to start on a machine that has never seen Electron:

- The deb names every shared library Electron loads. ALSA is the one the
  packaging defaults miss, and it is spelled `libasound2t64 | libasound2` —
  the t64 name first, because on releases that renamed it, plain
  `libasound2` resolves to an OSS compatibility stub that is missing symbols
  Electron calls.
- The AppImage carries the static runtime, so it needs neither FUSE nor a
  dynamically linked zlib on the host.

## Scenario: the packaged Linux app opens on a clean machine

- Given: a Linux system with no Electron and no developer tooling installed
- When: the user installs the deb, or marks the AppImage executable and runs it
- Then: the app window opens on the internal `app://` origin, the same as on
  macOS

## Scenario: building the Linux app from a Mac

- Given: a developer on macOS
- When: they run `bun run build:desktop --linux`
- Then: an AppImage and a deb for each architecture appear in `release/`

# Data locations

The desktop app has no meaningful working directory, so it anchors itself in
the OS application-data directory (`~/Library/Application Support/SpecDriven`
on macOS, `~/.config/SpecDriven` on Linux) via `SPECDRIVEN_ROOT`:

- Settings follow the usual lookup (specs/app-start.spec.md) with the
  app-data directory as the "project root": an existing
  `~/.specdriven/settings.json` is picked up and written back — shared with
  the web version, so both see the same data repo. With no settings file
  anywhere, the desktop app keeps its own under the app-data directory.
- GitHub data repos are cloned under the app-data directory
  (`.../SpecDriven/repos/<name>`) via `SPECDRIVEN_REPOS_DIR`, instead of the
  web version's sibling-of-the-checkout location.

## Scenario: desktop and web share settings

- Given: the web version has recorded a data repo in `~/.specdriven/settings.json`
- When: the desktop app starts
- Then: it opens that data repo without asking

# Window

- One main window; launching the app a second time focuses the existing
  window instead of opening another.
- On macOS the window uses the hidden-inset title bar: the traffic lights sit
  inside the sidebar header, and the header doubles as the drag region.
  Elsewhere the window wears the system title bar and the sidebar header is
  an ordinary header.
- Deep links (specs/navigation.spec.md) keep working inside the app: the
  internal protocol serves the app shell for every `/features/...` url.
- The app registers the `specdriven://` scheme with the OS, so a link shared
  by chat or email launches it, or focuses the running window, on that spec
  (specs/navigation.spec.md "links from outside the app"). A second launch
  carrying a link still focuses the one window rather than opening another.
  The installed bundle declares the scheme to the OS — in `Info.plist` on
  macOS, in the desktop entry's `MimeType` on Linux.

# External links

- A link that leaves the app — a scenario's automated-test link on GitHub,
  any `http(s)` url — opens in the user's default browser, never inside the
  app window.

## Scenario: test link opens in the browser

- Given: a scenario with a link to an automated test on GitHub
- When: the user clicks the test link in the desktop app
- Then: the link opens in the default browser and the app window stays where
  it was

# Dialogs

The desktop runtime has no native `prompt()`, so every prompt and
confirmation is an in-app dialog (specs/ui.spec.md "Dialogs") — the same
dialogs the web version shows.

# Git

Git operations shell out to the machine's binaries where it has them
(specs/git-operations.spec.md): the GitHub CLI is used for GitHub
credentials and clones wherever it is installed, plain git where only that
is, and the built-in engine on a machine with neither — so the desktop app
works on a fresh machine with nothing installed. A packaged macOS app
launches with a minimal PATH, so the usual Homebrew locations are appended
— that is where both binaries usually live.

The GitHub sign-in token is stored OS-encrypted (Electron safeStorage,
keychain-backed on macOS); when the OS offers no key store it falls back
to the user-only token file next to the home settings file.

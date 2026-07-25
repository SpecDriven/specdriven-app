# Desktop app

SpecDriven also runs as a native desktop app (Electron), installed from a
macOS dmg. It is the same application as the web version: one React frontend,
one API, one git-backed data store. The desktop shell serves the frontend and
the API over an internal `app://` protocol — no localhost port is opened, so
nothing else on the machine can reach the API.

The web version keeps working unchanged (`bun run dev`, the compiled binary).
Server code is written against Node APIs only, so the same modules run under
Bun on the web and under Electron's runtime on the desktop.

# Data locations

The desktop app has no meaningful working directory, so it anchors itself in
the OS application-data directory (`~/Library/Application Support/SpecDriven`
on macOS) via `SPECDRIVEN_ROOT`:

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
- Deep links (specs/navigation.spec.md) keep working inside the app: the
  internal protocol serves the app shell for every `/features/...` url.

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

Git is built in: the app bundles a JavaScript git implementation
(specs/git-operations.spec.md), so no git or gh installation is needed.
The system git binary is used only when selected in Settings or as
automatic fallback; a packaged macOS app launches with a minimal PATH, so
the usual Homebrew locations are appended in case that binary is needed.

The GitHub sign-in token is stored OS-encrypted (Electron safeStorage,
keychain-backed on macOS); when the OS offers no key store it falls back
to the user-only token file next to the home settings file.

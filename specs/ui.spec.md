- Feature page lists scenarios, up to 8 lines per scenario.
- Scenarios are ordered by name, then by version.
- Published scenarios are shaded differently from un-published, editable scenarios.

Edit scenarios in a separate dialog box.

If a scenario is already published, then it is immutable — apart from its
links to automated tests, which stay editable (specs/traceability.spec.md).

# Main page

- Top of page should say 'Scenario: <scenario name>' Ex: `Feature: Quote Policy`
- Left side should also use abbreviated scenario name, not file name.
- We don't need to display the file name.
- Add `Edit` link next to the feature name which allows editing the feature
  name — the file's `# <name>` heading — not the file name.
  - the edited name is committed and pushed to GitHub
  - the file name stays unchanged, so links to the feature keep working

Sync button (immediate data reload), disabled with a progress label while
running. No "Syncing…"/"Synced" status update at the bottom of the page.

Publish button: same style and behavior as the Sync button (disabled with a
progress label while running). No "Published" status update at the bottom of
the page.

## Scenario List
- render scenario body as Markdown preview; up to n lines
- make the number of Markdown lines to render for each scenario in list configurable in Settings dialog

# Feature entry menu

Each feature entry in the left pane has a drop down menu (a `⋯` button,
visible on hover) with two items: `File` and `Delete`.

- `File` opens a submenu with `Rename`, which renames the underlying file.
  - Only the file name to the left of the dot is shown and edited; the
    `.feature.md` extension is hidden and always kept. The folder is kept too.
  - The rename is a `git mv`, committed and pushed.
  - The feature's url follows the file name, so links to the old name go stale.
  - The feature name (the `# <name>` heading) is untouched — renaming that is
    the Edit link on the main page.
- `Delete` deletes the feature file after a confirmation — a `git rm`,
  committed and pushed.
- ESC or a click anywhere else closes the menu.

# Folders

Features can be organized into folders — see specs/folders.spec.md.

# Sidebar resize

A deep folder hierarchy needs more room than the default left-pane width.

- The divider between the left pane and the editor is draggable; dragging it
  resizes the left pane.
- The width is clamped: the pane can never collapse away nor swallow the
  editor.
- Double-clicking the divider restores the default width. The divider is
  focusable, and arrow keys nudge the width.
- The chosen width is remembered on the device (browser/app storage), like
  the theme — a per-device preference, not shared team state.

# Select scenarios via up and down keys
- Highlight selected scenario
- Edit on Enter key press

# Dialogs

Applies to every dialog (scenario edit, Settings, and any future dialog).

- While a dialog is in the foreground, Tab and Shift+Tab must only move focus
  between the fields inside that dialog. Focus wraps from the last field back to
  the first, and from the first back to the last.
- Focus must never reach elements behind the dialog while it is open.
- On open, focus moves into the dialog; on close, focus returns to the element
  that opened it.
- Native browser prompts and confirms are never used — creating a feature or
  folder, renaming a file, and every delete confirmation are in-app dialogs.
  (The desktop runtime has no `prompt()` at all —
  specs/desktop-app.spec.md.) Prompts submit on Enter and can't submit
  empty; delete confirmations carry a solid-red destructive button.
- Dialogs can stack — a delete confirmation above the scenario edit dialog.
  Tab cycles only the top dialog, and ESC closes only the top dialog.

# Scenario edit dialog

- Name must be the title of the dialog
- Must be resizable
- Scenario body must contain an embedded Markdown Editor
- Below the body, a table widget edits the scenario's markdown table
  (specs/scenario-table.spec.md)
- ESC key to get back to Scenario screen.
- The version is never user editable; it is shown read-only and assigned by
  the app.
- A new scenario takes the next version for the name it is given: one past the
  highest version already carrying that name, or v1 when the name is new.
  Retyping the name in the dialog re-derives the version.
- Editing an existing scenario keeps the version it was already assigned.
- A `[proposed]` scenario has a `Delete` button: after a confirmation, the
  scenario is removed from the feature. The removal is saved like any edit —
  auto-saved locally and pushed by the reload cron.
- Published scenarios have no Delete button — they are immutable. Their name,
  version, body and scenario table are read-only; only the Automated tests
  field can be changed (specs/traceability.spec.md), and the dialog's save
  button reads `Save test links`.
- ESC inside a field that is editing one row in place (the ✎ on a test link)
  backs out of that row; a second ESC closes the dialog.

# Merge conflict dialog

A publish that hits a merge conflict (specs/crud-feature.spec.md "Publish
feature with merge conflict") opens a dialog — not a strip appended to the
feature page, where a long feature pushes the resolutions out of sight.

- The dialog is sized to the window and resizable; it never grows with the
  feature.
- `Yours` and `Theirs` sit side by side, each scrolling in its own pane. A
  file that does not exist on the remote says so instead of showing an
  empty pane.
- Below them, a `Manual edit` box, pre-filled with yours, that can also be
  reset to either side.
- The three resolutions — `Accept yours`, `Accept theirs`, `Publish manual
  edit` — are pinned at the bottom and always visible, no matter how long
  the two sides are. They disable with a progress label while one runs.
- `Cancel`, ESC, or a click outside closes the dialog without resolving. The
  unfinished merge stays in the repo (specs/git-operations.spec.md), so
  Publish brings the same choices back.

# Settings

A settings dialog. Settings are saved to the settings file
(`.specdriven/settings.json`, specs/app-start.spec.md)

- Data reload frequency
- Appearance: System, Light or Dark. Applied immediately and remembered on
  the device (browser/app storage), not in the settings file — theme is a
  per-device preference, not shared team state. "System" follows the OS.

# Design system

Warm, minimal, Claude-like. All colors flow through CSS tokens in
`src/frontend/index.css` — components never hardcode a color, so both themes
come from one token block.

- Surfaces: ivory app canvas, oat sidebar, white cards (light); warm
  charcoal equivalents (dark).
- Accent: terracotta. Primary buttons are filled terracotta; secondary
  buttons are quiet outlines; sidebar actions stay muted.
- Type: serif display faces for feature/scenario/dialog titles (Source
  Serif 4), Inter for UI text, JetBrains Mono for code and file names. The
  fonts ship with the app — no network fetch, so the desktop app renders
  identically offline.
- Published scenarios keep their distinct shading: a parchment wash.
- Focus is always visible: accent rings on fields, focus outlines on
  controls.

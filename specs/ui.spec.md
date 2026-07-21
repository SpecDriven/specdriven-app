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

# Settings

A settings dialog. Settings are saved to the settings file
(`.specdriven/settings.json`, specs/app-start.spec.md)

- Data reload frequency

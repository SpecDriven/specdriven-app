- Feature page lists scenarios, up to 8 lines per scenario.
- Published scenarios are shaded differently from un-published, editable scenarios.

Edit scenarios in a separate dialog box.

If a scenario is already published, then it is immutable.

# Main page

- Top of page should say 'Scenario: <scenario name>' Ex: `Feature: Quote Policy`
- Left side should also use abbreviated scenario name, not file name.
- We don't need to display file name unless we want to edit it.
- Add `Edit` link next to scenario name which allows to edit the actual feature file name.
  - if file name is edited, it will be committed and pushed to GitHub using `git mv`

Sync button (immediate data reload), disabled with a progress label while
running. No "Syncing…"/"Synced" status update at the bottom of the page.

Publish button: same style and behavior as the Sync button (disabled with a
progress label while running). No "Published" status update at the bottom of
the page.

## Scenario List
- render scenario body as Markdown preview; up to n lines
- make the number of Markdown lines to render for each scenario in list configurable in Settings dialog

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
- ESC key to get back to Scenario screen.
- The version is never user editable; it is shown read-only and assigned by
  the app.
- A new scenario takes the next version for the name it is given: one past the
  highest version already carrying that name, or v1 when the name is new.
  Retyping the name in the dialog re-derives the version.
- Editing an existing scenario keeps the version it was already assigned.

# Settings

A settings dialog. Settings are saved to .specdriven

- Data reload frequency

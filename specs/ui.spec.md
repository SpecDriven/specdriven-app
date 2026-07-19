- Feature page lists scenarios, up to 8 lines per scenario.
- Published scenarios are shaded differently from un-published, editable scenarios.

Edit scenarios in a separate dialog box.

If a scenario is already published, then it is immutable.

# Main page

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

# Scenario edit dialog

- Name must be the title of the dialog
- Must be resizable
- Scenario body must contain an embedded Markdown Editor
- ESC key to get back to Scenario screen.

# Settings

A settings dialog. Settings are saved to .specdriven

- Data reload frequency

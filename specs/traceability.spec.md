# Store links to automated tests
- store links as github urls.
- Ex: `https://github.com/vydra/GatlingGen/blob/main/app/src/test/java/ggen/GatlingCodeGeneratorTest.java`
- Display in a table; links are clickable
- Display at the end of each scenario
- These links are optional and will be controlled by user setting; default is ON

The links live inside the feature file, as a trailing `### Tests` markdown
table in the scenario — like the scenario table (specs/scenario-table.spec.md),
plain markdown that renders naturally on GitHub:

```
### Tests

| Test |
| --- |
| https://github.com/vydra/GatlingGen/blob/main/app/src/test/java/ggen/GatlingCodeGeneratorTest.java |
```

- The parser lifts the urls out of that section; the scenario card shows them
  as an "Automated tests" table at the end, each row a clickable link opening
  in a new tab. The link text is the url without the `https://github.com/`
  prefix.
- Only GitHub urls (`https://github.com/…`) are accepted.
- The scenario edit dialog has an "Automated tests" field: the current links,
  each with an ✎ to correct it in place and a remove ✕, plus an add field.
  A published scenario is immutable, but its test links are not part of the
  spec — they keep changing as the tests get written — so the field stays
  editable there too. Nothing else about a published scenario is: its name,
  version and body stay read-only.
- Because of that the `[published]` card's dialog link reads `Edit`, and falls
  back to `View` only when the setting below leaves nothing to change.
- A url is rejected — Add and Save stay disabled — unless it is a GitHub url
  the scenario does not already list.
- Pressing the dialog's Save with a url still sitting in the add field or in
  an open ✎ row folds it into the save as if Add (or the row's Save) had been
  pressed — it is never silently dropped. A pending url that can't join the
  list blocks the save with a message under the field.
- The Settings dialog has a "Show links to automated tests" checkbox; the
  choice is saved to the settings file (`showTestLinks`), and only hides the
  tables on the cards and the Automated tests field in the scenario dialog —
  the stored links are untouched.

## Scenario: add a test link

- When: the user pastes a GitHub url into the edit dialog's Automated tests
  field and presses Add
- Then: the link joins the scenario's list, and after Save the feature file
  holds it in the scenario's `### Tests` table

## Scenario: the add field still holds a url when Save is pressed

- When: the user pastes a GitHub url into the Automated tests add field and
  presses the dialog's Save without pressing Add
- Then: the link is saved all the same
- And: an invalid or duplicate url there blocks the save with a message
  under the field instead of being dropped

## Scenario: correct a test link

- When: the user presses ✎ on a link, edits the url and presses Save
- Then: that row holds the new url, and the others are untouched

## Scenario: edit the tests of a published scenario

- Given: "Show links to automated tests" is ON (the default)
- When: the user opens a `[published]` scenario through its card's `Edit` link
- Then: the dialog's Automated tests field takes adds, ✎ edits and ✕ removes,
  and Save test links writes them to the feature file — while the name,
  version and body stay read-only

## Scenario: see the tests of a scenario

- When: a scenario has test links and the setting is ON (the default)
- Then: the end of the scenario card shows a table of clickable links

## Scenario: hide the test links

- When: the user turns "Show links to automated tests" off in Settings
- Then: the tables disappear from the scenario cards and the Automated tests
  field disappears from the scenario dialog, but the links stay in the
  feature files
- And: a `[published]` scenario now has nothing editable, so its card link
  reads `View` and the dialog offers only Close

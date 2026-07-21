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
- The scenario edit dialog has an "Automated tests" field: the current links
  with a remove ✕ each, and an add field. Published scenarios are immutable —
  the dialog shows their links read-only.
- The Settings dialog has a "Show links to automated tests" checkbox; the
  choice is saved to the settings file (`showTestLinks`), and only hides the
  tables on the cards and the Automated tests field in the scenario dialog —
  the stored links are untouched.

## Scenario: add a test link

- When: the user pastes a GitHub url into the edit dialog's Automated tests
  field and presses Add
- Then: the link joins the scenario's list, and after Save the feature file
  holds it in the scenario's `### Tests` table

## Scenario: see the tests of a scenario

- When: a scenario has test links and the setting is ON (the default)
- Then: the end of the scenario card shows a table of clickable links

## Scenario: hide the test links

- When: the user turns "Show links to automated tests" off in Settings
- Then: the tables disappear from the scenario cards and the Automated tests
  field disappears from the scenario dialog, but the links stay in the
  feature files

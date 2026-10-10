# Contributing

Thank you for wanting to help. Please read this before you write any code.

## We do not accept pull requests

We are unable to accept pull requests, for two reasons:

- **Security liability.** We distribute the app as source, and the people who
  run it trust every line in it. Merging code from outside the team is a
  supply-chain risk we can't take on.
- **Resources.** A careful review of an outside change costs more than
  writing it ourselves, and we are a small team.

Pull requests opened against this repository are closed automatically, with
a link back here. Forks are welcome — the code is
[AGPL-3.0-only](LICENSE.md).

## Propose specs instead

SpecDriven is built from its own specifications, which live in
[SpecDriven/specs-specdriven](https://github.com/SpecDriven/specs-specdriven).
A spec is the most useful thing you can send us: it says what the app should
do, and we write the code and tests for it.

A good proposal is a feature with one or more scenarios, written the way the
specs repo writes them:

```markdown
# Export a feature as PDF

A reviewer who doesn't use the app reads a feature as a PDF.

## Export the open feature @v1 [proposed]

- Given: a feature is open
- When: I choose Export → PDF
- Then: a PDF of the feature and its published scenarios downloads
```

New scenarios arrive as `[proposed]`; we decide which ones to publish.

**How to send one.** We are building a proposals service where you sign in
with your GitHub account and propose a feature or a scenario straight into
the specs repo (with a daily limit per account). Until it is live, open an
issue on
[SpecDriven/specdriven-app-release](https://github.com/SpecDriven/specdriven-app-release/issues)
with your proposal in the format above.

## Bugs

Report bugs as issues on
[SpecDriven/specdriven-app-release](https://github.com/SpecDriven/specdriven-app-release/issues):
what you did, what you expected, what happened, and the version from the
user menu.

## Security issues

Don't open a public issue — see [SECURITY.md](SECURITY.md).

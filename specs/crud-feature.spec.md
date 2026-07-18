# Background

Feature files are markdown files that we version in git.

Feature files contain atomic, immutable, and versioned specifications.

## Feature file format

Feature: <name of the feature>

Scenario: <name of scenario> @vNNN (where NNN is a positive integer)
<scenario body> (any text)
<scenario table> (use Gherkin table format)

## Scenario: create new feature

- Given: user is verified to have access to the data GH repo
- When: user asks to create a feature
- Then: new feature file is created in the local filesystem

## Publishing scenarios

When a scenario is published it is marked with [pub] after the version

Ex: ```Scenario: Basic Quote @v1 [pub]```

## Scenario: Publish feature with successful merge

- Do a 'git pull' and merge all the files.
- If merge successful, proceed with saving
- do a git commit and push

## Scenario: Publish feature with merge conflict

- Display conflict to the user and ask for a resolution
- Either accept yours, accept theirs, or manual edit
- do a git commit and push

## Scenario: reload data on a cron job

- automatically reload (git pull) data every n seconds
- specify reload frequency in the Settings screen



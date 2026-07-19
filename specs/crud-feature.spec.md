# Background

Feature files are markdown files that we version in git.

Feature files contain atomic, immutable, and versioned specifications.

## Feature file format

Feature files are plain markdown, named `<slug>.feature.md`, so they render
nicely on GitHub and in any markdown viewer:

```markdown
# <name of the feature>

<optional feature description — any markdown>

## <name of scenario> vNNN [proposed | published | archived]

<scenario body — any markdown up to the next scenario heading>
```



```markdown
## Basic Quote v1 [proposed]

- **Given** a potential customer has an account
- **When** the customer requests a quote
- **Then** a quote is provided

| plan   | mobile UI |
| ------ | --------- |
| Gold   | yes       |
| Silver | yes       |
```

## Scenario: create new feature

- Given: user is verified to have access to the data GH repo
- When: user asks to create a feature
- Then: new feature file is created in the local filesystem

## Publishing scenarios

When a scenario is published it is marked with a `` [published] `` chip after
the version.

Ex:

```markdown
## Basic Quote v1 [published]
```

## Scenario: Scenario is automatically saved locally and pushed to GitHub

- We don't want to loose any data.
- Based on data reload frequency in Settings
- after Git pull; do a commit and push of the saved scenarios; on the top banner of the UI,
- display 'Saved' message for 2 sec

Ex:

```markdown
## Customer calls accident hotline and talks to a live agent v1 [proposed]

Customer calls accident hotline and leaves a message with accident info.
```

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

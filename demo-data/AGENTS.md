# AGENTS.md — writing specs in this folder

This folder is a SpecDriven data repo: a git repository of plain-markdown
specification files that the SpecDriven app reads, edits, commits and pushes.
An AI agent (or a person) can add and edit files here directly; the app
absorbs edits made on disk about once a minute. This file tells an agent how
the files must be written so that the app reads them as intended.

## Layout

| Path | Meaning |
| --- | --- |
| `README.md` | The repo's home page in the app. |
| `AGENTS.md` | This file. |
| `specs/**/<slug>.feature.md` | Feature files, in folders of any depth. Only files ending in `.feature.md` are features. |
| `roadmap/**.md`, `tasks/**.md` | Plain markdown pages. A `##` heading there is never a scenario. |
| `.images/` | Images referenced from specs. Only reference files that exist here. |
| `project-settings.json` | Project members, the names an `**Assigned:**` line may use. |
| `.specdriven/` | The app's own documents and settings. Never edit anything under it. |

## A feature file

One file is one **feature**: a `# <name>` heading, an optional description
in free markdown, then **scenarios**. A scenario is an atomic, versioned unit
of behaviour. Published scenarios are immutable; new behaviour ships as a new
version of the same scenario name.

The file name is the feature name slugified: lower case, every run of
characters outside `a-z0-9` replaced by one `-`, no leading or trailing `-`,
plus `.feature.md`. "Collect Premium" → `collect-premium.feature.md`.

A complete, canonical file:

```markdown
# Collect premium

[Jira:BIL-42](https://acme.atlassian.net/browse/BIL-42)

Automatic payment collection for policies on autopay.

## S1: Failed autopay starts the grace period @v1 [proposed]

- **Given** a policy on autopay whose card is declined
- **When** the collection job runs
- **Then** the policy enters a 30-day grace period
- **And** the policyholder is emailed the retry date

## S2: A policy without autopay is not charged @v1 [proposed]

[negative]

- **Given** a policy that is not on autopay
- **When** the collection job runs
- **Then** no charge is attempted

## S3: Retry schedule follows the card network @v1 [proposed]

- **Given** a declined charge on a "<network>" card
- **When** the grace period starts
- **Then** the charge is retried after <days> days

| network | days |
| ------- | ---- |
| Visa    | 3    |
| Amex    | 5    |
```

## Scenario headings

A scenario starts at, and only at, a `##` heading of this exact shape:

```text
## S<n>: <name> @v<version> [proposed]
```

- `S<n>:` is the scenario's position in the file, 1, 2, 3… in file order.
  Write it: a file whose headings carry no numbers is sorted by name on the
  app's first write. The app regenerates the numbers on every write, so they
  are never part of the name.
- `@v<version>` is a positive integer with no leading zeros: `@v1`, `@v2`.
  `@v0` and `@v01` do not parse. A name may contain `@v` itself; the last
  one, at the end of the line, is the version.
- The status chip is lower case, in square brackets, with a space before it:
  `[proposed]` or `[published]`. Always write `[proposed]` for new content:
  a heading with no chip is a draft, and the app drops drafts from the file.
  Publishing is a human act in the app, so never write `[published]`.
- The heading starts at column 0. An indented `##`, a `##` heading without
  `@v<version>`, or a heading inside a fenced code block is ordinary text, so
  use plain `##` and `###` headings freely for sections of a description.
- Never change the body of a `[published]` scenario. Add
  `## S<n>: <same name> @v<max+1> [proposed]` after it instead.
- Anything after the chip (`[proposed] (skipped)`) makes the whole line
  ordinary text and the scenario silently disappears from the app.

## Metadata lines

Right under a `#` or `##` heading, as its first non-blank lines and in any
order, a feature or a scenario may carry:

| Line | Where | Meaning |
| --- | --- | --- |
| `[Jira:ABC-123](https://…)` | feature, scenario | The ticket tracking it. The program name is anything without `:`; `GitHub`, `Jira` and `Linear` are known to the app. |
| `[Confluence:99999](https://…)` | feature | The Confluence page the feature was published to. The app writes it; do not invent one. |
| `[negative]` | scenario | The scenario guards a failure or an edge case. Absent means positive. |
| `**Assigned:** Ada Lovelace` | feature | A member named in `project-settings.json`. |
| `[ff:new-checkout:on] [ff:card-v2:off]` | feature, scenario | Feature flags gating it. |
| `[br:young-driver-surcharge:on]` | feature, scenario | Custom attributes, `[<key>:<name>:<value>]`, keys defined in `custom-attributes.txt`. |

Metadata ends at the first line that is none of these. A ticket link lower
in the description is just a link.

## The body

Everything from the metadata to the next scenario heading is the body: any
markdown. Conventions that keep specs uniform and testable:

- Steps as bold bullets: `- **Given** …`, `- **When** …`, `- **Then** …`,
  with `- **And**` and `- **But**` for continuations. One behaviour per
  scenario; a scenario with three `When`s is three scenarios.
- Parameters in angle brackets, `<network>`, with the values in a markdown
  table under the steps.
- A `Preconditions:` list above the steps for setup shared by several steps.
- Images as `![image](/api/images/<file>)`, naming a file that exists in
  `.images/`. The app uploads images; do not add files to `.images/` by hand.
- Tests that automate the scenario, last in the body, one per line:
  `[test: <test name> : https://github.com/<org>/<repo>/blob/main/<file>#L<line> ]`.
  Only GitHub urls, and only for tests that exist.

## Canonical form

The app rewrites every file it saves into one form. Writing it the same way
means the app's first save of your file is a zero diff:

1. `# <name>`, then the feature's metadata lines, then the description, then
   the scenarios in file order, each numbered by position.
2. Under a scenario heading: `[negative]` first, then flags, attributes, the
   ticket link, the body, the `[test: … ]` lines.
3. Exactly one blank line between blocks, none at the start, one `\n` at
   the end.

## Before you finish

- Every scenario heading matches `## S<n>: <name> @v<N> [proposed]` exactly,
  numbered 1..N in file order, with nothing after the chip.
- No two headings share a name and version.
- Every ``` or ~~~ fence is closed. An unclosed fence swallows every heading
  after it.
- No `[published]` body was changed.
- No file was added under `.specdriven/` or `.images/`.
- Keep this file where it is. The app installs it only into a folder that
  has none, so edits you make here stay.

## Conventions in this repo

Add this project's own conventions below: the vocabulary, the roles, the
systems a scenario may name, the folder each area's features go in.

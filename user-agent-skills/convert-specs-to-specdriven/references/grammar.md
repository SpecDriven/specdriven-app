# The SpecDriven `.feature.md` grammar

The complete reference for the spec file format the SpecDriven app reads and
writes. It is written to stand alone: everything an agent needs to produce a
valid, canonical `.feature.md` file is in this document.

The normative source is the app's parser (`src/server/parser.ts` in the
SpecDriven app repository, exercised by `tests/parser.test.ts`). This document
mirrors the parser; if prose elsewhere disagrees with it — including older
descriptions of the format that mention `[deleted]` or `[archived]` statuses,
which do not exist — the parser and this document win.

## Contents

1. [Design principles](#1-design-principles)
2. [Data repo layout](#2-data-repo-layout)
3. [File naming and paths](#3-file-naming-and-paths)
4. [File structure](#4-file-structure)
5. [Feature metadata lines](#5-feature-metadata-lines)
6. [Scenario headings](#6-scenario-headings)
7. [Statuses and lifecycle](#7-statuses-and-lifecycle)
8. [Scenario metadata and body](#8-scenario-metadata-and-body)
9. [The Tests section](#9-the-tests-section)
10. [Canonical serialization](#10-canonical-serialization)
11. [Deep links and back-references](#11-deep-links-and-back-references)
12. [Edge cases and gotchas](#12-edge-cases-and-gotchas)
13. [Complete annotated example](#13-complete-annotated-example)

## 1. Design principles

- **Plain markdown, deliberately no frontmatter.** Spec files must render
  nicely on GitHub and in any markdown viewer, so metadata is written as
  ordinary markdown lines (a link, a bold `**Assigned:**` line) instead of
  YAML frontmatter. Never add frontmatter to a `.feature.md` file.
- **Scenarios are atomic, immutable, and versioned.** A scenario is identified
  by its name plus a version; published versions never change — new behavior
  ships as a new version of the same name.
- **Reading is lenient, writing is strict.** The app tolerates legacy syntax
  and missing headings when reading, but refuses to write a malformed file.
  Write in the canonical form (section 10) so the app's first rewrite of your
  file produces no diff.
- **The data repo is git-backed and live.** The app commits and pushes edits,
  and periodically pulls and absorbs hand edits made on disk. Files you write
  into a repo the app has open are picked up automatically.

## 2. Data repo layout

Specs live in a "data repo" — an ordinary git repository, separate from the
app:

| Path | Meaning |
| --- | --- |
| `README.md` | The repo's home page; the app opens it at start. |
| `project-settings.json` | Project members: `{"members": [{"name": "Ada Lovelace", "email": "ada@acme.example"}, "Grace Hopper"]}` — entries may be objects or bare name strings. These names are the vocabulary for `**Assigned:**` lines. |
| `<folder>/…/<slug>.feature.md` | Feature spec files, nested in plain directories to any depth. |
| `roadmap/**.md` | Reserved folder of plain markdown pages (strategy, priorities). Never put `.feature.md` files here; `##` headings in roadmap pages are ordinary sections, never scenarios. A roadmap page may carry a `# <name>` heading and an `**Assigned:** <name>` line under it. |
| `.images/` | Images embedded in specs, stored as `<slug>-<hash8>.<ext>` (see section 8). |
| `.specdriven/` | App internals (CRDT documents, settings). Never hand-edit anything under it. |

Discovery walks every directory except entries starting with `.` and
`node_modules`, and treats only files ending in `.feature.md` as feature
specs. Any other `.md` file outside `roadmap/` is invisible to the app.

## 3. File naming and paths

A feature file is named `slugify(feature name) + ".feature.md"`. The slug
algorithm, exactly:

1. Lowercase the name.
2. Replace every run of characters outside `a-z0-9` with a single `-`.
3. Trim leading and trailing `-`.

Examples: `"Quote Policy"` → `quote-policy.feature.md`; `"Café Menu"` →
`caf-menu.feature.md` (accented characters are not in `a-z` and collapse into
hyphens); a name with no ASCII letters or digits slugifies to the empty
string, which is not a valid file name — derive or ask for an ASCII stem.

- A `/` in a feature name creates nested folders, each segment slugified:
  `"billing/Basic Quote"` → `billing/basic-quote.feature.md`.
- Path segments must be non-empty, must not start with `.`, and must not
  contain `\`.
- Avoid naming a folder `scenarios` — deep links cannot address it
  (section 11).
- The file name and the `# <name>` heading are independent after creation:
  renaming one does not rename the other. A file with no heading is displayed
  under a name derived from its stem (`quote-policy.feature.md` → "Quote
  Policy").

## 4. File structure

A feature file is: one feature heading, optional metadata lines, a free
markdown description, then zero or more scenarios.

```markdown
# Collect Premium

Premium collection for issued policies.

## Failed autopay starts the grace period @v1 [proposed]

- **Given** an installment due today
- **When** the autopay charge is declined
- **Then** the charge is retried in 3 days
```

Write-validation rules — a file violating them is refused on write with the
message shown:

| Rule | Error |
| --- | --- |
| The file must not be empty (or whitespace-only). | `the file is empty` |
| The first non-blank line must be the feature heading. | `it must start with the feature heading "# <name>", not …` |
| The heading is `#`, at least one space, then a non-empty name. `#Name` without the space is invalid. | `the feature heading has no name` / `must start with …` |

Leading blank lines above the heading are tolerated on read, but canonical
form starts at line 1. Only the **first** `#` heading before any scenario and
outside code fences is the feature name; later `#` lines are ordinary content.
The description is everything between the metadata lines and the first
scenario heading — any markdown, including `##` headings that carry no
version (section 6).

## 5. Feature metadata lines

Directly under the `# <name>` heading, a feature may carry metadata lines,
in any order, as its first non-blank lines:

**External ticket link** — one markdown link alone on its line:

```text
[Jira:ABC-123](https://acme.atlassian.net/browse/ABC-123)
```

The exact pattern is `[<program>:<ticket>](<url>)` where `<program>` contains
no `[`, `]`, or `:` (it ends at the first colon), `<ticket>` contains no `[`
or `]` (colons are fine — `#17`, `ENG:42`), and `<url>` is `http(s)://` with
no whitespace or parentheses. Up to three leading spaces are tolerated;
anything else on the line makes it ordinary prose. Programs the app offers by
name: `GitHub`, `Jira`, `Linear`; any other program name parses and is
treated as "Other" while keeping its name.

**Assignment** — one bold line:

```text
**Assigned:** Ada Lovelace
```

Pattern: `**Assigned:** <name>` (matched case-insensitively, up to three
leading spaces). The name should be a member's name exactly as
`project-settings.json` spells it; an unknown name still parses and is kept,
but only member names appear in the app's assignment dropdown. Assignment is
feature-level only — an `**Assigned:**` line under a scenario heading is
silently ordinary prose.

**Feature flags** — `[ff:<name>:on|off]` tokens, alone on their line:

```text
[ff:new-checkout:on] [ff:card-v2:off]
```

A name starts with a letter or digit and holds letters, digits, `.`, `_` and
`-`; `on`/`off` read in any case. A malformed `[ff:…]` token makes the
whole line prose.

**Custom attributes** — `[<key>:<name>…:<value>]` tokens, alone on their line
(a line may mix them with flag tokens):

```text
[br:young-driver-surcharge:on] [br:max-claims:3]
[br-sub:young-driver-surcharge:under-21:1.5]
```

The key is lower case: `[a-z][a-z0-9._-]*`, never `ff`, `test`, `http` or
`https`. Each segment after it holds no `[`, `]`, `:` or line break and no
whitespace at either end (inner spaces are fine). The last segment is the
value, the ones before it are names. Which keys a team uses is defined in the
data repo's `custom-attributes.txt`, but any token of this shape parses and
is kept; an exact duplicate token is dropped.

Metadata parsing stops at the first line that is none of these: a link
further down the description, or a paragraph that merely starts with a link
plus more text, is ordinary content. At most one link and one assignment are
lifted; flag and attribute lines may repeat and add up. Canonical order is in
section 10.

## 6. Scenario headings

A scenario starts at — and only at — a `##` heading that ends with a version:

```text
## <name> @v<version>            → a draft (see section 7 before writing this)
## <name> @v<version> [proposed]
## <name> @v<version> [published]
```

The heading pattern, exactly (this is the parser's regex):

```text
^##\s+(.+?)\s+@v([1-9]\d*)(?:\s+\[(published|proposed|saved|draft)\])?\s*$
```

Consequences worth internalizing:

- The heading must start at column 0 — `##` with leading spaces is ordinary
  content (unlike link/assignment lines, headings tolerate no indentation).
- The version is a positive integer with no leading zeros. `@v0` and `@v01`
  do not match, so the whole line silently becomes ordinary content.
- The `@` marks where the name ends, so a name that itself ends in a
  version-like word stays unambiguous: `## Migrate to v2 API @v1` is the
  scenario "Migrate to v2 API" at version 1. When a name contains several
  `@v` sequences, the final one (at end of line) is the version.
- The chip needs a space before it: `## X @v1[proposed]` does not match and
  the line becomes content. Chip names are case-sensitive lowercase:
  `[Proposed]` does not match either.
- A `##` heading **without** `@vNNN` is ordinary markdown — it stays part of
  the description or scenario body it appears in. Use plain `##`/`###`
  headings freely for sections.
- Headings inside fenced code blocks (``` or ~~~, up to three leading
  spaces) are content even when they carry a version — examples of the format
  must not parse as real scenarios. Both fence markers toggle the same state,
  so every fence must be closed.
- Two scenarios may share a name only with different versions. Never write
  two headings with the same name and version — both parse, and tooling
  cannot tell them apart.

Legacy forms, read but never to be written (the app rewrites them to the
current syntax on its next save): `## Name v1 [published]` (no `@`) and
``## Name `v1` `published` `` (backtick chips); `[saved]` is the legacy
spelling of `[proposed]`.

## 7. Statuses and lifecycle

A scenario's status advances one way: `draft` → `proposed` → `published`.

| Status | On-disk chip | Meaning |
| --- | --- | --- |
| draft | none — a chipless heading parses as a draft | Work in progress. Lives in the app's internal document only; the app's projection **removes chipless scenarios from the file** on its next sync. `[draft]` written explicitly is an editor↔server wire format that also never belongs in a file. |
| proposed | `[proposed]` | Saved and reviewable, not yet published. The status hand-written files should use. |
| published | `[published]` | Published and immutable: the body must stay byte-identical forever. Changes ship as a new version of the same name. Publishing is an explicit human act in the app. |

The two rules that matter most when generating files:

1. **Always write an explicit `[proposed]` chip** on content that should
   persist. A chipless heading is absorbed as an app-internal draft and
   silently leaves the file — hand-written scenarios without chips are lost
   from the markdown.
2. **Never write `[published]` for new or converted content**, and never edit
   the body of an existing `[published]` scenario. To change published
   behavior, add `## <same name> @v<max+1> [proposed]` alongside it.

## 8. Scenario metadata and body

Right under its heading, a scenario may carry its own external ticket link,
feature flags and custom attributes — same patterns and same
first-non-blank-line rule as the feature's (section 5). Scenarios cannot
carry `**Assigned:**` lines.

Everything from there to the next scenario heading (or end of file) is the
body: **arbitrary markdown**. The parser imposes nothing on it, but these
conventions make specs uniform and testable:

- Steps as bold bullets: `- **Given** …`, `- **When** …`, `- **Then** …`,
  with `- **And**` / `- **But**` for continuations.
- Tabular data (Gherkin-style example tables) as markdown tables.
- Plain `##`/`###` headings for sub-structure — they are content as long as
  they carry no `@vNNN` version.
- Images as `![alt](/api/images/<name>)`. The files live in `.images/` at the
  repo root; the app stores them content-addressed as `<slug>-<hash8>.<ext>`
  where `<hash8>` is the first 8 hex chars of the content's SHA-256. A served
  name must match `^[a-z0-9][a-z0-9-]*\.(png|jpg|jpeg|gif|webp|svg|avif)$`;
  uploads are capped at 10 MB. These references render inside the app but not
  on GitHub (GitHub has no `/api/images/` route).

## 9. Test links

A scenario may end with the automated tests that cover it, one
`[test: <url> ]` line each, after the body:

```text
[test: https://github.com/acme/policy-service/blob/main/test/bind.test.ts#L12 ]
```

Parser behavior to respect:

- A line made only of `[test: <url> ]` tokens is lifted out of the body into
  the scenario's test links, wherever it stands; the canonical place is last
  in the scenario. Spaces around the url are optional (`[test:<url>]` reads
  the same) and the url may not contain spaces or `]`.
- A token inside a rule's own line — `- **Then** the quote is priced
  [test: <url> ]` — traces that one rule, not the scenario. It stays in the
  body, and the app's preview shows it as a link named after the test: the
  file name without its extension and line anchor,
  `QuoteHomeownersPolicyTest`, opening the full url in a new tab.
- The older form, a trailing `### Tests` section with a single-column
  `| Test |` table, is still read (heading match case-insensitive, last such
  heading outside code fences, every following line with a url counts). The
  app rewrites it as test lines the first time it writes the file, so new
  files should use the lines.
- Valid test links are `https://github.com/…` or `https://www.github.com/…`
  only, unique within the scenario. Other URLs may survive parsing but
  violate the spec and the app's link validation.
- Test links stay editable even on a published scenario — they are
  traceability metadata, not part of the immutable spec body.

## 10. Canonical serialization

The app rewrites every file it saves into one canonical form. Producing that
form directly means the app's first save of your file is a zero diff:

1. Blocks in order: `# <name>` → flag line → attribute lines → feature link
   line → `**Assigned:**` line → authorship lines → description → scenarios.
   Each scenario: heading → flag line → attribute lines → scenario link line
   → authorship lines → body → `[test: <url> ]` lines. All flags go on one
   line; the attributes form one block, in written order, with a new line
   (no blank line) wherever the key changes.
2. Every block separated from the next by **exactly one blank line**; no
   leading/trailing blank lines inside blocks; the file ends with a single
   `\n`.
3. Headings written as `## <name> @v<version> [<status>]` — current syntax,
   explicit chip.
4. Scenarios sorted by name (locale-aware string comparison), then by version
   ascending — regardless of source order.
5. Test links exactly as in section 9: one `[test: <url> ]` line per link,
   last in the scenario, one blank line after the body.
6. A scenario with an empty body is just its heading.

## 11. Deep links and back-references

The app addresses specs with stable URLs — useful for cross-referencing:

| URL | Meaning |
| --- | --- |
| `/features/<path>` | Feature page; `<path>` is the file path minus `.feature.md`, spanning folders (`/features/billing/basic-quote`). |
| `/features/<path>/scenarios/<slug>` | Latest version of the scenario whose `slugify(name)` is `<slug>`. |
| `/features/<path>/scenarios/<slug>/v<N>` | Exactly version N — the permalink form. |
| `/roadmap/<page>` | Roadmap page (path minus `.md`). |

The desktop app registers the `specdriven://` scheme for links shared outside
the app: the spec folder's name, then the same path
(`specdriven://specs-insurance/features/billing/basic-quote`). Opening one
switches to that folder first. Two quirks: the first `scenarios` segment with
something after it splits feature from scenario, so a folder literally named
`scenarios` is unreachable; and when two scenario names slugify identically,
the link resolves to the first in the file's (sorted) order.

Cross-references the other way are conventions, not syntax: spec bodies refer
to other specs by relative path in prose (`bind-policy.feature.md`), and test
code points back at the scenario it automates with a `@Spec` comment
annotation naming `<file>#<scenario>@<version>`.

## 12. Edge cases and gotchas

Failure modes are silent — a malformed heading does not error, it just stops
being a scenario. Check for each of these after writing:

- **Silently demoted headings**: a typoed or capitalized chip
  (`[Proposed]`), a missing space before the chip (`@v1[proposed]`), `@v0`
  or a leading-zero version, a missing `@` (legacy form aside), or leading
  indentation all turn the heading into ordinary content — the scenario
  vanishes without an error.
- **Chipless headings vanish later**: they parse as drafts and the app's
  projection removes them from the file (section 7).
- **An unclosed fence swallows the file**: every heading after an unopened
  or unclosed ``` / ~~~ is content. Fence count per file must be even.
- **Pasted examples create real scenarios**: a line like
  `## Example @v1 [proposed]` inside prose is a real scenario boundary
  unless it sits inside a fence.
- **An accidental link line becomes metadata**: a body or description whose
  first non-blank line happens to match `[<a>:<b>](<url>)` alone on the line
  is lifted as the ticket link.
- **A decoy Tests heading**: `### tests` (any case) starts the Tests parser,
  and any later line containing a URL becomes a test row on the app's next
  rewrite. Only one Tests section per scenario, last, table-only.
- **Assignment under a scenario**: an `**Assigned:**` line below a scenario
  heading is silently prose — assignment is feature-level only.
- **Legacy forms** (`v1` without `@`, backtick chips, `[saved]`) parse but
  must never be written — the app normalizes them, so writing them creates
  churny diffs.
- **Non-GitHub or `http://` test links** violate the spec even where the
  parser carries them.
- **Duplicate (name, version) pairs** both parse; tooling cannot address one
  of them reliably.

## 13. Complete annotated example

A canonical file exercising every construct:

```markdown
# Bind Auto Policy

[Jira:POL-207](https://acme.atlassian.net/browse/POL-207)

**Assigned:** Dana Whitfield

Turning an accepted quote into an active policy. Payment is collected on
binding (collect-premium.feature.md).

### Out of scope

Renewals and mid-term endorsements.

## Bind an accepted quote @v1 [published]

- **Given** a quote in "accepted" state
- **When** the prospect provides payment for the first installment
- **Then** a policy is issued with an effective date of the next day

| payment method | supported |
| -------------- | --------- |
| card           | yes       |
| ACH            | yes       |

[test: https://github.com/acme/policy-service/blob/main/test/bind.test.ts#L12 ]

## Bind an accepted quote @v2 [proposed]

Adds same-day effective dates to v1.

- **Given** a quote in "accepted" state
- **When** the prospect provides payment before 3pm local time
- **Then** a policy is issued effective the same day

## Reject an expired quote @v1 [published]

[Jira:POL-215](https://acme.atlassian.net/browse/POL-215)

- **Given** a quote issued more than 30 days ago
- **When** the prospect tries to bind it
- **Then** binding is refused with reason "quote expired"
```

Reading it top to bottom:

1. `# Bind Auto Policy` — the feature name; the file is
   `bind-auto-policy.feature.md`.
2. The Jira line and the `**Assigned:**` line are the feature's metadata —
   first non-blank lines under the heading, link first.
3. The description runs to the first scenario heading and freely contains an
   `### Out of scope` section — no version, so plain content.
4. `Bind an accepted quote @v1 [published]` is immutable; its example table
   is plain markdown; its `[test: <url> ]` line names the covering test.
5. `@v2 [proposed]` is a new version of the same scenario name, superseding
   v1 when published. Its body states its delta and full behavior; it has no
   Tests section yet.
6. `Reject an expired quote` carries a scenario-level ticket link as its
   first body line.
7. Scenarios appear in canonical order: sorted by name, then version.

The minimal valid feature file is a heading alone:

```markdown
# Onboard Employee
```

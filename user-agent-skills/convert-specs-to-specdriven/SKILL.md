---
name: convert-specs-to-specdriven
description: Converts specs written in other formats — Gherkin/Cucumber .feature files, free-form Markdown PRDs and requirements docs, and Jira or other tracker exports (stories with acceptance criteria) — into SpecDriven .feature.md files, following the SpecDriven grammar exactly. Use when asked to import, migrate, or convert existing specs, user stories, requirements, or acceptance criteria into a SpecDriven data repo, and when writing or validating .feature.md files by hand; the complete format grammar is in references/grammar.md.
---

# Convert specs to SpecDriven

SpecDriven keeps a project's specs in a git "data repo" as plain-markdown
`<slug>.feature.md` files. Each file is one **feature**; inside it, each
**scenario** is an atomic, versioned unit of testable behavior with a status
lifecycle (`draft` → `proposed` → `published`, published being immutable).
There is no frontmatter and no tag/priority/date metadata — the format is
deliberately minimal so files render cleanly on GitHub.

This skill turns specs from other formats into valid, canonical `.feature.md`
files: survey the source, propose a structure, map the content with the
tables below, write canonically, then self-check. Read
[references/grammar.md](references/grammar.md) before writing your first
file — it is the complete grammar, and the failure modes are silent (a
malformed heading doesn't error, it just stops being a scenario). Worked
before/after conversions for each source format are in
[references/examples.md](references/examples.md).

## The target format in 30 seconds

```markdown
# Quote Auto Policy

[Jira:POL-12](https://acme.atlassian.net/browse/POL-12)

**Assigned:** Dana Whitfield

Rating and quoting for personal auto.

## Basic auto quote @v1 [proposed]

- **Given** a prospect provides a vehicle and a garaging ZIP code
- **When** the prospect requests a quote
- **Then** a six-month premium is quoted for each available plan

| plan     | premium |
| -------- | ------- |
| Standard | $517    |
```

- The file is `slugify(feature name) + ".feature.md"` (here
  `quote-auto-policy.feature.md`); slug = lowercase, non-alphanumeric runs
  → `-`, trimmed.
- The first non-blank line must be `# <name>` — space required, nothing
  above it.
- The ticket link and `**Assigned:**` lines are optional metadata, valid only
  directly under the `#` heading (link may also appear under a `##` scenario
  heading; Assigned may not).
- A scenario is exactly a `## <name> @vNNN [proposed|published]` heading —
  a `##` heading without `@vNNN` is ordinary content, which is how specs get
  plain sections.
- Converted scenarios are always `[proposed]` (see "Writing canonically").
- The body is free markdown; bold `- **Given**/**When**/**Then**` bullets and
  markdown tables are convention, not syntax.

## Conversion workflow

1. **Locate the data repo root** — the directory holding
   `project-settings.json` and/or existing `*.feature.md` files (its
   `README.md` is the app's home page). Write only regular feature folders:
   never under `.specdriven/` or any dot-directory (app internals), and never
   put `.feature.md` files under `roadmap/` (reserved for plain pages). Note
   that the app auto-commits and pushes this repo and absorbs on-disk edits
   while running, so files you write go live — leave committing/pushing to
   the user unless asked.

2. **Survey the source material.** Inventory it before converting anything:
   which format (Gherkin, PRD, tracker export, other), how many candidate
   features and scenarios, what metadata exists (ticket ids, assignees, tags,
   statuses, tables, images), and what has no target equivalent (priorities,
   estimates, due dates — the format has none; they fold into prose or the
   final report). Read `project-settings.json` now: its `members` names are
   the only ones worth writing into `**Assigned:**` lines.

3. **Propose the structure before writing.** Draft the tree of
   `folder/<slug>.feature.md` paths with each file's feature name and
   scenario names. Apply the naming rules: stem = slugified feature name; a
   `/` in a name nests folders; segments must be non-empty, not start with
   `.`, and contain no `\`; if a name slugifies to nothing (no ASCII
   letters/digits), derive an ASCII stem; don't name a folder `scenarios`
   (deep links can't address it). When working interactively, show the tree
   and get a nod before writing; when not, proceed and record every judgment
   call for the report.

4. **Map the content** using the table for your source format below, and the
   generic rules for anything else. For images the source embeds: copy the
   file into `.images/` at the repo root (lowercase slug name, extension one
   of png/jpg/jpeg/gif/webp/svg/avif, ≤10 MB) and reference it as
   `![alt](/api/images/<name>)` — noting it renders in the app but not on
   GitHub. If unsure the image matters, keep the source's reference and flag
   it.

5. **Write the files in canonical form** — see "Writing canonically". The
   app rewrites saved files into exactly that form, so matching it up front
   means the app's first save produces no diff.

6. **Self-check.** Re-read every file you wrote and walk the validation
   checklist below. The grammar's failure modes are silent, so this pass is
   what catches a scenario that quietly became plain text.

7. **Report.** In your reply (not as an extra file in the data repo unless
   asked): the files written with scenario counts, every judgment call, and
   everything dropped or folded into prose — source statuses, priorities,
   tags, estimates, assignees that matched no project member — plus open
   questions. Lossiness is fine; silent lossiness is not.

## Writing canonically

- Block order: `# <name>` → ticket link line → `**Assigned:**` line →
  description → scenarios. Each scenario: `## <name> @v<N> [proposed]` →
  scenario ticket link line → body → `[test: <url> ]` lines. Exactly one
  blank line between blocks; single trailing newline.
- Sort scenarios by name (locale string order), then version ascending — the
  order the app writes, so any other order churns on first save.
- Version: `@v1` for new scenarios. If the target file already exists and has
  scenarios of the same name, use max(existing version)+1 — and leave every
  existing block byte-identical; published scenarios are immutable.
- Status: always `[proposed]`. Never `[published]` (publishing is the
  human's explicit act in the app, and it freezes the body). Never chipless —
  a chipless heading parses as an app-internal draft and is **removed from
  the file** by the app's next sync. Never `[draft]` or `[saved]`
  (wire-format and legacy tokens).
- Test lines only when the source names real automated tests: one
  `[test: <url> ]` line per test, last in the scenario —
  `https://github.com/…` URLs only, unique. A test that covers one rule
  rather than the scenario goes on that rule's own line instead. The older
  `### Tests` table is still read, but never write it.

## Mapping: Gherkin / Cucumber `.feature`

| Gherkin | SpecDriven | Notes |
| --- | --- | --- |
| `Feature: <name>` | `# <name>`; file `<slug>.feature.md` | One file per source file; source directories become folders. |
| Feature description | Feature description | Verbatim, reflowed as markdown. |
| `Background:` | Its steps repeated as the leading `- **Given**`/`- **And**` bullets of *every* scenario | Deliberate duplication: scenarios are atomic and must stand alone. Purely narrative background goes to the description instead. |
| `Rule: <name>` | `### Rule: <name>` section in the description; each governed scenario opens with a `**Rule:** <name>` body line | No Rule construct exists — the grouping flattens. Prefix scenario names if two rules have same-named scenarios. |
| `Scenario:` / `Example:` | `## <name> @v1 [proposed]` | |
| `Scenario Outline:` + `Examples:` | ONE scenario: steps keep `<placeholder>` names as inline code, each Examples table becomes a markdown table (titled `**Examples: <name>**` when named or multiple) | Never expand one scenario per example row. |
| `Given`/`When`/`Then` | `- **Given**` / `- **When**` / `- **Then**` bullets | |
| `And`/`But`/`*` | `- **And**` / `- **But**` (`*` → `- **And**`) | |
| Step data table | Markdown table right after its step's bullet list | |
| Doc string `"""` | Fenced code block, media type as the language tag | Always close the fence — an unclosed fence swallows every later scenario. |
| Tags (`@billing @smoke`) | `` Tags: `@billing` `@smoke` `` line at the end of the description (feature tags) or body (scenario tags) | Lossy — no tag construct. A ticket-shaped tag (`@JIRA-123`) becomes the ticket link line instead when the tracker URL is known or confirmed. `@wip`/`@skip` do NOT become drafts — still `[proposed]`; note them in the report. |
| `# comment` | Meaningful → `> comment` blockquote near what it annotates; boilerplate → drop and report | Never leave a raw leading-`#` line: it renders as a huge heading, and above the feature heading it makes the file invalid. |
| `# language: xx` | Drop the header; keep step text in its language with the localized keywords bolded (`- **Étant donné** …`) | The bullet convention is language-neutral. |

## Mapping: Markdown PRDs / requirements docs

| PRD construct | SpecDriven | Notes |
| --- | --- | --- |
| Document title | Folder name (multi-capability PRD) or feature name (single-capability doc) | One `.feature.md` per cohesive capability, not per document. |
| Capability sections (H2/H3) | One `.feature.md` each, named after the section | |
| Overview / goals / context | Description of the most relevant feature; PRD-wide strategy or timeline → offer a `roadmap/<slug>.md` page (extra file — needs the user's OK) | Roadmap pages are free markdown; `##` there never makes scenarios. |
| User story ("As a … I want … so that …") | One scenario: name from the "I want" clause, the full story sentence as the first body line, its acceptance criteria as Given/When/Then bullets | |
| Acceptance-criteria list | Each criterion with its own trigger/behavior → its own scenario; refinements of one behavior → extra `- **Then**`/`- **And**` bullets | Rule of thumb: a distinct *When* means a distinct scenario. |
| Requirement tables / matrices | Markdown tables in the relevant body or description | |
| Measurable NFRs ("p95 < 200 ms") | Given/When/Then scenarios — in the owning feature when specific to it, in a dedicated feature (e.g. `performance.feature.md`) when cross-cutting | |
| Vague NFRs ("should be fast") | Description prose; flag as untestable in the report | |
| Open questions | `### Open questions` section in the description | Scenarios are for agreed behavior only. |
| Priority / MoSCoW / due dates | One prose line in the description (`Priority: P1 (from PRD)`) or report only | Explicitly lossy — no such fields exist. |
| Owner / stakeholder | `**Assigned:** <name>` on the feature, only on an exact `project-settings.json` member match; otherwise description prose | Scenarios cannot carry assignees. |

## Mapping: Jira / tracker exports

| Tracker construct | SpecDriven | Notes |
| --- | --- | --- |
| Epic | Folder `<epic-slug>/`; its summary/description → the epic's main feature description, or a roadmap page when purely strategic | |
| Story / task | Its own `.feature.md` when it carries several independent acceptance criteria; one scenario in a grouped per-epic or per-component feature when it describes a single behavior | |
| Summary | Feature or scenario name, with the `ABC-123:` key prefix stripped | The key lives in the link line, not the name. |
| Description field | Feature description / opening body prose; convert Jira wiki-markup or ADF to plain markdown | |
| Acceptance-criteria field | Given/When/Then bullets; independent criteria → separate scenarios | |
| Issue key + browse URL | `[Jira:ABC-123](https://<site>/browse/ABC-123)` as the first line under the feature or scenario heading it tracks | First-class support. Program is `Jira`, `Linear`, `GitHub`, or the tool's own name. |
| Status (To Do / Done / …) | Always `[proposed]`; original status → report, plus a prose line when useful | Done ≠ `[published]` — publishing is a human act in the app. |
| Priority / points / sprint / fix version / due date | Report, optionally one prose line in the description | Explicitly lossy. |
| Labels | `` Tags: `label-a` `label-b` `` line at the end of the body; may also inform folder placement | |
| Component | Folder-placement hint | |
| Assignee | Feature-level `**Assigned:**` on an exact member match; otherwise prose or report | |
| Sub-tasks | Body bullets, or their own scenarios when independently testable | |
| Comments | Drop and report; fold decisions that changed the spec into the description on request | |

## Mapping: anything else

Sort each piece of source content with these rules, in order:

1. A unit of *testable behavior* → a scenario, `@v1 [proposed]`.
2. A cohesive *capability* → a feature file.
3. A *grouping* of capabilities → a folder.
4. A *ticket reference* → a link line; a *test URL on github.com* → a
   `[test: <url> ]` line; an *owner* who is a project member → feature-level
   `**Assigned:**`.
5. Everything else — statuses, priorities, dates, estimates, tags,
   comments — is prose in the description/body, or a line in the report.

Never invent versions, statuses, or metadata the target has no construct
for. When in doubt, put it in the description and flag it in the report.

## Validation checklist

Walk this for every file written; each item is checkable by re-reading or
grep:

1. File name is exactly `slugify(feature name) + ".feature.md"`; no path
   segment is empty, starts with `.`, or contains `\`; the file is not under
   `roadmap/` or a dot-directory.
2. The first non-blank line is `# ` + a non-empty name, with nothing above
   it (`#Name` without the space is rejected on write).
3. Feature metadata sits directly under the heading — at most one ticket
   link line and one `**Assigned:**` line, link first — and nowhere else in
   the file does a paragraph *start* with a lone `[a:b](http…)` line that
   isn't meant as metadata.
4. Every intended scenario heading matches
   `^## .+ @v[1-9][0-9]* \[(proposed|published)\]$` (grep for it; count must
   equal intended scenarios). No `@v0`, no leading-zero versions, no
   capitalized or typoed chips, no missing space before the chip, no leading
   indentation — each of those silently demotes the heading to plain text.
5. No two scenarios share the same (name, version); warn when two names
   slugify identically (deep links resolve to the first only).
6. Fences balance: the count of lines matching `` ^\s{0,3}(```|~~~) `` is
   even in every file — an unclosed fence swallows every later scenario.
7. Test links are `[test: <url> ]` lines, last in the scenario,
   `https://github.com/…` URLs only, no duplicates. No `### Tests` heading
   is written (match case-insensitively — a lowercase `### tests` decoy also
   triggers the parser's legacy table reader).
8. No `**Assigned:**` line under any scenario heading (it would be silent
   prose — assignment is feature-level).
9. Statuses: every converted scenario is `[proposed]`; any pre-existing
   `[published]` block is byte-identical to what was already there.
10. Blocks are separated by exactly one blank line, the file ends with one
    newline, and scenarios are sorted by name then version.
11. Every `**Assigned:**` name appears in `project-settings.json` `members`
    (unknown names are kept by the parser but pollute the assignment UI —
    prefer folding non-members into the description).

## Common pitfalls

- A typoed chip, a capitalized chip, `@v0`, `@v01`, or `@v1[proposed]`
  (missing space) turns the heading into ordinary content — no error, the
  scenario just vanishes.
- A chipless `## Name @v1` heading survives parsing but is absorbed as an
  app-internal draft and removed from the file on the next sync.
- An unclosed ``` or ~~~ fence makes every later heading plain content.
- A raw Gherkin `# comment` line pasted verbatim renders as a page-title
  heading — and before the feature heading it makes the file unwritable.
- A pasted example containing a real `## X @v1 [proposed]` line creates a
  real scenario unless it sits inside a fence.
- Legacy heading forms (`## X v1 [saved]`, backtick chips) parse but must
  never be written — the app rewrites them, churning the diff.
- A ticket link anywhere but the first non-blank line under its heading is
  just prose; conversely, an accidental lone `[a:b](url)` first line becomes
  metadata.
- `http://github.com/…` (not https) and non-GitHub URLs are invalid as test
  links.

## References

- [references/grammar.md](references/grammar.md) — the complete grammar:
  read before writing the first file; consult its edge-case list (section
  12) during the self-check pass.
- [references/examples.md](references/examples.md) — one full before/after
  conversion per source format, with the conversion notes the report step
  expects.

# Exploratory test session: feature-file parser and serializer

Date: 2026-10-20. Scope: `src/server/parser.ts` (`parseFeature`, `serializeFeature`,
`splitTests`, metadata splitting) with end-to-end confirmation through
`saveFeature` / `createFeature` in temp data dirs. Five iterations, ~95 probes.
Charter: find silent data loss after today's incident.

## Confirmed data loss (end to end)

### 1. A `### Tests` heading in a scenario body deletes everything below it

`splitTests` treats the last `### Tests` heading (any case, outside fences,
anywhere in the body) as the legacy test table and discards every line after
it that has no URL. Any URL on those lines, GitHub or not, becomes a test link.

Reproduced through `saveFeature` on a `[proposed]` scenario:

```
## S1: A @v1 [proposed]

Given x

### Tests

Manual checklist:
- open the app
- see https://example.com/dash

And then more steps
```

lands in the document as body `Given x` with tests `["https://example.com/dash"]`.
The checklist and "And then more steps" are gone, with no error. The same happens
on `createFeature` (import of a file) for a `[published]` scenario. With two such
headings the loss is progressive: each save eats one more section.

Spec context: `specs/traceability.feature.md` describes the table as *trailing*;
`specs/external-links/test-traceability.feature.md` S61 says an older table is
still read. The parser applies that rule to a heading anywhere, which a user
typing a "Tests" section by hand will hit.

Suggested fix: only recognise the legacy section when it is the last thing in the
body and every non-blank line under it carries a GitHub URL (or is table framing);
otherwise leave the heading and its lines in the body.

### 2. Leading indentation of a body's first line is stripped, which can open a fence

`parseFeature`'s `flush` does `bodyLines.join("\n").trim()`, so a body that starts
with an indented line loses that indentation. For an indented code block whose
first line is `    ```` the projection writes a bare ```` ``` ````, an open fence.

Reproduced through `saveFeature`:

- Save 1 succeeds and writes a file whose first scenario now opens a fence that is
  never closed (the write guard checks the incoming text, not the projection).
- The editor reloads that text; every later save is refused with
  "the code fence opened on line 5 is never closed". The drift pass also refuses
  the file. The feature is stuck until someone hand-edits the file.
- On read, the second scenario is swallowed into the first's body, so it
  disappears from the UI while still being in the document.

Milder forms of the same trim: a nested list item (`  - nested`) becomes a top-level
item; a tab-indented code line becomes prose; trailing two-space hard breaks on
the last line are lost.

Suggested fix: trim only blank lines (`/^\n+|\n+$/`) rather than `trim()`, and run
`assertFeatureText` on the projection before writing it.

## Refused rather than lost (guard from PR #252 works), but legitimate files cannot be saved

- A ``` fence containing a `~~~` line (or vice versa) toggles the fence state
  twice, so a valid CommonMark file reads as an open fence and the save is refused.
  A four-backtick fence containing ``` only survives by parity luck.
- A body ending with a lone fence line is refused (expected).

## Serializer writes what the parser cannot read back

Each of these is written on its metadata line but is parsed as body text on the
next read, so the scenario body silently grows a line (and a published scenario's
next save can be refused as "immutable"):

- link URL containing `(`, `)` or a space; ticket containing `]`; program
  containing `:` (splits program/ticket at the first colon)
- flag name containing a space (the UI validates this; the API path may not)
- test ref whose name contains `]` or whose URL contains a space
- a scenario whose `link.program` is `qTest`/`Confluence` is re-read as `qtest`/
  `confluence`, and a feature `link` with program `Confluence` becomes `confluence`

`formatAttributeLines` silently drops any attribute that fails `isAttribute`
(uppercase key, `]` in the value): the document keeps it, the file never shows it.

## Name edge cases

- Empty scenario name serialises as `## S1:  @v1` and parses back as name `S1:`.
  The editor blocks empty names; other callers may not.
- A hand-written `S0:`, `s1:` or `S1:A` prefix becomes part of the name
  (no loss, but the next write produces `## S1: S0: A`).
- A `[Published]` chip (capital) or a heading indented by one space is not a
  heading: the scenario folds into the previous body and reconcile would delete
  it from the document on the next save.
- Description or body text whose first line looks like a link, flag or
  authorship line is lifted into metadata; with "Publish external links" off,
  a description that was only a link line vanishes from the file.

## No issues found

Numbering and ordering (iteration 4): duplicate or descending `S<n>`, mixed
numbered and numberless headings, drafts between numbered scenarios, same name
in two versions, `markProposed`/`markPublished`/`markScenarioPublished`/
`extractScenarios`/`renameFeatureName` on numbered text, CRLF files, unicode,
HTML comments and blockquotes around headings, legacy chips, metadata lines in
any order, duplicate test URLs (first wins, by design).

## Probe scripts

`/private/tmp/claude-501/-Users-I574426-dev-personal-SpecDriven-specdriven-app--claude-worktrees-specs-tests-recent-prs-d4e8ce/acf18d64-5534-49b5-b00f-9e8bfa61ad1e/scratchpad/probe.ts` … `probe5.ts`
(session scratchpad; copy them into `tests/` if any become regression tests).

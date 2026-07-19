# Navigation

We want to have a unique url for each Feature and each scenario, to enable
deep linking and navigation from outside the app as well as sharing the links
via chat and email.

## URL scheme

| URL                                             | Meaning                                    |
| ----------------------------------------------- | ------------------------------------------ |
| `/`                                             | Home — no feature selected                 |
| `/features/<feature>`                           | Feature page for `<feature>.feature.md`    |
| `/features/<feature>/scenarios/<scenario>`      | Latest version of that scenario            |
| `/features/<feature>/scenarios/<scenario>/v<N>` | Exactly version N — a permalink            |

Identity comes from the data repo, never from session state:

- `<feature>` is the feature file path minus `.feature.md`, and spans several
  url segments when the feature lives in a folder (specs/folders.spec.md):
  `/features/billing/quotes` is `billing/quotes.feature.md`.
  File stems are already slugified and unique within their folder, so the
  mapping is bijective. The first `scenarios` segment with a following slug
  separates the feature path from the scenario ref, so a folder literally
  named `scenarios` is not addressable by deep link.
- Moving a feature to another folder changes its urls — folder placement is
  part of the path identity. A link to the old path reports "not found" like
  any stale link.
- `<scenario>` is `slugify(scenario name)` — the same slugify used for file
  stems. Scenario identity is (name, version), the same identity publish
  immutability keys on; list position is unstable across syncs and must never
  appear in a url.
- Because published scenarios are immutable, a versioned scenario url is a
  permalink that cannot rot. A url resolves to the same content on any
  instance pointed at the same data repo, so links can be shared via chat and
  email. This is the spec-ref identity `<file>#<name> vN` in url form.

## Resolution rules

- A versionless scenario url resolves to the highest version of that name.
- Segments after the scenario version are ignored, and a bare trailing
  `/scenarios` is dropped (chat and email clients often mangle link tails).
  Other unrecognized segments read as folder path — they resolve to "feature
  not found" rather than being silently truncated. A path that doesn't start
  with a known shape is home. A `<feature>` stem that already carries a
  `.feature.md` or legacy `.feature` suffix is accepted.
- If several scenario names slugify identically, the first match in file
  order wins.
- After resolution the address bar shows the canonical url of what is
  actually selected: the feature url, or the versioned scenario url.
- The server serves the app shell for every `/features/...` path; resolution
  happens in the client via `/api/features/:file`.

## Scenario: open a feature link

- Given: the data repo contains `navigation.feature.md`
- When: the user opens `/features/navigation`
- Then: the app shows that feature — same view as clicking it in the sidebar

## Scenario: open a scenario link

- Given: `navigation.feature.md` contains scenario "ESC key closes the dialog" v2
- When: the user opens `/features/navigation/scenarios/esc-key-closes-the-dialog/v2`
- Then: the feature opens with that scenario card selected, highlighted, and
  scrolled into view — the same highlight the up/down keys move, so Enter
  opens the full body

## Scenario: versionless scenario link opens the latest version

- Given: the scenario name exists as v1 and v2
- When: the user opens the scenario url without the `/v<N>` segment
- Then: v2 is selected, and the address bar shows the canonical `/v2` url

## Scenario: link to a missing feature

- When: the user opens `/features/<something>` that doesn't resolve to a file
- Then: the app shows home with a note that the feature was not found and the
  link may be stale

## Scenario: link to a missing scenario

- When: the feature resolves but the scenario slug (or version) doesn't
- Then: the feature opens with no selection and a note that the scenario was
  not found — it may have been renamed or deleted

## Scenario: browser history and reload

- Selecting a feature (sidebar click, create) pushes a history entry —
  back/forward walk through previously viewed features
- Moving the scenario selection with the up/down keys rewrites the url in
  place (no history entry per keystroke)
- Reloading the page restores the same feature and scenario selection

## Scenario: share a link

- Sidebar entries and scenario card titles are real links: right-click →
  Copy Link and cmd-click → new tab work natively
- Every scenario card has a "Copy link" action that puts the absolute
  versioned url on the clipboard; its label flips to "Copied" for 2 sec
- The feature file name in the editor bar has the same "Copy link" action for
  the feature url

## Scenario: window title follows the selection

- `SpecDriven` on home, `SpecDriven — <feature name>` on a feature,
  `SpecDriven — <feature name> · <scenario name> v<N>` with a selection —
  chat and email link previews show the title

## Scenario: deep link before a data repo is configured

- Given: `.specdriven` has no data repo recorded
- When: the user opens a deep link
- Then: the repo prompt shows first (specs/app-start.spec.md); once a repo is
  accepted, the deep link is honored

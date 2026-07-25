# Search

Full-text search over every spec in the data repo, so a growing tree of
feature files stays navigable: any word in a feature description, scenario
name, or scenario body finds its spec in a couple of keystrokes.

## Search field

- A search field sits at the top of the sidebar, directly under the app
  header, with a magnifier icon on its left — the first thing in the
  top-left of the UI, styled with the design-system tokens.
- Placeholder: `Search specs`. While the field has text, a `✕` clear
  button shows inside the field on the right.
- `/` and Cmd/Ctrl+F focus the field from anywhere in the app, except
  while a dialog is open or the user is typing in another field.

## Results

- While the query is non-empty, the sidebar's folder tree is replaced by a
  ranked results list; clearing the query (or pressing Escape in the field)
  restores the tree exactly as it was.
- Matching is indexed full-text over feature names, feature descriptions,
  scenario names, and scenario bodies (the `### Tests` table is not
  indexed). Prefix matches and small typos still hit; matches in names
  rank above matches in bodies. Each scenario version is its own result.
- A result row shows the feature name — plus `› <scenario name> v<N>` for
  scenario hits — and a short snippet around the first match, with the
  matched words highlighted.
- Results are fetched as the user types (debounced); a stale response
  never overwrites a newer query's results.
- The list serves at most a handful of screens of results (default 20,
  capped at 50) — ranking, not scrolling, is the tool.

## Scenario: a body match is found with a snippet

- Given: some scenario body in the data repo contains the word "premium"
  and no scenario or feature name contains it
- When: the user types `premium` into the search field
- Then: the sidebar shows a result row for that scenario — feature name,
  `› <scenario> v<N>` crumb, and a snippet containing "premium"
  highlighted

## Scenario: name matches rank above body matches

- Given: a scenario named "Premium rules" and another scenario that only
  mentions "premium" in its body
- When: the user searches `premium`
- Then: both are listed and the scenario named "Premium rules" ranks first

## Scenario: prefix and fuzzy matches hit

- Given: specs containing the word "premium"
- When: the user searches `prem`, or the typo `premum`
- Then: the "premium" specs are found either way

## Scenario: clicking a result opens it like its deep link

- Given: a scenario hit for `quotes.feature.md` scenario "Basic quote" v2
- When: the user clicks the result (or moves the highlight with ↑/↓ and
  presses Enter)
- Then: the feature opens with that scenario card selected, highlighted,
  and scrolled into view, and the address bar shows
  `/features/quotes/scenarios/basic-quote/v2` — exactly as if the deep
  link had been opened (specs/navigation.spec.md). The query is kept so
  other results can be visited.

## Scenario: Escape or ✕ restores the tree

- Given: an active query with results showing
- When: the user presses Escape in the field, or clicks the `✕` button
- Then: the query clears and the sidebar shows the folder tree again

## Scenario: no matches

- When: the user searches a word that appears nowhere
- Then: the sidebar shows `No matches for "<query>"` instead of results

## Scenario: the index follows external file changes

- Given: a search for "premium" returns results
- When: a spec file is changed, added, or deleted outside the app (editor,
  `git pull`, the reload cron) and the user searches again
- Then: the results reflect the new content — new text is found, text
  that no longer exists is not

## Scenario: search before a data repo is configured

- Given: the settings file has no data repo recorded
- Then: the repo prompt shows first (specs/app-start.spec.md); the search
  field only exists alongside the sidebar tree once a repo is accepted

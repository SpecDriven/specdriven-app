# SpecDriven UI/UX proposal — toward a Linear-grade desktop app

## Context

SpecDriven is an Electron + Bun desktop app for spec-driven development. The
frontend is a single 5,023-line `App()` component (`src/frontend/App.tsx`), one
2,758-line stylesheet (`src/frontend/index.css`), no component library, no
router, no icon set. It works, but it reads as a web page rather than a
desktop tool: text-link actions ("Edit", "Copy link", "Publish") strung across
a header, unicode glyphs for icons, status shown only as text badges on cards,
a sidebar search that swaps the tree out, 45 `setStatus()` call sites that all
land in one undifferentiated `<p class="status">`, and hover-only row menus
that keyboard users cannot reach.

The user asked for proposals modeled on the Linear desktop app and chose:
**shift the visual language toward Linear's look**, **proposal only this
session** (no code), with all four focus areas in scope: command palette +
keyboard, page header + property chips, status glyphs + sidebar, feedback +
accessibility.

Linear's conventions confirmed from public docs: `⌘K` command menu with every
action by name; `C` creates an issue from anywhere; `[` collapses/expands the
sidebar; `?` opens the shortcuts help; `G` then a key for "go to" chords.
(Sources: [Linear collapsible sidebar changelog](https://linear.app/changelog/unpublished-collapsible-sidebar),
[Linear keyboard shortcuts help changelog](https://linear.app/changelog/2021-03-25-keyboard-shortcuts-help),
[fastshortcuts Linear cheat sheet](https://fastshortcuts.com/shortcuts/linear/),
[shortcut.fyi Linear](https://shortcut.fyi/linear-shortcuts).)

Constraint to respect: `specs/ui/ui.feature.md` "Design system" currently
specifies the warm terracotta/serif look. Shifting the look means that spec
section must change too. Per project rules the spec repo is never edited from
a session, so the proposal includes the replacement text for the user to apply.

## Design principles (what "Linear-like" means here)

1. **Keyboard is the primary input.** Every action reachable via `⌘K`; single-key
   shortcuts for the top ten; every tooltip and menu item shows its key.
2. **Quiet chrome, dense content.** 13px UI text, 1px low-contrast borders,
   6px radii, no drop shadows on panes, shadows only on popovers/dialogs.
3. **Status is a glyph, not a word.** One icon vocabulary for draft / proposed /
   published, used identically in tree, cards, editor, palette, and filters.
4. **Properties are chips.** Assignee, ticket, status are pill buttons opening a
   searchable popover, never a native `<select>` or a text link.
5. **Feedback is non-blocking and reversible.** Toasts with Undo, never a status
   line that lingers under the wrong view.
6. **One implementation per pattern.** One Menu, one Popover, one Tooltip, one
   Toast, one shortcut dispatcher, one Icon component. Today there are three
   hand-rolled menus and ten `keydown` listeners.

## Proposals

Ordered by value. Each names the current code it replaces.

### 1. Command palette (`⌘K`) — replaces sidebar search-as-tree-swap

- **What:** centered overlay, 560px wide, input on top, grouped results below:
  *Features*, *Scenarios* (with parent feature), *Roadmap pages*, *Actions*.
  Typing filters all groups; `↑↓` moves, `Enter` opens, `⌘Enter` opens in the
  editor pane, `Esc` closes. Recent items shown when empty.
- **Actions in the palette:** New feature, New folder, New scenario (on a
  feature page), Publish scenario / Publish all, Propose, New version, Copy
  link, Rename, Move to folder…, Delete, Sync now, Start code-gen session,
  Toggle sidebar, Theme: light / dark / system, Open settings, Change data
  repo, Open README, Open roadmap page…
- **Reuse:** `/api/search` + MiniSearch already ranks name > body and returns
  snippets (`App.tsx:1032-1063`); `useFocusTrap.ts` for the overlay;
  `markSnippet` for highlighting; `route.ts` builders for navigation.
- **Sidebar search field stays** as a secondary entry point but opens the
  palette prefilled (Linear's sidebar search icon does the same). The
  results-replace-tree behavior in `App.tsx:3578-3612` goes away.
- **A11y:** input `role="combobox"` with `aria-expanded`, `aria-controls`,
  `aria-activedescendant`; list `role="listbox"`; groups as `role="group"`
  with `aria-label`. Fixes the incomplete combobox pattern at `App.tsx:3460`.

### 2. Unified keyboard model — replaces ~10 ad-hoc `keydown` listeners

- **Dispatcher:** one `useShortcuts()` hook with a scope stack
  (`global` → `page` → `dialog` → `field`). Replaces the hand-maintained
  `escapeOwnedElsewhere` flag at `App.tsx:882` and the listeners at
  `762, 863, 891, 905, 940, 962, 987, 1003, 1068, 3710`.
- **Bindings (Linear-style):**

  | Key | Action |
  |---|---|
  | `⌘K` | Command palette |
  | `/` or `⌘F` | Palette prefilled for search (kept) |
  | `C` | New scenario on feature page; New feature elsewhere |
  | `[` | Toggle sidebar |
  | `?` | Shortcut cheat sheet |
  | `J` / `K`, `↑` / `↓` | Move selection in tree, cards, palette, menus |
  | `Enter` / `O` | Open selected |
  | `E` | Edit selected scenario |
  | `⌘⏎` | Publish (editor) / Propose if draft |
  | `⌘⇧C` | Copy link to current item |
  | `G` then `H` / `R` / `S` | Go to Home (README) / Roadmap / Settings |
  | `⌘,` | Settings |
  | `⌘⇧L` | Cycle theme |
  | `Esc` | Close top of stack (dialog → menu → editor → deselect) |

- **Cheat sheet:** `?` opens a two-column dialog listing bindings by scope,
  rendered from the same registry the dispatcher uses, so it cannot drift.
- **Hints:** every tooltip and menu item renders `<kbd>` from the registry.

### 3. Page header with breadcrumbs and an action bar — replaces `editor-bar`

- **Current:** `<h2>Feature: name</h2>` followed by text links Edit · Copy link ·
  ticket · Edit description · Assigned `<select>`, then "Publish All" far right
  (`App.tsx:3964-4099`). Scenario editor has a back chevron and its own set.
- **Proposed:** a 40px header row, sticky, border-bottom:
  - Left: breadcrumb `repo-name › folder › Feature name` (each segment a real
    link; the last segment is inline-editable on click, replacing the
    rename form at `App.tsx:4051-4080`). In the scenario editor the trail
    extends `… › Scenario name` and the back chevron goes.
  - Right: icon buttons with tooltips — Copy link, Edit description, ⋯ (more:
    Rename, Move, Delete, Start code-gen) — and one primary button
    (`Publish all` / `Publish` / `Propose`, context-dependent). The `*` suffix
    on "Publish All *" becomes a small dot badge on the button.
  - Second row (properties): chips per §4.
- **Cards:** the four text links per card (`App.tsx:4213-4239`) collapse to a
  status glyph + title + version + a `⋯` menu shown on hover *and* focus-within
  (mirrored as a right-click context menu). Primary card action on hover:
  `Edit`.

### 4. Property chips with popover menus — replaces `<select>` and text links

- **Chips:** `● Status`, `◯ Assignee`, `⌗ Ticket`, `v3`. 24px tall, 12.5px text,
  1px border, icon + label; hover shows `--hover`; click opens a popover
  anchored below.
- **Popover:** searchable list, `↑↓ Enter Esc`, checkmark on current, each row
  optionally with a `<kbd>` hint. Assignee rows show a 16px avatar/initials
  (reuse the `user-corner` initials logic).
- **Reuse:** `assignableMembers()`, `saveAssigned()` (`App.tsx:4030-4047`),
  `ExternalLinkField.tsx` moves inside the Ticket popover, `externallinks.ts`
  unchanged.
- **One `Menu` component** backs chip popovers, the tree `⋯` menu
  (`App.tsx:3167-3218`), the repo-recent menu (`3392`), the user menu (`3646`),
  and right-click context menus. It handles outside-click, `Esc`, typeahead,
  `Home/End`, `role="menu"/"menuitem"`, and focus return. Deletes the three
  per-menu effects at `App.tsx:933-998`.

### 5. Status glyph system — replaces text badges

- **Vocabulary (16px inline SVG, `currentColor` + one status color token):**
  - **draft** — dashed circle, `--status-draft` (grey)
  - **proposed** — circle with a half fill, `--status-proposed` (amber)
  - **published** — filled circle with check, `--status-published` (green)
  - **new version pending** — published glyph with a small "+" corner mark
- **Where:** sidebar tree rows (feature shows a rollup: e.g. 3/5 published as a
  tiny ring gauge like Linear's project progress), scenario cards, editor
  header chip, palette rows, filter chips, roadmap entries (page icon).
- **Replaces** `.badge`, `.badge.proposed`, `.badge.draft` in cards
  (`App.tsx:4186-4190`) and the editor status badge (`3766-3808`); the
  parchment "sealed" wash (`--pub-bg/--pub-border`) is dropped in favor of the
  glyph plus a subtle left-edge status color on the card.

### 6. Sidebar: collapse, hierarchy, filters, keyboard tree

- **Collapse** with `[` and a header icon; collapsed state keeps a 44px rail
  with the logo, `⌘K`, and a hover-to-peek flyout. Persist in `localStorage`
  beside `sd-sidebar-width`.
- **Sections** in Linear order: workspace switcher (repo name + recent menu),
  primary nav (`Home`, `Roadmap`, `My specs` = features assigned to me),
  then `Features` tree. Section headers 11px uppercase `--text-3`, collapsible.
- **Filter row** above the tree: `Filter ▾` chip that adds chips for status
  (any/draft/proposed/published) and assignee. Filtering greys out
  non-matching tree rows and hides non-matching cards on the feature page.
  New; there is no filtering today.
- **Tree semantics:** `role="tree"` / `treeitem` / `aria-level` /
  `aria-expanded`; `↑↓` move, `←→` collapse/expand, `Enter` open, `⋯` menu
  reachable via `Shift+F10` or the menu key. Row actions get
  `.tree-row:focus-within` visibility (fixes `index.css:850-861, 889-902`).
- **Drag-and-drop** keeps working; add a 2px insertion line and a
  `--accent-soft` drop highlight on folders.

### 7. Feedback: toasts, skeletons, consistent errors

- **Toast system** (`useToasts()`): bottom-left stack, 3.5s auto-dismiss for
  success, sticky until dismissed for errors, optional `Undo` action with a
  5s window. `aria-live="polite"` region for success, `role="alert"` for
  errors. Replaces the `.saved-banner` (`App.tsx:3337`) and the 45
  `setStatus()` call sites: success ones become toasts, errors become error
  toasts, and "Saved" for README/roadmap/description autosave becomes a quiet
  header indicator (`Saved · 2s ago` / `Saving…` / `Unsaved`), not a toast.
- **Undo** wired to: delete scenario (draft), delete folder, move feature,
  unassign. Server side already has the inverse operations.
- **Skeletons** for feature page (header + 3 card outlines), palette results,
  roadmap page; `aria-busy` on the pane. Replaces the single full-page
  "Loading…" (`App.tsx:3284`).
- **Error boundary** around the main pane with a "Reload view" button.
- **Dialogs:** every dialog gets `role="dialog"` + `aria-modal="true"`; the
  code-gen session error dialog (`App.tsx:5003`) gets the focus trap and
  `Esc` like the others.

### 8. Roadmap polish

- Rename / delete via the same `⋯` menu (server: add `DELETE /api/roadmap/:file`,
  `removeRoadmapDoc` already exists in `src/server/automerge/store.ts`).
- Nested pages grouped by folder with indentation (`listRoadmap` already
  returns the path; the sidebar prints only `page.name` at `App.tsx:3570`).
- Roadmap pane gets the same breadcrumb header and Saved indicator.

### 9. Icons and tooltips

- **Icon set:** vendor Lucide as inline SVG components (npm, bundled, offline
  — same constraint as fonts). Replace all unicode glyphs
  (`✎ ✕ ▸ ▾ ⋯ ⚙ ✓ ❝ • 🔗 🖼 ▶ ›`) and the four hand-drawn icon files.
- **Tooltip** component: 350ms delay, 12px text, `<kbd>` suffix, follows
  `aria-describedby`; used on every icon button.

## Visual token retune (Linear direction)

Replace the token block at `index.css:1-113`. Keep the three-way theme
mechanism, but generate the dark block from one source (a `@layer tokens`
with a single dark ruleset applied via `:root[data-theme="dark"], @media
(prefers-color-scheme: dark) :root:not([data-theme="light"])`) to end the
duplicated-block drift noted in the CSS comment.

| Token | Light | Dark |
|---|---|---|
| `--surface-0` (canvas) | `#ffffff` | `#191a1c` |
| `--surface-1` (sidebar) | `#f7f8f8` | `#1f2023` |
| `--surface-2` (cards/popovers) | `#ffffff` | `#232427` |
| `--hover` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.05)` |
| `--border` | `#e6e7e9` | `rgba(255,255,255,.08)` |
| `--border-strong` | `#d3d5d8` | `rgba(255,255,255,.14)` |
| `--text-1` | `#282a30` | `#e6e6e8` |
| `--text-2` | `#6b6f76` | `#9a9da3` |
| `--text-3` | `#9a9ea6` | `#6b6f76` |
| `--accent` | `#5e6ad2` | `#6e79e6` |
| `--accent-soft` | `rgba(94,106,210,.12)` | `rgba(110,121,230,.18)` |
| `--status-draft` | `#8a8f98` | `#7c8088` |
| `--status-proposed` | `#e0a03c` | `#f2b64a` |
| `--status-published` | `#3fa56b` | `#4cc283` |
| `--danger-fg` | `#d0473f` | `#f16b62` |
| `--radius-sm/md/lg` | `4px / 6px / 8px` | same |

- **Type:** Inter for everything, base `13px`, line-height 1.45; titles 15px/600
  (page), 13px/500 (cards); serif display faces removed. JetBrains Mono stays
  for code. Remove `@fontsource-variable/source-serif-4`.
- **Spacing:** 4px grid; tree rows 28px; card padding 12px 14px; header 40px.
- **Elevation:** no shadows on panes; `--shadow-md` on popovers, `--shadow-lg`
  on dialogs; dialog backdrop `rgba(0,0,0,.4)` with 2px blur.
- **Focus:** 2px `--accent` ring, offset 1px, on `:focus-visible` only (kept).

### Spec change to apply (user applies; not edited from a session)

Replace the "Design system" section of `specs/ui/ui.feature.md` (lines
171-187) with:

> Quiet, dense, keyboard-first, Linear-like. All colors flow through CSS
> tokens in `src/frontend/index.css`; components never hardcode a color.
> Surfaces: white canvas, faint-grey sidebar (light); near-black equivalents
> (dark). Accent: indigo, used for primary buttons, focus rings, and the
> active row. Status has its own three colors (draft grey, proposed amber,
> published green) shown as glyphs, never as text badges. Type: Inter for all
> UI text at 13px; JetBrains Mono for code and file names; fonts ship with
> the app. Borders are 1px low-contrast; radii 4-8px; shadows only on
> popovers and dialogs. Focus is always visible. Every action is available
> from the ⌘K command menu, and every menu item and tooltip shows its shortcut.

Also mark the stale "Draft checkbox" rule (`ui.feature.md:112-119`) as
superseded by Propose/Publish buttons, which is what the code does.

## Phased backlog (for later sessions)

| Phase | Items | Notes |
|---|---|---|
| 1 | Tokens + type retune (§ Visual), Icon set + Tooltip (§9), Status glyphs (§5), `focus-within` row actions, dialog `aria-modal` + session-error fixes | Mostly CSS; lowest risk; makes everything after it look right |
| 2 | Shortcut dispatcher + cheat sheet (§2), Menu/Popover component (§4), Toast system + Saved indicator (§7) | Foundations the rest depend on |
| 3 | Command palette (§1), Page header + breadcrumbs + chips (§3) | Biggest visible change |
| 4 | Sidebar collapse, sections, filters, tree semantics (§6), Roadmap polish (§8), skeletons + error boundary (§7) | |

Each phase should also extract its views from `App.tsx` into components
(`Sidebar`, `FeaturePage`, `ScenarioEditor`, `RoadmapPage`, `dialogs/*`) —
the 5,023-line file is the main practical obstacle to all of the above.

## Deliverable for this session

After approval:

1. Publish this proposal as a designed artifact page with inline SVG mockups
   of: the sidebar (expanded + collapsed rail), the feature page header with
   breadcrumbs and chips, a scenario card with status glyph and `⋯` menu, the
   `⌘K` palette, the toast stack, and a before/after token swatch strip.
   Load the `artifact-design` and `artifact-diagramming` skills first.
2. No source or spec edits.

## Verification

- Proposal only: verify the artifact renders in light and dark, mockups are
  legible at 900px width, and every §-reference points at a line that exists
  in the current `App.tsx` / `index.css` (spot-check the ones cited above).
- For later implementation phases: run `specdriven-demo` (`DEMO_MODE=1`, no
  git push, safe) via preview_start, screenshot each view in both themes,
  tab through the tree and a dialog, and run `bun test`.

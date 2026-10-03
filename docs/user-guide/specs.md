# Features and specs

How to write, organise and publish specifications in the SpecDriven app. This
guide covers the **Specs** tab: folders, features, scenarios, the draft →
proposed → published lifecycle, saving and syncing, links to tests and
tickets, and sharing. The companion guide, [AI sessions](ai-sessions.md),
covers handing specs to a coding agent.

The file format itself is specified in the
[`.feature.md` grammar](../../user-agent-skills/convert-specs-to-specdriven/references/grammar.md);
this guide describes what you see and do in the app. Where they overlap, the
grammar wins.

## Contents

1. [What is a spec](#1-what-a-spec-is)
2. [The Specs tab](#2-the-specs-tab)
3. [A feature page](#3-a-feature-page)
4. [Scenario cards](#4-scenario-cards)
5. [The scenario editor](#5-the-scenario-editor)
6. [Lifecycle: draft, proposed, published](#6-lifecycle-draft-proposed-published)
7. [Saving and syncing](#7-saving-and-syncing)
8. [Links and sharing](#8-links-and-sharing)
9. [Settings that affect the Specs tab](#9-settings-that-affect-the-specs-tab)
10. [Keyboard shortcuts](#10-keyboard-shortcuts)
11. [Glossary](#11-glossary)

## 1. What is a spec

Everything the app shows lives in one **data folder**: an ordinary git
repository of markdown files. The app commits and pushes what you write and
periodically pulls what others wrote, so the folder can be shared through
GitHub like any other repository, read on GitHub as plain markdown, and
edited by hand or by an AI agent without going through the app at all.

The data folder's `README.md` is the app's home page. It is editable in
place; the first time you open a folder with no README the page invites you
to write one.

Inside the folder:

- A **feature** is one file, `<slug>.feature.md`, in any folder. It has a
  name (the `# <name>` heading, independent of the file name), an optional
  description in free markdown, an optional ticket link, an optional
  assignee, and a list of scenarios.
- A **scenario** is one `## <name> @v<N> [status]` heading plus the markdown
  body under it. Scenarios are **atomic, immutable once published, and
  versioned**: a published scenario never changes, and a change in behaviour
  ships as a new version of the same name.

The app uses the word **spec** loosely: on a scenario card and in the editor
it means one scenario ("Delete Published Spec"); on the sidebar and in the AI
session dialog it can mean a whole feature file ("Select a spec here"). This
guide says *feature* and *scenario* throughout.

A minimal feature file, as the app writes it:

```markdown
# Collect premium

Automatic payment collection for policies on autopay.

## Failed autopay starts the grace period @v1 [published]

Given a policy on autopay whose card is declined
When the collection job runs
Then the policy enters a 30-day grace period
[test: failedAutopayStartsGracePeriod : https://github.com/acme/billing/blob/main/src/test/CollectionTest.java#L42 ]
```

## 2. The Specs tab

The sidebar lists the data folder as a tree. When other modules are switched
on in Settings the sidebar gains tabs (**Specs**, **Roadmap**, **Tasks**,
**Issues**, **Tests**); with only the Specs module on there is no tab bar.

Above the tree:

- The **data folder name** links to the home page. Next to it, **Recent data
  folders** switches between folders you have opened, and **Change data
  directory** points the app at another folder or a GitHub url.
- **Sync** pulls the data folder, absorbs any edits made outside the app,
  commits what you have saved and pushes. It reads `Syncing…` while it runs.
  See [Saving and syncing](#7-saving-and-syncing).
- **Search or run a command…** (`⌘K`, or `/`) opens the command palette. It
  searches feature names, descriptions, scenario names and bodies (prefix and
  fuzzy matches, names ranked above bodies) and lists every command the app
  offers. Choosing a search result opens the feature or scenario.
- The **Features** heading above the tree carries the tree's actions as
  icons, after the **Filter** chip. Hover over one to see its name.
  - **New folder** (a folder with a +) creates a folder inside the selected
    folder. A name with `/` in it nests: `billing/renewals`.
  - **New feature** (a page with a +, shortcut `c`) creates a feature file.
    Type `folder/name` to create it inside a folder. The new feature opens
    with its description editor ready.
  - **Start session** (a play button with a spark) and the **Selected:** line
    under the heading belong to [AI sessions](ai-sessions.md). While specs
    are checked, the button is highlighted and shows how many.

  With a folder selected, the New folder and New feature tooltips name the
  folder the new item goes into.

The tree:

- **Folders** open and close with the disclosure triangle. Clicking a folder
  selects it, which is where **New folder** and **New feature** create things;
  `Esc` deselects. A folder's ✕ deletes it, and only an empty folder can be
  deleted.
- **Features** show a publish ring: a filled arc for the share of scenarios
  that are published, with `<n> of <m> published` as its tooltip. Drag a
  feature onto a folder to move it; the file is moved with `git mv` and
  committed.
- A feature's **⋯ menu** offers **File › Rename** (the file name, not the
  heading) and **Delete**. Both ask for confirmation; a delete is committed
  and pushed.
- The **Filter** chip narrows the tree by **Status** (Any status, Draft,
  Proposed, Published) and, when assignments are on, by **Assignee**. Active
  filters show as chips on a row under the heading, and you can clear them one
  by one. On a feature page the same filter hides scenario cards that do not
  match, and the page says so.

An empty data folder shows `No feature files yet`.

## 3. A feature page

Click a feature in the tree to open it. Across the top:

- **Breadcrumbs** run from the data folder through the folders to the feature
  name. Click the name to edit the `# <name>` heading in place (**Save** or
  **Cancel**). Renaming the heading does not rename the file.
- The **save indicator** reads `Saving…`, `Unsaved`, `Saved`, then
  `Saved · 12s ago` and `Saved · 3m ago` as time passes.
- **Copy link** (`⌘⇧C`) copies the page's url and flips to `Copied` for a
  moment.
- The pencil toggles between **Add description** / **Edit description** and
  **Done editing the description**.
- **More actions** (⋯): **Rename feature** (the heading), **Rename file**,
  **Move to folder…** (type a path such as `billing/renewals`; `/` nests),
  **Start AI Session**, and **Delete feature**.
- **Publish all** publishes every unpublished scenario of the feature in one
  step and reads `Publishing…` while it runs. A dot on the button means the
  feature has unpublished changes.

Under the header, chips summarise the feature:

- `<n> / <m> published`.
- The **assignee** chip (`Unassigned` or a member's name) appears when
  **Assign features to project members** is on. Members are the names listed
  in the data folder's `project-settings.json`; the assignment is written
  into the file as an `**Assigned:** <name>` line.
- The **ticket** chip (`Link ticket`, or `Jira:ABC-123` once linked) opens a
  small form with the tracking tool, id and url, plus **Remove link**. The
  link is written into the file as a markdown link when **Publish external
  links** is on.

The **description** is free markdown. Click it to edit; it is saved
automatically, and **Done** shows it rendered again.

## 4. Scenario cards

Scenarios are listed below the description, ordered by name and then version.
Each card shows:

- A **status glyph**: a dashed circle for a draft, a half-filled circle for a
  proposed scenario, a filled circle with a check for a published one.
  Published cards are also shaded differently.
- The **title**, which is a real link to the scenario's versioned permalink,
  followed by `v<N>` and, when linked, the ticket.
- The first few lines of the body, rendered. The number of lines is the
  **Scenario preview lines** setting.
- An **Automated tests** table of links, when the scenario has any and
  **Show links to automated tests** is on.
- **Edit** (`e`) and **More actions** (⋯). The menu offers **Edit**, then
  **Publish** for an unpublished scenario or **New version** for a published
  one, then **Copy link**. Right-clicking a card opens the same menu.

A single click highlights a card; a double click, `Enter`, `e` or `o` opens
it in the editor; `j`/`↓` and `k`/`↑` move the highlight. **+ Add Scenario**
at the bottom of the list creates a new draft and opens it.

With nothing to show the page says `No scenarios yet.`, or explains that the
sidebar filter is hiding the rest.

## 5. The scenario editor

Opening a scenario replaces the feature page with the editor pane. The
sidebar stays, the url changes to the scenario's own, and the window title
follows (`SpecDriven — <feature> · <scenario> v<N>`).

At the top:

- Breadcrumbs back to the feature. `<` or `Esc` saves and returns, and the
  card you came from stays highlighted.
- The **title**, editable unless the scenario is published.
- **Version v<N>**, assigned by the app and never editable. A new scenario
  takes one past the highest version of the same name.
- A **status badge**: `draft`, `proposed` or `published`.
- On the right, the save indicator and the actions: **Delete**, set apart
  from **Propose** (drafts only) and **Publish**.

Below, in one scrolling column:

- **Body**: a markdown editor with **Write** and **Preview** tabs. `⌘B`,
  `⌘I` and `⌘K` insert bold, italic and a link. Paste an image or pick one
  with the image button; it is stored under the data folder's `.images/` and
  referenced from the body. Images are limited to 10 MB. A pasted screenshot
  shows at its full pixel size: in **Preview**, drag the handle at an image's
  bottom-right corner to size it (the arrow keys nudge it once the handle has
  focus), and double-click the handle for the natural size. The width is
  kept in the body as `<img src="…" alt="…" width="…">`, which any markdown
  viewer honours. With **Vim mode** on, a **Vim** tab appears as well.
- **Entity fields**: when the project names a code repo (`code-repo` in
  `project-settings.json`), type `@` and press `Tab` to pick a field of
  one of its data entities — `@firstName`, or `@User.firstName` when two
  entities share the name. Keep typing to narrow the list, `↑`/`↓` to move,
  `Enter` or `Tab` to insert, `Esc` to close; any other `Tab` moves focus on
  as usual. Fields are read from plain Java classes and records (test
  folders are skipped) and from SAP CDS entities, projections included. In
  the **Vim** tab the same works in insert mode.
- **Scenario table**: a grid over the last markdown table in the body. Add
  and remove columns and rows here rather than editing the table by hand;
  writing `{name}` in the body creates a column of that name. **+ Add
  table** appears when the body has none.
- **Ticket link**: the tracking tool (GitHub, Jira, Linear or Other), id and
  url.
- **Automated tests**: one row per test that automates the scenario. Each
  row has ✎ to edit in place and ✕ to remove. To add one, paste a GitHub url
  that names a line (`…/QuoteTest.java#L32`) and press **Add**; the app reads
  the test function declared at that line from GitHub and stores its name,
  so the link reads `quotesAHomeownersPolicy` rather than a bare url. Java,
  Kotlin, TypeScript, JavaScript, Python and Go are recognised. A url left
  in the add field is folded into the next save.

A **published** scenario opens read-only: the title is fixed, the body is
shown as source, the scenario table is hidden, and there is no save button,
because nothing about a published scenario can change. Its ticket link and
automated tests remain editable and are saved automatically, so developers
can attach tests to a scenario long after it was published.

**Delete** asks for confirmation. Deleting a draft or a proposed scenario
removes it and commits. Deleting a published scenario is only offered when
**Allow deleting published specs** is on in Settings, and warns with
`Danger Zone!` before it goes ahead.

## 6. Lifecycle: draft, proposed, published

A scenario's status only ever moves forward.

| Status | In the file | Meaning |
| --- | --- | --- |
| **draft** | not written | Work in progress. Drafts live only in the app's own store; the `.feature.md` file does not carry them, so a draft is invisible to anyone reading the folder on GitHub. |
| **proposed** | `[proposed]` | Saved into the file and open for review. Still editable, including its title and body. |
| **published** | `[published]` | Final. The title and body can never change. To change behaviour, create a new version of the same name. |

- **Propose** moves a draft into the file as `[proposed]`.
- **Publish** marks a scenario `[published]`, commits and pushes. `⌘Enter`
  publishes from the editor, or runs **Publish all** on a feature page.
- **New version** on a published card creates `<same name> @v<N+1>` as a
  fresh draft, prefilled with the published body. Both versions stay in the
  file; a link without a version number opens the highest one.

Publishing is the one step that touches the shared repository directly, so
it is where two people's work can collide. If someone else published the
same file first and git cannot merge the two, the **merge conflict** dialog
shows **Yours** and **Theirs** side by side with a **Manual edit** pane.
Choose **Accept yours**, **Accept theirs**, or edit the merged text and
**Publish manual edit**. Ordinary concurrent edits, two people typing in the
same scenario at once, merge on their own and never raise the dialog.

## 7. Saving and syncing

**Autosave** is always on. Whatever is open in an editor is written to the
data folder every few seconds (the **Autosave interval** setting; minimum 3,
default 6). Autosave writes locally only. It never publishes, and it never
changes a scenario's status. The save indicator in the header shows where
things stand; `Unsaved` means the latest keystrokes have not been written
yet.

**Sync** is one round trip with the remote: pull, absorb any changes made to
the files outside the app, commit what has been saved, push. **Autosync**
runs it on an interval (the **Autosync frequency** setting); with Autosync
off the folder is only pulled and pushed when you publish, or when you press
**Sync** yourself.

Editing the files outside the app is supported. Change a `.feature.md` in
your editor, accept a pull request against the data repository, or let an
agent write scenarios straight into the folder; the next sync notices the
difference and takes the change in. Two rules to keep in mind when writing
files by hand:

- Give every scenario an explicit `[proposed]` chip. A heading with no chip
  is read as a draft, and drafts are not kept in the file.
- Never edit the body of a `[published]` scenario. If a published body is
  changed on disk, the app repairs it from its own record on the next sync.
  Add `## <same name> @v<N+1> [proposed]` instead.

A sync leaves an open editor alone; you can keep typing through it.

## 8. Links and sharing

Every page has a stable url:

| Page | Url |
| --- | --- |
| Home (the README) | `/` |
| A feature | `/features/<feature>` |
| The latest version of a scenario | `/features/<feature>/scenarios/<scenario>` |
| Exactly version N | `/features/<feature>/scenarios/<scenario>/v<N>` |

`<feature>` is the file path without `.feature.md`, folders included;
`<scenario>` is the scenario name in lower case with hyphens. **Copy link**
on a feature page, a card or the editor puts the url on the clipboard. In the
desktop app the link is a `specdriven://` url that names the spec folder
first, then the same path — `specdriven://specs-insurance/features/quotes`,
`specdriven://specs-insurance/tasks/<task>` — so a url pasted into a ticket
opens the app on that folder, switching to it when another one is open. The
folder is matched by name against the folders in your folder list; a link
without one opens in the folder that is open.

A url whose feature or scenario has been deleted opens the nearest page with
a note saying what was not found.

## 9. Settings that affect the Specs tab

Open Settings with `⌘,` or `g s`.

| Setting | Effect |
| --- | --- |
| **Appearance** | System, Light or Dark. `⌘⇧L` cycles it. |
| **Vim mode** | Adds a Vim tab to every markdown editor. Remembered per device. Hidden in the public demo, which keeps it off. |
| **Autosync** and **Autosync frequency (seconds)** | Whether and how often the data folder is pulled and pushed on its own. |
| **Autosave interval (seconds)** | How often open editors are written to disk. Minimum 3. |
| **Scenario preview lines** | How many body lines a scenario card shows. |
| **Show links to automated tests** | Shows or hides the Automated tests table on cards. Hiding never deletes the links. |
| **Project management** and **Project management tool** | Whether features and scenarios offer a ticket link, and which tracker it names. |
| **Publish external links** | Writes ticket links into the `.feature.md` file as markdown links. |
| **Assign features to project members** | Adds the assignee chip and the Assignee filter. Members come from `project-settings.json`. |
| **Allow deleting published specs** | Offers Delete on published scenarios, behind the Danger Zone confirmation. |
| **Git engine** | Which git the app drives: the GitHub CLI, the system `git`, or the built-in engine. |
| **GitHub account** | Sign in so that pushes and test-name lookups are authenticated. |

## 10. Keyboard shortcuts

Press `?` anywhere for the cheat sheet; it is generated from the same list
the app uses, so it is always current. The shortcuts that matter on the Specs
tab:

| Keys | Action |
| --- | --- |
| `⌘K`, `/` | Search specs and commands |
| `?` | Keyboard shortcuts |
| `g h` | Go to Home (README) |
| `⌘,`, `g s` | Settings |
| `⌘⇧L` | Cycle the theme |
| `[` | Collapse or expand the sidebar |
| `]` | Open or close the coding agent pane |
| `Esc` | Close, go back, or clear the selection |
| `c` | New feature, or New scenario on a feature page |
| `j`, `↓` / `k`, `↑` | Next / previous scenario |
| `Enter`, `e`, `o` | Open the selected scenario |
| `⌘Enter` | Publish all, Propose, or Publish, depending on where you are |
| `⌘⇧C` | Copy link to this page |
| `⌘B`, `⌘I`, `⌘K` | Bold, italic, insert a link (in a text editor) |
| `←`, `→` | Resize the sidebar (with the divider focused) |

On Windows and Linux `⌘` is `Ctrl`.

## 11. Glossary

- **Data folder** (data repo): the git repository holding the specs. Its
  `README.md` is the home page.
- **Feature**: one `<slug>.feature.md` file with a name, a description and
  scenarios.
- **Scenario** (spec): one `## <name> @v<N>` heading and its body. Atomic,
  versioned, immutable once published.
- **Version**: the `@v<N>` on a scenario. Assigned by the app; a new scenario
  with an existing name takes the next number.
- **Chip**: the `[proposed]` or `[published]` marker on a heading. Also the
  small pills in the UI (assignee, ticket, filter).
- **Draft / proposed / published**: the three statuses. See
  [section 6](#6-lifecycle-draft-proposed-published).
- **Propose**: move a draft into the file as `[proposed]`.
- **Publish**: mark a scenario `[published]`, commit and push. **Publish all**
  does it for a whole feature.
- **New version**: a fresh draft of a published scenario, under the same
  name and the next version number.
- **Autosave**: the periodic local write of whatever is open. Always on.
- **Sync**: pull, absorb outside edits, commit, push. **Autosync** does it on
  an interval.
- **Test link** (automated test): a GitHub url with a `#L<n>` anchor, stored
  with the test's name, that says which test automates a scenario.
- **Ticket link** (external link): the tracker issue behind a feature or a
  scenario, such as `Jira:ABC-123`.
- **Member / assignee**: a name from `project-settings.json` that a feature
  can be assigned to.
- **Publish ring**: the arc on a sidebar feature showing how many of its
  scenarios are published.

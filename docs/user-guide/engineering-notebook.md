# Engineering notebook

How to keep a shared, dated log of what your team notices about the way it
works and what it decides to do about it: writing entries, the two kinds,
superseding an earlier decision, and how entries reach your teammates.
Writing specifications is covered in [Features and specs](specs.md).

The notebook is the one module that is **on by default**. It writes nothing
to your data folder until you write your first entry, so a repository that
never uses it stays untouched.

## Contents

1. [What the notebook is for](#1-what-the-notebook-is-for)
2. [Writing an entry](#2-writing-an-entry)
3. [Observations and decisions](#3-observations-and-decisions)
4. [Superseding a decision](#4-superseding-a-decision)
5. [Sharing and syncing](#5-sharing-and-syncing)
6. [What an entry looks like on disk](#6-what-an-entry-looks-like-on-disk)
7. [The setting](#7-the-setting)

## 1. What the notebook is for

Three tabs hold three different kinds of writing:

- The **Roadmap** says where you want to go.
- **Tasks** say who does what next.
- The **Notebook** says what you learned on the way, and why the process
  looks the way it does.

An entry is written once, signed and dated, and stays as the record of what
you knew and chose at the time. It is not a chat and not a task list. Nobody
ticks an entry off.

Entries are worth writing when a pattern shows up more than once ("the drift
import bit us twice this week"), or when the team settles something that
would otherwise be re-argued in six months ("a spec change lands before the
code").

## 2. Writing an entry

Open the **Notebook** tab and press **+ New entry**, or run **New notebook
entry** from the command palette (⌘K). The dialog asks for a title and
whether the entry is an observation or a decision.

Today's date goes in front of the file name, so the folder reads in date
order on GitHub and the list sorts without opening anything. The entry is
committed and pushed straight away, then opens in the editor.

Entries are listed newest first, grouped by month, each row showing its kind,
who wrote it and the day. The notebook is flat: a `/` in a title is part of
the title, not a subfolder.

Two entries cannot share a title on the same day. The same title on another
day is a different entry.

Each row's ⋯ menu offers Rename, Copy link and Delete. Deleting pushes
immediately and cannot be undone, so the app asks first.

## 3. Observations and decisions

- An **observation** is something you noticed about the way you work. It
  opens empty.
- A **decision** is something you have decided to do about it. It opens with
  a Context / Decision / Consequences skeleton, which you are free to delete.

The kind is a chip at the top of the entry. Change it there rather than by
editing the `**Kind:**` line by hand; the app rewrites the line for you.

The author and date are set when the entry is created, from the identity that
signs your commits to the data repository. They are shown, not edited.

## 4. Superseding a decision

A decision can replace an earlier one. Open the newer decision and pick
**Supersedes…** in its header, then choose the decision it replaces. Only
earlier decisions are offered: an entry cannot supersede itself, and an
observation replaces nothing.

The earlier entry's text is never rewritten. The notebook adds to history
rather than editing it. What changes is presentation: the superseded entry
shows a **Superseded by** badge in its header and its row is muted in the
list, so a reader can tell at a glance which decision still stands.

Both are derived from the newer entry's link. Remove the link — in the app,
or by deleting the line on GitHub — and the badge goes with it on the next
sync.

## 5. Sharing and syncing

Entries live in your data repository, so everyone with access to it reads and
writes the same notebook. A teammate's entry appears in your Notebook tab
after your next sync, with its author and date intact.

Typing in an entry autosaves locally; the sync tick commits and pushes it,
the same as a roadmap page. When two people edit one entry at the same time
their edits merge rather than conflicting, and the metadata resolves to one
value each rather than a mix.

Turning the setting off does not stop the sync. You keep pulling your
teammates' entries; you just do not see the tab.

## 6. What an entry looks like on disk

`notebook/2026-09-12-a-spec-change-lands-before-the-code.md`:

```markdown
# A spec change lands before the code

**Author:** ada

**Date:** 2026-09-12

**Kind:** Decision

**Supersedes:** [Ship on Fridays](/notebook/2026-09-01-ship-on-fridays)

## Context

## Decision

## Consequences
```

The file is the interchange format, so a plain markdown file dropped into the
folder by hand is still an entry. With no metadata lines at all it takes its
date from the file name and reads as an observation. A `**Kind:**` line naming
something other than Observation or Decision is left in the body rather than
being swallowed.

## 7. The setting

**Settings → Engineering notebook** switches the tab on and off. It is on
unless you turn it off, and it is stored on this machine, so it does not
follow you to another device.

Turning it off hides the tab, closes an entry you have open, and stops the
app asking the server for entries. Your files stay exactly where they are;
turning it back on shows them again.

The `notebook/` folder is created by your first entry, not by the switch.
That is what makes it safe for the module to ship switched on.

# Opening a code repository

How to open a code repository directly, without a specifications folder:
the file tree, the plain editor, IntelliJ IDEA, the coding agent, and how
to get back to your specs. Specifications are covered in
[Features and specs](specs.md); the coding agent in
[AI sessions](ai-sessions.md).

## Contents

1. [When to use it](#1-when-to-use-it)
2. [Opening one](#2-opening-one)
3. [What changes](#3-what-changes)
4. [The Files tab and the editor](#4-the-files-tab-and-the-editor)
5. [Open in IntelliJ](#5-open-in-intellij)
6. [The coding agent](#6-the-coding-agent)
7. [Back to a specifications folder](#7-back-to-a-specifications-folder)

## 1. When to use it

The coding agent pane is useful without any specifications: point it at a
code repository and work with Claude, Codex or Pi there. In this mode the
app is a guest in your repository. It never pulls, commits or pushes, and
writes no file into the repository except the ones you save. Git is
entirely yours.

It is available in the desktop app and the local web app. The demo, the
hosted app and the read-only specs site do not offer it.

## 2. Opening one

- **First run:** where the app asks where your specs are, pick
  **A code repository**, then type the folder or use **Browse…**.
- **Later:** open the folder menu (the ▾ beside the folder name) and choose
  **Manage folders…**, then **Open a code repository…**. The command palette
  (⌘K) has **Open a code repository…** too.

The folder dialog keeps a **Code repositories** list beside your spec
folders, most recent first. Removing one only takes it off the list.

## 3. What changes

- The **Specs** tab and the specification modules' tabs (Roadmap, Tasks,
  Notebook, Issues, Tests) are hidden. The navigation pane shows the
  **Files** tab instead.
- **Sync** and **Sync now** are gone, and so is the
  Sync section in Settings. Nothing syncs.
- Plugins found in the repository's own `.specdriven/plugins` folder are not
  loaded. Plugins installed on your computer, such as the coding agents,
  still are.

## 4. The Files tab and the editor

The tree lists the repository's folders first, then its files. It leaves
out `.git` and whatever the repository's `.gitignore` files exclude, such
as `node_modules` and build output. Click a folder to open or close it; the
app remembers which folders you left open. **Refresh** lists them again,
and so does coming back to the window, since an agent or your IDE may have
added files.

Clicking a file opens it in a plain text editor with line numbers. Its url,
`/files/<path>`, opens it again. The home view opens the repository's
`README.md` when it has one.

- Edits save every few seconds, the autosave interval in Settings, and at
  once with ⌘S (Ctrl+S elsewhere). Leaving the file saves it too.
- The file's line endings are kept, Windows ones included.
- If the file changed on disk since you opened it, the app does not
  overwrite it. It says so and offers **Reload from disk** or **Save over
  it**. Coming back to the window re-reads a file that has no unsaved
  edits, so your IDE's changes show up.
- Binary files and files over 2 MB are not opened as text; the editor says
  why.

The editor is deliberately plain. Most developers will edit in their own
IDE, which is what the next button is for.

## 5. Open in IntelliJ

**Open in IntelliJ** in the editor's header opens the file in IntelliJ
IDEA, at the line the cursor is on. It works for binary and large files
too. It needs IntelliJ's `idea` launcher on your PATH. On a Mac, make it
once with:

```bash
ln -s "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea" /usr/local/bin/idea
```

Without it, the app shows that command instead of opening anything.

## 6. The coding agent

The coding agent pane works in the open repository. Its prompt does not
point the agent at any specifications folder. The **Worktree** option still
runs a session in a git worktree of its own; that is the one git command
made in your repository, and only when you tick it.

## 7. Back to a specifications folder

Open a spec folder from the folder dialog, or from the ▾ menu while one is
listed. The Specs tab, the modules' tabs and Sync come back, and the folder
syncs as on any switch. The code repository stays on its list for next
time.

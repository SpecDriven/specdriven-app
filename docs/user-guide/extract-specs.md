# Extracting specs from a code project

How to start a specifications folder for a project that already has code:
the app reads the project's module structure, proposes folders, makes a
`specs-<project>` folder beside it — or adds to a specification folder you
already have — and has an agent draft the first features from the code. Specifications themselves are covered in
[Features and specs](specs.md); opening a project without specs in
[Opening a code repository](code-repository.md).

## Contents

1. [When to use it](#1-when-to-use-it)
2. [Starting](#2-starting)
3. [Reviewing the folders](#3-reviewing-the-folders)
4. [The specification folder and GitHub](#4-the-specification-folder-and-github)
5. [Drafting](#5-drafting)
6. [Linking your tests](#6-linking-your-tests)
7. [What you get, and what to do with it](#7-what-you-get-and-what-to-do-with-it)
8. [Limits](#8-limits)

## 1. When to use it

You have a Java, JavaScript, TypeScript or Python project and no written
specifications for it. Extraction gives you a first set to correct, which
is faster than starting from an empty folder.

It is available in the desktop app and the local web app. The demo, the
hosted app and the read-only specs site do not offer it.

Nothing is written into your project, with one exception you tick
yourself: a `specs` link to the new folder.

## 2. Starting

- **First run:** where the app asks where your work is, pick
  **Extract specs from code**, then type the project's folder or use
  **Browse…**. The project opens as a code repository and the dialog starts
  on it.
- **With a code repository open:** the command palette (⌘K) has
  **Extract specs from this project…**.
- **Later:** **Manage folders…** has **Extract specs from code…**, and the
  desktop app has **File → Extract Specs from Code Project…**.

## 3. Reviewing the folders

The app proposes one folder per module, and says why for each:

| Project | What becomes a folder |
|---|---|
| JavaScript, TypeScript | npm, pnpm and Lerna workspaces, Nx projects, tsconfig references, any folder with its own `package.json` |
| Java | Maven modules, Gradle projects; in a single module, the packages below the base package |
| Python | uv workspace members, folders with their own `pyproject.toml` or `setup.py`, top-level packages, Django apps |
| No modules | The folders under `src` |

Tests go with the code they test. `node_modules`, build output, generated
code and anything your `.gitignore` excludes are not read.

In the review you can:

- **Tick or untick** a folder. Shared plumbing such as `utils` and `config`
  starts unticked.
- **Rename** a folder by editing its name.
- **Move…** a folder into another, or back to the top level.
- **Refine with** an agent, when one is switched on: it regroups and
  renames the folders by what the project does. **Back to the original**
  undoes it.

## 4. The specification folder and GitHub

The last step asks where the specifications go: **A new specification
folder** or **An existing specification folder**.

### A new folder

The folder is named `specs-<project>` and made beside the project. You can
change the name; a name that is already taken is refused, and when a
specification folder sits there the dialog offers **Add to it instead**.

When you are signed in to GitHub, **Create a repository** is ticked: a
private repository of the same name is made, under the owner of the
project's own repository by default, and the folder is pushed to it.

If GitHub refuses — no sign-in, or a sign-in that may not create
repositories — the folder is made on your computer anyway and the app says
why. Publish it later with **Publish to GitHub…**, in the drafting pill's
list or the command palette.

### An existing folder

Use this when the project's specifications belong with ones you already
keep, for example one specification folder for several code projects.
Name the folder by its path on this computer (type it or use **Browse…**)
or by its repository's GitHub url, then click **Add and open**.

- The ticked folders are added to it. What it holds stays as it is: its
  README, its features, and the name of a spec folder that was already
  there.
- The project is added to the folder's code repositories in
  `project-settings.yaml`. Its default code repository does not change.
- What was written is committed and pushed like any other edit. No new
  folder and no GitHub repository is made.
- A repository named by its url is cloned first, where the app keeps its
  clones.

The choice is made for you when the project already has a specification
folder: one named `specs-<project>` beside it, or the one its `specs` link
points into. Otherwise the folder that is open is filled in, ready if you
pick it.

Only a specification folder is accepted, one with `.specdriven` and
`specs` in it. Anything else is refused with the reason.

## 5. Drafting

After **Create and open** (or **Add and open**) the folder opens and an
agent drafts specs for each ticked folder, one at a time, in the background. A pill above
your name in the sidebar shows progress, for example
"Drafting specs — 4 of 12 folders". Click it for the list of folders, with:

- links to the features drafted so far
- **Cancel**, which abandons the request in flight and drafts nothing more;
  what was drafted stays
- **Retry** on a folder that failed
- **Resume** for a run that was cancelled or that the app was closed on
- **Dismiss**, once the run is over

A run never resumes by itself.

## 6. Linking your tests

A project that already has tests can have them linked to the drafted
scenarios, so each scenario lists the tests that check it under
**Automated tests**. An agent does the matching; the app finds the tests
and writes the links.

### With the import

The last step of the dialog has **Link the project's tests to the
scenarios**, ticked when the project has tests and a repository on
github.com. Once every folder is drafted, the same background run links
the tests, one agent request for each feature. The pill changes from
"Drafting specs" to "Linking tests — 3 of 12 features".

### Later

Leave the box unticked, or come back after the project has gained tests,
and use **Link tests to specs…**:

- in the drafting pill's list, as **Link tests…**, once a run is over
- under **Manage folders…**
- in the command palette (⌘K)

The dialog asks which code repository (when the folder has several),
which features (all extracted ones, or one folder's) and which agent and
model. **Link tests** starts the run; Cancel, Retry, Resume and Dismiss
work as they do for drafting.

### What gets linked

- Only features that were extracted from code, the ones whose first line
  reads "Extracted from …". The app takes tests from those directories.
  A feature you wrote yourself is left alone.
- Tests are recognised by the language's own mark: `test(…)` and `it(…)`
  in JavaScript and TypeScript, `@Test` methods in Java and Kotlin,
  `def test…` in Python, `func Test…` in Go.
- A scenario gets at most six tests per run. A scenario no test checks
  gets none.
- Links are only added. A scenario keeps the links it has, and running
  the linking again adds no duplicates.

A link is the agent's reading of the test. Check it as you check the
scenario.

## 7. What you get, and what to do with it

Each folder gets one feature, or several for a large folder. Every
scenario is `[proposed]` and ends with the source files it was drafted
from. Read them against the code, correct what is wrong, delete what is
not worth specifying, and publish the ones that say what the code is
meant to do.

A drafted scenario describes what the code does today. Whether that is
what it should do is your call.

## 8. Limits

- Each file is read up to 12,000 characters. A folder too large for one
  request is split by subfolder; past six requests the rest is left unread,
  and the list says how many files that was.
- At most 60 folders are ticked for a very large project.
- Tests are linked only for a project whose `origin` is a repository on
  github.com. A project on GitHub Enterprise, or with no remote, cannot
  have its tests linked.
- Test links point at the repository's default branch, with the line
  numbers of your checkout. A test you have not pushed yet gives a link
  that works once you push it.
- For one feature the agent reads test files up to the same request size
  as drafting. Tests past that are offered to it by file and name only.
- Other languages are counted and reported, not read.

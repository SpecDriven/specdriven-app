# AI sessions

How to hand specs to a coding agent from the SpecDriven app. This guide
covers selecting what to send, the **Start AI Session** dialog, the places a
session can run (Claude Code Desktop, the app's own coding agent pane with
Claude, Codex or Pi, or the clipboard), the pane itself, and what to do when
something fails. Writing the specs in the first place is covered in
[Features and specs](specs.md).

## Contents

1. [What an AI session is](#1-what-an-ai-session-is)
2. [Prerequisites](#2-prerequisites)
3. [Selecting what to send](#3-selecting-what-to-send)
4. [Starting a session](#4-starting-a-session)
5. [Where it runs](#5-where-it-runs)
6. [The coding agent pane](#6-the-coding-agent-pane)
7. [A session without specs](#7-a-session-without-specs)
8. [Session records](#8-session-records)
9. [Demo mode](#9-demo-mode)
10. [Troubleshooting](#10-troubleshooting)

## 1. What an AI session is

An AI session takes the features and scenarios you have selected, builds one
prompt from them, and hands that prompt to a coding agent working in your
code repository. The agent implements the specs; you watch it work, answer
its questions and approve what it wants to run, in the Claude app or in a
pane inside SpecDriven.

A session is deliberately simple. It creates no git branch, no worktree, no
task and no issue. It sends the specs and lets the agent do what it would do
if you had pasted the same text into it yourself. The agent is told to edit
the code, not the specs.

## 2. Prerequisites

SpecDriven runs the agents you already have installed and signed in. It holds
no API key of its own and adds no sign-in of its own; each agent's CLI or
app authenticates the way it always does.

| To run in | You need | Notes |
| --- | --- | --- |
| Claude Code Desktop | The Claude app in `/Applications` or `~/Applications` | macOS only. |
| The coding agent pane, with Claude | The `claude` command on your `PATH` | Signed in with `claude auth login`. |
| The coding agent pane, with Codex | The `codex` command on your `PATH` | OpenAI's Codex CLI (`npm i -g @openai/codex`), signed in with `codex login`. Verified against Codex CLI 0.141. |
| The coding agent pane, with Pi | The `pi` command on your `PATH` | From [pi.dev](https://pi.dev); sign in with `/login` inside `pi`. |
| Copy prompt to clipboard | Nothing | Always offered. |

Only the agents that are actually installed are offered; with none installed
the app still builds the prompt for you to paste elsewhere.

Two settings shape sessions:

- **Code generation** (Settings). On by default. Turning it off removes the
  selection checkboxes and the Start AI Session button, clears any
  selection, and makes the server refuse sessions even from outside the UI.
  The switch is saved in `.specdriven/settings.json`.
- **`code-repo`** in the data folder's `project-settings.json`. This is the
  directory the agent works in, the repository whose code implements the
  specs. Without it the session runs in the data folder itself, which is
  fine for a project that keeps specs and code together.

```json
{
  "members": ["ada", "grace"],
  "code-repo": "../acme-app"
}
```

A relative path is resolved from the data folder.

## 3. Selecting what to send

Selection checkboxes appear in two places while Code generation is on:

- **A whole feature**: the checkbox on its row in the sidebar tree. Its
  tooltip reads `Select all of <feature> for an AI session`.
- **Single scenarios**: the checkbox on each scenario card on a feature page
  (`Include this scenario in an AI session`).

A feature with only some of its scenarios selected shows a dash in the
sidebar instead of a check; selecting every scenario of a feature is the
same as selecting the feature. The selection holds while you move between
features, so you can gather scenarios from several. The line under the
button sums it up: `Selected: 2 whole specs and 3 scenarios from 1 spec`.

The prompt takes the specs as they are in the editor, so unsaved and draft
scenarios go along with published ones. A feature cut down to some of its
scenarios is marked `(selected scenarios only)` in the prompt.

The selection clears after a session starts or a prompt is copied. To
drop it by hand, untick the boxes, or turn Code generation off and on again.

## 4. Starting a session

With something selected, press **Start AI Session (n)** in the sidebar. The
same command is in the command palette (`⌘K`) and in a feature page's
**More actions** (⋯) menu. While a session is being opened the button reads
`Session running…`.

The **Name the session** dialog asks for two things:

- **A name.** It is prefilled with a timestamp, `Session 2026-09-08 15:30:30
  PDT`, and you can replace it with something meaningful, `implement billing
  quotes`. The name titles the session in the Claude app or the pane, and
  names the session record.
- **Run in.** Where the session goes. Only installed agents are listed:

  | Choice | What happens |
  | --- | --- |
  | **Copy prompt to clipboard** | Copies the prompt; paste it into any agent. The confirm button becomes **Copy prompt**. |
  | **Claude Code Desktop** | Opens a new session in the Claude app, on the code repo. |
  | **Coding agent pane** | Chats with Claude in a pane inside SpecDriven, on the code repo. |
  | **Codex in the coding agent pane** | The same pane, driven by Codex, with permission cards for commands and file changes. |
  | **Pi in the coding agent pane** | The same pane, driven by Pi. Pi runs its own tools and asks no permission. |

  Your choice is remembered for next time. With no agent installed the
  dialog skips the choice and only offers to build the prompt.

Confirm with **Start AI Session**. The app reports progress under the
button, `Building the prompt for "…"…`, then `Opening "…" in Claude Code
Desktop…` or `Opening "…" in the coding agent pane…`, and finally
`Session "…" opened in Claude Code Desktop.` or `Session "…" opened in the
coding agent pane.` A failure shows in an error box in the same place.

The prompt the agent receives starts with the session name and an
instruction, then each selected feature verbatim under a heading naming its
file:

```markdown
SpecDriven code gen session: implement billing quotes

Implement the following specifications.
Work in the current directory and exit when done.
The current directory is the code repository. The specifications live in the SpecDriven data repository at /Users/ada/specs-acme; edit the code, not the specifications.

## Spec: billing/quotes.feature.md (selected scenarios only)

# Quotes

## Quote a homeowners policy @v2 [published]

Given …
```

The third instruction line only appears when a `code-repo` is configured.

## 5. Where it runs

### Claude Code Desktop

The app writes the full prompt to a file, then opens the Claude app on the
code repo with a short bootstrap message that tells the new session to title
itself after the session name and start from that file. From there the
session is an ordinary Claude Code Desktop session; SpecDriven is not
involved further. If the Claude app cannot be opened the error box says so,
with the operating system's own words.

### The coding agent pane

The pane opens on the right with the prompt already sent as the first turn,
and the agent starts working immediately. Everything the agent does streams
into the pane: its replies, the tools it runs, and the permission requests
and questions it needs you to answer. The next section describes the pane.

### Clipboard

Nothing is launched and no session record is written. The notice reads
`Prompt for "…" copied to the clipboard.` Paste the prompt into whichever
agent you like.

## 6. The coding agent pane

The pane is where sessions run inside SpecDriven. Open or close it with `]`,
or from the command palette. It stays open while you move around the app,
and an agent keeps working while it is closed; if the agent needs an answer
while the pane is closed, a toast says `Claude is waiting for your approval
in the coding agent pane` (or Codex, or Pi).

### The header

- The **session menu**, labelled with the active session's name. It lists
  every live session, so you can run several and switch between them, then
  **New session** and **End session**.
- A **working directory** chip with the folder's name; its tooltip gives the
  agent and the full path.
- A **status dot** and label:

  | Label | Meaning |
  | --- | --- |
  | `Starting Claude…` (or Codex, or Pi) | The agent is launching. |
  | `Ready` | Waiting for your next message. |
  | `Working…` | A turn is in progress. |
  | `Waiting for your answer` | A permission card or a question needs you. |
  | `Ended` | The session is over; start a new one from the menu. |
  | `Failed` | The agent could not start or crashed. |

- A **Permission mode** selector, for Claude and Codex:

  | Mode | Claude | Codex |
  | --- | --- | --- |
  | **Default** | Asks before running commands and editing files. | Approval on request; the sandbox may write to the workspace. |
  | **Accept edits** | File edits go through without asking; commands still ask. | Asks only when a command fails. |
  | **Plan** | Reads and plans, changes nothing. | Read-only sandbox. |
  | **Bypass permissions** | Nothing asks. | No approvals, full access. |

  A change takes effect from the next turn. Pi has no permission protocol;
  its sessions show a `No permission gate` chip instead of the selector.

- **Stop** interrupts the current turn.
- **Close the coding agent pane** (`]`).

### The transcript

Each turn shows your message and the agent's reply as it streams, plus:

- **Tool rows**, one per command or file change, showing the tool, a short
  summary and `running…`, `done` or `failed`. Expand a row to see the input
  and output.
- **Permission cards**, when the agent wants to run something the current
  mode does not allow on its own: `Claude wants to use Bash`, with the input
  and three answers. **Allow once** runs it. **Allow always** also allows
  the same thing for the rest of the session. **Deny…** reveals an optional
  `Why not?` field the agent reads, then **Deny**. A resolved card reads
  `Allowed` or `Denied`, with `(stopped)` or `(session ended)` if it was
  overtaken.
- **Question cards**, when the agent asks you to choose between options.
  Pick one or more, or type an answer in the other field.
- A **turn footer**: `Turn done` or `Turn failed`, with the cost and
  duration when the agent reports them.

`Connection lost — reconnecting…` appears if the browser loses the stream;
the pane picks up where it left off. When you have scrolled up, a **Jump to
latest** chip returns you to the newest output.

### The composer

Type a message and press `Enter`. Typing `/` opens a popup of the commands
the agent supports (Claude Code's own slash commands, for instance). While
the agent is working the composer says so; press **Stop** to send something
else. After **End session** it reads `This session has ended — start a new
one from the session menu`.

## 7. A session without specs

The pane can also start a free-form session with nothing selected. Open the
pane with nothing running, or choose **New coding agent session** from the
command palette, and the pane shows a small form:

- **Agent**: Claude, Codex or Pi, when more than one is installed. Each
  option says what it brings: Claude with permission cards and its own
  commands; Codex with permission cards for commands and file changes; Pi
  minimal, running its own tools without asking.
- **Session name**, prefilled with the timestamp name.
- **Start chat**.

The session runs in the code repo, or the data folder without one, exactly
like a session started from specs, but the first message is yours to write.

## 8. Session records

Every session opened in Claude Code Desktop or the pane leaves a record on
this machine: a folder named by the session's id, holding `session.json`
(name, start time, agent, data folder, code repo, and the specs sent) and,
for desktop sessions, the `prompt.md` that was handed over. The records sit
under `sessions/` next to the app's settings file, `.specdriven/settings.json`,
and never inside the data folder, which is pushed to git.

The record also carries the agent's own session id, so a past pane session
can be resumed from the agent's CLI. Codex threads are named after the
session, so `codex resume` lists them by name.

## 9. Demo mode

In the public demo every pane session is a scripted simulation. The
transcript, the tool rows and the permission card are staged, and nothing
runs or is written to disk. The pane shows a `Simulation` chip and a
watermark, and the Code generation switch is hidden.

## 10. Troubleshooting

Errors from starting a session show in a box under the Start AI Session
button; errors inside a session show in the pane's transcript.

| Message | What to do |
| --- | --- |
| `Claude CLI not found — install the claude command` | Install Claude Code and make sure `claude` is on the `PATH` of the shell that launched SpecDriven, then reload. |
| `Codex CLI not found — install the codex command (npm i -g @openai/codex)` | Install the Codex CLI and reload. |
| `Pi CLI not found — install the pi command (https://pi.dev)` | Install Pi and reload. |
| `Claude Code Desktop not found — install Claude.app` | Install the Claude app on macOS, or pick the coding agent pane instead. |
| `Could not open Claude Code Desktop: …` | The operating system could not open the `claude://` link; the rest of the message is its reason. |
| `Code generation is switched off in Settings` | Turn the **Code generation** switch on. |
| `Code repo not found: <path> (code-repo in project-settings.json)` | Fix or remove `code-repo` in the data folder's `project-settings.json`. |
| `The Claude CLI is not signed in on this machine: run claude auth login in a terminal, then start a new session.` | Do that; the running session cannot recover. |
| `The Codex CLI is not signed in on this machine: run codex login in a terminal, then start a new session.` | Same. |
| `Pi has no credentials for this model here: run pi in a terminal and /login, then start a new session.` | Same. |
| `No coding agent CLI found — install the claude command (or codex, from OpenAI, or pi, from pi.dev) and reload.` | The pane found no agent at all. Install one and reload. |
| `Connection lost — reconnecting…` | Wait; the pane reconnects on its own. If it does not, reload the page: the session keeps running on the server. |
| `Turn failed` | The agent's turn ended with an error. Expand the last tool row for the cause, or send a follow-up message. |

The agents are found on the `PATH` of the process that started SpecDriven.
An app launched from the Dock or a desktop shortcut may see a shorter `PATH`
than your terminal does; if a CLI that works in a terminal is reported
missing, start the app from that terminal or install the CLI somewhere on
the system `PATH`.

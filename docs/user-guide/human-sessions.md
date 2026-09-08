# Pomodoro sessions

How to time your own work in the SpecDriven app with the Pomodoro technique:
starting a session, the timer at the foot of the sidebar, the sounds, and
the record the app keeps on your machine. Handing specs to a coding agent is
covered in [AI sessions](ai-sessions.md).

## Contents

1. [What a Pomodoro session is](#1-what-a-pomodoro-session-is)
2. [Starting a session](#2-starting-a-session)
3. [The timer](#3-the-timer)
4. [Sounds](#4-sounds)
5. [Session records](#5-session-records)
6. [Troubleshooting](#6-troubleshooting)

## 1. What a Pomodoro session is

The Pomodoro technique (Francesco Cirillo, late 1980s, named after a
tomato-shaped kitchen timer) breaks work into timed intervals:

1. Pick a task.
2. Set the timer for one **pomodoro**, 25 minutes by default, and work.
3. When it rings, take a **short break**, 5 minutes by default.
4. After four pomodoros take a **long break**, 15 minutes by default.

The app follows the technique's rules, not just its clock:

- **A pomodoro is indivisible.** There is no pause. An interruption means
  the pomodoro is **abandoned**, and it does not count; start a fresh one
  when you are back.
- **A break can be skipped.** Cutting a break short is fine; the next
  pomodoro starts when you are ready.
- **The long break comes after four completed pomodoros** since the last
  long break. Abandoned pomodoros do not move the count. The number four is
  yours to change.
- **Nothing starts on its own.** When an interval ends the app rings and
  waits for you to start the next one. Winding the timer yourself is part
  of the technique.

A session is a run of intervals with a name, like `write the quotes spec`.
It lasts until you end it, and the app keeps the total focus time.

## 2. Starting a session

Press **Start session…** in the sidebar, or `p` anywhere the keyboard is
not in a field, or **Start a Pomodoro session** in the command palette
(`⌘K`). The dialog opens with two tabs, **AI session** and **Pomodoro**;
the AI tab is the [AI sessions](ai-sessions.md#4-starting-a-session)
dialog, and needs specs selected and code generation switched on. The
Pomodoro tab needs neither.

The **Start a Pomodoro** tab asks for:

- **A name.** Prefilled with a timestamp; replace it with what you are
  working on.
- **Focus, Short break, Long break.** The interval lengths in minutes,
  1 to 180.
- **Long break every.** How many completed pomodoros come before a long
  break, 1 to 12.
- **Sound when an interval ends.** Bell, Chime, Ding, Wood block, or None,
  with a ▶ button to hear it.
- **Tick during focus.** A soft tick every second while a pomodoro runs,
  the way the kitchen timer did. Off by default.

Your choices are remembered on this device and prefilled next time.
Confirm with **Start Pomodoro**: the session begins and its first pomodoro
starts at once.

Only one Pomodoro session runs at a time. Opening the tab while one is
running offers **End session** instead.

## 3. The timer

While a session runs, a bar sits at the foot of the sidebar, above your
name:

- The phase, **Focus**, **Short break** or **Long break**, and the time
  left as `mm:ss`.
- A progress line under the clock, and four dots (or however many your
  cycle has) filling in as pomodoros complete.
- **Focus 50m**: the session's focus time so far, the running pomodoro
  included. Abandoned time counts as time spent; only completed pomodoros
  count as pomodoros.
- One button for the moment: **Abandon** during a pomodoro, **Skip**
  during a break, and between intervals **Start break**, **Start long
  break** or **Start pomodoro**, whichever the rules say comes next.
- The ⋯ menu holds **End session**. The command palette offers **End
  Pomodoro session** too.

The time left is also the first thing in the window title, `24:59 · Focus`,
so the browser tab shows it while you work elsewhere. With the sidebar
collapsed the clock alone shows as a chip in the rail; clicking it brings
the sidebar back.

When an interval ends the sound plays, the bar flashes, and a toast offers
the next step. The clock is always the interval's planned end minus the time
now, never a counter, so a reload, or a laptop that slept for ten minutes,
lands on the right number. An interval that ran out while the app was
closed is closed as completed at its planned end when the app comes back,
and the bar offers the next step.

## 4. Sounds

The sounds are made in the browser, not played from files, so there is
nothing to install. They only play after a click or a key in the app, as
browsers require: starting the session counts. If a session was picked up
after a reload, the first click anywhere in the app enables sound again.

## 5. Session records

Every Pomodoro session leaves a record on this machine, in the same place
as the [AI session records](ai-sessions.md#8-session-records): a folder
named by the session's id under `sessions/`, next to the app's settings
file, `.specdriven/settings.json`. The records never go inside the data
folder, which is pushed to git. AI and Pomodoro records share the folder;
a Pomodoro record says `"kind": "human"`.

The record is `session.json`, described by
`src/server/humanSession.schema.json` in the app's source:

```json
{
  "schemaVersion": 1,
  "kind": "human",
  "id": "0f2d7d3e-3a2b-4c1d-9e8f-0a1b2c3d4e5f",
  "name": "write the quotes spec",
  "user": "ada",
  "startedAt": "2026-09-08T16:15:00.000Z",
  "updatedAt": "2026-09-08T16:45:00.000Z",
  "dataRepo": "/Users/ada/specs-acme",
  "specs": [],
  "pages": [],
  "pomodoro": { "workMinutes": 25, "shortBreakMinutes": 5, "longBreakMinutes": 15, "longBreakEvery": 4 },
  "intervals": [
    { "kind": "work", "startedAt": "2026-09-08T16:15:00.000Z", "endedAt": "2026-09-08T16:40:00.000Z", "outcome": "completed" },
    { "kind": "shortBreak", "startedAt": "2026-09-08T16:40:00.000Z", "endedAt": "2026-09-08T16:43:00.000Z", "outcome": "abandoned" },
    { "kind": "work", "startedAt": "2026-09-08T16:45:00.000Z" }
  ],
  "totals": { "workMs": 1500000, "breakMs": 180000, "completedPomodoros": 1 }
}
```

- **`intervals`** lists every interval in order. One without `endedAt` is
  running. `outcome` is `completed` when the timer ran out and `abandoned`
  for a voided pomodoro or a skipped break.
- **`totals`** is the session's time: focus and break milliseconds, and the
  number of completed pomodoros. It is recomputed from the intervals on
  every write.
- **`endedAt`** is absent while the session is open. The app never has to
  write an end to stay consistent: if it is closed mid-session, the record
  simply lacks one, and `updatedAt` says when it was last touched.
- **`pomodoro`** is the settings the session was started with; changing
  the preferences later does not change a running session.
- Minutes are the settings you typed; milliseconds are measured time.

## 6. Troubleshooting

- **No sound.** The browser has not heard a click yet, the sound is set to
  **None**, or the machine is muted. Click anywhere in the app and try the
  ▶ preview in the dialog.
- **The bar is gone after a reload but the session was not ended.** The
  app could not reach its own server on boot; reload again. The record on
  disk is untouched.
- **"A Pomodoro session is already running."** End it from the bar's ⋯
  menu, or from the dialog's Pomodoro tab.
- **A pomodoro ended while I was away and it says completed.** The timer
  ran out before you left, or while the app was closed; either way the
  pomodoro was finished. Use **Abandon** while it is running if it should
  not count.

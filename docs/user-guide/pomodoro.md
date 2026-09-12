# Pomodoro

How to time your own work in the SpecDriven app with the Pomodoro technique:
starting the timer, the bar the header's timer icon opens, the settings, and the
sounds. Handing specs to a coding agent is covered in
[AI sessions](ai-sessions.md).

The Pomodoro is a feature of the app, not a kind of session. It is about the
person at the keyboard: one timer runs however many AI sessions you have going
in parallel, and starting it takes one click — no name, no dialog.

It is **off until you switch it on** in Settings. Once on, a timer icon in the
sidebar header opens and closes the bar, so it costs no space when you are not
looking at it.

## Contents

1. [What a pomodoro is](#1-what-a-pomodoro-is)
2. [Switching it on](#2-switching-it-on)
3. [Starting the timer](#3-starting-the-timer)
4. [The bar](#4-the-bar)
5. [Settings](#5-settings)
6. [Sounds](#6-sounds)
7. [Troubleshooting](#7-troubleshooting)

## 1. What a pomodoro is

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

## 2. Switching it on

**The Pomodoro is off until you ask for it.** Open **Settings** (`⌘,`) and
turn **Pomodoro timer** on. Until you do there is no timer icon and no bar,
the `p` key does nothing, and the command palette offers no pomodoro — a timer
nobody asked for is a row of sidebar taken from the work.

The choice is remembered on this device, like Vim mode and the theme, rather
than in the settings file: it is a habit of the person at this keyboard, not a
property of the project.

### Opening and closing the bar

Once on, a **timer icon** appears in the sidebar header, just left of the
coding agent's robot. It opens and closes the Pomodoro bar, which appears
directly beneath the header.

The bar carries a clock, a progress line, the cycle's dots and a button, which
is a lot of a narrow sidebar — so it is a pane you open when you want it, not
permanent furniture. The **⌄** button on the bar closes it, as does the header
icon.

Closing is not stopping. A running pomodoro keeps running, the header icon
carries its clock (coloured for a break), and the window title keeps counting
down. To actually stop the timer, use **Stop Pomodoro** in the bar's ⋯ menu.

## 3. Starting the timer

Press **Start a pomodoro** in the bar under the sidebar header, or `p` anywhere
the keyboard is not in a field, or **Start a pomodoro** in the command palette
(`⌘K`). With the sidebar collapsed, the timer chip in the rail starts one too.

That is the whole of it: the first pomodoro begins at once, on the lengths you
last set. There is no name to type and no dialog to fill in — a pomodoro is
something you start in the second you decide to focus.

Only one timer runs at a time; it is yours, not any session's. Starting one
while another is running changes nothing.

## 4. The bar

With the bar open, it sits under the sidebar header, below the search field:

- The phase, **Focus**, **Short break** or **Long break**, and the time
  left as `mm:ss`.
- A progress line under the clock, and four dots (or however many your
  cycle has) filling in as pomodoros complete.
- **Focus 50m**: the focus time so far, the running pomodoro included.
  Abandoned time counts as time spent; only completed pomodoros count as
  pomodoros.
- One button for the moment: **Abandon** during a pomodoro, **Skip**
  during a break, and between intervals **Start break**, **Start long
  break** or **Start pomodoro**, whichever the rules say comes next.
- The ⋯ menu holds **Pomodoro settings…** and **Stop Pomodoro**. The
  command palette offers both too.

The time left is also the first thing in the window title, `24:59 · Focus`,
so the browser tab shows it while you work elsewhere. With the sidebar
collapsed the clock alone shows as a chip in the rail; clicking it brings
the sidebar back.

When an interval ends the sound plays, the bar flashes, and a toast offers
the next step. The clock is always the interval's planned end minus the time
now, never a counter, so a laptop that slept for ten minutes lands on the
right number.

**The timer lives only as long as the app is open.** It is not written to
disk: reloading the page, or quitting and coming back, leaves no pomodoro
running. Nothing is kept but your settings.

## 5. Settings

**Pomodoro settings…**, from the bar's ⋯ menu or the command palette, holds:

- **Focus, Short break, Long break.** The interval lengths in minutes,
  1 to 180.
- **Long break every.** How many completed pomodoros come before a long
  break, 1 to 12.
- **Sound when an interval ends.** Bell, Chime, Ding, Wood block, or None,
  with a ▶ button to hear it.
- **Tick during focus.** A soft tick every second while a pomodoro runs,
  the way the kitchen timer did. Off by default.

Your choices are remembered on this device, and are a habit of the person at
this keyboard rather than a property of any one timer. Saving while a pomodoro
is running is fine: the running interval keeps the length it started with, and
the change lands on the next one.

## 6. Sounds

The sounds are made in the browser, not played from files, so there is
nothing to install. They only play after a click or a key in the app, as
browsers require: starting the timer counts.

## 7. Troubleshooting

- **No sound.** The browser has not heard a click yet, the sound is set to
  **None**, or the machine is muted. Click anywhere in the app and try the
  ▶ preview in the settings.
- **There is no Pomodoro anywhere.** It is off by default: turn **Pomodoro
  timer** on in Settings (`⌘,`).
- **The bar disappeared.** It was closed, by the **⌄** button or the header
  icon. Click the header's timer icon to open it again; any running pomodoro
  is still running.
- **The bar is gone after a reload.** That is expected: the timer is not
  saved anywhere, and a reload ends it. Start a fresh pomodoro.
- **A pomodoro ended while I was away and it says completed.** The timer
  ran out before you left; the pomodoro was finished. Use **Abandon** while
  it is running if it should not count.

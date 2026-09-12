# Spec changes still to make (in the app, not from a session)

`specs/` is a symlink into the separate data repo `../specs-specdriven`, which
a session must not edit — specs are authored in the SpecDriven app itself. So
this branch changes code, tests and docs only. What follows is what the spec
needs, ready to apply in the app.

## Move the file

`specs/code-sessions/developer-led-coding-session.feature.md`
→ `specs/app/pomodoro.feature.md`

The Pomodoro is no longer a kind of coding session; it is a feature of the app,
about the person at the keyboard. `specs/code-sessions/` is left holding only
AI-led work.

## Rewrite the preamble

The rules themselves are unchanged. What changes is the framing:

- It is **not** started from a tab of the Start session dialog. It is started
  in one click — the **Start a pomodoro** button at the foot of the sidebar,
  the `p` key, the rail's timer chip, or the command palette. No name, no
  dialog.
- There is **no session record**. The timer lives in memory for as long as the
  app is open. Nothing is written to disk but the device-local preferences.
- "One session at a time" becomes **one timer for the person**: a single
  pomodoro runs however many AI sessions are going in parallel.
- The interval lengths, the sound and the tick are device-local preferences,
  reached from the bar's ⋯ menu. Changing them affects the **next** interval;
  the running one keeps what it started with.

## Scenarios to drop

- **an interval that ran out while the app was closed** — no record to come
  back to; the timer is gone with the app.
- **the clock survives a reload** — it does not any more. (This is the
  deliberate cost of the no-persistence decision; worth stating in the
  preamble instead.)
- **the Pomodoro tab needs no specs and no code generation** — there is no
  tab. The AI-gating half of it belongs in the AI session's own spec.

## Scenarios to reword

- **start a developer-led session** → *start a pomodoro*: one click, no name,
  no dialog; the first pomodoro runs at once.
- **end the session** → *stop the timer*: the ⋯ menu's "Stop Pomodoro".
- **one session at a time** → *one timer, however many sessions*: starting
  while one runs changes nothing.
- **interval lengths are remembered on this machine** and **preview the sound**
  now happen in the settings dialog, not the Start session dialog.

## Test refs

Every `[test: … ]` ref must be re-pointed. Refs carry the test's *name* and a
url with a line number (`[test: <title> : <url>#L<n> ]`). Current names and
lines on this branch:

### tests/pomodoro.test.ts
- L99 defaults when nothing or junk is stored; each field clamps on its own
- L110 load takes the stored preferences, and savePrefs keeps them for the next timer
- L123 the clock rounds up, the title carries the phase, durations read as minutes
- L136 derive from the open interval's planned end
- L155 start unlocks audio, keeps the prefs, and opens the first pomodoro at once
- L170 starting while one runs changes nothing
- L178 a tick before the end only moves the clock; at the end the pomodoro completes at its planned end
- L204 the next interval follows the rules, and the tick sounds only during focus when asked
- L222 auto-start chains the next interval
- L231 abandon voids a pomodoro, skip cuts a break, and each refuses the other
- L250 stop switches the timer off, and the title prefix goes with it
- L261 nothing happens without a timer

### tests/pomodoroRules.test.ts (was humanSessionRules.test.ts)
- L38 come from the timer's settings
- L47 work to begin with, and again after a voided pomodoro
- L52 a short break after a pomodoro, the long one when the cycle is full
- L60 work after any break, and the cycle restarts after a long break of any outcome
- L69 honours the timer's own cycle length
- L78 fills one dot per completed pomodoro, capped at the cycle length
- L87 splits work from breaks, counts abandoned time, and only completed pomodoros
- L92 an open interval counts only when told the time
- L98 a span that runs backwards clamps to zero
- L104 only the last interval can be open
- L114 appendInterval opens one, and refuses a second while it runs
- L120 closeInterval ends the open one at now or at the planned end
- L129 closeInterval refuses when nothing runs, or an end before the start or in the future

### tests/pomodoroBar.test.tsx
- L25 during focus: the phase, the clock, progress, dots, total, and Abandon
- L39 during a break: Skip, the break class, and a coffee
- L48 between intervals: no clock, and the button that starts what comes next
- L58 flashes when told to, and the menu offers the settings and to stop
- L66 the rail chip is the clock alone, and a timer icon between intervals
- L78 with no timer running, one button starts a pomodoro — no name, no dialog
- L89 the length shown follows the preferences, and the menu holds the settings
- L96 the rail's idle chip is a timer icon that starts one

### tests/pomodoroSettings.test.tsx (new)
- L20 offers the four lengths, the sounds with a preview, the tick, and Save
- L39 shows the stored preferences, and no preview for silence
- L47 while a pomodoro runs, says the change lands on the next one
- L55 the form's text becomes clamped preferences

### tests/startSessionDialog.test.tsx
- L31 is the old button's gating, each reason in words
- L42 keeps the session dialog's title, name, Run in group, and confirm label
- L53 the clipboard choice relabels the button; no agent means no group and Copy prompt
- L70 when off, says why and disables the field and the button
- L80 is the AI session's dialog alone — no tabs, no Pomodoro

### Gone
`tests/humanSession.test.ts` and `tests/humanSessionApi.test.ts` are deleted
with the record; every ref to them must go.

Delete this file once the spec is updated.

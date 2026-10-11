---
name: electron-crash-test
description: Build the SpecDriven Electron desktop app and crash-test it by launching and restarting it three times (bun run test:desktop), checking that every launch renders the window, survives a hold, and quits cleanly with no crash, no uncaught main-process exception, no hang and no crash signature in its output. Use this whenever asked to build the desktop or Electron app and make sure it runs, to check the desktop app for startup, restart or shutdown crashes, to smoke-test a build before a release or after bumping Electron or electron-builder, and after any change under src/electron, scripts/build-desktop.ts or the "build" section of package.json — even when the request only says "does the desktop app still start?" or "verify the desktop build".
---

# Build and crash-test the desktop app

`bun run test:desktop` builds the desktop app the way a release does —
renderer bundle, main-process bundle, electron-builder into an unpacked
directory (no installers) — then launches the result three times on one
throwaway profile. Each launch waits for the window to render (asked over
Chromium's DevTools protocol: document loaded and the app mounted under
`#root`), holds five seconds, then sends SIGTERM, which Electron turns into
`app.quit()`. Launches 2 and 3 are restarts: they load the window geometry
and settings the previous launch saved, which is where "works the first
time, crashes on the second" bugs live.

A launch fails when

- the process ends before it is asked to (a crash, `process.exit`, a bail-out);
- the window never renders, or stops answering during the hold;
- the main process throws an uncaught exception or leaves a promise
  rejection unhandled — after startup Electron only shows those in a modal
  dialog and prints nothing, so the test installs a recording listener in
  the main process through its Node inspector (Electron's own handler steps
  aside when another listener exists, so the dialog is replaced by a line in
  the report);
- the quit hangs or exits non-zero;
- the output carries a crash signature (Chromium `FATAL`, `Received signal`,
  a renderer `Uncaught` error, `Cannot find module`), or Crashpad wrote a dump.

The script is [scripts/crash-test-desktop.ts](../../../scripts/crash-test-desktop.ts);
its pure parts are unit-tested in `tests/crashTestDesktop.test.ts`.

## Run it

```sh
bun run test:desktop                        # build + package + 3 launches (about 1–2 min)
bun run test:desktop --no-build             # relaunch what release/ already holds
bun run test:desktop --unpackaged           # no electron-builder: node_modules' electron on dist/ (about 15 s)
bun run test:desktop --runs 10 --uptime 20  # more restarts, longer holds
bun run test:desktop -- --disable-gpu       # after --, arguments go to the app
```

Exit code 0 is a pass, 1 a failed launch, 2 a setup problem (nothing built,
no display). Everything the test saw is in `dist/crash-test/`:

| file | what it is |
| --- | --- |
| `run-N.log` | the app's stdout and stderr for launch N |
| `run-N.png` | the window at the end of the hold — look at it: "rendered" means the app mounted, not that the right thing is on screen |
| `summary.json` | every launch's timings, exit, screen text, findings and verdict |
| `profile/` | the throwaway user-data directory: `window-state.json`, `specdriven-home/` (settings, logs), `Crashpad/` |

Which mode to run:

- The default (packaged) is the real thing — asar packaging, `app.isPackaged`
  code paths, the electron-builder config `bun run build:desktop` uses — and
  costs about a minute of building. Use it for release checks and for anything
  touching packaging or `src/electron`.
- `--unpackaged` is for iterating: two seconds to build, then node_modules'
  electron launches `dist/`. Its log carries an Electron security warning
  about the Content-Security-Policy (`INFO:CONSOLE`) that a packaged app does
  not print; it is not a finding.
- After a real `bun run build:desktop`, `--no-build` tests exactly what was packaged.

The test covers startup, first paint, a few idle seconds, restart with saved
state, and shutdown. It clicks nothing, configures no data repo and never
reaches GitHub, so a crash that needs a configured repo or a user action is
out of its reach — `bun run dev:electron` is for those.

## Environment

- **Dependencies**: `bun install` downloads the Electron binary (electron is a
  trusted dependency). If `node_modules/electron/dist` is missing — a sandbox
  that skipped lifecycle scripts — `node node_modules/electron/install.js`
  fetches it.
- **Headless Linux**: with no `DISPLAY` the test starts an `Xvfb` of its own
  (install `xvfb` if it is missing) and stops it afterwards.
- **Root** (containers, CI): Chromium refuses to run its sandbox as root; the
  test adds `--no-sandbox` for you and changes nothing else.
- The app runs with `--inspect=0` so the listener above can be installed;
  a note under a launch says when that did not work (a build with the
  `EnableNodeCliInspectArguments` fuse off, for instance) — the launch still
  counts, with that one blind spot.
- **`specs` symlink**: electron-builder stats every path in the project, so a
  dangling `specs` fails the packaged build with `ENOENT … stat '…/specs'`.
  `git submodule update --init` (the specs-specdriven submodule, see
  docs/DEVELOPMENT.md) fixes it; `--unpackaged` sidesteps it.
- **macOS**: the window appears on screen three times; that is expected.
  There is no Windows desktop build, so nothing runs there.
- The app's state is isolated: a fresh `--user-data-dir` and `SPECDRIVEN_HOME`
  inside `dist/crash-test/profile`, so the developer's real settings, token and
  `~/.specdriven` are never touched. The app therefore opens on its first-run
  screen — "No spec data directory configured yet" is the expected screen text.

## When a launch fails

Read the problem lines under the failed run, then the log tail the test
prints, then `run-N.log` in full. D-Bus, Floss/Bluetooth, VA-API and `dri3`
messages are what a headless box always says; skip them.

| the test says | it usually means | look at |
| --- | --- | --- |
| `ended on its own (signal SIGSEGV/SIGTRAP/SIGABRT)` | a native crash: Electron or Chromium, a native module, `process.crash` | the log's `Received signal` stack, dumps under `profile/Crashpad/`, what changed in native deps or the Electron version |
| `ended on its own (exit code N)` | the app quit itself: `process.exit`, a load error, or `app.quit()` on a code path — exit code 0 with no window means the profile's single-instance lock was taken by a launch still running | the log's last lines; `App threw an error during load` means `dist/electron/main.js` failed to import |
| `main process uncaught exception: …` | a throw or rejected promise in `src/electron/main.ts` or the server modules it pulls in, after startup; a user would have seen Electron's error dialog | the message's file:line points into the bundle — map it with `dist/electron/main.js.map`, or search the message in `src/` |
| `window did not render within Ns` | `loadURL` failed (the app:// handler, a missing `dist/renderer`), a renderer error before mount, or the main process never reached `createWindow` | `[app://]` and `CONSOLE` lines in the log; there is no screenshot — try `--unpackaged`, then `bun run dev:electron` to watch it |
| `window stopped answering during the hold` | a renderer crash (OOM, native), or a main process that stopped serving its window | `Renderer process crashed` and `FATAL` lines in the log, `Crashpad/`, the screenshot; a `main process uncaught exception` line above it is the cause when there is one |
| `did not exit within Ns of SIGTERM — killed` | quit is blocked: a `before-quit`/`will-quit` handler that never lets go (telemetry flush, agent sessions), a dialog, a stuck child process | the `will-quit` handler in `src/electron/main.ts`, telemetry lines in the log |
| only run 2 or 3 fails | state the previous launch left behind: `window-state.json`, settings, the token file, a lock or a clone in the profile | `profile/` after run 1 versus after the failure; `src/electron/windowState.ts`, `src/server/state.ts` |
| `Chromium fatal error` / `Check failed` | Chromium or Electron itself, usually flags or an unsupported environment | the line itself; whether the Electron version or the command-line switches changed |

To narrow it down: `--unpackaged` separates the bundle from the packaging,
`--runs 1` a first start from a restart, `--uptime 30` catches a timer or
sync that fires later, and `bun run dev:electron` gives an interactive look.
Fix the cause in `src/`, rebuild, rerun until all launches pass.

## Report back

Verdict first, then the per-launch lines the test printed (render time,
hold, quit, exit code, screen text), then for each failure the problem lines
and the log excerpt that explains them, and what you changed. Say which mode
ran (packaged or unpackaged) and on which platform — a run that only used
`--unpackaged` has not verified the packaged app — and that the screenshots
are in `dist/crash-test/`.

## Do not

- Do not turn a red run green by removing a crash signature, skipping a
  launch or lengthening a timeout. Raising `--ready-timeout` on a machine that
  is merely slow is fine; hiding a hang is not.
- Do not point the test at the developer's real profile or settings; the
  isolation is what makes three launches comparable.
- Do not leave `electron` or `Xvfb` processes behind. The test cleans up after
  itself, on Ctrl-C too; after a hard kill, stop `Xvfb` and the `electron`
  processes by hand.

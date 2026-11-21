// Automates specs/app/multiple-windows.feature.md "Closing and restarting":
// which windows come back after a restart, where each folder's window is
// put, and — every window loading the app from one origin — which window a
// request came from. The rules of src/electron/windowSession.ts, which
// main.ts wires to the windows.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadWindowSession,
  MAX_REMEMBERED_BOUNDS,
  parseWindowSession,
  planRestore,
  rememberBounds,
  requestWindow,
  saveWindowSession,
  sessionFor,
  WINDOW_HEADER,
  windowIdOf,
  windowUserAgent,
  type WindowSession,
} from "../src/electron/windowSession";

const dir = mkdtempSync(join(tmpdir(), "specdriven-window-session-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const at = (x: number) => ({ x, y: 40, width: 1300, height: 800, maximized: false });
const spec = (path: string) => ({ dataRepo: path });
const empty: WindowSession = { windows: [], bounds: {} };

test("every window open at quit comes back with its folder and its place", () => {
  const session: WindowSession = {
    windows: [
      { folder: spec("/specs/a"), bounds: at(10) },
      { folder: { dataRepo: "/specs/b", openCodeRepo: "/code/b" }, bounds: at(200), focused: true },
    ],
    bounds: {},
    mirror: spec("/specs/a"),
  };
  expect(planRestore(session, spec("/specs/a"))).toEqual([
    { folder: spec("/specs/a"), bounds: at(10) },
    { folder: { dataRepo: "/specs/b", openCodeRepo: "/code/b" }, bounds: at(200), focused: true },
  ]);
});

test("with nothing saved the app starts with one window on the folder the settings name", () => {
  expect(planRestore(null, spec("/specs/a"))).toEqual([{ folder: spec("/specs/a"), focused: true }]);
  // No folder was ever picked: one window, which asks for one.
  expect(planRestore(null, {})).toEqual([{ folder: {}, focused: true }]);
});

test("a file from before there were several windows is that one window, where it was", () => {
  const session = parseWindowSession(JSON.stringify({ x: 5, y: 6, width: 1400, height: 900, maximized: true }));
  expect(planRestore(session, spec("/specs/a"))).toEqual([
    { folder: spec("/specs/a"), bounds: { x: 5, y: 6, width: 1400, height: 900, maximized: true }, focused: true },
  ]);
});

test("a folder saved twice comes back as one window, and a window with no folder does not come back", () => {
  const session: WindowSession = {
    windows: [{ folder: spec("/specs/a") }, { folder: {} }, { folder: spec("/specs/a"), focused: true }],
    bounds: {},
    mirror: spec("/specs/a"),
  };
  expect(planRestore(session, spec("/specs/a"))).toEqual([{ folder: spec("/specs/a"), focused: true }]);
});

test("a folder picked elsewhere since the last run opens in the window used last", () => {
  const session: WindowSession = {
    windows: [{ folder: spec("/specs/a"), bounds: at(10) }, { folder: spec("/specs/b"), bounds: at(200), focused: true }],
    bounds: { "spec:/specs/z": at(555) },
    mirror: spec("/specs/b"),
  };
  // The web version, which shares the settings file, switched to /specs/z.
  expect(planRestore(session, spec("/specs/z"))).toEqual([
    { folder: spec("/specs/a"), bounds: at(10) },
    { folder: spec("/specs/z"), bounds: at(555), focused: true },
  ]);
});

test("a window closed before the quit stays closed, though the settings file still names its folder", () => {
  // Two windows; /specs/b wrote the settings last, then was closed.
  const session: WindowSession = {
    windows: [{ folder: spec("/specs/a"), focused: true }],
    bounds: {},
    mirror: spec("/specs/b"),
  };
  expect(planRestore(session, spec("/specs/b"))).toEqual([{ folder: spec("/specs/a"), focused: true }]);
});

test("a folder opened again comes back where its window was left", () => {
  let session = sessionFor(empty, [{ folder: spec("/specs/a"), bounds: at(10) }, { folder: spec("/specs/b"), bounds: at(300), focused: true }], spec("/specs/b"));
  // The second window is closed; only the first is saved from here on.
  session = sessionFor(session, [{ folder: spec("/specs/a"), bounds: at(10), focused: true }], spec("/specs/b"));
  expect(session.windows.map((w) => w.folder)).toEqual([spec("/specs/a")]);
  expect(session.bounds["spec:/specs/b"]).toEqual(at(300));
});

test("closing the last window keeps it as the one that comes back", () => {
  const one = sessionFor(empty, [{ folder: spec("/specs/a"), bounds: at(10), focused: true }], spec("/specs/a"));
  const none = sessionFor(one, [], spec("/specs/a"));
  expect(none.windows).toEqual(one.windows);
  // A window that only ever asked for a folder is not one to bring back.
  expect(sessionFor(one, [{ folder: {}, focused: true }], spec("/specs/a")).windows).toEqual(one.windows);
});

test("one of the saved windows is always the one in front", () => {
  const session = sessionFor(empty, [{ folder: spec("/specs/a") }, { folder: spec("/specs/b") }], undefined);
  expect(session.windows.map((w) => w.focused === true)).toEqual([true, false]);
  expect(planRestore({ ...session, windows: session.windows.map(({ focused: _f, ...w }) => w) }, {}).filter((w) => w.focused).length).toBe(1);
});

test("the places remembered are capped, the oldest going first", () => {
  let session = empty;
  for (let i = 0; i < MAX_REMEMBERED_BOUNDS + 5; i++) session = rememberBounds(session, `spec:/specs/${i}`, at(i));
  expect(Object.keys(session.bounds).length).toBe(MAX_REMEMBERED_BOUNDS);
  expect(session.bounds["spec:/specs/0"]).toBeUndefined();
  // Saved again, a folder is the newest.
  session = rememberBounds(session, "spec:/specs/5", at(99));
  expect(Object.keys(session.bounds).at(-1)).toBe("spec:/specs/5");
});

test("the session round-trips through its file; a corrupt file is no session", () => {
  const file = join(dir, "window-state.json");
  const session = sessionFor(empty, [{ folder: spec("/specs/a"), bounds: at(10), focused: true }], spec("/specs/a"));
  saveWindowSession(file, session);
  expect(loadWindowSession(file)).toEqual(session);
  writeFileSync(file, "{not json");
  expect(loadWindowSession(file)).toBeNull();
  expect(loadWindowSession(join(dir, "missing.json"))).toBeNull();
  // Rows that are not windows are dropped, not fatal.
  expect(parseWindowSession(JSON.stringify({ version: 2, windows: [7, { folder: "x" }], bounds: { k: { x: "?" } } }))).toEqual({
    windows: [{ folder: {} }],
    bounds: {},
  });
});

test("a request is told apart by the header the shell sets, or by its window's User-Agent", () => {
  const ua = windowUserAgent("Mozilla/5.0 Chrome/140 Electron/45.2.3 Safari/537.36", "w2");
  expect(ua).toBe("Mozilla/5.0 Chrome/140 Electron/45.2.3 Safari/537.36 SpecDrivenWindow/w2");
  // Set twice, a window's User-Agent names it once.
  expect(windowUserAgent(ua, "w3")).toBe("Mozilla/5.0 Chrome/140 Electron/45.2.3 Safari/537.36 SpecDrivenWindow/w3");
  expect(windowIdOf(new Headers({ "user-agent": ua }))).toBe("w2");
  expect(windowIdOf(new Headers({ [WINDOW_HEADER]: "w1", "user-agent": ua }))).toBe("w1");
  expect(windowIdOf(new Headers({ "user-agent": "Mozilla/5.0" }))).toBeNull();
});

test("with several windows a request that names none of them is nobody's", () => {
  const marked = new Headers({ [WINDOW_HEADER]: "w2" });
  const unmarked = new Headers();
  expect(requestWindow(marked, ["w1", "w2"])).toBe("w2");
  expect(requestWindow(unmarked, ["w1", "w2"])).toBeNull();
  // A window that has closed is not one to answer for.
  expect(requestWindow(new Headers({ [WINDOW_HEADER]: "w9" }), ["w1", "w2"])).toBeNull();
  // One window is asked nothing: every request is its own.
  expect(requestWindow(unmarked, ["w1"])).toBe("w1");
  expect(requestWindow(new Headers({ [WINDOW_HEADER]: "w9" }), ["w1"])).toBe("w1");
  expect(requestWindow(unmarked, [])).toBeNull();
});

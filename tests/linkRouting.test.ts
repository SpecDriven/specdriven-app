// Automates specs/app/desktop-app.feature.md "External links" and
// specs/ui/navigation.feature.md "a second link reuses the running app":
// where a url the window tries to reach ends up, and how a specdriven://
// link reaches the one window (src/electron/linkRouting.ts). main.ts only
// wires these to Electron, so nothing here launches it.

import { describe, expect, test } from "bun:test";
import { linkEntry } from "../src/frontend/route";
import {
  createLinkRouter,
  historyJump,
  navigationTarget,
  windowOpenTarget,
  type LinkWindow,
} from "../src/electron/linkRouting";

const APP = "app://specdriven";
const DEV = "http://localhost:3000";
const TEST_URL =
  "https://github.com/SpecDriven/specdriven_app/blob/main/tests/windowState.test.ts#L120";

describe("links that leave the app", () => {
  test("a test link on GitHub opens in the browser, not in a new window", () => {
    // Test links render as target=_blank anchors (src/frontend/markdown.tsx).
    expect(windowOpenTarget(TEST_URL)).toEqual({ kind: "browser", url: TEST_URL });
  });

  test("a click that would navigate the window away goes to the browser instead", () => {
    expect(navigationTarget(TEST_URL, [APP])).toEqual({ kind: "browser", url: TEST_URL });
    expect(navigationTarget("http://example.com/", [APP])).toEqual({
      kind: "browser",
      url: "http://example.com/",
    });
  });

  test("the app's own pages stay in the window", () => {
    expect(navigationTarget(`${APP}/features/quotes`, [APP])).toEqual({ kind: "inside" });
    expect(navigationTarget(`${DEV}/features/quotes`, [APP, DEV])).toEqual({ kind: "inside" });
  });

  test("an origin that only starts like the app's is not the app", () => {
    expect(navigationTarget("http://localhost:30001/x", [APP, DEV])).toEqual({
      kind: "browser",
      url: "http://localhost:30001/x",
    });
    expect(navigationTarget("app://specdriven.evil/x", [APP])).toEqual({ kind: "drop" });
  });

  test("the app never opens a second window, even onto its own pages", () => {
    expect(windowOpenTarget(`${APP}/features/quotes`)).toEqual({ kind: "drop" });
  });

  test("schemes that are not web pages go nowhere", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "mailto:a@b.c", "ftp://x/y"]) {
      expect(windowOpenTarget(url)).toEqual({ kind: "drop" });
      expect(navigationTarget(url, [APP])).toEqual({ kind: "drop" });
    }
  });

  test("a specdriven link in a spec body is followed in place", () => {
    expect(windowOpenTarget("specdriven://features/quotes")).toEqual({
      kind: "deep",
      path: "/features/quotes",
    });
    expect(navigationTarget("specdriven://features/quotes", [APP])).toEqual({
      kind: "deep",
      path: "/features/quotes",
    });
  });
});

/** A stand-in for the app window that records what was done to it. */
function fakeWindow(opts: { minimized?: boolean; loading?: boolean } = {}) {
  const calls: string[] = [];
  let onLoad: (() => void) | null = null;
  const win: LinkWindow = {
    isMinimized: () => Boolean(opts.minimized),
    restore: () => calls.push("restore"),
    focus: () => calls.push("focus"),
    isLoading: () => Boolean(opts.loading),
    afterLoad: (fn) => {
      onLoad = fn;
    },
    run: (script) => calls.push(`run ${script}`),
  };
  return { win, calls, finishLoad: () => onLoad?.() };
}

function router(win: LinkWindow | null) {
  let opened = 0;
  const r = createLinkRouter({ window: () => win, openWindow: () => opened++ });
  return { r, opened: () => opened };
}

/** Runs a history jump against a stand-in history, as the renderer would. */
function runJump(script: string) {
  const events: string[] = [];
  const history = {
    pushState: (_s: unknown, _t: string, url: string) => events.push(`push ${url}`),
    replaceState: (_s: unknown, _t: string, url: string) => events.push(`replace ${url}`),
  };
  class PopStateEvent {
    constructor(readonly type: string) {}
  }
  const dispatchEvent = (e: PopStateEvent) => events.push(`event ${e.type}`);
  const location = {
    reload: () => events.push("reload"),
    assign: (u: string) => events.push(`assign ${u}`),
  };
  new Function("history", "PopStateEvent", "dispatchEvent", "location", script)(
    history,
    PopStateEvent,
    dispatchEvent,
    location,
  );
  return events;
}

describe("a second link reuses the running app", () => {
  test("a link moves the open window to the linked page, with no second window", () => {
    const { win, calls } = fakeWindow();
    const { r, opened } = router(win);
    r.open("/features/quotes");
    expect(opened()).toBe(0);
    expect(calls).toEqual(["focus", `run ${historyJump("/features/quotes")}`]);
  });

  test("the move is a history push, so Back returns and nothing reloads", () => {
    expect(runJump(historyJump("/features/quotes"))).toEqual([
      `push ${linkEntry("/features/quotes")}`,
      "event popstate",
    ]);
  });

  test("a hostile path stays a path", () => {
    const path = `/features/x");location.reload();("`;
    expect(runJump(historyJump(path))).toEqual([`push ${linkEntry(path)}`, "event popstate"]);
  });

  test("a minimized window is restored and brought to the front", () => {
    const { win, calls } = fakeWindow({ minimized: true });
    router(win).r.open("/features/quotes");
    expect(calls.slice(0, 2)).toEqual(["restore", "focus"]);
  });

  test("a window still loading takes the link once it has loaded", () => {
    const { win, calls, finishLoad } = fakeWindow({ loading: true });
    router(win).r.open("/features/quotes");
    expect(calls).toEqual(["focus"]);
    finishLoad();
    expect(calls).toEqual(["focus", `run ${historyJump("/features/quotes")}`]);
  });

  test("a second launch carrying a link shows it in the running window", () => {
    const { win, calls } = fakeWindow();
    const { r, opened } = router(win);
    r.secondLaunch(["/opt/SpecDriven/specdriven", "--no-sandbox", "specdriven://features/quotes"]);
    expect(opened()).toBe(0);
    expect(calls).toEqual(["focus", `run ${historyJump("/features/quotes")}`]);
  });

  test("a second launch without a link only brings the window to the front", () => {
    const { win, calls } = fakeWindow({ minimized: true });
    const { r, opened } = router(win);
    r.secondLaunch(["/opt/SpecDriven/specdriven"]);
    expect(opened()).toBe(0);
    expect(calls).toEqual(["restore", "focus"]);
  });

  test("with no window open, a link opens one on the linked page", () => {
    const { r, opened } = router(null);
    r.open("/features/quotes");
    expect(opened()).toBe(1);
    expect(r.takeEntry()).toBe(linkEntry("/features/quotes"));
    // Consumed: a later window starts at home.
    expect(r.takeEntry()).toBe("/");
  });

  test("a launch by link opens the first window on that page", () => {
    const { r } = router(null);
    r.holdLaunchLink(["/opt/SpecDriven/specdriven", "specdriven://features/quotes"]);
    expect(r.takeEntry()).toBe(linkEntry("/features/quotes"));
  });

  test("a link that arrived before the launch arguments were read wins", () => {
    // macOS: open-url runs before whenReady reads process.argv.
    const { r } = router(null);
    r.open("/features/from-open-url");
    r.holdLaunchLink(["specdriven://features/from-argv"]);
    expect(r.takeEntry()).toBe(linkEntry("/features/from-open-url"));
  });

  test("followed deep links are shown; browser links go out; the rest are dropped", () => {
    const { win, calls } = fakeWindow();
    const { r } = router(win);
    const browsed: string[] = [];
    const browse = (u: string) => browsed.push(u);
    r.follow(windowOpenTarget(TEST_URL), browse);
    r.follow(windowOpenTarget("file:///etc/passwd"), browse);
    r.follow(windowOpenTarget("specdriven://features/quotes"), browse);
    expect(browsed).toEqual([TEST_URL]);
    expect(calls).toEqual(["focus", `run ${historyJump("/features/quotes")}`]);
  });
});

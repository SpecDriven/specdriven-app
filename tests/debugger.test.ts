import { describe, expect, test } from "bun:test";
import { DEBUG_PORT, devtoolsUrl, startInspector, type InspectorApi } from "../src/electron/debugger";

/** Node's inspector as observed in Electron: a busy port opens nothing. */
function fakeInspector(busy: number[] = [], running?: string) {
  const opened: Array<[number | undefined, string | undefined]> = [];
  let url = running;
  const api: InspectorApi = {
    url: () => url,
    open: ((port?: number, host?: string) => {
      opened.push([port, host]);
      if (!busy.includes(port ?? DEBUG_PORT)) url = `ws://${host}:${port || 40123}/abc`;
    }) as InspectorApi["open"],
  };
  return { api, opened };
}

describe("startInspector", () => {
  test("opens the default port on loopback", () => {
    const { api, opened } = fakeInspector();
    expect(startInspector(api)).toBe("ws://127.0.0.1:9229/abc");
    expect(opened).toEqual([[9229, "127.0.0.1"]]);
  });

  test("falls back to a free port when the default is taken", () => {
    const { api, opened } = fakeInspector([9229]);
    expect(startInspector(api)).toBe("ws://127.0.0.1:40123/abc");
    expect(opened).toEqual([
      [9229, "127.0.0.1"],
      [0, "127.0.0.1"],
    ]);
  });

  test("reuses an inspector that is already running", () => {
    const { api, opened } = fakeInspector([], "ws://127.0.0.1:5555/xyz");
    expect(startInspector(api)).toBe("ws://127.0.0.1:5555/xyz");
    expect(opened).toEqual([]);
  });

  test("null when no port opens", () => {
    const { api } = fakeInspector([9229, 0]);
    expect(startInspector(api)).toBeNull();
  });
});

test("devtoolsUrl points Chrome's DevTools at the inspector", () => {
  expect(devtoolsUrl("ws://127.0.0.1:9229/abc")).toBe(
    "devtools://devtools/bundled/js_app.html?ws=127.0.0.1:9229/abc",
  );
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fitToDisplays,
  loadWindowState,
  MIN_HEIGHT,
  MIN_WIDTH,
  parseWindowState,
  saveWindowState,
  type WindowState,
} from "../src/electron/windowState";

const state = (over: Partial<WindowState> = {}): WindowState => ({
  x: 100,
  y: 100,
  width: 1280,
  height: 860,
  ...over,
});

describe("parseWindowState", () => {
  test("a saved state round-trips", () => {
    const s = state({ maximized: true });
    expect(parseWindowState(JSON.stringify(s))).toEqual(s);
  });

  test("missing or empty input reads as null", () => {
    expect(parseWindowState(null)).toBeNull();
    expect(parseWindowState("")).toBeNull();
  });

  test("garbage never throws", () => {
    expect(parseWindowState("{not json")).toBeNull();
    expect(parseWindowState("42")).toBeNull();
    expect(parseWindowState("[]")).toBeNull();
    expect(parseWindowState("null")).toBeNull();
  });

  test("wrong-shaped objects read as null", () => {
    expect(parseWindowState(JSON.stringify({ x: 1, y: 2 }))).toBeNull();
    expect(parseWindowState(JSON.stringify(state({ width: Number.NaN })))).toBeNull();
    expect(parseWindowState(JSON.stringify({ ...state(), height: "860" }))).toBeNull();
    expect(parseWindowState(JSON.stringify(state({ width: Infinity })))).toBeNull();
    expect(parseWindowState(JSON.stringify(state({ width: 0 })))).toBeNull();
    expect(parseWindowState(JSON.stringify(state({ height: -1 })))).toBeNull();
  });

  test("maximized must be exactly true", () => {
    expect(parseWindowState(JSON.stringify({ ...state(), maximized: 1 }))?.maximized).toBe(false);
    expect(parseWindowState(JSON.stringify({ ...state(), maximized: "yes" }))?.maximized).toBe(
      false,
    );
  });

  test("unknown extra keys are tolerated and dropped", () => {
    expect(parseWindowState(JSON.stringify({ ...state(), theme: "dark" }))).toEqual({
      ...state(),
      maximized: false,
    });
  });
});

describe("fitToDisplays", () => {
  const laptop = { x: 0, y: 0, width: 1920, height: 1080 };

  test("null state stays null", () => {
    expect(fitToDisplays(null, [laptop])).toBeNull();
  });

  test("bounds fully on-screen and large enough pass through unchanged", () => {
    expect(fitToDisplays(state(), [laptop])).toEqual({ ...state(), maximized: false });
  });

  test("a too-small saved size is raised to the minimums", () => {
    const fitted = fitToDisplays(state({ width: 800, height: 600 }), [laptop]);
    expect(fitted?.width).toBe(MIN_WIDTH);
    expect(fitted?.height).toBe(MIN_HEIGHT);
  });

  test("bounds larger than the work area are capped and moved to fit", () => {
    const fitted = fitToDisplays(state({ x: 50, y: 50, width: 3000, height: 2000 }), [laptop]);
    expect(fitted).toEqual({ x: 0, y: 0, width: 1920, height: 1080, maximized: false });
  });

  test("a window on a disconnected monitor falls back to null", () => {
    expect(fitToDisplays(state({ x: 3000 }), [laptop])).toBeNull();
    expect(fitToDisplays(state(), [])).toBeNull();
  });

  test("bounds hanging off an edge are pulled back inside", () => {
    const fitted = fitToDisplays(state({ x: 1500, y: 900 }), [laptop]);
    expect(fitted?.x).toBe(1920 - 1280);
    expect(fitted?.y).toBe(1080 - 860);
  });

  test("a display left of the primary keeps its negative coordinates", () => {
    const secondary = { x: -2560, y: 0, width: 2560, height: 1440 };
    const s = state({ x: -2000, y: 200 });
    expect(fitToDisplays(s, [laptop, secondary])).toEqual({ ...s, maximized: false });
  });

  test("bounds straddling two displays land on the one with more overlap", () => {
    const right = { x: 1920, y: 0, width: 1920, height: 1080 };
    // 200px on the laptop, 1080px on the right display.
    const fitted = fitToDisplays(state({ x: 1720, y: 0 }), [laptop, right]);
    expect(fitted?.x).toBe(1920);
  });

  test("maximized survives fitting", () => {
    expect(fitToDisplays(state({ maximized: true }), [laptop])?.maximized).toBe(true);
  });
});

describe("load/saveWindowState", () => {
  const dir = mkdtempSync(join(tmpdir(), "window-state-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("save then load round-trips", () => {
    const file = join(dir, "window-state.json");
    const s = state({ maximized: true });
    saveWindowState(file, s);
    expect(loadWindowState(file)).toEqual(s);
  });

  test("a missing file reads as null", () => {
    expect(loadWindowState(join(dir, "nope.json"))).toBeNull();
  });

  test("a corrupt file reads as null", () => {
    const file = join(dir, "corrupt.json");
    writeFileSync(file, "{broken");
    expect(loadWindowState(file)).toBeNull();
  });
});

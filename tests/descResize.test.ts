// specs/editor/feature-editor.feature.md "Edit feature descrition": the
// description editor's lower boundary is dragged to give the description more
// or less room. The drag runs through one clamp, so neither a drag nor an
// arrow-key nudge can shrink the editor to nothing or push the scenario list
// off the window.
import { describe, expect, test } from "bun:test";
import { clampDescHeight } from "../src/frontend/App";

const WINDOW = 1000; // a 1000px-tall window: min 120, max 750

describe("the height the description editor is dragged to", () => {
  test("a height between the bounds is taken as dragged", () => {
    expect(clampDescHeight(400, WINDOW)).toBe(400);
  });

  test("dragging up past the minimum stops at it", () => {
    expect(clampDescHeight(40, WINDOW)).toBe(120);
    expect(clampDescHeight(-200, WINDOW)).toBe(120);
  });

  test("dragging down stops with a quarter of the window left for the scenarios", () => {
    expect(clampDescHeight(900, WINDOW)).toBe(750);
  });

  test("fractional pixels from the pointer land on whole ones", () => {
    expect(clampDescHeight(400.4, WINDOW)).toBe(400);
    expect(clampDescHeight(400.6, WINDOW)).toBe(401);
  });

  test("on a window too short for both bounds the minimum wins, so the editor stays usable", () => {
    expect(clampDescHeight(300, 100)).toBe(120);
    expect(clampDescHeight(10, 100)).toBe(120);
  });
});

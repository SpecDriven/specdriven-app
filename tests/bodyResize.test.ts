// specs/editor/spec-editor.feature.md "Spec body resize": the scenario body's
// lower boundary is dragged to give the body more or less room when the
// table, ticket and test links below crowd it. The drag runs through one
// clamp, so neither a drag nor an arrow-key nudge can shrink the body to
// nothing or carry its strip off the window.
import { describe, expect, test } from "bun:test";
import { clampBodyHeight } from "../src/frontend/App";

const WINDOW = 1000; // a 1000px-tall window: min 120, max 850

describe("the height the scenario body is dragged to", () => {
  test("a height between the bounds is taken as dragged", () => {
    expect(clampBodyHeight(600, WINDOW)).toBe(600);
  });

  test("dragging up past the minimum stops at it", () => {
    expect(clampBodyHeight(40, WINDOW)).toBe(120);
    expect(clampBodyHeight(-200, WINDOW)).toBe(120);
  });

  test("dragging down stops while the strip is still on the window", () => {
    expect(clampBodyHeight(1400, WINDOW)).toBe(850);
  });

  test("fractional pixels from the pointer land on whole ones", () => {
    expect(clampBodyHeight(600.4, WINDOW)).toBe(600);
    expect(clampBodyHeight(600.6, WINDOW)).toBe(601);
  });

  test("on a window too short for both bounds the minimum wins, so the body stays usable", () => {
    expect(clampBodyHeight(300, 100)).toBe(120);
  });
});

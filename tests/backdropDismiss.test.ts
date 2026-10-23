// specs/ui/ui.feature.md "Dialogs": a click outside closes a dialog, a drag
// that starts inside it (selecting a field's text past its edge) does not.
import { describe, expect, test } from "bun:test";
import type { MouseEvent } from "react";
import { backdropDismiss } from "../src/frontend/backdropDismiss";

const backdrop = { name: "backdrop" };
const field = { name: "parent page url field" };
const event = (target: object) => ({ target, currentTarget: backdrop }) as unknown as MouseEvent;

/** Press on `down`, release so the browser clicks `clicked`; returns how often it closed. */
function gesture(down: object, clicked: object) {
  let closed = 0;
  const handlers = backdropDismiss(() => closed++);
  handlers.onMouseDown(event(down));
  handlers.onClick(event(clicked));
  return closed;
}

describe("backdropDismiss", () => {
  test("a click outside the dialog closes it", () => {
    expect(gesture(backdrop, backdrop)).toBe(1);
  });

  test("selecting a field's text by dragging out of the dialog keeps it open", () => {
    // The browser sends that drag's click to the backdrop, the nearest
    // element holding both the press and the release.
    expect(gesture(field, backdrop)).toBe(0);
  });

  test("a drag from outside that ends inside the dialog keeps it open", () => {
    expect(gesture(backdrop, field)).toBe(0);
  });

  test("a stray click with no press before it keeps the dialog open", () => {
    gesture(field, backdrop); // clears the last press
    let closed = 0;
    backdropDismiss(() => closed++).onClick(event(backdrop));
    expect(closed).toBe(0);
  });
});

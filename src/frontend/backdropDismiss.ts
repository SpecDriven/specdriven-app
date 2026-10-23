import type { MouseEvent } from "react";

// Where the last press began. One pointer presses at a time, so one slot is
// enough, and it outlives any re-render between the press and the release.
let pressedOn: EventTarget | null = null;

/**
 * specs/ui/ui.feature.md "Dialogs": a click outside a dialog closes it, but a
 * drag that starts inside — selecting a field's text past its edge — never
 * does. The browser sends that drag's click to the backdrop (the nearest
 * element holding both ends), so only a press and a release that both land
 * on the backdrop itself count.
 *
 * Spread the result onto the backdrop element.
 */
export function backdropDismiss(close: () => void) {
  return {
    onMouseDown: (e: MouseEvent) => {
      pressedOn = e.target;
    },
    onClick: (e: MouseEvent) => {
      const started = pressedOn;
      pressedOn = null;
      if (e.target === e.currentTarget && started === e.currentTarget) close();
    },
  };
}

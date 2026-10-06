import { useSyncExternalStore } from "react";

// Editor font size (specs/editor/common-editor.feature.md "Increase and
// decrease font size"): two buttons next to the Heading button in every
// Markdown editor's toolbar step the text up and down. One size for every
// editor — feature, scenario, page, test — and, like Vim mode, kept on this
// device (localStorage): it is about the eyes at the screen, not the project.

const KEY = "sd-editor-font";
/** Fired on window when the size changes, so every open editor follows. */
const EVENT = "sd-editor-font-change";

/**
 * The sizes the buttons step through, as a scale on the editor's own size
 * (13px). 1 is where an editor starts, and what a cleared or unreadable
 * preference falls back to.
 */
export const FONT_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2] as const;
export const DEFAULT_FONT_SCALE = 1;

export function readFontScale(): number {
  try {
    const stored = Number(localStorage.getItem(KEY));
    return (FONT_SCALES as readonly number[]).includes(stored) ? stored : DEFAULT_FONT_SCALE;
  } catch {
    return DEFAULT_FONT_SCALE;
  }
}

export function applyFontScale(scale: number): void {
  try {
    if (scale === DEFAULT_FONT_SCALE) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(scale));
  } catch {
    // Storage unavailable (private mode): the size just won't stick.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/**
 * The next size up (`step` 1) or down (-1) from `scale`; the same size at
 * either end of the range. A scale between steps moves to the nearest step
 * that way.
 */
export function stepFontScale(scale: number, step: 1 | -1): number {
  if (step > 0) return FONT_SCALES.find((s) => s > scale) ?? FONT_SCALES[FONT_SCALES.length - 1]!;
  return [...FONT_SCALES].reverse().find((s) => s < scale) ?? FONT_SCALES[0];
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  // Another window of the app changing it.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const serverScale = () => DEFAULT_FONT_SCALE;

/** The editors' font scale; re-renders when any editor's buttons change it. */
export function useFontScale(): number {
  return useSyncExternalStore(subscribe, readFontScale, serverScale);
}

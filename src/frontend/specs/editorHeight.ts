// The heights of the two editors a strip drags taller or shorter — the
// feature's description and a scenario's body — remembered on this device,
// like the sidebar's width.

// Description editor height (specs/editor/feature-editor.feature.md): the
// editor opens a third of the window tall and is dragged taller or shorter by
// the strip along its lower boundary.
export const DESC_MIN = 120;
export const DESC_HEIGHT_KEY = "sd-desc-height";

export function clampDescHeight(h: number, windowHeight: number): number {
  // The scenario list below keeps at least a quarter of the window, so the
  // editor can never swallow the page it belongs to.
  const max = Math.max(DESC_MIN, Math.round(windowHeight * 0.75));
  return Math.min(Math.max(Math.round(h), DESC_MIN), max);
}

// Scenario body height (specs/editor/spec-editor.feature.md "Spec body
// resize"): the body editor opens at least 40% of the window tall and is
// dragged taller or shorter by the strip under it; the pane's column scrolls
// to whatever is below.
export const BODY_MIN = 120;
export const BODY_HEIGHT_KEY = "sd-body-height";

export function clampBodyHeight(h: number, windowHeight: number): number {
  // The pane scrolls, so the body may outgrow it — but never past what fits
  // the window, or the strip would end up off screen mid-drag.
  const max = Math.max(BODY_MIN, Math.round(windowHeight * 0.85));
  return Math.min(Math.max(Math.round(h), BODY_MIN), max);
}

export function readEditorHeight(key: string, min: number): number | null {
  try {
    const h = Number(localStorage.getItem(key));
    // Nothing stored, or junk: the CSS default stands until a first drag.
    return Number.isFinite(h) && h >= min ? Math.round(h) : null;
  } catch {
    return null;
  }
}

/** A height, or null to clear it on a double-click: back to the CSS default. */
export function storeEditorHeight(key: string, h: number | null): void {
  try {
    if (h === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(h));
  } catch {
    // Storage unavailable (private mode): the height just won't stick.
  }
}

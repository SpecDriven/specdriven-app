// Window geometry for the desktop shell (specs/app/desktop-app.feature.md
// "Window"): the size and position survive a restart, clamped to the
// minimums the layout needs and to the displays actually present. Pure
// geometry and parsing, kept out of main.ts so it runs under bun test.

import { readFileSync, writeFileSync } from "node:fs";

export type Rect = { x: number; y: number; width: number; height: number };
export type WindowState = Rect & { maximized?: boolean };

// Below 1280×700 the layout hides buttons and scrollbars (#55).
export const MIN_WIDTH = 1280;
export const MIN_HEIGHT = 700;
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 860;

// The window must overlap a display by at least a grabbable title bar's
// worth before its saved position counts as on-screen.
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 50;

/** Persisted JSON -> WindowState; null for missing, corrupt or wrong-shaped data. */
export function parseWindowState(raw: string | null): WindowState | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { x, y, width, height, maximized } = data as Record<string, unknown>;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return {
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
    maximized: maximized === true,
  };
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * Saved state fitted to the current displays: size raised to the minimums
 * and capped to the work area it mostly sits on, position clamped so the
 * window is fully inside it. Null when no display shows enough of the
 * window to grab (a monitor was disconnected) — the caller then falls back
 * to the centered default.
 */
export function fitToDisplays(
  state: WindowState | null,
  workAreas: readonly Rect[],
): WindowState | null {
  if (!state) return null;
  let best: Rect | null = null;
  let bestArea = 0;
  for (const wa of workAreas) {
    const o = overlap(state, wa);
    if (o.width < MIN_VISIBLE_WIDTH || o.height < MIN_VISIBLE_HEIGHT) continue;
    const area = o.width * o.height;
    if (area > bestArea) {
      best = wa;
      bestArea = area;
    }
  }
  if (!best) return null;
  const width = Math.min(Math.max(state.width, MIN_WIDTH), best.width);
  const height = Math.min(Math.max(state.height, MIN_HEIGHT), best.height);
  const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));
  return {
    x: clamp(state.x, best.x, best.x + best.width - width),
    y: clamp(state.y, best.y, best.y + best.height - height),
    width,
    height,
    maximized: state.maximized === true,
  };
}

// Sync I/O is deliberate: the read happens once before the window exists,
// and the write on `close` must land before the app quits. Both fail soft —
// persistence is best-effort, never a startup crash.

/** State from the file, or null when it is missing or unreadable. */
export function loadWindowState(file: string): WindowState | null {
  try {
    return parseWindowState(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Best-effort write; a failure loses nothing but the remembered geometry. */
export function saveWindowState(file: string, state: WindowState): void {
  try {
    writeFileSync(file, JSON.stringify(state));
  } catch {
    // Ignored — next launch simply opens at the default size.
  }
}

import { useSyncExternalStore } from "react";

// Excalidraw support (specs/editor/excalidraw-support.feature.md): a switch
// in Settings adds a diagram button to every Markdown editor's toolbar. Like
// Vim mode (src/frontend/vimPref.ts) the choice lives on this device
// (localStorage), not in the settings file — it is a habit of the person at
// the keyboard, not a property of the project.
//
// Demo mode (src/server/demo.ts) differs from Vim mode, which the demo pins
// off: drawing is the feature a visitor came to see and a button in a toolbar
// traps nobody, so here the demo only moves the DEFAULT to on. The switch
// still works and a visitor who turns it off keeps it off — the choice is
// stored either way, so "off" is a decision rather than the absence of one.

const KEY = "sd-excalidraw";
/** Fired on window when the preference changes, so open editors follow. */
const EVENT = "sd-excalidraw-change";

/** Demo mode: on unless this device says otherwise. */
let demoDefaultOn = false;

/** Told by App.tsx once /api/state reports demo mode. */
export function setExcalidrawDemoMode(on: boolean): void {
  if (demoDefaultOn === on) return;
  demoDefaultOn = on;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export function readExcalidrawPref(): boolean {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "on") return true;
    if (stored === "off") return false;
  } catch {
    // Storage unavailable (private mode): fall through to the default.
  }
  return demoDefaultOn;
}

export function applyExcalidrawPref(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable (private mode): the choice just won't stick.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  // Another window of the app flipping the switch.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Whether Excalidraw support is on; re-renders when the Settings switch flips. */
export function useExcalidrawEnabled(): boolean {
  return useSyncExternalStore(subscribe, readExcalidrawPref, readExcalidrawPref);
}

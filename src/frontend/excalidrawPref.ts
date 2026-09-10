import { useSyncExternalStore } from "react";

// Excalidraw support (specs/editor/excalidraw-support.feature.md): a switch
// in Settings adds a diagram button to every Markdown editor's toolbar. Like
// Vim mode (src/frontend/vimPref.ts) the choice lives on this device
// (localStorage), not in the settings file — it is a habit of the person at
// the keyboard, not a property of the project. Unlike Vim mode it is not
// pinned off in the demo: it is opt-in and cannot trap a visitor.

const KEY = "sd-excalidraw";
/** Fired on window when the preference changes, so open editors follow. */
const EVENT = "sd-excalidraw-change";

export function readExcalidrawPref(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function applyExcalidrawPref(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
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

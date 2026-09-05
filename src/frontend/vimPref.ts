import { useSyncExternalStore } from "react";

// Vim mode (specs/ui.spec.md "Settings"): a switch in Settings adds a Vim tab
// to every Markdown editor. Like the theme, the choice lives on this device
// (localStorage), not in the settings file — it is a habit of the person at
// the keyboard, not a property of the project.

const KEY = "sd-vim";
/** Fired on window when the preference changes, so open editors follow. */
const EVENT = "sd-vim-change";

export function readVimPref(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function applyVimPref(on: boolean): void {
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

/** Whether Vim mode is on; re-renders when the Settings switch flips. */
export function useVimMode(): boolean {
  return useSyncExternalStore(subscribe, readVimPref, readVimPref);
}

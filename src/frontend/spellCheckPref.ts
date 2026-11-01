import { useSyncExternalStore } from "react";

// Spell check (specs/editor/common-editor.feature.md "Spell check"): every
// place the user writes prose — the Markdown editor's Write and Vim tabs,
// the merge-conflict draft, the agent's message box, a bug report, an issue
// title, a test note, a proposal — gets the browser's own spell checker: a
// wavy underline under a misspelt word, and the usual right-click
// suggestions (which the desktop shell provides itself,
// src/electron/contextMenu.ts). Fields that hold code or identifiers — urls,
// test names, attribute definitions, table cells — keep it off, where a
// red underline would only be noise.
//
// On by default. A switch in Settings turns it off for people who find the
// underlines distracting, and like Vim mode (src/frontend/vimPref.ts) the
// choice lives on this device (localStorage): it is a habit of the person at
// the keyboard, not a property of the project.

const KEY = "sd-spellcheck";
/** Fired on window when the preference changes, so every open editor follows. */
const EVENT = "sd-spellcheck-change";

export function readSpellCheckPref(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    // Storage unavailable (private mode): the default.
    return true;
  }
}

export function applySpellCheckPref(on: boolean): void {
  try {
    // On is the default, so it is the absence of a choice; only off is stored.
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    // Storage unavailable (private mode): the choice just won't stick.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/**
 * The attributes CodeMirror's editable element needs. CodeMirror sets
 * `spellcheck="false"` on it by default (so the browser leaves code alone),
 * and this overrides that for the Vim tab, whose text is prose like the Write
 * tab's. `EditorView.contentAttributes.of(spellCheckContentAttributes(on))`
 * — the facet's values win over the defaults.
 */
export function spellCheckContentAttributes(on: boolean): Record<string, string> {
  return { spellcheck: on ? "true" : "false" };
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

/** Whether spell check is on; re-renders when the Settings switch flips. */
export function useSpellCheck(): boolean {
  return useSyncExternalStore(subscribe, readSpellCheckPref, readSpellCheckPref);
}

import { useSyncExternalStore } from "react";

// Whether the Pomodoro is part of this person's app at all, and whether its
// bar is on screen (specs/app/pomodoro.feature.md). Like Vim mode
// (src/frontend/vimPref.ts) and Excalidraw (src/frontend/excalidrawPref.ts)
// both choices live on this device (localStorage), not in the settings file —
// they are a habit of the person at the keyboard, not a property of the
// project.
//
// Two preferences, because they answer different questions:
//
// - `enabled`, the switch in Settings, is "do I time my own work here?". It
//   is OFF by default: most people came to write specs, and a timer nobody
//   asked for is a row of sidebar taken from the work. Off means off — no
//   bar, no icon, no `p` key, no palette entries.
// - `shown` is "do I want the bar out right now?", and only matters once the
//   feature is on. The bar carries a clock, a progress line, the cycle's dots
//   and a button; that is a lot of a narrow sidebar to spend on a timer you
//   glance at twice an hour. Hidden, the whole thing folds into one small
//   icon that toggles it back. It starts shown, so turning the feature on in
//   Settings shows you what you just switched on.
//
// Hiding is not stopping: a running timer keeps running behind the icon (the
// icon carries its clock) and the window title keeps counting down. Stopping
// is the ⋯ menu's "Stop Pomodoro".

const ENABLED_KEY = "sd-pomodoro-enabled";
const SHOWN_KEY = "sd-pomodoro-shown";
/** Fired on window when either preference changes, so the sidebar follows. */
const EVENT = "sd-pomodoro-pref-change";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (stored === "on") return true;
    if (stored === "off") return false;
  } catch {
    // Storage unavailable (private mode): fall through to the default.
  }
  return fallback;
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // Storage unavailable (private mode): the choice just won't stick.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/** Whether the Pomodoro exists in this app at all. Off until asked for. */
export function readPomodoroEnabled(): boolean {
  return readFlag(ENABLED_KEY, false);
}

export function applyPomodoroEnabled(on: boolean): void {
  writeFlag(ENABLED_KEY, on);
}

/** Whether the bar is out, as opposed to folded into its icon. */
export function readPomodoroShown(): boolean {
  return readFlag(SHOWN_KEY, true);
}

export function applyPomodoroShown(on: boolean): void {
  writeFlag(SHOWN_KEY, on);
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

/** Whether the Pomodoro is on; re-renders when the Settings switch flips. */
export function usePomodoroEnabled(): boolean {
  return useSyncExternalStore(subscribe, readPomodoroEnabled, readPomodoroEnabled);
}

/** Whether the bar is out; re-renders when the icon toggles it. */
export function usePomodoroShown(): boolean {
  return useSyncExternalStore(subscribe, readPomodoroShown, readPomodoroShown);
}

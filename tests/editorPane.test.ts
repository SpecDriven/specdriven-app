// specs/ui/ui.feature.md "Hide the editor pane": the editor column can be
// hidden so the coding agent pane takes the window, and the choice is
// remembered on the device the way the sidebar's collapse and width are.
// The preference alone is tested here — pure storage, no DOM.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readEditorHidden, storeEditorHidden } from "../src/frontend/App";

const KEY = "sd-editor-hidden";

/** A stand-in for the browser's, so the helpers have one to talk to. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

const original = Reflect.getOwnPropertyDescriptor(globalThis, "localStorage");

function useStorage(storage: Storage | (() => never)) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: typeof storage === "function" ? storage : () => storage,
  });
}

beforeEach(() => useStorage(fakeStorage()));

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("the editor pane's remembered visibility", () => {
  test("nothing stored means the editor shows — the column is there by default", () => {
    expect(readEditorHidden()).toBe(false);
  });

  test("hiding it survives the round trip", () => {
    storeEditorHidden(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    expect(readEditorHidden()).toBe(true);
  });

  test("showing it again clears the key rather than storing a falsy one", () => {
    storeEditorHidden(true);
    storeEditorHidden(false);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readEditorHidden()).toBe(false);
  });

  test("junk under the key reads as shown: only \"1\" hides the editor", () => {
    localStorage.setItem(KEY, "yes");
    expect(readEditorHidden()).toBe(false);
    localStorage.setItem(KEY, "0");
    expect(readEditorHidden()).toBe(false);
  });

  test("storage unavailable (private mode): the editor shows and storing is quiet", () => {
    useStorage(() => {
      throw new Error("denied");
    });
    expect(readEditorHidden()).toBe(false);
    expect(() => storeEditorHidden(true)).not.toThrow();
    expect(() => storeEditorHidden(false)).not.toThrow();
  });
});

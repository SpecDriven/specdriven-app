// specs/editor/common-editor.feature.md "Spell check": every field that
// holds prose has the browser's spell checker on, a switch in Settings turns
// it off for this device, and fields that hold urls, names and code keep it
// off either way. The switch is device-local like Vim mode
// (src/frontend/spellCheckPref.ts); the Vim tab's CodeMirror editor, which
// disables the checker itself, is turned back on through its content
// attributes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownEditor } from "../src/frontend/MarkdownEditor";
import {
  applySpellCheckPref,
  readSpellCheckPref,
  spellCheckContentAttributes,
} from "../src/frontend/spellCheckPref";

// The preference lives in localStorage, which bun's test runtime lacks.
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const g = globalThis as { localStorage?: Storage };
let saved: Storage | undefined;

beforeEach(() => {
  saved = g.localStorage;
  g.localStorage = fakeStorage();
});

afterEach(() => {
  if (saved === undefined) delete g.localStorage;
  else g.localStorage = saved;
});


describe("the spell check preference", () => {
  test("is on until switched off, and the choice is remembered on the device", () => {
    expect(readSpellCheckPref()).toBe(true);
    applySpellCheckPref(false);
    expect(readSpellCheckPref()).toBe(false);
    expect(g.localStorage!.getItem("sd-spellcheck")).toBe("off");
    // On is the default, so turning it back on clears the key rather than
    // storing a second value.
    applySpellCheckPref(true);
    expect(readSpellCheckPref()).toBe(true);
    expect(g.localStorage!.getItem("sd-spellcheck")).toBeNull();
  });

  test("is on when storage is unavailable, and a flip does not throw", () => {
    g.localStorage = {
      ...fakeStorage(),
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    };
    expect(readSpellCheckPref()).toBe(true);
    expect(() => applySpellCheckPref(false)).not.toThrow();
  });

  test("tells the browser to check prose in the Vim tab, which CodeMirror turns off", () => {
    // CodeMirror sets spellcheck="false" on its editable element; the facet
    // value overrides it, so "true" is the whole override.
    expect(spellCheckContentAttributes(true)).toEqual({ spellcheck: "true" });
    expect(spellCheckContentAttributes(false)).toEqual({ spellcheck: "false" });
  });
});

// The Write tab is a CodeMirror editor, which needs a DOM; this file borrows
// one from happy-dom the way tests/commonEditor.test.tsx does. The
// preference's fake storage above stays in front of the window's.
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;

beforeAll(() => {
  happyWindow = new Window({ url: "http://localhost/" });
  const w = happyWindow as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (w[key] ?? w.window);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  savedGlobals.clear();
  await happyWindow?.happyDOM.close();
});

describe("the Markdown editor's Write tab", () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = (async () => new Response("[]")) as unknown as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    globalThis.fetch = realFetch;
  });

  /** The spellcheck attribute of the editor's editable element. */
  async function spellcheck() {
    root = createRoot(host!);
    await act(async () => root!.render(<MarkdownEditor value="Given a polcy" onChange={() => {}} />));
    return host!.querySelector(".cm-content")?.getAttribute("spellcheck");
  }

  test("has the checker on by default", async () => {
    expect(await spellcheck()).toBe("true");
  });

  test("follows the switch off", async () => {
    applySpellCheckPref(false);
    expect(await spellcheck()).toBe("false");
  });
});

describe("fields that hold names and code", () => {
  test("keep the checker off whatever the switch says, since a url is never misspelt", async () => {
    // The field editors for links and identifiers each set spellCheck={false}
    // (specs/editor/common-editor.feature.md "Spell check"); this pins the
    // ones most likely to be touched by a wider sweep.
    const sources = await Promise.all(
      [
        "src/frontend/PullRequestField.tsx",
        "src/frontend/ExternalLinkField.tsx",
        "src/frontend/ResourceLinkField.tsx",
        "src/frontend/CustomAttributesEditor.tsx",
        "src/frontend/TableDialog.tsx",
      ].map((f) => Bun.file(new URL(`../${f}`, import.meta.url)).text()),
    );
    for (const src of sources) expect(src).toContain("spellCheck={false}");
  });
});

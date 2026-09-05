// specs/ui.spec.md "Settings": Vim mode is a device-local switch that adds a
// Vim tab to every Markdown editor. Off, the editor is as it was; on, the tab
// is there and is the one an editable body opens on; a read-only body has
// nothing to edit with Vim and never shows it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownEditor } from "../src/frontend/MarkdownEditor";
import { applyVimPref, readVimPref } from "../src/frontend/vimPref";

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

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const tabs = (markup: string) =>
  [...markup.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
const selectedTab = (markup: string) =>
  markup.match(/<button[^>]*aria-selected="true"[^>]*>([^<]*)<\/button>/)?.[1];

describe("the Vim mode preference", () => {
  test("is off until switched on, and remembered on the device", () => {
    expect(readVimPref()).toBe(false);
    applyVimPref(true);
    expect(readVimPref()).toBe(true);
    expect(g.localStorage!.getItem("sd-vim")).toBe("on");
    applyVimPref(false);
    expect(readVimPref()).toBe(false);
    expect(g.localStorage!.getItem("sd-vim")).toBeNull();
  });

  test("survives a storage that throws", () => {
    g.localStorage = {
      ...fakeStorage(),
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readVimPref()).toBe(false);
    expect(() => applyVimPref(true)).not.toThrow();
  });
});

describe("the Markdown editor's Vim tab", () => {
  test("is absent while Vim mode is off", () => {
    const markup = html(<MarkdownEditor value="Given a policy" onChange={() => {}} />);
    expect(tabs(markup)).toEqual(["Write", "Preview"]);
    expect(selectedTab(markup)).toBe("Write");
    expect(markup).not.toContain("md-vim");
  });

  test("is there, and open, once Vim mode is on", () => {
    applyVimPref(true);
    const markup = html(<MarkdownEditor value="Given a policy" onChange={() => {}} />);
    expect(tabs(markup)).toEqual(["Write", "Vim", "Preview"]);
    expect(selectedTab(markup)).toBe("Vim");
    // The toolbar stays: its actions work on the Vim pane too.
    expect(markup).toContain('aria-label="Bold"');
    // CodeMirror is built in the browser; on the server the tab is its shell.
    expect(markup).toContain("md-vim");
  });

  test("never shows for a read-only body", () => {
    applyVimPref(true);
    const markup = html(<MarkdownEditor value="Given a policy" onChange={() => {}} readOnly />);
    expect(tabs(markup)).toEqual(["Source", "Preview"]);
    expect(selectedTab(markup)).toBe("Preview");
  });
});

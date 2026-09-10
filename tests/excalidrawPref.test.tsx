// specs/editor/excalidraw-support.feature.md "Create new Excalidraw diagram":
// Excalidraw support is a device-local switch in Settings. On, every editable
// Markdown editor's toolbar shows the diagram button that opens the pane;
// off, the editor is as it was. A read-only body has nothing to draw into.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownEditor } from "../src/frontend/MarkdownEditor";
import {
  applyExcalidrawPref,
  readExcalidrawPref,
} from "../src/frontend/excalidrawPref";

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
const BUTTON = 'aria-label="Excalidraw diagram"';

describe("the Excalidraw preference", () => {
  test("is off until switched on, and remembered on the device", () => {
    expect(readExcalidrawPref()).toBe(false);
    applyExcalidrawPref(true);
    expect(readExcalidrawPref()).toBe(true);
    expect(g.localStorage!.getItem("sd-excalidraw")).toBe("on");
    applyExcalidrawPref(false);
    expect(readExcalidrawPref()).toBe(false);
    expect(g.localStorage!.getItem("sd-excalidraw")).toBeNull();
  });

  test("reads off when storage is unavailable", () => {
    g.localStorage = {
      ...fakeStorage(),
      getItem: () => {
        throw new Error("private mode");
      },
    };
    expect(readExcalidrawPref()).toBe(false);
  });
});

describe("the editor toolbar", () => {
  test("has no diagram button while the switch is off", () => {
    expect(html(<MarkdownEditor value="" onChange={() => {}} />)).not.toContain(BUTTON);
  });

  test("shows the diagram button once the switch is on", () => {
    applyExcalidrawPref(true);
    const markup = html(<MarkdownEditor value="" onChange={() => {}} />);
    expect(markup).toContain(BUTTON);
    // The pane itself is closed — and its library unloaded — until clicked.
    expect(markup).not.toContain("excalidraw-dialog");
  });

  test("never offers it on a read-only body", () => {
    applyExcalidrawPref(true);
    expect(html(<MarkdownEditor value="x" onChange={() => {}} readOnly />)).not.toContain(BUTTON);
  });
});

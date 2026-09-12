// specs/editor/excalidraw-support.feature.md "Create new Excalidraw diagram":
// Excalidraw support is a device-local switch in Settings. On, every editable
// Markdown editor's toolbar shows the diagram button that opens the pane;
// off, the editor is as it was. A read-only body has nothing to draw into.
//
// "Edit Excalidraw diagram": the same switch puts a button on each diagram
// already in the text, in the editable Preview, that reopens it in the pane.
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

describe("a diagram already in the text", () => {
  const DIAGRAM = "![flow.excalidraw](/api/images/flow-excalidraw-1a2b3c4d.svg)";
  const SHOT = "![shot](/api/images/shot-1a2b3c4d.png)";
  const EDIT = 'aria-label="Edit diagram &quot;flow.excalidraw&quot;"';
  const preview = (value: string) =>
    html(<MarkdownEditor value={value} onChange={() => {}} initialTab="preview" />);

  test("carries an edit button in the editable preview once the switch is on", () => {
    applyExcalidrawPref(true);
    const markup = preview(DIAGRAM);
    expect(markup).toContain(EDIT);
    expect(markup).toContain('class="md-img-edit"');
  });

  test("carries none while the switch is off", () => {
    expect(preview(DIAGRAM)).not.toContain("md-img-edit");
  });

  test("carries none on a published (read-only) body", () => {
    applyExcalidrawPref(true);
    expect(html(<MarkdownEditor value={DIAGRAM} onChange={() => {}} readOnly />)).not.toContain(
      "md-img-edit",
    );
  });

  test("is the only image offered it — an ordinary one is just an image", () => {
    applyExcalidrawPref(true);
    const markup = preview(`${SHOT}\n\n${DIAGRAM}`);
    expect(markup).toContain(EDIT);
    expect(markup).not.toContain('aria-label="Edit diagram &quot;shot&quot;"');
  });
});

// The toolbar's one diagram button does whichever the caret asks for. The
// caret moving is a DOM interaction; what the button becomes is decided by
// imageAt + isDiagram, covered in tests/excalidrawDiagram.test.ts. Here: the
// caret as the editor opens, at the start of the body.
describe("the toolbar's diagram button", () => {
  const write = (value: string) => html(<MarkdownEditor value={value} onChange={() => {}} />);

  test("draws a new diagram with the caret in ordinary text", () => {
    applyExcalidrawPref(true);
    const markup = write("Given a policy\n");
    expect(markup).toContain(BUTTON);
    expect(markup).not.toContain("Edit diagram");
  });

  test("edits the diagram the caret is in, naming it", () => {
    applyExcalidrawPref(true);
    const markup = write("![flow.excalidraw](/api/images/flow-excalidraw-1a2b3c4d.svg)\n");
    expect(markup).toContain('aria-label="Edit diagram &quot;flow&quot;"');
    expect(markup).not.toContain(BUTTON);
  });

  test("draws a new one when the caret is in an ordinary image", () => {
    applyExcalidrawPref(true);
    expect(write("![shot](/api/images/shot-1a2b3c4d.png)\n")).toContain(BUTTON);
  });

  test("is absent altogether while the switch is off", () => {
    const markup = write("![flow.excalidraw](/api/images/flow-excalidraw-1a2b3c4d.svg)\n");
    expect(markup).not.toContain(BUTTON);
    expect(markup).not.toContain("Edit diagram");
  });
});

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
  setExcalidrawDemoMode,
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
  // The demo default is module state: leave it off for the next test.
  setExcalidrawDemoMode(false);
});

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const BUTTON = 'aria-label="Excalidraw diagram"';

describe("the Excalidraw preference", () => {
  test("is off until switched on, and remembered on the device", () => {
    expect(readExcalidrawPref()).toBe(false);
    applyExcalidrawPref(true);
    expect(readExcalidrawPref()).toBe(true);
    expect(g.localStorage!.getItem("sd-excalidraw")).toBe("on");
    // Off is stored, not erased: the demo reads an absent key as "on", so a
    // visitor's "off" has to be a decision it can tell from silence.
    applyExcalidrawPref(false);
    expect(readExcalidrawPref()).toBe(false);
    expect(g.localStorage!.getItem("sd-excalidraw")).toBe("off");
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

  // Demo mode (src/server/demo.ts) only moves the default: drawing is what a
  // visitor came to see, so the button is there before they find Settings.
  describe("in the demo", () => {
    test("is on for a device that has never chosen", () => {
      setExcalidrawDemoMode(true);
      expect(readExcalidrawPref()).toBe(true);
    });

    test("still lets a visitor turn it off, and stays off", () => {
      setExcalidrawDemoMode(true);
      applyExcalidrawPref(false);
      expect(readExcalidrawPref()).toBe(false);
    });

    test("keeps an on choice made outside the demo", () => {
      applyExcalidrawPref(true);
      setExcalidrawDemoMode(true);
      expect(readExcalidrawPref()).toBe(true);
    });

    test("goes back to off once the demo default is dropped", () => {
      setExcalidrawDemoMode(true);
      setExcalidrawDemoMode(false);
      expect(readExcalidrawPref()).toBe(false);
    });

    test("is still on when storage is unavailable", () => {
      // A private window cannot remember a choice, so there is no choice to
      // read and the default stands. Only the preference is unrememberable;
      // a diagram still saves to the data repo like any other.
      g.localStorage = {
        ...fakeStorage(),
        getItem: () => {
          throw new Error("private mode");
        },
      };
      setExcalidrawDemoMode(true);
      expect(readExcalidrawPref()).toBe(true);
    });
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

// "Import Excalidraw file": with the switch on, the image picker takes
// `.excalidraw` files too — one picked opens the pane on it. Off, the picker
// is the plain image picker it was.
describe("the image picker", () => {
  const accept = (markup: string) => markup.match(/type="file"[^>]*accept="([^"]*)"/)?.[1];

  test("offers .excalidraw files once the switch is on", () => {
    applyExcalidrawPref(true);
    expect(accept(html(<MarkdownEditor value="" onChange={() => {}} />))).toBe(
      "image/*,.excalidraw",
    );
  });

  test("takes only images while it is off", () => {
    expect(accept(html(<MarkdownEditor value="" onChange={() => {}} />))).toBe("image/*");
  });
});

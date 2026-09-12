// specs/editor/excalidraw-support.feature.md "Create new Excalidraw diagram":
// the pane's export is handed to the image upload under a name that gives the
// embedded link the same shape as an excalidraw.com export pasted in by hand —
// `![<name>.excalidraw](/api/images/<name>-excalidraw-<hash>.svg)`.
import { describe, expect, test } from "bun:test";
import {
  diagramFileName,
  diagramName,
  isDiagram,
  svgFile,
} from "../src/frontend/excalidraw/diagram";
import { imageAt, imageAtOffset, imageRefs, setImageSrc } from "../src/frontend/markdown";
import { storeImage } from "../src/server/images";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("diagramFileName", () => {
  test("slugs the name the server's way and marks it as an Excalidraw export", () => {
    expect(diagramFileName("Order flow")).toBe("order-flow.excalidraw.svg");
    expect(diagramFileName("  My Flow!  ")).toBe("my-flow.excalidraw.svg");
    expect(diagramFileName("Claims/Home")).toBe("claims-home.excalidraw.svg");
  });

  test("falls back to 'diagram' when nothing slugs", () => {
    expect(diagramFileName("")).toBe("diagram.excalidraw.svg");
    expect(diagramFileName("   ")).toBe("diagram.excalidraw.svg");
    expect(diagramFileName("日本語")).toBe("diagram.excalidraw.svg");
  });
});

describe("svgFile", () => {
  test("wraps the markup as an SVG image file under the diagram name", async () => {
    const file = svgFile("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "Order flow");
    expect(file.name).toBe("order-flow.excalidraw.svg");
    expect(file.type).toBe("image/svg+xml");
    expect(await file.text()).toBe("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
  });
});

describe("the exported diagram through the image pipeline", () => {
  test("lands as <name>-excalidraw-<hash>.svg, the alt keeping <name>.excalidraw", async () => {
    const root = await mkdtemp(join(tmpdir(), "specdriven-excalidraw-"));
    try {
      const file = svgFile("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "Order flow");
      const stored = await storeImage(root, file.name, new Uint8Array(await file.arrayBuffer()));
      expect(stored).toMatch(/^order-flow-excalidraw-[0-9a-f]{8}\.svg$/);
      // What addImages (src/frontend/MarkdownEditor.tsx) uses as the alt text.
      expect(file.name.replace(/\.[^.]*$/, "")).toBe("order-flow.excalidraw");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// specs/editor/excalidraw-support.feature.md "Edit Excalidraw diagram": an
// image in the text is one the pane can reopen when either mark is there —
// the alt an insert left, or the stored file's own name.
describe("recognising a diagram in the text", () => {
  test("takes the alt an inserted or pasted export carries", () => {
    expect(isDiagram("order-flow.excalidraw", "/api/images/anything.svg")).toBe(true);
    expect(diagramName("order-flow.excalidraw", "/api/images/anything.svg")).toBe("order-flow");
  });

  test("takes the stored file's name when the alt was retyped", () => {
    const src = "/api/images/order-flow-excalidraw-1a2b3c4d.svg";
    expect(isDiagram("The order flow", src)).toBe(true);
    expect(diagramName("The order flow", src)).toBe("order-flow");
  });

  test("reads through a query or fragment on the url", () => {
    expect(isDiagram("", "/api/images/flow-excalidraw-1a2b3c4d.svg?v=2")).toBe(true);
    expect(diagramName("", "/api/images/flow-excalidraw-1a2b3c4d.svg#top")).toBe("flow");
  });

  test("leaves ordinary images alone", () => {
    expect(isDiagram("shot", "/api/images/shot-1a2b3c4d.png")).toBe(false);
    // An excalidraw-looking name without the hash storeImage gives is not one.
    expect(isDiagram("shot", "/api/images/my-excalidraw-notes.svg")).toBe(false);
    expect(isDiagram("excalidraw", "/api/images/shot-1a2b3c4d.png")).toBe(false);
  });

  test("falls back to 'diagram' when the link says nothing", () => {
    expect(diagramName(".excalidraw", "/api/images/x-1a2b3c4d.svg")).toBe("diagram");
    expect(diagramName("", "/x.svg")).toBe("diagram");
  });
});

// The toolbar's diagram button acts on the link the caret is in, so what
// counts as "in" one matters.
describe("the image under the caret", () => {
  const LINK = "![flow.excalidraw](/api/images/flow-excalidraw-1a2b3c4d.svg)";
  const BODY = `ab\n\n${LINK}\n\ncd`;
  const START = BODY.indexOf("!");
  const END = START + LINK.length;

  test("is found from anywhere inside the link, both ends included", () => {
    for (const at of [START, START + 1, START + 20, END - 1, END]) {
      const hit = imageAt(BODY, at);
      expect(hit?.index).toBe(0);
      expect(hit?.ref.src).toBe("/api/images/flow-excalidraw-1a2b3c4d.svg");
    }
  });

  test("is nothing when the caret is in ordinary text", () => {
    expect(imageAt(BODY, 0)).toBeNull();
    expect(imageAt(BODY, START - 1)).toBeNull();
    expect(imageAt(BODY, END + 1)).toBeNull();
    expect(imageAt(BODY, BODY.length)).toBeNull();
  });

  test("gives the index the rest of the editing works in", () => {
    const two = `${LINK} ${LINK}`;
    expect(imageAt(two, 1)?.index).toBe(0);
    expect(imageAt(two, LINK.length + 2)?.index).toBe(1);
  });

  test("finds an <img> tag the same way", () => {
    const tag = '<img src="/api/images/flow-excalidraw-1a2b3c4d.svg" alt="flow.excalidraw">';
    expect(imageAt(tag, 5)?.ref.alt).toBe("flow.excalidraw");
    expect(imageAt(`x ${tag}`, 0)).toBeNull();
  });

  test("reads a CRLF source at the offsets the editor works in", () => {
    // The editor's own offsets are LF, as imageRefs and setImageSrc are.
    const crlf = `ab\r\n\r\n${LINK}`;
    expect(imageAt(crlf, "ab\n\n".length + 1)?.index).toBe(0);
  });

  // The editor parses once per edit and looks up on every caret move; the
  // two halves must agree.
  test("is the same answer whether the refs are parsed here or passed in", () => {
    const refs = imageRefs(BODY);
    for (const at of [0, START, START + 9, END, END + 3, BODY.length]) {
      expect(imageAtOffset(refs, at)).toEqual(imageAt(BODY, at));
    }
  });
});

// The saved diagram replaces the one it was opened from, in place, keeping
// the size that image was given.
describe("saving over the diagram in the text", () => {
  const OLD = "/api/images/flow-excalidraw-11111111.svg";
  const NEW = "/api/images/flow-excalidraw-22222222.svg";

  test("repoints the nth image, leaving the rest of the text alone", () => {
    const body = `Before\n\n![flow.excalidraw](${OLD})\n\nAfter`;
    expect(setImageSrc(body, 0, NEW, "flow.excalidraw")).toBe(
      `Before\n\n![flow.excalidraw](${NEW})\n\nAfter`,
    );
  });

  test("repoints only that one when the text holds several", () => {
    const body = `![a.excalidraw](${OLD}) ![shot](/api/images/shot-1a2b3c4d.png) ![b.excalidraw](${OLD})`;
    expect(setImageSrc(body, 2, NEW, "b.excalidraw")).toBe(
      `![a.excalidraw](${OLD}) ![shot](/api/images/shot-1a2b3c4d.png) ![b.excalidraw](${NEW})`,
    );
  });

  test("keeps a width the image was given, as the tag it was written in", () => {
    const body = `<img src="${OLD}" alt="flow.excalidraw" width="320">`;
    expect(setImageSrc(body, 0, NEW, "flow.excalidraw")).toBe(
      `<img src="${NEW}" alt="flow.excalidraw" width="320">`,
    );
  });

  test("changes nothing when that image is no longer there", () => {
    const body = "Nothing to see";
    expect(setImageSrc(body, 0, NEW, "flow.excalidraw")).toBe(body);
  });
});

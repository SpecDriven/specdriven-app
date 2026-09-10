// specs/editor/excalidraw-support.feature.md "Create new Excalidraw diagram":
// the pane's export is handed to the image upload under a name that gives the
// embedded link the same shape as an excalidraw.com export pasted in by hand —
// `![<name>.excalidraw](/api/images/<name>-excalidraw-<hash>.svg)`.
import { describe, expect, test } from "bun:test";
import { diagramFileName, svgFile } from "../src/frontend/excalidraw/diagram";
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

// specs/image-editor-markup.feature.md: a marked-up image is a PNG the size
// of the original with the shapes burnt in, carrying — in a `tEXt` chunk —
// the clean original's url and the shapes, so the markup pane can reopen it
// with the shapes still editable. The pane itself needs a real canvas; these
// are the pure pieces it rests on (src/frontend/excalidraw/markup.ts).
import { describe, expect, test } from "bun:test";
import {
  MARKUP_KEYWORD,
  canMarkUp,
  crc32,
  decodeMarkup,
  encodeMarkup,
  markupFileName,
  readMarkup,
  readPngText,
  shiftElements,
  withMarkup,
  withPngText,
} from "../src/frontend/excalidraw/markup";
import type { MarkupRecord } from "../src/frontend/excalidraw/markup";
import { storeImage } from "../src/server/images";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A 1×1 PNG: signature, IHDR, IDAT, IEND. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);
const IEND = [0, 0, 0, 0, 73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82];

/** Where `text` (ASCII) first occurs in the bytes, or -1. */
function find(bytes: Uint8Array, text: string): number {
  const needle = [...text].map((c) => c.charCodeAt(0));
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (needle.every((b, j) => bytes[i + j] === b)) return i;
  }
  return -1;
}

function count(bytes: Uint8Array, text: string): number {
  let n = 0;
  for (let at = find(bytes, text); at >= 0; n++) {
    const next = find(bytes.subarray(at + 1), text);
    at = next < 0 ? -1 : at + 1 + next;
  }
  return n;
}

const RECORD: MarkupRecord = {
  version: 1,
  source: "/api/images/login-1a2b3c4d.png",
  elements: [
    { id: "box", type: "rectangle", x: 10, y: 20, width: 100, height: 40 },
    { id: "label", type: "text", x: 12, y: 70, text: "Sign in → 日本語 😀" },
  ] as unknown as MarkupRecord["elements"],
};

describe("which images can be marked up", () => {
  test("any image stored in the data repo", () => {
    expect(canMarkUp("shot", "/api/images/shot-1a2b3c4d.png")).toBe(true);
    expect(canMarkUp("photo", "/api/images/photo-1a2b3c4d.jpg")).toBe(true);
    expect(canMarkUp("photo", "/api/images/photo-1a2b3c4d.jpeg")).toBe(true);
    expect(canMarkUp("logo", "/api/images/logo-1a2b3c4d.svg")).toBe(true);
    expect(canMarkUp("", "/api/images/shot-1a2b3c4d.webp?v=2#top")).toBe(true);
  });

  test("not a diagram, which has its own editor", () => {
    expect(canMarkUp("flow.excalidraw", "/api/images/flow-excalidraw-1a2b3c4d.svg")).toBe(false);
    expect(canMarkUp("flow.excalidraw", "/api/images/shot-1a2b3c4d.png")).toBe(false);
    expect(canMarkUp("flow", "/api/images/flow-excalidraw-1a2b3c4d.svg")).toBe(false);
  });

  test("not an image from anywhere else, whose pixels the canvas cannot read", () => {
    expect(canMarkUp("shot", "https://example.com/shot.png")).toBe(false);
    expect(canMarkUp("shot", "data:image/png;base64,iVBORw0KGgo=")).toBe(false);
    expect(canMarkUp("shot", "/elsewhere/shot.png")).toBe(false);
    expect(canMarkUp("shot", "/api/images/../secret.png")).toBe(false);
    expect(canMarkUp("shot", "/api/images/shot.bmp")).toBe(false);
  });
});

describe("markupFileName", () => {
  test("is the original's stem, without its hash, marked as markup", () => {
    expect(markupFileName("/api/images/login-1a2b3c4d.png")).toBe("login-markup.png");
    expect(markupFileName("/api/images/photo-1a2b3c4d.jpg")).toBe("photo-markup.png");
    expect(markupFileName("/api/images/my-login-page-1a2b3c4d.svg?v=1")).toBe(
      "my-login-page-markup.png",
    );
  });

  test("never piles the suffixes up", () => {
    expect(markupFileName("/api/images/login-markup-9f8e7d6c.png")).toBe("login-markup.png");
  });

  test("falls back to 'image'", () => {
    expect(markupFileName("https://example.com/x.png")).toBe("image-markup.png");
  });

  test("is stored as <stem>-markup-<hash>.png, the markup still in it", async () => {
    const root = await mkdtemp(join(tmpdir(), "specdriven-markup-"));
    try {
      const name = markupFileName(RECORD.source);
      const stored = await storeImage(root, name, withMarkup(PNG, RECORD));
      expect(stored).toMatch(/^login-markup-[0-9a-f]{8}\.png$/);
      const bytes = new Uint8Array(await readFile(join(root, ".images", stored)));
      expect(readMarkup(bytes)).toEqual(RECORD);
      expect(canMarkUp("login", `/api/images/${stored}`)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PNG text chunks", () => {
  test("carry the PNG CRC", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });

  test("round-trip, just before IEND", () => {
    const out = withPngText(PNG, "greeting", "hello");
    expect(readPngText(out, "greeting")).toBe("hello");
    expect([...out.subarray(out.length - 12)]).toEqual(IEND);
    expect(find(out, "tEXt")).toBeLessThan(find(out, "IEND"));
    expect([...out.subarray(0, PNG.length - 12)]).toEqual([...PNG.subarray(0, PNG.length - 12)]);
  });

  test("replace the keyword's chunk and leave other keywords alone", () => {
    const once = withPngText(withPngText(PNG, "other", "kept"), "greeting", "hello");
    const twice = withPngText(once, "greeting", "again");
    expect(readPngText(twice, "greeting")).toBe("again");
    expect(readPngText(twice, "other")).toBe("kept");
    expect(count(twice, "greeting")).toBe(1);
  });

  test("are absent from a PNG without one, and from what is no PNG", () => {
    expect(readPngText(PNG, "greeting")).toBeNull();
    expect(readPngText(withPngText(PNG, "other", "x"), "greeting")).toBeNull();
    expect(readPngText(new TextEncoder().encode("GIF89a…"), "greeting")).toBeNull();
    expect(readPngText(PNG.subarray(0, 20), "greeting")).toBeNull();
  });

  test("refuse what is no PNG, and text beyond Latin-1", () => {
    expect(() => withPngText(new TextEncoder().encode("GIF89a"), "k", "v")).toThrow();
    expect(() => withPngText(PNG, "k", "日本")).toThrow();
  });
});

describe("the markup record", () => {
  test("encodes as ASCII and decodes to itself", () => {
    const text = encodeMarkup(RECORD);
    expect(text).toMatch(/^[\x20-\x7e]*$/);
    expect(decodeMarkup(text)).toEqual(RECORD);
  });

  test("travels in the PNG under its own keyword, not Excalidraw's", () => {
    const out = withMarkup(PNG, RECORD);
    expect(readPngText(out, MARKUP_KEYWORD)).toBe(encodeMarkup(RECORD));
    expect(find(out, "application/vnd.excalidraw+json")).toBe(-1);
    expect(readMarkup(out)).toEqual(RECORD);
    expect(readMarkup(PNG)).toBeNull();
  });

  test("is nothing when it is not one", () => {
    expect(decodeMarkup(null)).toBeNull();
    expect(decodeMarkup("not json")).toBeNull();
    expect(decodeMarkup("[]")).toBeNull();
    expect(decodeMarkup(JSON.stringify({ ...RECORD, version: 2 }))).toBeNull();
    expect(decodeMarkup(JSON.stringify({ ...RECORD, elements: "box" }))).toBeNull();
    expect(decodeMarkup(JSON.stringify({ ...RECORD, elements: [{ type: "rectangle" }] }))).toBeNull();
  });

  test("names only an image stored here as its original", () => {
    for (const source of ["https://example.com/a.png", "/api/images/../a.png", "javascript:x"]) {
      expect(decodeMarkup(JSON.stringify({ ...RECORD, source }))).toBeNull();
    }
  });
});

describe("shiftElements", () => {
  test("moves each element by the offset, its points along with it", () => {
    const arrow = { id: "a", type: "arrow", x: 50, y: 60, points: [[0, 0], [30, 40]] };
    expect(shiftElements([arrow], -10, -20)).toEqual([{ ...arrow, x: 40, y: 40 }]);
    expect(arrow.x).toBe(50); // a copy, not the element itself
  });
});

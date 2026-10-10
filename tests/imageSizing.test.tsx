// specs/images.feature.md: an image in an editable Preview carries a handle
// that sizes it — a slider to the keyboard — and writes the width into the
// source through the editor's onChange. Read-only bodies and the previews
// outside an editor (scenario cards, agent output) show the image plain. The
// dragging itself needs a layout engine; what a key asks for is pure and tested
// here.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownEditor } from "../src/frontend/MarkdownEditor";
import {
  IMAGE_WIDTH_STEP,
  ImageSizingContext,
  MIN_IMAGE_WIDTH,
  clampWidth,
  widthAfterKey,
} from "../src/frontend/MarkdownImage";
import { renderMarkdown } from "../src/frontend/markdown";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const BODY = "Given a policy\n\n![shot](/api/images/shot-1a2b3c4d.png)";

describe("the resize handle", () => {
  test("is on every image of an editable preview", () => {
    const markup = html(<MarkdownEditor value={BODY} onChange={() => {}} initialTab="preview" />);
    expect(markup).toContain('<img src="/api/images/shot-1a2b3c4d.png" alt="shot"/>');
    expect(markup).toContain('class="md-img"');
    expect(markup).toContain('role="slider"');
    expect(markup).toContain('aria-label="Width of image &quot;shot&quot;"');
    expect(markup).toContain(`aria-valuemin="${MIN_IMAGE_WIDTH}"`);
  });

  test("is not on a published (read-only) body", () => {
    const markup = html(<MarkdownEditor value={BODY} onChange={() => {}} readOnly />);
    expect(markup).toContain('<img src="/api/images/shot-1a2b3c4d.png" alt="shot"/>');
    expect(markup).not.toContain("md-img");
    expect(markup).not.toContain('role="slider"');
  });

  test("is not on a preview outside an editor", () => {
    const markup = html(<>{renderMarkdown(BODY)}</>);
    expect(markup).toContain("<img ");
    expect(markup).not.toContain("md-img");
  });

  test("names an unnamed image plainly", () => {
    const markup = html(
      <ImageSizingContext.Provider value={{ resize: () => {} }}>
        {renderMarkdown('<img src="/x.png" width="240">')}
      </ImageSizingContext.Provider>,
    );
    expect(markup).toContain('<img src="/x.png" alt="" width="240"/>');
    expect(markup).toContain('aria-label="Image width"');
  });
});

describe("what a key on the handle asks for", () => {
  const MAX = 600;

  test("arrows nudge the width; Shift takes bigger steps", () => {
    expect(widthAfterKey("ArrowRight", false, 100, MAX)).toBe(100 + IMAGE_WIDTH_STEP);
    expect(widthAfterKey("ArrowUp", false, 100, MAX)).toBe(100 + IMAGE_WIDTH_STEP);
    expect(widthAfterKey("ArrowLeft", false, 100, MAX)).toBe(100 - IMAGE_WIDTH_STEP);
    expect(widthAfterKey("ArrowDown", false, 100, MAX)).toBe(100 - IMAGE_WIDTH_STEP);
    expect(widthAfterKey("ArrowRight", true, 100, MAX)).toBe(100 + IMAGE_WIDTH_STEP * 5);
    expect(widthAfterKey("ArrowLeft", true, 100, MAX)).toBe(100 - IMAGE_WIDTH_STEP * 5);
  });

  test("stops at the floor and at the pane's width", () => {
    expect(widthAfterKey("ArrowLeft", false, MIN_IMAGE_WIDTH + 3, MAX)).toBe(MIN_IMAGE_WIDTH);
    expect(widthAfterKey("ArrowRight", true, MAX - 3, MAX)).toBe(MAX);
    expect(widthAfterKey("Home", false, 300, MAX)).toBe(MIN_IMAGE_WIDTH);
    expect(widthAfterKey("End", false, 300, MAX)).toBe(MAX);
    // A pane narrower than the floor still lets the image be the floor.
    expect(widthAfterKey("End", false, 300, 20)).toBe(MIN_IMAGE_WIDTH);
  });

  test("Backspace and Delete ask for the natural size", () => {
    expect(widthAfterKey("Backspace", false, 300, MAX)).toBeNull();
    expect(widthAfterKey("Delete", false, 300, MAX)).toBeNull();
  });

  test("other keys are not the handle's", () => {
    for (const key of ["Escape", "Enter", "Tab", " ", "a"]) {
      expect(widthAfterKey(key, false, 300, MAX)).toBeUndefined();
    }
  });
});

describe("clampWidth", () => {
  test("keeps a width between the floor and the room, in whole pixels", () => {
    expect(clampWidth(700, 600)).toBe(600);
    expect(clampWidth(10, 600)).toBe(MIN_IMAGE_WIDTH);
    expect(clampWidth(100.6, 600)).toBe(101);
    expect(clampWidth(100, Infinity)).toBe(100);
  });
});

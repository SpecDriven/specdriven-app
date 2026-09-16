// Where a character sits inside a textarea, in pixels (specs/editor/
// data-model-integration-in-editor.feature.md): the entity-field list opens
// next to the `@` it completes, and a textarea offers no coordinates for an
// offset — only a caret index. So the text is measured in a mirror, the same
// trick the search marks use (`.md-highlights`, src/frontend/index.css): a
// div wearing the textarea's font, padding and wrapping, holding the text up
// to that offset, with a marker span where the character falls.
//
// The mirror copies the textarea's *computed* styles rather than repeating
// the editor's own constants, so restyling the editor cannot put the
// measurement out of step with what is on screen.
//
// `placePopup` below is pure — no DOM — so the placement rules are tested
// without a layout engine, as MarkdownImage's `widthAfterKey` is.

/** A character's box inside the textarea's padding box, scroll taken off. */
export interface CaretBox {
  left: number;
  top: number;
  /** The bottom of the character's line — where a popup below it starts. */
  bottom: number;
}

// The styles that decide where text lands. Copied onto the mirror so its
// line breaks fall exactly where the textarea's do.
const MIRRORED = [
  "boxSizing",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "lineHeight",
  "textIndent",
  "textTransform",
  "wordSpacing",
  "whiteSpace",
  "overflowWrap",
  "wordBreak",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const;

// One mirror per document, reused: building it costs a layout, and the list
// re-measures on every keystroke. It lives off-screen and is never read by
// assistive tech.
let mirror: HTMLDivElement | null = null;

function mirrorFor(doc: Document): HTMLDivElement {
  if (mirror && mirror.ownerDocument === doc && mirror.isConnected) return mirror;
  const el = doc.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.position = "absolute";
  el.style.top = "0";
  el.style.left = "-9999px";
  el.style.visibility = "hidden";
  el.style.pointerEvents = "none";
  doc.body.appendChild(el);
  mirror = el;
  return el;
}

/**
 * Where the character at `offset` sits inside `ta`'s padding box, with the
 * textarea's scroll already taken off — so the box is in the same frame as
 * the textarea itself. Null when the browser cannot measure (no layout
 * engine, or the textarea is not in a document).
 */
export function measureOffset(ta: HTMLTextAreaElement, offset: number): CaretBox | null {
  const doc = ta.ownerDocument;
  const win = doc.defaultView;
  if (!win || typeof win.getComputedStyle !== "function") return null;

  const style = win.getComputedStyle(ta);
  const el = mirrorFor(doc);
  for (const key of MIRRORED) el.style[key] = style[key];
  // The wrapping width is the textarea's own content box: `clientWidth`
  // already has any scrollbar taken off, so the mirror breaks lines where
  // the textarea does.
  el.style.width = `${ta.clientWidth}px`;
  el.style.height = "auto";

  // Text up to the offset, then a marker at the character itself. A
  // zero-width space keeps the marker on the line even at its very start,
  // where an empty span would collapse.
  el.textContent = ta.value.slice(0, offset);
  const marker = doc.createElement("span");
  marker.textContent = "​";
  el.appendChild(marker);

  const left = marker.offsetLeft - ta.scrollLeft;
  const top = marker.offsetTop - ta.scrollTop;
  // The marker is zero-width, so its own height is the line's.
  const bottom = top + marker.offsetHeight;

  // Let go of the text: a long body held here would be kept alive for as
  // long as the page is.
  el.textContent = "";

  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left, top, bottom };
}

export interface Placement {
  left: number;
  top: number;
  /** True when there was no room below and the popup went above instead. */
  flipped: boolean;
}

/**
 * Whether the anchored character is still in view: scrolled out of the pane
 * it has no place to point at, and the popup belongs closed rather than
 * hanging off an edge.
 */
export function anchorVisible(anchor: CaretBox, pane: { height: number }): boolean {
  return anchor.bottom > 0 && anchor.top < pane.height;
}

/**
 * Where to put a popup anchored to `anchor` inside a pane `pane` big: its
 * top-left just below the anchored character, or — with no room for it
 * there — its bottom just above that character's line, the same "no room
 * below, go above" rule the tooltips follow (src/frontend/Tooltip.tsx).
 * Either way it is kept inside the pane, an anchor near an edge included.
 */
export function placePopup({
  anchor,
  pane,
  popup,
  gap = 4,
  margin = 4,
}: {
  anchor: CaretBox;
  pane: { width: number; height: number };
  popup: { width: number; height: number };
  /** Space between the character's line and the popup. */
  gap?: number;
  /** Space kept between the popup and the pane's edges. */
  margin?: number;
}): Placement {
  const below = anchor.bottom + gap;
  const flipped = below + popup.height > pane.height - margin && anchor.top - gap - popup.height >= margin;
  const top = flipped
    ? anchor.top - gap - popup.height
    : // With room in neither direction the popup stays below and is pulled
      // up as far as the pane allows, rather than hanging out of it.
      Math.min(below, Math.max(margin, pane.height - margin - popup.height));
  const left = Math.max(margin, Math.min(anchor.left, pane.width - margin - popup.width));
  return { left, top, flipped };
}

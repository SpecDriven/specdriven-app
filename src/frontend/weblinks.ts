// Web links in the editor (specs/editor/common-editor.feature.md "web links
// are clickable"): a bare `https://abc.com` typed into any markdown editor is
// a link. The Preview tab renders it as one (src/frontend/markdown.tsx); in
// the Write and Vim tabs, where a plain click has to keep placing the caret,
// ⌘-click (Ctrl-click off the Mac) opens it, and the toolbar offers to open
// the one the caret is in (src/frontend/MarkdownEditor.tsx,
// src/frontend/SourceEditor.tsx). One finder for all three, so they agree on
// where a link starts and ends.

/** A web link in the text: where it sits, and the url it opens. */
export interface WebLink {
  start: number;
  end: number;
  url: string;
}

/**
 * A bare web url as markdown writes one: `http://` or `https://`, a host, and
 * anything up to whitespace, a `<`/`>` or a bracket that is not part of a
 * balanced `(…)` pair. The match runs long on purpose — webLinkEnd() trims
 * what a sentence put after it.
 */
export const WEB_URL_RE = /https?:\/\/[^\s<>()[\]]*(?:\([^\s<>()]*\)[^\s<>()[\]]*)*/;

/**
 * How much of a raw match is the url. Punctuation closing a sentence —
 * "see https://abc.com." — and emphasis marks around the url belong to the
 * text, not the link. A `(…)` pair inside the url is kept (WEB_URL_RE takes
 * only balanced ones), so "(see https://abc.com)" stops before its `)`, as
 * GitHub's autolinks read it. Returns 0 when nothing is left but the scheme.
 */
export function webLinkEnd(raw: string): number {
  let end = raw.length;
  while (end > 0 && /[.,:;!?'"*_~]/.test(raw[end - 1]!)) end--;
  // A scheme with no host after it is not a link.
  return /^https?:\/\/[^/?#\s]/.test(raw.slice(0, end)) ? end : 0;
}

/** Every web link in `text`, in order. */
export function webLinks(text: string): WebLink[] {
  const re = new RegExp(WEB_URL_RE.source, "g");
  const out: WebLink[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // "xhttps://…" is a word that happens to contain a scheme, not a link.
    if (m.index > 0 && /\w/.test(text[m.index - 1]!)) continue;
    const len = webLinkEnd(m[0]);
    if (len > 0) out.push({ start: m.index, end: m.index + len, url: m[0].slice(0, len) });
  }
  return out;
}

/**
 * The web link `offset` is in, if any — for a click or a caret, so either
 * end of the link counts (the caret sits after the last character).
 */
export function webLinkAt(text: string, offset: number): WebLink | null {
  // Only the line the offset is on can hold the link: a url never spans one.
  const from = text.lastIndexOf("\n", offset - 1) + 1;
  const nl = text.indexOf("\n", offset);
  const to = nl === -1 ? text.length : nl;
  for (const link of webLinks(text.slice(from, to))) {
    const start = from + link.start;
    const end = from + link.end;
    if (offset >= start && offset <= end) return { start, end, url: link.url };
  }
  return null;
}

/** ⌘-click on the Mac, Ctrl-click elsewhere: the gesture that opens a link in the source. */
export function isOpenLinkClick(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/**
 * Open a web link the way a link in the preview opens: a new browser tab on
 * the web; the default browser in the desktop app, whose window-open handler
 * sends every http(s) url there (src/electron/linkRouting.ts).
 */
export function openWebLink(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

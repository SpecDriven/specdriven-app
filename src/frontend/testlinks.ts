// The scenario dialog's "Automated tests" field (specs/traceability.spec.md).
// The field is a small list editor over the scenario's `tests` array — add,
// ✎ update and ✕ remove — and every operation obeys the same two rules: only
// GitHub urls, and no scenario lists the same url twice. Kept pure and apart
// from the dialog so the rules can be tested without a DOM.

import { isTestLink } from "../server/parser";

/**
 * Shown as just the test's file name — the repo path and line anchor only
 * clutter the row; the full url stays on the link's title and href.
 */
export function testLinkLabel(url: string): string {
  const path = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return path.slice(path.lastIndexOf("/") + 1) || url;
}

/**
 * Whether `url` may take the slot at `index`: a GitHub url that no *other*
 * entry already holds. `index === null` asks about appending a new link.
 */
export function canSetTestLink(tests: string[], index: number | null, url: string): boolean {
  const next = url.trim();
  return isTestLink(next) && !tests.some((t, i) => t === next && i !== index);
}

/** Append `url`; a url that fails canSetTestLink leaves the list unchanged. */
export function addTestLink(tests: string[], url: string): string[] {
  return canSetTestLink(tests, null, url) ? [...tests, url.trim()] : tests;
}

/** Replace the link at `index`; an invalid or duplicate url changes nothing. */
export function updateTestLink(tests: string[], index: number, url: string): string[] {
  if (index < 0 || index >= tests.length || !canSetTestLink(tests, index, url)) return tests;
  return tests.map((t, i) => (i === index ? url.trim() : t));
}

/** Drop the link at `index`. */
export function removeTestLink(tests: string[], index: number): string[] {
  return tests.filter((_, i) => i !== index);
}

export interface PendingTests {
  tests: string[];
  /** Set when a pending url can't join the list; the save must not proceed. */
  error?: string;
}

/**
 * Fold what is still sitting in the tests widgets into the list about to be
 * saved: an open ✎ row first, then the add field. Pressing Save with a url
 * left in a field must behave as if Add (or the row's Save) had been pressed
 * — never silently drop it — and a url that can't join the list blocks the
 * save with a message instead.
 */
export function resolvePendingTests(
  tests: string[],
  edit: { index: number; url: string } | null,
  draft: string,
): PendingTests {
  let next = tests;
  if (edit) {
    if (!canSetTestLink(next, edit.index, edit.url)) return { tests, error: reject(edit.url) };
    next = updateTestLink(next, edit.index, edit.url);
  }
  if (draft.trim()) {
    if (!canSetTestLink(next, null, draft)) return { tests, error: reject(draft) };
    next = addTestLink(next, draft);
  }
  return { tests: next };
}

/** Why `url` was turned away, for the message under the field. */
function reject(url: string): string {
  return isTestLink(url)
    ? `Already listed: ${url.trim()}`
    : `Not a GitHub url: "${url.trim()}"`;
}

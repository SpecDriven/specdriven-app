// The scenario dialog's "Automated tests" field (specs/external-links/
// test-traceability.feature.md). The field is a small list editor over the
// scenario's `tests` array — add, ✎ update and ✕ remove — and every operation
// obeys the same rules: only GitHub urls, each pointing at a line (`#L<n>`)
// so the test's function name can be read from the code, a name the token
// syntax can carry, and no scenario lists the same url twice. Kept pure and
// apart from the dialog so the rules can be tested without a DOM.

import { formatTestRef, isTestLink, isTestName, parseTestRef, testLine } from "../server/parser";

/** The two fields of a row being added or edited. */
export interface TestDraft {
  url: string;
  /** The test's function name; empty means none (the file name is shown). */
  name: string;
}

/** The test's file name: the last path segment, line anchor and query dropped. */
export function testLinkFile(ref: string): string {
  const url = parseTestRef(ref).url;
  const path = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return path.slice(path.lastIndexOf("/") + 1) || url;
}

/**
 * Shown as the test's function name when the reference carries one, else
 * as just its file name — the repo path and line anchor only clutter the
 * row; the full url stays on the link's title and href.
 */
export function testLinkLabel(ref: string): string {
  return parseTestRef(ref).name ?? testLinkFile(ref);
}

/** The url a reference opens. */
export function testLinkUrl(ref: string): string {
  return parseTestRef(ref).url;
}

/** Why `draft` may not take a row, or null when it may. */
export function testLinkProblem(tests: string[], index: number | null, draft: TestDraft): string | null {
  const url = draft.url.trim();
  const name = draft.name.trim();
  if (!isTestLink(url)) return `Not a GitHub url: "${url}"`;
  if (testLine(url) === null) return `Needs a line anchor, like …/MyTest.java#L32: ${url}`;
  if (name && !isTestName(name)) return `A test name cannot contain ":" or "]": "${name}"`;
  if (tests.some((t, i) => parseTestRef(t).url === url && i !== index)) return `Already listed: ${url}`;
  return null;
}

/**
 * What to say under the field while a url is being typed: only the missing
 * line anchor is worth pointing out as it happens — a GitHub url is
 * recognisable at once, while "not a GitHub url" would nag at every
 * half-typed one. Null when there is nothing to say yet.
 */
export function testLinkHint(url: string): string | null {
  const trimmed = url.trim();
  if (!isTestLink(trimmed) || testLine(trimmed) !== null) return null;
  // The url itself is right there in the field; only the rule is news.
  return "Needs a line anchor, like …/MyTest.java#L32, to name the test.";
}

/**
 * Whether `draft` may take the slot at `index`: a GitHub url with a line
 * anchor that no *other* entry already holds, and a name the token can
 * carry. `index === null` asks about appending a new link.
 */
export function canSetTestLink(tests: string[], index: number | null, draft: TestDraft): boolean {
  return testLinkProblem(tests, index, draft) === null;
}

/** The entry a draft is stored as. */
function entryOf(draft: TestDraft): string {
  const name = draft.name.trim();
  return formatTestRef(name ? { url: draft.url.trim(), name } : { url: draft.url.trim() });
}

/** Append `draft`; one that fails canSetTestLink leaves the list unchanged. */
export function addTestLink(tests: string[], draft: TestDraft): string[] {
  return canSetTestLink(tests, null, draft) ? [...tests, entryOf(draft)] : tests;
}

/** Replace the link at `index`; an invalid or duplicate draft changes nothing. */
export function updateTestLink(tests: string[], index: number, draft: TestDraft): string[] {
  if (index < 0 || index >= tests.length || !canSetTestLink(tests, index, draft)) return tests;
  return tests.map((t, i) => (i === index ? entryOf(draft) : t));
}

/** Drop the link at `index`. */
export function removeTestLink(tests: string[], index: number): string[] {
  return tests.filter((_, i) => i !== index);
}

/** The fields an ✎ row opens with: the entry's url and name. */
export function testDraftOf(ref: string): TestDraft {
  const parsed = parseTestRef(ref);
  return { url: parsed.url, name: parsed.name ?? "" };
}

export interface PendingTests {
  tests: string[];
  /** Set when a pending draft can't join the list; the save must not proceed. */
  error?: string;
}

/**
 * Fold what is still sitting in the tests widgets into the list about to be
 * saved: an open ✎ row first, then the add fields. Pressing Save with a url
 * left in a field must behave as if Add (or the row's Save) had been pressed
 * — never silently drop it — and a draft that can't join the list blocks
 * the save with a message instead. A name typed without a url is nothing to
 * save.
 */
export function resolvePendingTests(
  tests: string[],
  edit: ({ index: number } & TestDraft) | null,
  draft: TestDraft,
): PendingTests {
  let next = tests;
  if (edit) {
    const problem = testLinkProblem(next, edit.index, edit);
    if (problem) return { tests, error: problem };
    next = updateTestLink(next, edit.index, edit);
  }
  if (draft.url.trim()) {
    const problem = testLinkProblem(next, null, draft);
    if (problem) return { tests, error: problem };
    next = addTestLink(next, draft);
  }
  return { tests: next };
}

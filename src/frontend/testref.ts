// Inline test references (specs/external-links/test-traceability.feature.md).
// A test is traced to an individual spec — a scenario, or one rule inside it —
// by writing `[test:<url>]` right where it applies in the feature markdown:
//
//   [test:https://github.com/acme/insurance/blob/main/src/test/java/QuoteHomeownersPolicyTest.java#L32]
//
// The reference stays in the body as plain text (GitHub shows it verbatim);
// the app's markdown preview shows it as a link whose text is the test's
// name — `QuoteHomeownersPolicyTest` — through the RenderTestInEditor
// interface below. Pure and DOM-free so the formatting can be unit-tested.

/**
 * A `[test:<url>]` reference, as matched inside a line of markdown. Spaces
 * around the url are allowed — `[test: <url> ]` is the form the feature files
 * use. One followed by `(` is an ordinary markdown link whose text happens
 * to start with `test:`, and is left to the link rule.
 */
export const TEST_REF_RE = /\[test:\s*(?<url>[^\]\s]+)\s*\](?!\()/;

/** What the editor shows for one `[test:<url>]` reference. */
export interface RenderedTest {
  /** The link text: the test's name, e.g. `QuoteHomeownersPolicyTest`. */
  label: string;
  /** Where the link opens; null when the url is not one the preview may follow. */
  href: string | null;
  /** The full url, for the tooltip — the label deliberately drops the path and line. */
  title: string;
}

/**
 * Formats a test url for user display. An interface rather than a bare
 * function so the display rule can be swapped (a different forge, a
 * different naming convention) without touching the markdown renderer.
 */
export interface RenderTestInEditor {
  render(url: string): RenderedTest;
}

/** Only web urls open from the preview; anything else is shown but not linked. */
function safeHref(url: string): string | null {
  return /^https?:\/\/\S+$/i.test(url) ? url : null;
}

/**
 * The name a test goes by: the last path segment of its url with the file
 * extension, line anchor (`#L32`) and query dropped. A url with no path to
 * speak of is shown as it is.
 */
export function testName(url: string): string {
  const trimmed = url.trim();
  const bare = trimmed.replace(/[#?].*$/, "");
  let path = bare;
  try {
    path = new URL(bare).pathname;
  } catch {
    // not an absolute url — treat the whole thing as a path
  }
  const last = path.split("/").filter(Boolean).pop();
  if (!last) return trimmed;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // keep the raw segment
  }
  const dot = decoded.lastIndexOf(".");
  return dot > 0 ? decoded.slice(0, dot) : decoded;
}

/** The default rule: display the test as its name, linking to the full url. */
export const renderTestInEditor: RenderTestInEditor = {
  render(url: string): RenderedTest {
    const title = url.trim();
    return { label: testName(title), href: safeHref(title), title };
  },
};

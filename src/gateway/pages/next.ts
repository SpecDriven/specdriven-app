// Where the sign-in page goes afterwards. Kept apart from main.ts, which
// touches the DOM as it loads, so the check can be tested on its own.

/**
 * The same-site path a `?next=` value names, else "/".
 *
 * The value is resolved the way the browser will resolve it and kept only
 * when it lands on this origin: a prefix check alone is not enough, since
 * the browser drops tabs and newlines from a url ("/\t/other.example" loads
 * "//other.example") and reads "\" as "/". What is returned is the resolved
 * path, so what was checked is what is loaded.
 */
export function safeNextPath(next: string | null, origin: string): string {
  if (!next || !next.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin) return "/";
  return url.pathname + url.search + url.hash;
}

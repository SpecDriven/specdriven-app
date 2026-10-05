/**
 * How text the user typed is saved (specs/ui/ui.feature.md "User-entered
 * text is cleaned up"). Pure, so the frontend shares it with the server.
 */

/** A one-line value — a name, a title, a note: ends trimmed, every inner
    run of whitespace (tabs, newlines, repeated spaces) one space. */
export function cleanLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A multi-line value — a body, a message: leading blank lines and trailing
    whitespace dropped; the first line's indentation (an indented code block)
    and everything inside stay as typed. Text that is one line after all is
    trimmed whole, like any other one-line value. */
export function cleanText(s: string): string {
  const text = s.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
  return text.includes("\n") ? text : text.trim();
}

/** A `folder/name` path typed as names: each segment cleaned as a line. */
export function cleanSegments(s: string): string {
  return s.split("/").map(cleanLine).join("/");
}

// specs/ui/ui.feature.md "User-entered text is cleaned up": how a value the
// user typed is saved.
import { describe, expect, test } from "bun:test";
import { cleanLine, cleanSegments, cleanText } from "../src/server/text";

describe("a one-line value", () => {
  test("loses the whitespace around it", () => {
    expect(cleanLine("  Quote Policy \t")).toBe("Quote Policy");
    expect(cleanLine(" Quote ")).toBe("Quote");
  });

  test("keeps one space for every inner run", () => {
    expect(cleanLine("Quote   \t Policy")).toBe("Quote Policy");
    expect(cleanLine("pasted\ntitle")).toBe("pasted title");
  });

  test("of only whitespace is empty", () => {
    expect(cleanLine(" \t\n ")).toBe("");
  });

  test("as a folder/name path is cleaned segment by segment", () => {
    expect(cleanSegments(" billing  /  Basic   Quote ")).toBe("billing/Basic Quote");
  });
});

describe("a multi-line value", () => {
  test("loses the blank lines around it and trailing whitespace", () => {
    expect(cleanText("\n  \nFirst\n\nSecond  \n\n")).toBe("First\n\nSecond");
  });

  test("keeps the first line's indentation and everything inside", () => {
    expect(cleanText("\n    code()\n  more\n")).toBe("    code()\n  more");
    expect(cleanText("a  b\n\n\n  c")).toBe("a  b\n\n\n  c");
  });

  test("of only whitespace is empty", () => {
    expect(cleanText(" \n\t\n ")).toBe("");
  });

  test("that is one line after all is trimmed whole", () => {
    expect(cleanText("\n  Fixed in 1.2  \n")).toBe("Fixed in 1.2");
  });
});

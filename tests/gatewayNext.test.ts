// Where the gateway's sign-in page goes afterwards (src/gateway/pages/next.ts):
// a same-site path from ?next=, and never another site, however the value
// is dressed up.

import { expect, test } from "bun:test";
import { safeNextPath } from "../src/gateway/pages/next";

const ORIGIN = "https://gateway.example";

/** The value the page reads from a sign-in link's query string. */
const fromLink = (query: string) => safeNextPath(new URLSearchParams(query).get("next"), ORIGIN);

test("a same-site path is kept, with its query and fragment", () => {
  expect(safeNextPath("/admin", ORIGIN)).toBe("/admin");
  expect(safeNextPath("/features/billing/quote?tab=write#s3", ORIGIN)).toBe("/features/billing/quote?tab=write#s3");
  expect(fromLink("next=%2Faccount")).toBe("/account");
});

test("no value, or one that is not a path, goes to the app", () => {
  expect(safeNextPath(null, ORIGIN)).toBe("/");
  expect(safeNextPath("", ORIGIN)).toBe("/");
  expect(safeNextPath("admin", ORIGIN)).toBe("/");
  expect(safeNextPath("https://other.example/", ORIGIN)).toBe("/");
  expect(safeNextPath("javascript:alert(1)", ORIGIN)).toBe("/");
});

test("a value the browser would load from another site goes to the app", () => {
  expect(safeNextPath("//other.example", ORIGIN)).toBe("/");
  expect(safeNextPath("/\\other.example", ORIGIN)).toBe("/");
  // The browser drops tabs and newlines from a url before reading it, so
  // these load "//other.example" although they do not start with "//".
  expect(safeNextPath("/\t/other.example", ORIGIN)).toBe("/");
  expect(safeNextPath("/\n/other.example", ORIGIN)).toBe("/");
  expect(safeNextPath("/\r\n\\other.example", ORIGIN)).toBe("/");
  expect(fromLink("next=/%09/other.example")).toBe("/");
  expect(fromLink("next=/%0A/other.example/path")).toBe("/");
});

test("what is returned is the path the browser resolves, not the raw value", () => {
  expect(safeNextPath("/a/\t../admin", ORIGIN)).toBe("/admin");
});

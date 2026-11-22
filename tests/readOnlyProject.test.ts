// The visitor's project on a read-only site showing several
// (src/frontend/readOnlyProject.ts): a `?project=` link picks it into the
// cookie every request carries, and a tab brought back to the front puts
// its own project back.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

const KEYS = ["window", "document", "location", "history"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let happy: Window;

beforeAll(() => {
  happy = new Window({ url: "http://localhost/" });
  const w = happy as unknown as Record<string, unknown>;
  for (const key of KEYS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: w[key] ?? w.window, configurable: true, writable: true });
  }
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  await happy.happyDOM.close();
});

import {
  adoptProjectFromUrl,
  cookieProject,
  parseReadOnlyProjects,
  setTabProject,
} from "../src/frontend/readOnlyProject";

beforeEach(() => {
  document.cookie = "specdriven-project=; Path=/; Max-Age=0";
});

test("a ?project= link picks the project and leaves the address bar", () => {
  happy.happyDOM.setURL("http://localhost/features/shop/checkout?project=claims#S2");
  adoptProjectFromUrl();
  expect(cookieProject()).toBe("claims");
  expect(location.pathname + location.search + location.hash).toBe("/features/shop/checkout#S2");
});

test("a malformed project id is dropped from the url and picks nothing", () => {
  happy.happyDOM.setURL("http://localhost/?project=..%2Fetc");
  adoptProjectFromUrl();
  expect(cookieProject()).toBeNull();
  expect(location.search).toBe("");
});

test("a tab coming back to the front puts its own project back in the cookie", () => {
  happy.happyDOM.setURL("http://localhost/");
  setTabProject("quotes");
  // Another tab picked another project meanwhile.
  document.cookie = "specdriven-project=claims; Path=/";
  window.dispatchEvent(new happy.Event("focus") as unknown as Event);
  expect(cookieProject()).toBe("quotes");
});

test("only well-formed project rows are read from the state", () => {
  expect(parseReadOnlyProjects(undefined)).toEqual([]);
  expect(
    parseReadOnlyProjects([{ id: "quotes", repo: "https://github.com/a/quotes" }, { id: "Bad Id", repo: "x" }, null]),
  ).toEqual([{ id: "quotes", repo: "https://github.com/a/quotes" }]);
});

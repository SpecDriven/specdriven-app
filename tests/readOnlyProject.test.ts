// The visitor's project on a read-only site showing several
// (src/frontend/readOnlyProject.ts): a `?project=` link picks it into the
// cookie every request carries, the address bar names it through every
// navigation, and a tab brought back to the front puts its own project back.
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
  chooseProject,
  cookieProject,
  parseReadOnlyProjects,
  setTabProject,
  showProjectInUrl,
} from "../src/frontend/readOnlyProject";

const here = () => location.pathname + location.search + location.hash;

beforeEach(() => {
  document.cookie = "specdriven-project=; Path=/; Max-Age=0";
  showProjectInUrl(null);
});

test("a ?project= link picks the project, and the address bar keeps naming it", () => {
  happy.happyDOM.setURL("http://localhost/features/shop/checkout?project=claims#S2");
  adoptProjectFromUrl();
  expect(cookieProject()).toBe("claims");
  expect(here()).toBe("/features/shop/checkout?project=claims#S2");
});

test("the address bar names the tab's project through the page's own navigation", () => {
  happy.happyDOM.setURL("http://localhost/features/shop#S2");
  showProjectInUrl("claims");
  expect(here()).toBe("/features/shop?project=claims#S2");
  history.pushState(null, "", "/features/shop/checkout");
  expect(here()).toBe("/features/shop/checkout?project=claims");
  history.replaceState(null, "", "/tasks?view=board#top");
  expect(here()).toBe("/tasks?view=board&project=claims#top");
  // A url that names another project is the tab's again.
  history.pushState(null, "", "/?project=quotes");
  expect(here()).toBe("/?project=claims");
  // Another origin's url is not the page's to rename.
  expect(() => history.pushState(null, "", "https://example.com/x")).toThrow();
});

test("a site showing one project names none in the address bar", () => {
  happy.happyDOM.setURL("http://localhost/features/shop?project=claims");
  showProjectInUrl(null);
  expect(here()).toBe("/features/shop");
  history.pushState(null, "", "/features/shop/checkout");
  expect(here()).toBe("/features/shop/checkout");
});

test("a malformed project id picks nothing, and the project shown replaces it in the url", () => {
  happy.happyDOM.setURL("http://localhost/?project=..%2Fetc");
  adoptProjectFromUrl();
  expect(cookieProject()).toBeNull();
  showProjectInUrl("quotes");
  expect(location.search).toBe("?project=quotes");
});

test("picking another project opens its home with the address bar naming it", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "location")!;
  const opened: string[] = [];
  Object.defineProperty(globalThis, "location", {
    value: { protocol: "http:", assign: (url: string) => opened.push(url) },
    configurable: true,
    writable: true,
  });
  try {
    chooseProject("claims");
  } finally {
    Object.defineProperty(globalThis, "location", real);
  }
  expect(opened).toEqual(["/?project=claims"]);
  expect(cookieProject()).toBe("claims");
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

// The Specs tab's urls (src/plugins/builtin/specs/route.ts) and the tab
// helpers a tab with no home view needs (src/plugins/client/tabs.ts).
import { expect, test } from "bun:test";
import { matchSpecsRoute, specsPath } from "../src/plugins/builtin/specs/route";
import { specsTab } from "../src/plugins/builtin/specs/client";
import { tabHref, tabReachable, type TabPlugin } from "../src/plugins/client/tabs";

test("a feature's url and a scenario's, versioned or not, read as the Specs view they name and back", () => {
  for (const url of [
    "/features/quotes",
    "/features/billing/basic-quote",
    "/features/quotes/scenarios/renewal",
    "/features/quotes/scenarios/renewal/v2",
  ]) {
    const view = matchSpecsRoute(url);
    expect(view === null).toBe(false);
    expect(specsPath(view!)).toBe(url);
  }
  expect(matchSpecsRoute("/features/quotes/scenarios/renewal/v2")).toEqual({
    feature: "specs/quotes.feature.md",
    scenario: { slug: "renewal", version: 2 },
  });
});

test("a url that is not a feature's is not the Specs tab's", () => {
  for (const url of ["/", "/notebook/entry", "/plugins", "/features"]) expect(matchSpecsRoute(url)).toBeNull();
});

test("a tab with no home view always has its door, and the door is home", () => {
  const tab = specsTab as unknown as TabPlugin;
  expect(tabReachable(tab)).toBe(true);
  expect(tabHref(tab)).toBe("/");
});

import { describe, expect, test } from "bun:test";
import {
  featurePath,
  pagePath,
  parseRoute,
  repoDisplayName,
  resolveScenario,
  pageLink,
  scenarioPath,
} from "../src/frontend/route";
import type { Scenario } from "../src/server/parser";

const sc = (name: string, version: number): Scenario => ({
  name,
  version,
  status: "draft",
  body: "",
  tests: [],
});

describe("parseRoute", () => {
  test("home", () => {
    expect(parseRoute("/")).toEqual({});
    expect(parseRoute("/features")).toEqual({});
    expect(parseRoute("/settings")).toEqual({});
  });

  // Roadmap pages (specs/app/roadmap.feature.md) and tasks (specs/app/tasks
  // .feature.md) address the markdown files in those data-repo folders.
  test("roadmap pages", () => {
    expect(parseRoute("/roadmap/pricing")).toEqual({ page: "roadmap/pricing.md" });
    expect(parseRoute("/roadmap/q3/pricing")).toEqual({ page: "roadmap/q3/pricing.md" });
    // A hand-typed link carrying the suffix doesn't double it up.
    expect(parseRoute("/roadmap/pricing.md")).toEqual({ page: "roadmap/pricing.md" });
    expect(parseRoute("/roadmap")).toEqual({});
    expect(pageLink("roadmap/q3/pricing.md")).toBe("/roadmap/q3/pricing");
    expect(parseRoute(pageLink("roadmap/a b.md"))).toEqual({ page: "roadmap/a b.md" });
    // Tasks read the same way, under their own folder.
    expect(parseRoute("/tasks/ship-v2")).toEqual({ page: "tasks/ship-v2.md" });
    expect(pageLink("tasks/sprint-4/ship-v2.md")).toBe("/tasks/sprint-4/ship-v2");
    expect(parseRoute("/tasks")).toEqual({});
  });

  test("feature url restores the file suffix", () => {
    expect(parseRoute("/features/navigation")).toEqual({ feature: "navigation.feature.md" });
    expect(parseRoute("/features/navigation/")).toEqual({ feature: "navigation.feature.md" });
  });

  test("a stem already carrying a suffix is not doubled", () => {
    expect(parseRoute("/features/navigation.feature.md").feature).toBe("navigation.feature.md");
    expect(parseRoute("/features/quote.feature").feature).toBe("quote.feature.md");
  });

  test("scenario url, with and without a version", () => {
    expect(parseRoute("/features/nav/scenarios/esc-key")).toEqual({
      feature: "nav.feature.md",
      scenario: { slug: "esc-key" },
    });
    expect(parseRoute("/features/nav/scenarios/esc-key/v2")).toEqual({
      feature: "nav.feature.md",
      scenario: { slug: "esc-key", version: 2 },
    });
  });

  test("an invalid version segment means no version", () => {
    expect(parseRoute("/features/nav/scenarios/esc-key/v0").scenario).toEqual({ slug: "esc-key" });
    expect(parseRoute("/features/nav/scenarios/esc-key/vx").scenario).toEqual({ slug: "esc-key" });
  });

  test("folder paths: every segment up to /scenarios belongs to the feature", () => {
    expect(parseRoute("/features/billing/quotes")).toEqual({
      feature: "billing/quotes.feature.md",
    });
    expect(parseRoute("/features/billing/sub/deep/scenarios/esc-key/v2")).toEqual({
      feature: "billing/sub/deep.feature.md",
      scenario: { slug: "esc-key", version: 2 },
    });
    // a top-level feature file that happens to be named scenarios
    expect(parseRoute("/features/scenarios")).toEqual({ feature: "scenarios.feature.md" });
  });

  test("mangled tails: a bare trailing /scenarios is dropped; version tails are ignored", () => {
    expect(parseRoute("/features/nav/scenarios")).toEqual({ feature: "nav.feature.md" });
    expect(parseRoute("/features/billing/nav/scenarios")).toEqual({
      feature: "billing/nav.feature.md",
    });
    expect(parseRoute("/features/nav/scenarios/esc-key/v2/extra")).toEqual({
      feature: "nav.feature.md",
      scenario: { slug: "esc-key", version: 2 },
    });
  });

  test("segments are url-decoded; malformed escapes survive as-is", () => {
    expect(parseRoute("/features/a%20b").feature).toBe("a b.feature.md");
    expect(parseRoute("/features/100%").feature).toBe("100%.feature.md");
  });
});

describe("paths", () => {
  test("featurePath strips the suffix and keeps folder segments", () => {
    expect(featurePath("navigation.feature.md")).toBe("/features/navigation");
    expect(featurePath("billing/sub/quotes.feature.md")).toBe("/features/billing/sub/quotes");
  });

  test("folder paths round-trip through parseRoute", () => {
    const path = scenarioPath("billing/quotes.feature.md", sc("Basic Quote!", 3));
    expect(path).toBe("/features/billing/quotes/scenarios/basic-quote/v3");
    expect(parseRoute(path)).toEqual({
      feature: "billing/quotes.feature.md",
      scenario: { slug: "basic-quote", version: 3 },
    });
    // segments a url can't carry are escaped and decoded back
    expect(parseRoute(featurePath("odd folder/a b.feature.md"))).toEqual({
      feature: "odd folder/a b.feature.md",
    });
  });

  test("scenarioPath is the canonical versioned permalink", () => {
    expect(scenarioPath("navigation.feature.md", sc("ESC key closes the dialog", 2))).toBe(
      "/features/navigation/scenarios/esc-key-closes-the-dialog/v2",
    );
  });

  test("paths round-trip through parseRoute", () => {
    const path = scenarioPath("quote-policy.feature.md", sc("Basic Quote!", 3));
    expect(parseRoute(path)).toEqual({
      feature: "quote-policy.feature.md",
      scenario: { slug: "basic-quote", version: 3 },
    });
  });
});

// specs/navigation.feature.md "a scenario page carries its own url": the url
// names the page that is open — a scenario's own while its page is open, the
// feature's otherwise. A highlighted card is not a page.
describe("pagePath", () => {
  test("no feature open is home", () => {
    expect(pagePath(null, null)).toBe("/");
    expect(pagePath(null, sc("Basic Quote", 2))).toBe("/");
  });

  test("a feature page with no scenario page open is the feature url", () => {
    expect(pagePath("billing/quotes.feature.md", null)).toBe("/features/billing/quotes");
  });

  test("an open scenario page is that scenario's permalink", () => {
    expect(pagePath("billing/quotes.feature.md", sc("Basic Quote", 2))).toBe(
      "/features/billing/quotes/scenarios/basic-quote/v2",
    );
  });

  test("the shared link resolves back to the page it was copied from", () => {
    const file = "billing/quotes.feature.md";
    const scenarios = [sc("Basic Quote", 1), sc("Basic Quote", 2)];
    // "Copy link" on the card shares exactly the page url ...
    const copied = pagePath(file, scenarios[1]!);
    expect(copied).toBe(scenarioPath(file, scenarios[1]!));
    // ... and opening it lands on that same scenario.
    const route = parseRoute(copied);
    expect(route.feature).toBe(file);
    expect(resolveScenario(scenarios, route.scenario!)).toBe(1);
  });
});

describe("resolveScenario", () => {
  const scenarios = [sc("Basic Quote", 1), sc("Basic Quote", 3), sc("Renewal", 2)];

  test("exact version", () => {
    expect(resolveScenario(scenarios, { slug: "basic-quote", version: 1 })).toBe(0);
    expect(resolveScenario(scenarios, { slug: "renewal", version: 2 })).toBe(2);
  });

  test("no version resolves to the highest version of the name", () => {
    expect(resolveScenario(scenarios, { slug: "basic-quote" })).toBe(1);
  });

  test("misses return null", () => {
    expect(resolveScenario(scenarios, { slug: "basic-quote", version: 2 })).toBeNull();
    expect(resolveScenario(scenarios, { slug: "gone" })).toBeNull();
    expect(resolveScenario([], { slug: "basic-quote" })).toBeNull();
  });

  test("slug collisions: first match in file order wins", () => {
    const colliding = [sc("Add user!", 1), sc("Add User", 1)];
    expect(resolveScenario(colliding, { slug: "add-user", version: 1 })).toBe(0);
    expect(resolveScenario(colliding, { slug: "add-user" })).toBe(0);
  });
});

// Sidebar header (specs/app-start.spec.md): only the data repo's own name
// shows; parent folders live in the tooltip.
describe("repoDisplayName", () => {
  test("absolute path shows the last folder", () => {
    expect(repoDisplayName("/Users/x/dev/specs-insurance")).toBe("specs-insurance");
    expect(repoDisplayName("/Users/x/dev/specs-insurance/")).toBe("specs-insurance");
  });

  test("relative path and bare name", () => {
    expect(repoDisplayName("../specs-insurance")).toBe("specs-insurance");
    expect(repoDisplayName("data")).toBe("data");
  });

  test("GitHub url shows the repo name", () => {
    expect(repoDisplayName("https://github.com/SpecDriven/data-insurance")).toBe(
      "data-insurance",
    );
    expect(repoDisplayName("https://github.com/SpecDriven/data-insurance.git")).toBe(
      "data-insurance",
    );
  });

  test("windows separators", () => {
    expect(repoDisplayName("C:\\dev\\specs-insurance")).toBe("specs-insurance");
  });
});

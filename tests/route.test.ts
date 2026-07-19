import { describe, expect, test } from "bun:test";
import { featurePath, parseRoute, resolveScenario, scenarioPath } from "../src/frontend/route";
import type { Scenario } from "../src/server/parser";

const sc = (name: string, version: number): Scenario => ({
  name,
  version,
  published: false,
  saved: false,
  body: "",
});

describe("parseRoute", () => {
  test("home", () => {
    expect(parseRoute("/")).toEqual({});
    expect(parseRoute("/features")).toEqual({});
    expect(parseRoute("/settings")).toEqual({});
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

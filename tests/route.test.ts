import { describe, expect, test } from "bun:test";
import {
  appPagePath,
  featurePath,
  matchAppPage,
  pagePath,
  parseRoute,
  repoDisplayName,
  resolveScenario,
  scenarioPath,
} from "../src/frontend/route";
import { pageLink, pagesPath, parsePageRoute } from "../src/plugins/builtin/pages/route";
import { issuesPath, parseIssuesRoute } from "../src/plugins/builtin/issues/route";
import { parseTestsRoute, testsPath } from "../src/plugins/builtin/tests/route";
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

  // Roadmap pages, tasks and notebook entries are the pages plugin's urls
  // (src/plugins/builtin/pages/route.ts); to the core they are home.
  test("the special folders' urls are not the core's", () => {
    expect(parseRoute("/roadmap/pricing")).toEqual({});
    expect(parseRoute("/tasks")).toEqual({});
    expect(parseRoute("/notebook/2026-09-12-spec-first")).toEqual({});
  });

  // GitHub issues (specs/app/github-issues.feature.md): the list, the
  // new-issue form, and one issue by number.
  // Parsed by the plugin (src/plugins/builtin/issues/route.ts); to the core
  // router the urls are home until the mounted tab claims them.
  test("issues routes", () => {
    expect(parseIssuesRoute("/issues")).toEqual({ kind: "list" });
    expect(parseIssuesRoute("/issues/")).toEqual({ kind: "list" });
    expect(parseIssuesRoute("/issues/new")).toEqual({ kind: "new" });
    expect(parseIssuesRoute("/issues/12")).toEqual({ kind: "issue", number: 12 });
    // Anything else under /issues is the list, not home.
    expect(parseIssuesRoute("/issues/0")).toEqual({ kind: "list" });
    expect(parseIssuesRoute("/issues/abc")).toEqual({ kind: "list" });
    expect(parseIssuesRoute("/issues/12/extra")).toEqual({ kind: "list" });
    expect(parseIssuesRoute("/issuesx")).toBeNull();
    expect(parseRoute("/issues/12")).toEqual({});
    for (const view of [{ kind: "list" as const }, { kind: "new" as const }, { kind: "issue" as const, number: 7 }]) {
      expect(parseIssuesRoute(issuesPath(view))).toEqual(view);
    }
    expect(issuesPath({ kind: "issue", number: 7 })).toBe("/issues/7");
  });

  // The test management module (specs/app/tests.feature.md) parses its own
  // urls, as a plugin (src/plugins/builtin/tests/route.ts): the plan list,
  // the case library, and one case, plan or run by id. To the core router
  // they are nothing — home — until the mounted tab claims them.
  test("tests routes", () => {
    expect(parseTestsRoute("/tests")).toEqual({ kind: "plans" });
    expect(parseTestsRoute("/tests/")).toEqual({ kind: "plans" });
    expect(parseTestsRoute("/tests/cases")).toEqual({ kind: "cases" });
    expect(parseTestsRoute("/tests/plans/p1")).toEqual({ kind: "plan", id: "p1" });
    expect(parseTestsRoute("/tests/cases/a%20b")).toEqual({ kind: "case", id: "a b" });
    expect(parseTestsRoute("/tests/runs/r1/extra")).toEqual({ kind: "run", id: "r1" });
    // Anything else under /tests is the plan list, not home.
    expect(parseTestsRoute("/tests/plans")).toEqual({ kind: "plans" });
    expect(parseTestsRoute("/tests/nope/x")).toEqual({ kind: "plans" });
    expect(parseTestsRoute("/testsy")).toBeNull();
    expect(parseTestsRoute("/features/x")).toBeNull();
    expect(parseRoute("/tests/plans/p1")).toEqual({});
    for (const view of [
      { kind: "plans" as const },
      { kind: "cases" as const },
      { kind: "case" as const, id: "a b" },
      { kind: "plan" as const, id: "p1" },
      { kind: "run" as const, id: "r/1" },
    ]) {
      expect(parseTestsRoute(testsPath(view))).toEqual(view);
    }
    expect(testsPath({ kind: "run", id: "r/1" })).toBe("/tests/runs/r%2F1");
  });

  test("feature url restores the file suffix", () => {
    expect(parseRoute("/features/navigation")).toEqual({ feature: "specs/navigation.feature.md" });
    expect(parseRoute("/features/navigation/")).toEqual({ feature: "specs/navigation.feature.md" });
  });

  test("a stem already carrying a suffix is not doubled", () => {
    expect(parseRoute("/features/navigation.feature.md").feature).toBe("specs/navigation.feature.md");
    expect(parseRoute("/features/quote.feature").feature).toBe("specs/quote.feature.md");
  });

  // Features moved under `specs/` without their urls changing, so a link
  // minted before the move must still land on the file at its new path.
  test("a url without the specs prefix still resolves", () => {
    expect(parseRoute("/features/billing/quotes").feature).toBe("specs/billing/quotes.feature.md");
  });

  test("a hand-typed specs prefix is not doubled", () => {
    expect(parseRoute("/features/specs/billing/quotes").feature).toBe(
      "specs/billing/quotes.feature.md",
    );
    expect(parseRoute("/features/specs/quotes.feature.md").feature).toBe(
      "specs/quotes.feature.md",
    );
  });

  test("scenario url, with and without a version", () => {
    expect(parseRoute("/features/nav/scenarios/esc-key")).toEqual({
      feature: "specs/nav.feature.md",
      scenario: { slug: "esc-key" },
    });
    expect(parseRoute("/features/nav/scenarios/esc-key/v2")).toEqual({
      feature: "specs/nav.feature.md",
      scenario: { slug: "esc-key", version: 2 },
    });
  });

  test("an invalid version segment means no version", () => {
    expect(parseRoute("/features/nav/scenarios/esc-key/v0").scenario).toEqual({ slug: "esc-key" });
    expect(parseRoute("/features/nav/scenarios/esc-key/vx").scenario).toEqual({ slug: "esc-key" });
  });

  test("folder paths: every segment up to /scenarios belongs to the feature", () => {
    expect(parseRoute("/features/billing/quotes")).toEqual({
      feature: "specs/billing/quotes.feature.md",
    });
    expect(parseRoute("/features/billing/sub/deep/scenarios/esc-key/v2")).toEqual({
      feature: "specs/billing/sub/deep.feature.md",
      scenario: { slug: "esc-key", version: 2 },
    });
    // a top-level feature file that happens to be named scenarios
    expect(parseRoute("/features/scenarios")).toEqual({ feature: "specs/scenarios.feature.md" });
  });

  test("mangled tails: a bare trailing /scenarios is dropped; version tails are ignored", () => {
    expect(parseRoute("/features/nav/scenarios")).toEqual({ feature: "specs/nav.feature.md" });
    expect(parseRoute("/features/billing/nav/scenarios")).toEqual({
      feature: "specs/billing/nav.feature.md",
    });
    expect(parseRoute("/features/nav/scenarios/esc-key/v2/extra")).toEqual({
      feature: "specs/nav.feature.md",
      scenario: { slug: "esc-key", version: 2 },
    });
  });

  test("segments are url-decoded; malformed escapes survive as-is", () => {
    expect(parseRoute("/features/a%20b").feature).toBe("specs/a b.feature.md");
    expect(parseRoute("/features/100%").feature).toBe("specs/100%.feature.md");
  });
});

describe("paths", () => {
  test("featurePath strips the suffix and keeps folder segments", () => {
    expect(featurePath("specs/navigation.feature.md")).toBe("/features/navigation");
    expect(featurePath("specs/billing/sub/quotes.feature.md")).toBe("/features/billing/sub/quotes");
  });

  test("folder paths round-trip through parseRoute", () => {
    const path = scenarioPath("specs/billing/quotes.feature.md", sc("Basic Quote!", 3));
    expect(path).toBe("/features/billing/quotes/scenarios/basic-quote/v3");
    expect(parseRoute(path)).toEqual({
      feature: "specs/billing/quotes.feature.md",
      scenario: { slug: "basic-quote", version: 3 },
    });
    // segments a url can't carry are escaped and decoded back
    expect(parseRoute(featurePath("specs/odd folder/a b.feature.md"))).toEqual({
      feature: "specs/odd folder/a b.feature.md",
    });
  });

  test("scenarioPath is the canonical versioned permalink", () => {
    expect(scenarioPath("specs/navigation.feature.md", sc("ESC key closes the dialog", 2))).toBe(
      "/features/navigation/scenarios/esc-key-closes-the-dialog/v2",
    );
  });

  test("paths round-trip through parseRoute", () => {
    const path = scenarioPath("specs/quote-policy.feature.md", sc("Basic Quote!", 3));
    expect(parseRoute(path)).toEqual({
      feature: "specs/quote-policy.feature.md",
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
    expect(pagePath("specs/billing/quotes.feature.md", null)).toBe("/features/billing/quotes");
  });

  test("an open scenario page is that scenario's permalink", () => {
    expect(pagePath("specs/billing/quotes.feature.md", sc("Basic Quote", 2))).toBe(
      "/features/billing/quotes/scenarios/basic-quote/v2",
    );
  });

  test("the shared link resolves back to the page it was copied from", () => {
    const file = "specs/billing/quotes.feature.md";
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

// Roadmap pages (specs/app/roadmap.feature.md), tasks (specs/app/tasks
// .feature.md) and notebook entries address the markdown files in those
// data-repo folders — each folder its own plugin, parsing only its own prefix.
describe("parsePageRoute", () => {
  test("roadmap pages", () => {
    expect(parsePageRoute("roadmap", "/roadmap/pricing")).toEqual({ fileName: "roadmap/pricing.md" });
    expect(parsePageRoute("roadmap", "/roadmap/q3/pricing")).toEqual({
      fileName: "roadmap/q3/pricing.md",
    });
    // A hand-typed link carrying the suffix doesn't double it up.
    expect(parsePageRoute("roadmap", "/roadmap/pricing.md")).toEqual({
      fileName: "roadmap/pricing.md",
    });
    expect(pageLink("roadmap/q3/pricing.md")).toBe("/roadmap/q3/pricing");
    expect(parsePageRoute("roadmap", pageLink("roadmap/a b.md"))).toEqual({
      fileName: "roadmap/a b.md",
    });
    // Tasks read the same way, under their own folder — and only there.
    expect(parsePageRoute("tasks", "/tasks/ship-v2")).toEqual({ fileName: "tasks/ship-v2.md" });
    expect(parsePageRoute("roadmap", "/tasks/ship-v2")).toBeNull();
    expect(pageLink("tasks/sprint-4/ship-v2.md")).toBe("/tasks/sprint-4/ship-v2");
  });

  // A special folder with no page after it names the tab, not a page: the
  // tab opens the first page it lists, the way `g t` / `g r` / `g n` and the
  // collapsed rail do (specs/app/tasks.feature.md "A bare folder url opens
  // that tab").
  test("a bare special folder names its tab", () => {
    expect(parsePageRoute("tasks", "/tasks")).toEqual({ fileName: null });
    expect(parsePageRoute("roadmap", "/roadmap")).toEqual({ fileName: null });
    expect(parsePageRoute("notebook", "/notebook")).toEqual({ fileName: null });
    // A trailing slash is the same url; empty segments are dropped.
    expect(parsePageRoute("tasks", "/tasks/")).toEqual({ fileName: null });
  });

  // specs/app/tasks.feature.md "Support deep link just like Features": an
  // open task holds the pane, and its url resolves back to it.
  test("a page's url resolves back to the page it was copied from", () => {
    const fileName = "tasks/sprint-4/ship-v2.md";
    expect(pagesPath("tasks", { fileName })).toBe("/tasks/sprint-4/ship-v2");
    expect(parsePageRoute("tasks", pagesPath("tasks", { fileName }))).toEqual({ fileName });
    expect(pagesPath("tasks", { fileName: null })).toBe("/tasks");
    // A search hit's marks are not part of the url.
    expect(pagesPath("tasks", { fileName, terms: ["ship"] })).toBe("/tasks/sprint-4/ship-v2");
  });
});

// specs/user-info-settings.feature.md "open Settings", "open Plugins": the
// app's own pages have their own urls.
describe("app pages", () => {
  test("Settings and Plugins have urls that resolve back to them", () => {
    expect(appPagePath("settings")).toBe("/settings");
    expect(appPagePath("plugins")).toBe("/plugins");
    expect(matchAppPage("/settings")).toBe("settings");
    expect(matchAppPage("/plugins/")).toBe("plugins");
  });

  test("anything else is not an app page", () => {
    expect(matchAppPage("/")).toBeNull();
    expect(matchAppPage("/settings/extra")).toBeNull();
    expect(matchAppPage("/features/settings")).toBeNull();
    expect(matchAppPage("/tasks")).toBeNull();
  });
});

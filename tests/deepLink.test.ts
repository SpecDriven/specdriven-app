import { describe, expect, test } from "bun:test";
import { deepLinkFromArgv, parseDesktopLink } from "../src/electron/deepLink";
import {
  desktopLink,
  featurePath,
  parseRoute,
  scenarioPath,
  splitRepoPath,
} from "../src/frontend/route";
import { pageLink, parsePageRoute } from "../src/plugins/builtin/pages/route";

describe("parseDesktopLink", () => {
  test("the url host is the first path segment", () => {
    expect(parseDesktopLink("specdriven://features/record-car-accident")).toBe(
      "/features/record-car-accident",
    );
  });

  test("folder paths and scenario refs survive intact", () => {
    expect(parseDesktopLink("specdriven://features/accidents/record-car-accident")).toBe(
      "/features/accidents/record-car-accident",
    );
    expect(parseDesktopLink("specdriven://features/billing/quotes/scenarios/esc-key/v2")).toBe(
      "/features/billing/quotes/scenarios/esc-key/v2",
    );
  });

  test("the three-slash form carries the whole path", () => {
    expect(parseDesktopLink("specdriven:///features/navigation")).toBe("/features/navigation");
  });

  test("the bare scheme is home", () => {
    expect(parseDesktopLink("specdriven://")).toBe("/");
    expect(parseDesktopLink("specdriven:///")).toBe("/");
  });

  test("query and fragment are dropped", () => {
    expect(parseDesktopLink("specdriven://features/nav?utm=chat#top")).toBe("/features/nav");
  });

  test("surrounding whitespace from a copy-paste is tolerated", () => {
    expect(parseDesktopLink("  specdriven://features/nav\n")).toBe("/features/nav");
  });

  test("other schemes and non-urls are not deep links", () => {
    expect(parseDesktopLink("https://example.com/features/nav")).toBeNull();
    expect(parseDesktopLink("app://specdriven/features/nav")).toBeNull();
    expect(parseDesktopLink("/features/nav")).toBeNull();
    expect(parseDesktopLink("--inspect")).toBeNull();
    expect(parseDesktopLink("")).toBeNull();
  });

  test("a link built by the app round-trips back to its route", () => {
    const file = "specs/billing/quotes.feature.md";
    const scenario = { name: "ESC key closes the dialog", version: 2 };
    const link = desktopLink(scenarioPath(file, scenario));
    expect(link).toBe("specdriven://features/billing/quotes/scenarios/esc-key-closes-the-dialog/v2");
    expect(parseRoute(parseDesktopLink(link)!)).toEqual({
      feature: file,
      scenario: { slug: "esc-key-closes-the-dialog", version: 2 },
    });
    expect(parseRoute(parseDesktopLink(desktopLink(featurePath(file)))!)).toEqual({ feature: file });
  });
});

describe("links that name their spec folder", () => {
  const insurance = "/Users/me/code/specs-insurance";
  const billing = "https://github.com/SpecDriven/specs-billing";
  const repos = [insurance, billing];

  test("desktopLink puts the folder's display name first", () => {
    const task = pageLink("tasks/experiment-with-lean-lang-for-formal-verification.md");
    expect(desktopLink(task, insurance)).toBe(
      "specdriven://specs-insurance/tasks/experiment-with-lean-lang-for-formal-verification",
    );
    expect(desktopLink("/features/quotes", billing)).toBe("specdriven://specs-billing/features/quotes");
    expect(desktopLink("/", insurance)).toBe("specdriven://specs-insurance");
  });

  test("without a folder the link is the bare path", () => {
    expect(desktopLink("/tasks/ship", null)).toBe("specdriven://tasks/ship");
    expect(desktopLink("/tasks/ship")).toBe("specdriven://tasks/ship");
  });

  test("a folder name a url can't carry is escaped, and comes back intact", () => {
    const link = desktopLink("/tasks/ship", "/Users/me/my specs");
    expect(link).toBe("specdriven://my%20specs/tasks/ship");
    expect(splitRepoPath(parseDesktopLink(link)!, ["/Users/me/my specs"])).toEqual({
      repo: "/Users/me/my specs",
      path: "/tasks/ship",
    });
  });

  test("a link round-trips to its folder and its route", () => {
    const file = "tasks/experiment-with-lean-lang-for-formal-verification.md";
    const path = parseDesktopLink(desktopLink(pageLink(file), insurance))!;
    const linked = splitRepoPath(path, repos);
    expect(linked.repo).toBe(insurance);
    expect(parsePageRoute("tasks", linked.path)).toEqual({ fileName: file });
  });

  test("folder names match regardless of case", () => {
    expect(splitRepoPath("/Specs-Billing/features/quotes", repos)).toEqual({
      repo: billing,
      path: "/features/quotes",
    });
  });

  test("the first folder of that name wins", () => {
    expect(splitRepoPath("/specs-insurance/tasks", [insurance, "/elsewhere/specs-insurance"]).repo).toBe(
      insurance,
    );
  });

  test("a link from before folders were named is left as it is", () => {
    expect(splitRepoPath("/features/quotes", repos)).toEqual({ repo: null, path: "/features/quotes" });
    expect(splitRepoPath("/tasks/ship", repos)).toEqual({ repo: null, path: "/tasks/ship" });
    expect(splitRepoPath("/", repos)).toEqual({ repo: null, path: "/" });
  });

  test("a folder this machine doesn't know is not split off", () => {
    expect(splitRepoPath("/specs-other/tasks/ship", repos)).toEqual({
      repo: null,
      path: "/specs-other/tasks/ship",
    });
  });

  test("a link to the folder alone is its home", () => {
    expect(splitRepoPath("/specs-insurance", repos)).toEqual({ repo: insurance, path: "/" });
  });
});

describe("deepLinkFromArgv", () => {
  test("finds the link among the launch arguments", () => {
    expect(
      deepLinkFromArgv(["/path/to/SpecDriven", "--allow-file-access", "specdriven://features/nav"]),
    ).toBe("/features/nav");
  });

  test("null when the app was launched without one", () => {
    expect(deepLinkFromArgv(["/path/to/SpecDriven", "--enable-logging"])).toBeNull();
    expect(deepLinkFromArgv([])).toBeNull();
  });
});

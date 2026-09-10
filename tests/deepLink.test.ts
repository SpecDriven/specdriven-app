import { describe, expect, test } from "bun:test";
import { deepLinkFromArgv, parseDesktopLink } from "../src/electron/deepLink";
import { desktopLink, featurePath, parseRoute, scenarioPath } from "../src/frontend/route";

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

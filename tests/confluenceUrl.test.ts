// Automates specs/external-links/confluence-wiki.feature.md "Publish a
// feature to Confluence": the parent page is named by any url Confluence
// Server / Data Center shows for it, and the wiki is what comes before the
// page part — its context path included.

import { test, expect, describe } from "bun:test";
import { normalizeConfluenceBase, onBase, parseParentPageUrl, sameBase, scenarioAnchorUrl } from "../src/server/confluenceUrl";

describe("parseParentPageUrl", () => {
  test("reads the /spaces/KEY/pages/ID form, title or not", () => {
    expect(parseParentPageUrl("https://wiki.acme.com/spaces/ABC/pages/99999/parent -page")).toEqual({
      base: "https://wiki.acme.com",
      spaceKey: "ABC",
      pageId: "99999",
    });
    expect(parseParentPageUrl("https://wiki.acme.com/spaces/ABC/pages/99999")).toEqual({
      base: "https://wiki.acme.com",
      spaceKey: "ABC",
      pageId: "99999",
    });
  });

  test("keeps a context path and a port in the wiki's base", () => {
    expect(parseParentPageUrl("https://acme.com:8443/wiki/spaces/ABC/pages/12/Parent")?.base).toBe(
      "https://acme.com:8443/wiki",
    );
    expect(parseParentPageUrl("http://127.0.0.1:4100/spaces/ABC/pages/1/Parent")?.base).toBe("http://127.0.0.1:4100");
  });

  test("reads viewpage.action?pageId= and the short /pages/ID", () => {
    expect(parseParentPageUrl("https://wiki.acme.com/pages/viewpage.action?pageId=4242")).toEqual({
      base: "https://wiki.acme.com",
      pageId: "4242",
    });
    expect(parseParentPageUrl("https://acme.com/wiki/pages/4242")).toEqual({ base: "https://acme.com/wiki", pageId: "4242" });
  });

  test("reads /display/KEY/Title as a title to look up, + and %20 as spaces", () => {
    expect(parseParentPageUrl("https://wiki.acme.com/display/ABC/Parent+Page")).toEqual({
      base: "https://wiki.acme.com",
      spaceKey: "ABC",
      title: "Parent Page",
    });
    expect(parseParentPageUrl("https://wiki.acme.com/display/ABC/Parent%20Page%3A%20Two")?.title).toBe(
      "Parent Page: Two",
    );
  });

  test("is null for what names no page", () => {
    for (const url of [
      "",
      "not a url",
      "ftp://wiki.acme.com/spaces/ABC/pages/1",
      "https://wiki.acme.com/",
      "https://wiki.acme.com/x/AbCd",
      "https://wiki.acme.com/display/ABC",
      "https://wiki.acme.com/spaces/ABC/overview",
      "https://wiki.acme.com/pages/viewpage.action?pageId=abc",
    ]) {
      expect(parseParentPageUrl(url)).toBeNull();
    }
  });
});

describe("the wiki's base", () => {
  test("a bare wiki url, or any page of it, normalized", () => {
    expect(normalizeConfluenceBase("https://wiki.acme.com/")).toBe("https://wiki.acme.com");
    expect(normalizeConfluenceBase(" https://acme.com/wiki/ ")).toBe("https://acme.com/wiki");
    expect(normalizeConfluenceBase("https://acme.com/wiki/spaces/ABC/pages/1/X")).toBe("https://acme.com/wiki");
    expect(normalizeConfluenceBase("wiki.acme.com")).toBeNull();
  });

  test("two urls are the same wiki by origin and context path, whatever the case", () => {
    expect(sameBase("https://Wiki.Acme.com", "https://wiki.acme.com/")).toBe(true);
    expect(sameBase("https://acme.com/wiki", "https://acme.com")).toBe(false);
    expect(sameBase("https://acme.com/wiki", "https://acme.com/wiki/display/ABC/Page")).toBe(true);
  });

  test("a page url lies on its wiki, and not on another", () => {
    expect(onBase("https://acme.com/wiki/spaces/ABC/pages/1/X", "https://acme.com/wiki")).toBe(true);
    expect(onBase("https://acme.com/other/pages/1", "https://acme.com/wiki")).toBe(false);
    expect(onBase("https://wiki.acme.com/pages/1", "https://wiki.acme.com")).toBe(true);
    expect(onBase("https://evil.com/pages/1", "https://wiki.acme.com")).toBe(false);
  });
});

describe("a scenario's deep link", () => {
  // Fragments as a Confluence Data Center 9.2 site writes them for the S<n> anchors.
  test("names the anchor after the page title, spaces and hyphens dropped, other punctuation kept", () => {
    const page = "https://wiki.acme.com/spaces/QA/pages/99/SCM+-+Dashboard+Global+Filters";
    expect(scenarioAnchorUrl(page, "SCM - Dashboard (Global Filters)", 3)).toBe(`${page}#SCMDashboard(GlobalFilters)-S3`);
    expect(scenarioAnchorUrl(page, "Security & Scoped Configuration", 1)).toBe(`${page}#Security%26ScopedConfiguration-S1`);
  });

  test("replaces a fragment the page url had; a draft, with no number, links the page", () => {
    const page = "https://wiki.acme.com/pages/viewpage.action?pageId=99";
    expect(scenarioAnchorUrl(`${page}#Old-S1`, "Quote Policy", 2)).toBe(`${page}#QuotePolicy-S2`);
    expect(scenarioAnchorUrl(`${page}#Old-S1`, "Quote Policy", null)).toBe(page);
  });
});

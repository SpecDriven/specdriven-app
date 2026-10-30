// Automates specs/external-links/jira-wiki-import.feature.md at the url
// level: which Jira site and issue a url names, and when two urls are one
// site.

import { describe, expect, test } from "bun:test";
import { jiraIssueUrl, normalizeJiraBase, parseJiraIssueUrl, sameJiraBase } from "../src/server/jiraUrl";

describe("a Jira issue url", () => {
  test("reads /browse/KEY, the project's issue page and a board's selected issue", () => {
    expect(parseJiraIssueUrl("https://jira.acme.com/browse/ABC-123")).toEqual({
      base: "https://jira.acme.com",
      key: "ABC-123",
    });
    expect(parseJiraIssueUrl("https://jira.acme.com/projects/ABC/issues/ABC-7?filter=allopenissues")).toEqual({
      base: "https://jira.acme.com",
      key: "ABC-7",
    });
    expect(
      parseJiraIssueUrl("https://jira.acme.com/secure/RapidBoard.jspa?rapidView=1&selectedIssue=ABC-9&quickFilter=2"),
    ).toEqual({ base: "https://jira.acme.com", key: "ABC-9" });
  });

  test("keeps a context path and a port in the site's base, and upper-cases the key", () => {
    expect(parseJiraIssueUrl("http://acme.com:8080/jira/browse/abc-12/")).toEqual({
      base: "http://acme.com:8080/jira",
      key: "ABC-12",
    });
  });

  test("is null for what names no issue", () => {
    expect(parseJiraIssueUrl("https://jira.acme.com")).toBeNull();
    expect(parseJiraIssueUrl("https://jira.acme.com/browse/")).toBeNull();
    expect(parseJiraIssueUrl("https://jira.acme.com/browse/not-a-key")).toBeNull();
    expect(parseJiraIssueUrl("https://jira.acme.com/projects/ABC")).toBeNull();
    expect(parseJiraIssueUrl("https://jira.acme.com/secure/Dashboard.jspa")).toBeNull();
    expect(parseJiraIssueUrl("https://wiki.acme.com/spaces/ABC/pages/1/Home")).toBeNull();
    expect(parseJiraIssueUrl("ABC-123")).toBeNull();
    expect(parseJiraIssueUrl("ftp://jira.acme.com/browse/ABC-1")).toBeNull();
  });

  test("is built the way Jira shows it", () => {
    expect(jiraIssueUrl("https://jira.acme.com/", "ABC-1")).toBe("https://jira.acme.com/browse/ABC-1");
  });
});

describe("a Jira site url", () => {
  test("a bare site url, or any issue url of it, normalized", () => {
    expect(normalizeJiraBase("https://jira.acme.com/")).toBe("https://jira.acme.com");
    expect(normalizeJiraBase("https://acme.com/jira/browse/ABC-1")).toBe("https://acme.com/jira");
    expect(normalizeJiraBase("https://jira.acme.com/?x=1#top")).toBe("https://jira.acme.com");
    expect(normalizeJiraBase("not a url")).toBeNull();
  });

  test("two urls are the same site by origin and context path, whatever the case", () => {
    expect(sameJiraBase("https://JIRA.acme.com", "https://jira.acme.com/browse/ABC-1")).toBe(true);
    expect(sameJiraBase("https://acme.com/jira", "https://acme.com/other")).toBe(false);
    expect(sameJiraBase("https://acme.com", "nope")).toBe(false);
  });
});

// specs/external-links/qtest-test-cases.feature.md "Create qTest test cases
// from a feature": which qTest site, project and module a url names.

import { describe, expect, test } from "bun:test";
import {
  moduleIdFromUrl,
  moduleWebUrl,
  normalizeQtestBase,
  onQtestBase,
  parseModuleUrl,
  sameQtestBase,
  testCaseIdFromUrl,
  testCaseWebUrl,
} from "../src/server/qtestUrl";

const SITE = "https://acme.qtestnet.com";
const MODULE = `${SITE}/p/12/portal/project#tab=testdesign&object=0&id=901`;
const CASE = `${SITE}/p/12/portal/project#tab=testdesign&object=1&id=6517980`;

describe("a module url", () => {
  test("names the site, the project and the module", () => {
    expect(parseModuleUrl(MODULE)).toEqual({ base: SITE, projectId: "12", moduleId: "901" });
    expect(moduleIdFromUrl(MODULE)).toBe("901");
  });

  test("reads the fragment in qTest's own order, id first", () => {
    const url = "https://acme.qtestnet.com/p/12345/portal/project#id=67890&object=0&tab=testdesign";
    expect(parseModuleUrl(url)).toEqual({ base: "https://acme.qtestnet.com", projectId: "12345", moduleId: "67890" });
  });

  test("keeps an on-premise context path in the site", () => {
    const url = "https://qa.acme.com/qtest/p/3/portal/project/#tab=testdesign&object=0&id=7";
    expect(parseModuleUrl(url)).toEqual({ base: "https://qa.acme.com/qtest", projectId: "3", moduleId: "7" });
  });

  test("is not a test case url, a project url or a non-url", () => {
    expect(parseModuleUrl(CASE)).toBeNull();
    expect(parseModuleUrl(`${SITE}/p/12/portal/project#tab=testdesign&object=2&id=901`)).toBeNull();
    expect(parseModuleUrl(`${SITE}/p/12/portal/project#id=901&object=0&tab=testexecution`)).toBeNull();
    expect(parseModuleUrl(`${SITE}/p/12/portal/project#tab=testdesign`)).toBeNull();
    expect(parseModuleUrl(`${SITE}/p/12/portal/project#tab=testdesign&object=0&id=MD-9`)).toBeNull();
    expect(parseModuleUrl(SITE)).toBeNull();
    expect(parseModuleUrl("ftp://acme.qtestnet.com/p/1/portal/project#object=0&id=1")).toBeNull();
    expect(parseModuleUrl("not a url")).toBeNull();
  });
});

describe("a test case url", () => {
  test("gives its numeric id, and a module url none", () => {
    expect(testCaseIdFromUrl(CASE)).toBe("6517980");
    expect(testCaseIdFromUrl(MODULE)).toBeNull();
    expect(testCaseIdFromUrl("https://elsewhere.example/x#object=1&id=5")).toBeNull();
    expect(testCaseIdFromUrl(`${SITE}/p/12/portal/project#id=5&object=1&tab=testexecution`)).toBeNull();
  });

  test("is built the way qTest shows it", () => {
    expect(testCaseWebUrl(SITE, "12", "6517980")).toBe(CASE);
    expect(moduleWebUrl(SITE, "12", "901")).toBe(MODULE);
  });
});

describe("a site url", () => {
  test("is the site itself, or any portal url of it, normalized", () => {
    expect(normalizeQtestBase("https://acme.qtestnet.com/")).toBe(SITE);
    expect(normalizeQtestBase(MODULE)).toBe(SITE);
    expect(normalizeQtestBase("https://qa.acme.com/qtest/?x=1")).toBe("https://qa.acme.com/qtest");
    expect(normalizeQtestBase("acme.qtestnet.com")).toBeNull();
  });

  test("two urls are the same site by origin and context path, whatever the case", () => {
    expect(sameQtestBase("https://ACME.qtestnet.com", MODULE)).toBe(true);
    expect(sameQtestBase("https://acme.qtestnet.com", "https://other.qtestnet.com")).toBe(false);
    expect(onQtestBase(CASE, SITE)).toBe(true);
    expect(onQtestBase(CASE, "https://qa.acme.com/qtest")).toBe(false);
    expect(onQtestBase("https://qa.acme.com/qtest/p/1/portal/project", "https://qa.acme.com/qtest")).toBe(true);
    expect(onQtestBase("https://qa.acme.com/other/p/1/portal/project", "https://qa.acme.com/qtest")).toBe(false);
  });
});

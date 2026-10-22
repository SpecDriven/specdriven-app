// Automates specs/external-links/aha-import.feature.md "Import a feature by
// its url" at the url level: which Aha! site and record a url names, a bare
// reference number against a chosen site, and when two urls are one site.

import { describe, expect, test } from "bun:test";
import {
  ahaRecordUrl,
  ahaRefKind,
  normalizeAhaBase,
  parseAhaRecordUrl,
  parseAhaRef,
  sameAhaBase,
} from "../src/server/ahaUrl";

describe("an Aha! record url", () => {
  test("names the site and the record: a feature, an epic, a requirement, an idea", () => {
    expect(parseAhaRecordUrl("https://acme.aha.io/features/APP-123")).toEqual({
      base: "https://acme.aha.io",
      kind: "feature",
      ref: "APP-123",
    });
    expect(parseAhaRecordUrl("https://acme.aha.io/epics/APP-E-12")).toMatchObject({ kind: "epic", ref: "APP-E-12" });
    expect(parseAhaRecordUrl("https://acme.aha.io/requirements/APP-123-1")).toMatchObject({
      kind: "requirement",
      ref: "APP-123-1",
    });
    expect(parseAhaRecordUrl("https://ideas.acme.com/ideas/APP-I-7")).toMatchObject({
      base: "https://ideas.acme.com",
      kind: "idea",
      ref: "APP-I-7",
    });
  });

  test("reads the reference in any case, with a trailing slash, and on a loopback stub", () => {
    expect(parseAhaRecordUrl(" https://ACME.aha.io/features/app-123/ ")).toEqual({
      base: "https://acme.aha.io",
      kind: "feature",
      ref: "APP-123",
    });
    expect(parseAhaRecordUrl("http://127.0.0.1:3999/features/APP-123")).toMatchObject({
      base: "http://127.0.0.1:3999",
      ref: "APP-123",
    });
  });

  test("is not a site url, a list url, a non-url or another scheme", () => {
    expect(parseAhaRecordUrl("https://acme.aha.io")).toBeNull();
    expect(parseAhaRecordUrl("https://acme.aha.io/features")).toBeNull();
    expect(parseAhaRecordUrl("https://acme.aha.io/features/not-a-ref")).toBeNull();
    expect(parseAhaRecordUrl("acme.aha.io/features/APP-123")).toBeNull();
    expect(parseAhaRecordUrl("ftp://acme.aha.io/features/APP-123")).toBeNull();
  });

  test("is built the way Aha! shows it", () => {
    expect(ahaRecordUrl("https://acme.aha.io", "requirement", "APP-123-1")).toBe(
      "https://acme.aha.io/requirements/APP-123-1",
    );
  });
});

describe("a bare reference number", () => {
  test("is read against the chosen site, its kind from its shape", () => {
    expect(parseAhaRef("app-123", "https://acme.aha.io/features/APP-1")).toEqual({
      base: "https://acme.aha.io",
      kind: "feature",
      ref: "APP-123",
    });
    expect(ahaRefKind("APP-E-12")).toBe("epic");
    expect(ahaRefKind("APP-I-7")).toBe("idea");
    expect(ahaRefKind("APP-123-1")).toBe("requirement");
    expect(ahaRefKind("APP-123")).toBe("feature");
  });

  test("is refused without a site, or when it is no reference number", () => {
    expect(parseAhaRef("APP-123", "acme.aha.io")).toBeNull();
    expect(parseAhaRef("Basic Quote", "https://acme.aha.io")).toBeNull();
    expect(parseAhaRef("", "https://acme.aha.io")).toBeNull();
  });
});

describe("an Aha! site", () => {
  test("is the origin of the site url, or of any record url of it", () => {
    expect(normalizeAhaBase("https://acme.aha.io/")).toBe("https://acme.aha.io");
    expect(normalizeAhaBase("https://acme.aha.io/features/APP-123?x=1#y")).toBe("https://acme.aha.io");
    expect(normalizeAhaBase("acme.aha.io")).toBeNull();
  });

  test("two urls are the same site by origin, whatever the case", () => {
    expect(sameAhaBase("https://ACME.aha.io/features/APP-1", "https://acme.aha.io")).toBe(true);
    expect(sameAhaBase("https://acme.aha.io", "https://other.aha.io")).toBe(false);
    expect(sameAhaBase("https://acme.aha.io", "nope")).toBe(false);
  });
});

// Release versions (src/server/version.ts): plain X.Y.Z, compared number
// by number — what the bump script refuses to move backwards and what
// Check for Updates calls newer (specs/app/app-updates.feature.md).
import { describe, expect, test } from "bun:test";
import { compareVersions, isNewer, parseVersion } from "../src/server/version";

describe("release versions", () => {
  test("X.Y.Z parses to its three numbers; anything else is no version", () => {
    expect(parseVersion("0.1.220")).toEqual([0, 1, 220]);
    expect(parseVersion("10.0.0")).toEqual([10, 0, 0]);
    for (const bad of ["v0.1.220", "0.1", "0.1.220-rc1", "0.1.220.1", "", "latest", "1.2.x"]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });

  test("versions compare numerically, not as text", () => {
    expect(compareVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.1.999")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.220", "0.1.220")).toBe(0);
    expect(() => compareVersions("0.1", "0.1.220")).toThrow('"0.1" is not a X.Y.Z version');
  });

  test("a newer version comes after the running one; a malformed one never does", () => {
    expect(isNewer("0.1.221", "0.1.220")).toBe(true);
    expect(isNewer("0.1.220", "0.1.220")).toBe(false);
    expect(isNewer("0.1.219", "0.1.220")).toBe(false);
    expect(isNewer("v0.1.999", "0.1.220")).toBe(false);
    expect(isNewer("0.1.999", "latest")).toBe(false);
  });
});

// Covers roadmap/deployment.md "Versioning": what `bun run bump` moves the
// release version to, and what it refuses to do.
import { test, expect } from "bun:test";
import { nextVersion, parseArgs, readVersion, setVersion } from "../scripts/bump-version";

test("major, minor and patch each zero the fields below them", () => {
  expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
  expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
  expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
  expect(nextVersion("0.9.9", "minor")).toBe("0.10.0");
});

test("an explicit version is taken as given", () => {
  expect(nextVersion("0.1.0", "1.2.3")).toBe("1.2.3");
  expect(nextVersion("0.1.0", "0.1.1")).toBe("0.1.1");
});

test("a version that does not come after the current one is refused", () => {
  // Released versions name immutable artifacts; going backwards would
  // overwrite a build people already installed.
  expect(() => nextVersion("1.2.3", "1.2.3")).toThrow(/does not come after/);
  expect(() => nextVersion("1.2.3", "1.2.2")).toThrow(/does not come after/);
  expect(() => nextVersion("1.2.3", "0.9.9")).toThrow(/does not come after/);
  expect(() => nextVersion("0.10.0", "0.9.0")).toThrow(/does not come after/);
});

test("only plain X.Y.Z versions are understood", () => {
  expect(() => nextVersion("1.2.3", "v1.2.4")).toThrow(/neither major, minor, patch/);
  expect(() => nextVersion("1.2.3", "1.2")).toThrow(/neither major, minor, patch/);
  expect(() => nextVersion("1.2.3", "2.0.0-rc.1")).toThrow(/neither major, minor, patch/);
  expect(() => nextVersion("1.2.3", "pacth")).toThrow(/neither major, minor, patch/);
  expect(() => nextVersion("nightly", "patch")).toThrow(/not a X\.Y\.Z version/);
});

test("bumping rewrites one line, leaving the rest of package.json byte for byte", () => {
  const pkg = `{\n  "name": "specdriven",\n  "version": "0.1.0",\n  "private": true\n}\n`;
  const out = setVersion(pkg, "0.2.0");
  expect(out).toBe(`{\n  "name": "specdriven",\n  "version": "0.2.0",\n  "private": true\n}\n`);
  expect(readVersion(out)).toBe("0.2.0");
});

test("the top-level version moves, not a version-shaped value further down", () => {
  const pkg = `{\n  "version": "0.1.0",\n  "build": {\n    "electronVersion": "0.1.0"\n  }\n}\n`;
  expect(readVersion(setVersion(pkg, "0.2.0"))).toBe("0.2.0");
  expect(setVersion(pkg, "0.2.0")).toContain(`"electronVersion": "0.1.0"`);
});

test("the real package.json carries a bumpable version", async () => {
  const current = readVersion(await Bun.file("package.json").text());
  expect(current).toMatch(/^\d+\.\d+\.\d+$/);
  expect(nextVersion(current, "patch")).not.toBe(current);
});

test("git work is opt-out, and a dry run touches nothing", () => {
  expect(parseArgs(["patch"])).toEqual({ bump: "patch", git: true, dryRun: false });
  expect(parseArgs(["1.2.3", "--no-git"])).toEqual({ bump: "1.2.3", git: false, dryRun: false });
  expect(parseArgs(["--dry-run", "minor"])).toEqual({ bump: "minor", git: true, dryRun: true });
});

test("a mistyped flag or a missing argument stops before anything is written", () => {
  expect(() => parseArgs([])).toThrow(/say what to bump/);
  expect(() => parseArgs(["patch", "minor"])).toThrow(/expected one version argument/);
  expect(() => parseArgs(["patch", "--dry"])).toThrow(/unknown option --dry/);
});

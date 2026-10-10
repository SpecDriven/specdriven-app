// Automates specs/app/open-source-license.feature.md: the app is
// AGPL-3.0-only, and every copy links to the source of the version it runs.

import { afterEach, expect, test } from "bun:test";
import pkg from "../package.json";
import { RELEASE_REPO_URL, sourceUrl } from "../src/server/sourceUrl";
import { sourceCodeMenuItems } from "../src/frontend/App";

const savedOverride = process.env.SPECDRIVEN_SOURCE_URL;
afterEach(() => {
  if (savedOverride === undefined) delete process.env.SPECDRIVEN_SOURCE_URL;
  else process.env.SPECDRIVEN_SOURCE_URL = savedOverride;
});

test("package.json names the license by its SPDX id", () => {
  expect(pkg.license).toBe("AGPL-3.0-only");
});

test("LICENSE.md is the GNU AGPL version 3 and NOTICE.md says version 3 only", async () => {
  const license = await Bun.file(new URL("../LICENSE.md", import.meta.url)).text();
  expect(license.trimStart().startsWith("GNU AFFERO GENERAL PUBLIC LICENSE")).toBe(true);
  expect(license).toContain("Version 3, 19 November 2007");
  expect(license).toContain("13. Remote Network Interaction; Use with the GNU General Public License.");
  const notice = await Bun.file(new URL("../NOTICE.md", import.meta.url)).text();
  expect(notice).toContain("AGPL-3.0-only");
  expect(notice).toContain("Copyright (c) 2026 David Vydra");
});

test("the desktop app ships the license and the notice", () => {
  expect(pkg.build.files).toContain("LICENSE.md");
  expect(pkg.build.files).toContain("NOTICE.md");
});

test("the source link names the release of the running version", () => {
  delete process.env.SPECDRIVEN_SOURCE_URL;
  expect(sourceUrl()).toBe(`${RELEASE_REPO_URL}/releases/tag/v${pkg.version}`);
  expect(sourceUrl("1.2.3")).toBe(`${RELEASE_REPO_URL}/releases/tag/v1.2.3`);
});

test("a deployment running modified code names its own source", () => {
  process.env.SPECDRIVEN_SOURCE_URL = " https://example.com/my-fork ";
  expect(sourceUrl()).toBe("https://example.com/my-fork");
  process.env.SPECDRIVEN_SOURCE_URL = "  ";
  expect(sourceUrl()).toBe(`${RELEASE_REPO_URL}/releases/tag/v${pkg.version}`);
});

test("the user menu offers Source code, which opens the source url", () => {
  const opened: string[] = [];
  const items = sourceCodeMenuItems("https://example.com/src", (u) => opened.push(u));
  expect(items.map((i) => [i.id, i.label, i.description])).toEqual([
    ["source-code", "Source code", "AGPL-3.0"],
  ]);
  items[0]!.onSelect!();
  expect(opened).toEqual(["https://example.com/src"]);
});

test("no Source code item before the state names the url", () => {
  expect(sourceCodeMenuItems(null)).toEqual([]);
});

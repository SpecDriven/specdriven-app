// Automates specs/app/desktop-app.feature.md "Data locations": the web server
// is anchored at the working directory with clones in a sibling directory; the
// desktop app re-bases both via SPECDRIVEN_ROOT / SPECDRIVEN_REPOS_DIR.

import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cloneBase, getAppRoot } from "../src/server/paths";
import { cloneDir } from "../src/server/repo";

const savedRoot = process.env.SPECDRIVEN_ROOT;
const savedRepos = process.env.SPECDRIVEN_REPOS_DIR;

afterEach(() => {
  if (savedRoot === undefined) delete process.env.SPECDRIVEN_ROOT;
  else process.env.SPECDRIVEN_ROOT = savedRoot;
  if (savedRepos === undefined) delete process.env.SPECDRIVEN_REPOS_DIR;
  else process.env.SPECDRIVEN_REPOS_DIR = savedRepos;
});

describe("getAppRoot", () => {
  test("defaults to the working directory", () => {
    delete process.env.SPECDRIVEN_ROOT;
    expect(getAppRoot()).toBe(process.cwd());
  });

  test("SPECDRIVEN_ROOT re-bases the app root", () => {
    process.env.SPECDRIVEN_ROOT = "/tmp/sd-app-data";
    expect(getAppRoot()).toBe("/tmp/sd-app-data");
  });
});

describe("cloneBase / cloneDir", () => {
  test("clones default to a sibling of the app root", () => {
    delete process.env.SPECDRIVEN_REPOS_DIR;
    expect(cloneBase("/work/specdriven_app")).toBe(resolve("/work"));
    expect(cloneDir("/work/specdriven_app", "data-insurance")).toBe(
      resolve("/work", "data-insurance"),
    );
  });

  test("SPECDRIVEN_REPOS_DIR gathers clones under the app-data directory", () => {
    process.env.SPECDRIVEN_REPOS_DIR = "/tmp/sd-app-data/repos";
    expect(cloneDir("/work/specdriven_app", "data-insurance")).toBe(
      resolve("/tmp/sd-app-data/repos", "data-insurance"),
    );
  });
});

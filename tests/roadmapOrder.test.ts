// specs/app/roadmap.feature.md "Reorder roadmap pages": the roadmap keeps its
// pages in an order of its own, as the tasks do (tests/taskOrder.test.ts has
// the order file, merging and folders) — Move up and Move down step a page
// one place, the next-to-last page down to the bottom included.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { PAGE_ORDER_FILE, parseOrder } from "../src/server/pageOrder";
import { ROADMAP, listPages, movePage } from "../src/server/pages";
import { writeState } from "../src/server/state";
import { syncPlugins } from "../src/plugins/host/loader";
import { ROADMAP_TAB, stepPlacement } from "../src/frontend/pages/pages";
import { stopServers } from "./helpers/fixtures";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-roadmap-order-"));
});

afterEach(async () => {
  stopServers();
  await rm(root, { recursive: true, force: true });
});

const listing = (dir: string) => listPages(dir, ROADMAP);
const names = async (dir: string) => (await listing(dir)).map((p) => p.fileName);

/** Four roadmap pages, written by hand — nothing committed. */
async function seed(dir: string): Promise<void> {
  await mkdir(join(dir, "roadmap"), { recursive: true });
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
    await writeFile(join(dir, "roadmap", `${name.toLowerCase()}.md`), `# ${name}\n`);
  }
}

/** Move up / Move down as the ⋯ menu does it: the step, then the move. */
async function step(dir: string, fileName: string, by: -1 | 1): Promise<boolean> {
  const before = stepPlacement(await listing(dir), fileName, by);
  if (before === undefined) return false;
  await movePage(dir, ROADMAP, fileName, "roadmap", before);
  return true;
}

test("the roadmap tab and folder keep an order of their own", () => {
  expect(ROADMAP.ordered).toBe(true);
  expect(ROADMAP_TAB.ordered).toBe(true);
});

test("roadmap pages move up and down one place, the next-to-last to the bottom", async () => {
  await seed(root);
  expect(await names(root)).toEqual([
    "roadmap/alpha.md",
    "roadmap/bravo.md",
    "roadmap/charlie.md",
    "roadmap/delta.md",
  ]);

  // The next-to-last page goes down to the bottom.
  expect(await step(root, "roadmap/charlie.md", 1)).toBe(true);
  expect(await names(root)).toEqual([
    "roadmap/alpha.md",
    "roadmap/bravo.md",
    "roadmap/delta.md",
    "roadmap/charlie.md",
  ]);
  expect(parseOrder(await readFile(join(root, "roadmap", PAGE_ORDER_FILE), "utf8"))).toEqual([
    "alpha.md",
    "bravo.md",
    "delta.md",
    "charlie.md",
  ]);

  // And back up, and the last page can go no further down nor the first up.
  expect(await step(root, "roadmap/charlie.md", -1)).toBe(true);
  expect(await names(root)).toEqual([
    "roadmap/alpha.md",
    "roadmap/bravo.md",
    "roadmap/charlie.md",
    "roadmap/delta.md",
  ]);
  expect(await step(root, "roadmap/delta.md", 1)).toBe(false);
  expect(await step(root, "roadmap/alpha.md", -1)).toBe(false);

  // Down from the top, one place at a time, all the way to the bottom.
  for (let i = 0; i < 3; i++) expect(await step(root, "roadmap/alpha.md", 1)).toBe(true);
  expect(await names(root)).toEqual([
    "roadmap/bravo.md",
    "roadmap/charlie.md",
    "roadmap/delta.md",
    "roadmap/alpha.md",
  ]);
});

test("the roadmap routes list folders and move a page to the bottom", async () => {
  const home = await mkdtemp(join(tmpdir(), "specdriven-roadmap-order-home-"));
  const realRoot = process.env.SPECDRIVEN_ROOT;
  const realHome = process.env.SPECDRIVEN_HOME;
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  const data = join(root, "data");
  const call = async (method: string, path: string, body?: unknown) => {
    const res = (await handleApi(
      new Request(`http://localhost${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      }),
    )) as Response;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  try {
    await writeState({ dataRepo: data, roadmap: true }, root);
    await syncPlugins({ roadmap: true });
    await seed(data);

    // Move down on the next-to-last page: no `before`, so last.
    const moved = await call("POST", `/api/roadmap/${encodeURIComponent("roadmap/charlie.md")}/move`, {
      folder: "roadmap",
      before: null,
    });
    expect(moved.body).toEqual({ fileName: "roadmap/charlie.md", message: "reordered" });
    expect((await call("POST", "/api/roadmap-folders", { path: "Later" })).body).toEqual({
      path: "roadmap/later",
    });
    const list = await call("GET", "/api/roadmap");
    expect((list.body.pages as { fileName: string }[]).map((p) => p.fileName)).toEqual([
      "roadmap/alpha.md",
      "roadmap/bravo.md",
      "roadmap/delta.md",
      "roadmap/charlie.md",
    ]);
    expect(list.body.folders).toEqual(["roadmap/later"]);
  } finally {
    reloader.stop();
    await syncPlugins({ roadmap: false });
    await rm(home, { recursive: true, force: true });
    for (const [name, value] of [
      ["SPECDRIVEN_ROOT", realRoot],
      ["SPECDRIVEN_HOME", realHome],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

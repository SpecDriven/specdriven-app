// specs/ui/ui.feature.md "User-entered text is cleaned up": settings typed
// into the Settings and Plugins pages are saved cleaned — a name collapsed,
// a folder path only trimmed (a folder name may hold inner spaces).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { readState, writeState } from "../src/server/state";

let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-whitespace-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-whitespace-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  await writeState({ dataRepo: root }, root);
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const put = async (body: unknown) =>
  (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ))!;

test("a project-management tool name is saved trimmed and collapsed", async () => {
  const res = await put({ projectManagementTool: "  Azure   Boards " });
  expect(res.status).toBe(200);
  expect((await readState(root)).projectManagementTool).toBe("Azure Boards");
});

test("a plugin folder and a trusted folder are saved trimmed, inner spaces kept", async () => {
  const folder = join(root, "my  plugin");
  expect((await put({ plugins: { sources: [` ${folder} `] } })).status).toBe(200);
  expect((await put({ plugins: { trust: `${folder}\t` } })).status).toBe(200);
  const section = ((await readState(root)) as { plugins?: { sources?: unknown; trusted?: unknown } }).plugins;
  expect(section?.sources).toEqual([{ path: folder }]);
  expect(section?.trusted).toEqual([folder]);
});

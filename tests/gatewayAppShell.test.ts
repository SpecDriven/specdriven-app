// The app's frontend served by the hosted gateway (src/gateway/appShell.ts):
// every page path gets the shell, bundled assets come from /_app/, and the
// worker keeps its API and the plugins' client bundles.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkerPath, loadAppShell, type AppShell } from "../src/gateway/appShell";

let dist: string;
let shell: AppShell;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "app-dist-"));
  await Bun.write(join(dist, "index.html"), '<!doctype html><script src="/_app/index-abc.js"></script>');
  await Bun.write(join(dist, "index-abc.js"), "console.log(1)");
  shell = await loadAppShell({ production: true, distDir: dist });
});

afterAll(() => rm(dist, { recursive: true, force: true }));

const get = (path: string, method = "GET") =>
  shell.serve(new Request(`http://x${path}`, { method }), new URL(`http://x${path}`));

test("page paths get the shell", async () => {
  for (const path of ["/", "/features/billing/quote", "/settings", "/roadmap/x"]) {
    const res = await get(path);
    expect(res?.headers.get("content-type")).toContain("text/html");
    expect(await res!.text()).toContain("/_app/index-abc.js");
  }
});

test("bundled assets are served immutable, and nothing outside the build is", async () => {
  const res = await get("/_app/index-abc.js");
  expect(await res!.text()).toBe("console.log(1)");
  expect(res!.headers.get("cache-control")).toContain("immutable");
  expect((await get("/_app/..%2f..%2fetc%2fpasswd"))!.status).toBe(404);
  expect((await get("/_app/missing.js"))!.status).toBe(404);
});

test("the API, plugin bundles and writes are the worker's", async () => {
  expect(await get("/api/state")).toBeNull();
  expect(await get("/plugins/notes/client.js")).toBeNull();
  expect(await get("/", "POST")).toBeNull();
  expect(isWorkerPath("/plugins")).toBe(false);
});

// The Resources routes (src/server/resources.ts, specs/app/resource-usage
// .feature.md [proposed]): refused in the demo and the hosted app, and a
// cleanup request checked before anything runs.
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getResourceDisk, getResourceMemory, postResourceCleanup, resourcePlaces } from "../src/server/resources";

const saved = { demo: process.env.DEMO_MODE, hosted: process.env.SPECDRIVEN_HOSTED };
afterEach(() => {
  for (const [key, value] of [["DEMO_MODE", saved.demo], ["SPECDRIVEN_HOSTED", saved.hosted]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const get = (path: string) => new Request(`http://localhost${path}`);
const post = (body: unknown) =>
  new Request("http://localhost/api/resources/cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the resource routes", () => {
  test("the demo and the hosted app refuse every resource route", async () => {
    for (const [key, words] of [["DEMO_MODE", "Resources are not shown in the demo"], ["SPECDRIVEN_HOSTED", "This is not available in the hosted app"]] as const) {
      delete process.env.DEMO_MODE;
      delete process.env.SPECDRIVEN_HOSTED;
      process.env[key] = "1";
      for (const res of [
        await getResourceMemory(get("/api/resources/memory"), {}),
        await getResourceDisk(get("/api/resources/disk"), {}),
        await postResourceCleanup(post({ kind: "logs" }), {}),
      ]) {
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe(words);
      }
    }
  });

  test("a cleanup request that is not one is refused before anything runs", async () => {
    delete process.env.DEMO_MODE;
    delete process.env.SPECDRIVEN_HOSTED;
    const bad = await postResourceCleanup(post({ kind: "everything" }), {});
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("kind must be one of");
    const notJson = await postResourceCleanup(new Request("http://localhost/api/resources/cleanup", { method: "POST", body: "[]" }), {});
    expect(notJson.status).toBe(400);
  });

  test("memory answers with this process in its groups", async () => {
    delete process.env.DEMO_MODE;
    delete process.env.SPECDRIVEN_HOSTED;
    const res = await getResourceMemory(get("/api/resources/memory"), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: { branches: { processes: { pid: number }[] }[] }[] };
    expect(body.groups.flatMap((g) => g.branches.flatMap((b) => b.processes.map((p) => p.pid)))).toContain(process.pid);
  });

  test("the places measured are the SpecDriven home and the settings beside it", async () => {
    const places = await resourcePlaces();
    expect(places.home).toBe(process.env.SPECDRIVEN_HOME || join(homedir(), ".specdriven"));
    expect(places.settingsDir.length).toBeGreaterThan(0);
    expect(places.liveWorktrees.size).toBe(0);
  });
});

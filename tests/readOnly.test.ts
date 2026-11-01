// The public read-only spec site (src/server/readOnlyMode.ts,
// src/server/readOnly.ts, src/gateway/readOnly.ts): one public spec repo,
// cloned and kept current, served to anyone — every write refused.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { readOnlyEnv } from "../src/gateway/readOnly";
import {
  DEFAULT_READ_ONLY_REPO,
  readOnlyAllows,
  readReadOnlyConfig,
} from "../src/server/readOnlyMode";

test("the site shows SpecDriven's spec repo unless told otherwise", () => {
  expect(readReadOnlyConfig({})).toEqual({ repo: DEFAULT_READ_ONLY_REPO, branch: "main", refreshSeconds: 60 });
  expect(
    readReadOnlyConfig({
      SPECDRIVEN_READONLY_REPO: "https://github.com/acme/specs.git/",
      SPECDRIVEN_READONLY_BRANCH: "release",
      SPECDRIVEN_READONLY_REFRESH_SECONDS: "0",
    }),
  ).toEqual({ repo: "https://github.com/acme/specs.git", branch: "release", refreshSeconds: 0 });
});

test("a repo that is no GitHub url, a branch git reads as an option and a bad cadence stop the start", () => {
  expect(() => readReadOnlyConfig({ SPECDRIVEN_READONLY_REPO: "git@github.com:acme/specs.git" })).toThrow();
  expect(() => readReadOnlyConfig({ SPECDRIVEN_READONLY_REPO: "https://gitlab.com/acme/specs" })).toThrow();
  expect(() => readReadOnlyConfig({ SPECDRIVEN_READONLY_BRANCH: "--upload-pack=x" })).toThrow();
  expect(() => readReadOnlyConfig({ SPECDRIVEN_READONLY_REFRESH_SECONDS: "-1" })).toThrow();
  expect(() => readReadOnlyConfig({ SPECDRIVEN_READONLY_REFRESH_SECONDS: "soon" })).toThrow();
});

test("only the reads the site shows are allowed", () => {
  for (const pattern of ["/api/state", "/api/features", "/api/features/:file", "/api/search", "/api/roadmap/:file"]) {
    expect(readOnlyAllows("GET", pattern)).toBe(true);
  }
  expect(readOnlyAllows("HEAD", "/api/features")).toBe(true);
  expect(readOnlyAllows("PUT", "/api/features/:file")).toBe(false);
  expect(readOnlyAllows("POST", "/api/features")).toBe(false);
  expect(readOnlyAllows("PUT", "/api/state")).toBe(false);
  expect(readOnlyAllows("GET", "/api/logs")).toBe(false);
  expect(readOnlyAllows("GET", "/api/data/tables")).toBe(false);
  expect(readOnlyAllows("GET", "/api/tasks")).toBe(false);
  expect(readOnlyAllows("GET", "/api/confluence/tokens")).toBe(false);
});

test("on the hosted image the site listens publicly, keeps HOME off /root and fetches no plugins", () => {
  const env = readOnlyEnv({ SPECDRIVEN_READONLY: "1" });
  expect(env.SPECDRIVEN_ROOT).toBe("/tmp/specdriven-readonly");
  expect(env.HOME).toBe("/tmp/specdriven-readonly/home");
  expect(env.SPECDRIVEN_HOST).toBe("0.0.0.0");
  expect(env.SPECDRIVEN_ALLOWED_HOSTS).toBe("*");
  expect(env.SPECDRIVEN_NO_AUTO_INSTALL).toBe("1");
  expect(readOnlyEnv({ SPECDRIVEN_ALLOWED_HOSTS: "specs.specdriven.app" }).SPECDRIVEN_ALLOWED_HOSTS).toBe(
    "specs.specdriven.app",
  );
});

// ---- the site itself, against a repo of its own -----------------------------

const work = await mkdtemp(join(tmpdir(), "read-only-site-"));
const origin = join(work, "origin");
const root = join(work, "root");
let proc: ReturnType<typeof Bun.spawn> | undefined;
let base = "";

const FEATURE = `# Checkout

## S1: Pay by card @v1 [published]

- Given: a cart
- When: the shopper pays by card
- Then: the order is placed
`;

async function commit(file: string, text: string, message: string) {
  await mkdir(join(origin, file, ".."), { recursive: true });
  await writeFile(join(origin, file), text);
  await $`git -C ${origin} add -A`.quiet();
  await $`git -C ${origin} -c user.name=t -c user.email=t@t commit -q -m ${message}`.quiet();
}

beforeAll(async () => {
  await mkdir(origin);
  await $`git -C ${origin} init -q -b main`.quiet();
  await commit("specs/shop/checkout.feature.md", FEATURE, "checkout");
  await commit("roadmap/next.md", "# Next\n\nWhat comes next.\n", "roadmap");
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn([process.execPath, "src/index.ts"], {
    env: {
      ...process.env,
      SPECDRIVEN_READONLY: "1",
      SPECDRIVEN_READONLY_REPO: origin,
      SPECDRIVEN_READONLY_REFRESH_SECONDS: "1",
      SPECDRIVEN_ROOT: root,
      SPECDRIVEN_LOG_FILE: "0",
      SPECDRIVEN_NO_AUTO_INSTALL: "1",
      SPECDRIVEN_HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "production",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${base}/healthz`).catch(() => undefined);
    if (res?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error(`the site did not start: ${await new Response(proc.stderr as ReadableStream).text()}`);
}, 40_000);

afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  await rm(work, { recursive: true, force: true });
});

test("the state says read-only, names the repo and no one signed in", async () => {
  const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
  expect(state.readOnly).toBe(true);
  expect(state.dataRepo).toBe(origin);
  expect(state.recentDataRepoDirs).toEqual({});
  expect(state.auth).toEqual({ signedIn: false });
  expect(state.agents).toEqual([]);
  expect((state.user as { name: string }).name).toBe("Visitor");
  const enabled = (state.plugins as { id: string; enabled: boolean }[]).filter((p) => p.enabled).map((p) => p.id);
  expect(enabled).toEqual(["roadmap"]);
});

test("features and the roadmap are served", async () => {
  const listing = (await (await fetch(`${base}/api/features`)).json()) as { features: { fileName: string }[] };
  expect(listing.features.map((f) => f.fileName)).toContain("specs/shop/checkout.feature.md");
  const feature = await fetch(`${base}/api/features/${encodeURIComponent("specs/shop/checkout.feature.md")}`);
  expect(feature.status).toBe(200);
  const roadmap = (await (await fetch(`${base}/api/roadmap`)).json()) as { pages: { fileName: string }[] };
  expect(roadmap.pages.map((p) => p.fileName)).toEqual(["roadmap/next.md"]);
  expect((await fetch(`${base}/features/shop/checkout`)).status).toBe(200);
});

test("every write and every other read is refused before it runs", async () => {
  const file = encodeURIComponent("specs/shop/checkout.feature.md");
  const json = { "content-type": "application/json", origin: base };
  const refused = [
    fetch(`${base}/api/state`, { method: "PUT", headers: json, body: "{}" }),
    fetch(`${base}/api/features`, { method: "POST", headers: json, body: JSON.stringify({ fileName: "x" }) }),
    fetch(`${base}/api/features/${file}`, { method: "PUT", headers: json, body: "{}" }),
    fetch(`${base}/api/features/${file}`, { method: "DELETE", headers: { origin: base } }),
    fetch(`${base}/api/roadmap/${encodeURIComponent("roadmap/next.md")}`, { method: "PUT", headers: json, body: "{}" }),
    fetch(`${base}/api/reload`, { method: "POST", headers: json, body: "{}" }),
    fetch(`${base}/api/logs`),
    fetch(`${base}/api/data/tables`),
    fetch(`${base}/api/tasks`),
  ];
  for (const res of await Promise.all(refused)) {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This site is read-only" });
  }
  expect(await Bun.file(join(origin, "specs/shop/checkout.feature.md")).text()).toBe(FEATURE);
});

test("the app serves a copy with no .git, so nothing it does can commit or push", async () => {
  const snapshots = (await readdir(root)).filter((n) => n.startsWith("snapshot-"));
  expect(snapshots.length).toBeGreaterThan(0);
  for (const s of snapshots) {
    expect(await stat(join(root, s, ".git")).catch(() => null)).toBeNull();
  }
});

test("a change pushed to the repo shows up after the next refresh", async () => {
  await commit("specs/shop/returns.feature.md", "# Returns\n", "returns");
  let files: string[] = [];
  for (let i = 0; i < 100 && !files.includes("specs/shop/returns.feature.md"); i++) {
    await Bun.sleep(100);
    const listing = (await (await fetch(`${base}/api/features`)).json()) as { features: { fileName: string }[] };
    files = listing.features.map((f) => f.fileName);
  }
  expect(files).toContain("specs/shop/returns.feature.md");
}, 15_000);

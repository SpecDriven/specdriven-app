// The public read-only spec site (src/server/readOnlyMode.ts,
// src/server/readOnly.ts, src/gateway/readOnly.ts): one public spec repo,
// cloned and kept current, served to anyone — every write refused.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { readOnlyEnv } from "../src/gateway/readOnly";
import { PROFILE_FORMAT } from "../src/plugins/profile";
import { statePath } from "../src/server/state";
import { readSettings } from "./helpers/settingsFile";
import {
  DEFAULT_READ_ONLY_REPO,
  projectFromCookie,
  READ_ONLY_PLUGINS,
  readOnlyAllows,
  readReadOnlyConfig,
} from "../src/server/readOnlyMode";

test("the site shows SpecDriven's spec repo unless told otherwise", () => {
  expect(readReadOnlyConfig({})).toEqual({
    projects: [{ id: "specs-specdriven", repo: DEFAULT_READ_ONLY_REPO, branch: "main" }],
    refreshSeconds: 60,
  });
  expect(
    readReadOnlyConfig({
      SPECDRIVEN_READONLY_REPO: "https://github.com/acme/specs.git/",
      SPECDRIVEN_READONLY_BRANCH: "release",
      SPECDRIVEN_READONLY_REFRESH_SECONDS: "0",
    }),
  ).toEqual({ projects: [{ id: "specs", repo: "https://github.com/acme/specs.git", branch: "release" }], refreshSeconds: 0 });
});

test("several projects are listed in one variable, each named by its repo unless the entry names it", () => {
  const config = readReadOnlyConfig({
    SPECDRIVEN_READONLY_PROJECTS: `
      https://github.com/SpecDriven/specs-specdriven,
      https://github.com/acme/Shop-Specs.git#release
      legacy=https://github.com/other/specs-specdriven
    `,
    SPECDRIVEN_READONLY_BRANCH: "trunk",
  });
  expect(config.projects).toEqual([
    { id: "specs-specdriven", repo: "https://github.com/SpecDriven/specs-specdriven", branch: "trunk" },
    { id: "shop-specs", repo: "https://github.com/acme/Shop-Specs.git", branch: "release" },
    { id: "legacy", repo: "https://github.com/other/specs-specdriven", branch: "trunk" },
  ]);
});

test("a repo that is no GitHub url, a branch git reads as an option and a bad cadence stop the start", () => {
  expect(() => readReadOnlyConfig({ SPECDRIVEN_READONLY_REPO: "git@github.com:acme/specs.git" })).toThrow();
  expect(() => readReadOnlyConfig({ SPECDRIVEN_READONLY_REPO: "https://gitlab.com/acme/specs" })).toThrow();
  expect(() => readReadOnlyConfig({ SPECDRIVEN_READONLY_BRANCH: "--upload-pack=x" })).toThrow();
  expect(() => readReadOnlyConfig({ SPECDRIVEN_READONLY_REFRESH_SECONDS: "-1" })).toThrow();
  expect(() => readReadOnlyConfig({ SPECDRIVEN_READONLY_REFRESH_SECONDS: "soon" })).toThrow();
});

test("a project list with a bad entry, two projects of one name, or a single repo beside it stops the start", () => {
  const list = (v: string) => () => readReadOnlyConfig({ SPECDRIVEN_READONLY_PROJECTS: v });
  expect(list("https://github.com/a/specs, https://gitlab.com/b/specs")).toThrow("SPECDRIVEN_READONLY_PROJECTS");
  expect(list("https://github.com/a/specs#--upload-pack=x")).toThrow();
  expect(list("https://github.com/a/specs https://github.com/b/specs")).toThrow('two projects "specs"');
  expect(list("Bad Name=https://github.com/a/specs")).toThrow();
  expect(list(" , ")).toThrow("names no project");
  expect(() =>
    readReadOnlyConfig({
      SPECDRIVEN_READONLY_PROJECTS: "https://github.com/a/specs",
      SPECDRIVEN_READONLY_REPO: "https://github.com/b/specs",
    }),
  ).toThrow("not both");
});

test("a visitor's project is read from their cookie, and only a well-formed id counts", () => {
  expect(projectFromCookie(null)).toBeNull();
  expect(projectFromCookie("theme=dark; specdriven-project=shop-specs; x=1")).toBe("shop-specs");
  expect(projectFromCookie("specdriven-project=../etc")).toBeNull();
  expect(projectFromCookie("other-specdriven-project=shop")).toBeNull();
});

test("only the reads the site shows are allowed", () => {
  for (const pattern of ["/api/state", "/api/features", "/api/features/:file", "/api/search", "/api/roadmap/:file"]) {
    expect(readOnlyAllows("GET", pattern)).toBe(true);
  }
  // The Event Models: listed, opened and exported; never created, saved,
  // deleted or sliced into a feature.
  for (const pattern of ["/api/models", "/api/models/:file", "/api/models/:file/export"]) {
    expect(readOnlyAllows("GET", pattern)).toBe(true);
  }
  expect(readOnlyAllows("POST", "/api/models")).toBe(false);
  expect(readOnlyAllows("PUT", "/api/models/:file")).toBe(false);
  expect(readOnlyAllows("DELETE", "/api/models/:file")).toBe(false);
  expect(readOnlyAllows("POST", "/api/models/:file/slices/:slice/feature")).toBe(false);
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
/** The site's second project, named "other" in the list. */
const second = join(work, "second");
const root = join(work, "root");
/** The marketplace the site installs the Event Models from: a stand-in for SpecDriven's. */
const marketplace = join(work, "marketplace");
let proc: ReturnType<typeof Bun.spawn> | undefined;
let base = "";

const FEATURE = `# Checkout

## S1: Pay by card @v1 [published]

- Given: a cart
- When: the shopper pays by card
- Then: the order is placed
`;

async function commit(file: string, text: string, message: string, repo = origin) {
  await mkdir(join(repo, file, ".."), { recursive: true });
  await writeFile(join(repo, file), text);
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m ${message}`.quiet();
}

/**
 * A marketplace whose event-model ships prebuilt, as the real one does: a
 * host half answering GET /api/models with its version, so a test can tell
 * it is mounted.
 */
async function eventModelMarketplace() {
  await mkdir(marketplace);
  await $`git -C ${marketplace} init -q -b main`.quiet();
  const dir = "plugins/event-model";
  await writeFile(
    join(marketplace, "marketplace.json"),
    JSON.stringify({
      name: "specdriven",
      owner: { name: "Fixture", url: "https://example.com" },
      plugins: [{ name: "event-model", source: `./${dir}`, version: "2.0.1" }],
    }),
  );
  await mkdir(join(marketplace, dir, "dist"), { recursive: true });
  await writeFile(
    join(marketplace, dir, "dist", "client.js"),
    `export default { name: "event-model", apply() {} };`,
  );
  await writeFile(
    join(marketplace, dir, "dist", "host.js"),
    `export default { name: "event-model", inject: ["routes"], apply(ctx) {
      ctx.effect(() => ctx.need("routes").add("GET", "/api/models", () => Response.json({ models: [], version: "2.0.1" })));
      ctx.effect(() => ctx.need("routes").add("POST", "/api/models", () => Response.json({ created: true })));
    } };`,
  );
  await commit(
    `${dir}/package.json`,
    JSON.stringify({
      name: "event-model",
      version: "2.0.1",
      type: "module",
      specdriven: {
        id: "event-model",
        api: "1",
        displayName: "Event Models",
        description: "Event Models on a canvas",
        host: "./dist/host.js",
        client: "./dist/client.js",
        paths: ["/models"],
        permissions: ["data:read", "data:write"],
      },
    }),
    "event-model 2.0.1",
    marketplace,
  );
}

beforeAll(async () => {
  for (const repo of [origin, second]) {
    await mkdir(repo);
    await $`git -C ${repo} init -q -b main`.quiet();
  }
  await commit("specs/shop/checkout.feature.md", FEATURE, "checkout");
  await commit("roadmap/next.md", "# Next\n\nWhat comes next.\n", "roadmap");
  await commit("specs/library/loans.feature.md", "# Loans\n", "loans", second);
  await eventModelMarketplace();
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn([process.execPath, "src/index.ts"], {
    env: {
      ...process.env,
      SPECDRIVEN_READONLY: "1",
      SPECDRIVEN_READONLY_PROJECTS: `${origin}, other=${second}`,
      SPECDRIVEN_READONLY_REFRESH_SECONDS: "1",
      SPECDRIVEN_ROOT: root,
      SPECDRIVEN_LOG_FILE: "0",
      SPECDRIVEN_NO_AUTO_INSTALL: "1",
      // The Event Models come from the stand-in marketplace, offline.
      SPECDRIVEN_READONLY_MARKETPLACE: marketplace,
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
  expect(state.readOnlyProject).toBe("origin");
  expect(state.readOnlyProjects).toEqual([
    { id: "origin", repo: origin },
    { id: "other", repo: second },
  ]);
  expect(state.otherWindowFolders).toEqual([]);
  expect(state.recentDataRepoDirs).toEqual({});
  expect(state.auth).toEqual({ signedIn: false });
  expect(state.agents).toEqual([]);
  expect((state.user as { name: string }).name).toBe("Visitor");
  const enabled = (state.plugins as { id: string; enabled: boolean }[]).filter((p) => p.enabled).map((p) => p.id);
  expect(enabled).toEqual(["specs", "roadmap", "event-model"]);
  // The site's own list, stamped on the settings of the open snapshot: it
  // names Specs itself and says so, so the list is read as written — Specs,
  // the roadmap and the Event Models, nothing picked from the snapshot's data.
  expect(enabled).toEqual([...READ_ONLY_PLUGINS]);
  const stored = (await readSettings(statePath(root))) as {
    dataRepo: string;
    plugins: { format: number; repos: Record<string, { enabled: string[]; checked?: boolean }> };
  };
  expect(stored.plugins.format).toBe(PROFILE_FORMAT);
  expect(stored.plugins.repos[stored.dataRepo]).toEqual({ enabled: ["specs", "roadmap", "event-model"] });
});

test("the Event Models are installed from the marketplace at start and mounted; a write to a model is still refused", async () => {
  // In the background: Specs answered before the install finished.
  type Row = { id: string; active?: boolean; source?: string; install?: { marketplace: string; version: string } };
  let row: Row | undefined;
  for (let i = 0; i < 300 && !row?.active; i++) {
    const state = (await (await fetch(`${base}/api/state`)).json()) as { plugins: Row[] };
    row = state.plugins.find((p) => p.id === "event-model");
    if (!row?.active) await Bun.sleep(100);
  }
  expect(row).toMatchObject({ active: true, source: "home", install: { marketplace: "specdriven", version: "2.0.1" } });
  const models = await fetch(`${base}/api/models`);
  expect(models.status).toBe(200);
  expect(await models.json()).toEqual({ models: [], version: "2.0.1" });
  const create = await fetch(`${base}/api/models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(create.status).toBe(403);
}, 40_000);

test("features and the roadmap are served", async () => {
  const listing = (await (await fetch(`${base}/api/features`)).json()) as { features: { fileName: string }[] };
  expect(listing.features.map((f) => f.fileName)).toContain("specs/shop/checkout.feature.md");
  const feature = await fetch(`${base}/api/features/${encodeURIComponent("specs/shop/checkout.feature.md")}`);
  expect(feature.status).toBe(200);
  const roadmap = (await (await fetch(`${base}/api/roadmap`)).json()) as { pages: { fileName: string }[] };
  expect(roadmap.pages.map((p) => p.fileName)).toEqual(["roadmap/next.md"]);
  expect((await fetch(`${base}/features/shop/checkout`)).status).toBe(200);
});

const listing = async (cookie?: string) => {
  const res = await fetch(`${base}/api/features`, cookie ? { headers: { cookie } } : {});
  return ((await res.json()) as { features: { fileName: string }[] }).features.map((f) => f.fileName);
};

test("a visitor's cookie picks the project every request is answered for; any other cookie, the first", async () => {
  const cookie = "specdriven-project=other";
  const state = (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()) as Record<string, unknown>;
  expect(state.readOnlyProject).toBe("other");
  expect(state.dataRepo).toBe(second);
  expect(await listing(cookie)).toEqual(["specs/library/loans.feature.md"]);
  const feature = await fetch(`${base}/api/features/${encodeURIComponent("specs/library/loans.feature.md")}`, {
    headers: { cookie },
  });
  expect(feature.status).toBe(200);
  expect(await listing()).not.toContain("specs/library/loans.feature.md");
  expect(await listing("specdriven-project=nope")).toContain("specs/shop/checkout.feature.md");
  // A write is refused in every project.
  const put = await fetch(`${base}/api/state`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: "{}",
  });
  expect(put.status).toBe(403);
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
    files = await listing();
  }
  expect(files).toContain("specs/shop/returns.feature.md");
}, 15_000);

test("each project is refreshed on its own, a push to the second shows in it alone", async () => {
  await commit("specs/library/holds.feature.md", "# Holds\n", "holds", second);
  const cookie = "specdriven-project=other";
  let files: string[] = [];
  for (let i = 0; i < 100 && !files.includes("specs/library/holds.feature.md"); i++) {
    await Bun.sleep(100);
    files = await listing(cookie);
  }
  expect(files).toContain("specs/library/holds.feature.md");
  expect(await listing()).not.toContain("specs/library/holds.feature.md");
}, 15_000);

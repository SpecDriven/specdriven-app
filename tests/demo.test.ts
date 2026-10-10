// Demo mode (DEMO_MODE=1): the app serves an ephemeral copy of the bundled
// demo-data snapshot — edits land in a throwaway working directory, the
// pristine snapshot is never written, every page load (the client's
// /api/state?boot=1 fetch) reseeds a fresh copy, and everything that would
// reach GitHub — sign-in, the folder picker, a data-repo switch — is off.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  setClaudeAvailability,
  setDesktopAvailability,
  setPiAvailability,
} from "../src/server/agent";
import { setQueryFactory } from "../src/server/agentChat";
import { applyStartupState, handleApi, reloader, syncedOnStart } from "../src/server/api";
import { setupDemo } from "../src/server/demo";
import { setFolderChooser } from "../src/server/folderChooser";
import { setGitEngine } from "../src/server/git";
import { readState } from "../src/server/state";
import { version as pkgVersion } from "../package.json";
import { sourceUrl } from "../src/server/sourceUrl";

let root: string;
let source: string;
let realChooser: ReturnType<typeof setFolderChooser>;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const realDemo = process.env.DEMO_MODE;
const realDemoData = process.env.DEMO_DATA_DIR;

const PRISTINE_README = "# Demo specs\n";
const PRISTINE_FEATURE = "# Quote\n\n## Get a quote [published]\n\nsome text\n";
const PRISTINE_PAGE =
  "# Usage-Based Auto\n\n**Assigned:** Dana Whitfield\n\nPrice on how they drive.\n";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-demo-"));
  source = await mkdtemp(join(tmpdir(), "specdriven-demo-src-"));
  await Bun.write(join(source, "README.md"), PRISTINE_README);
  await Bun.write(join(source, "specs", "billing", "quote.feature.md"), PRISTINE_FEATURE);
  await Bun.write(join(source, "roadmap", "usage-based-auto.md"), PRISTINE_PAGE);
  process.env.SPECDRIVEN_ROOT = root;
  process.env.DEMO_MODE = "1";
  process.env.DEMO_DATA_DIR = source;
  realChooser = setFolderChooser(null);
  await setupDemo();
  await applyStartupState();
});

afterEach(async () => {
  // applyStartupState() fires the app-start sync without awaiting it. Let it
  // finish before teardown, or it runs on into the next test file — and into
  // whatever that file records (tests/telemetry.test.ts saw its git span).
  await syncedOnStart();
  reloader.stop();
  setGitEngine(null);
  setFolderChooser(realChooser);
  // setupDemo fills these four (src/server/demo.ts); left in place they would
  // hand a fake Claude to every later test file in the run.
  setQueryFactory(null);
  setClaudeAvailability(null);
  setPiAvailability(null);
  setDesktopAvailability(null);
  await rm(root, { recursive: true, force: true });
  await rm(source, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
    ["DEMO_MODE", realDemo],
    ["DEMO_DATA_DIR", realDemoData],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function api(path: string, init?: RequestInit) {
  return handleApi(new Request(`http://localhost${path}`, init)) as Promise<Response>;
}

async function bootState() {
  const res = await api("/api/state?boot=1");
  expect(res.status).toBe(200);
  return res.json();
}

/** A visitor switching plugins on in Settings → Plugins. */
async function enable(...ids: string[]) {
  const res = await api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugins: { enabled: ids } }),
  });
  expect(res.status).toBe(200);
}

/** Every file in dir (relative path → content), demo-data integrity checks. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = join(entry.parentPath.slice(dir.length + 1) || "", entry.name);
    out.set(rel, await readFile(join(entry.parentPath, entry.name), "utf8"));
  }
  return out;
}

test("boot state names the demo — ephemeral folder, no chooser, js git, no cron", async () => {
  const state = await bootState();
  expect(state.demo).toBe(true);
  expect(state.needsDataRepo).toBe(false);
  expect(state.canChooseFolder).toBe(false);
  expect(state.gitEngine).toBe("js");
  expect(state.reloadFrequencySeconds).toBe(0);
  expect(basename(state.dataRepo)).toMatch(/^data-\d+$/);
});

// Code gen sessions are the demo's point (roadmap/demo.md "Demo App"),
// but only the simulated pane: the other two targets report unavailable, so
// the session dialog offers no choice and nothing can reach a real CLI.
test("the coding agent pane is on and is the only target on offer", async () => {
  const state = await bootState();
  expect(state.codeGen).toBe(true);
  expect(state.codeGenTarget).toBe("pane");
  expect(state.canRunAgentPane).toBe(true);
  expect(state.canOpenClaudeDesktop).toBe(false);
  expect(state.canRunPi).toBe(false);
});

// The demo starts with Specs alone (src/server/demo.ts DEMO_SETTINGS,
// specs/app/plugins.feature.md "Each data folder keeps its own plugins"); a
// visitor switches plugins on, and the dataset ships content for each.
test("a visitor turns the roadmap on and it lists the dataset's pages", async () => {
  const state = await bootState();
  expect(state.roadmap).toBe(false);
  await enable("roadmap");

  const { pages } = await (await api("/api/roadmap")).json();
  expect(pages).toEqual([
    {
      fileName: "roadmap/usage-based-auto.md",
      name: "Usage-Based Auto",
      assigned: "Dana Whitfield",
    },
  ]);
});

test("Specs alone, and every other optional setting on except IntelliJ IDEA", async () => {
  const state = await bootState();
  for (const module of ["roadmap", "tasks", "notebook", "testing", "issues"] as const) {
    expect(`${module}=${state[module]}`).toBe(`${module}=false`);
  }
  for (const module of [
    "assignments",
    "deletePublished",
    "googleCalendar",
    "showTestLinks",
    "projectManagement",
    "publishExternalLinks",
  ] as const) {
    expect(`${module}=${state[module]}`).toBe(`${module}=true`);
  }
  // The exception: "Open test links in IntelliJ IDEA" runs `idea` on the
  // visitor's own machine, which a hosted demo cannot and should not do.
  expect(state.openTestsInIdea).toBe(false);
  // The profile behind the module switches (specs/app/plugins.feature.md
  // "Each data folder keeps its own plugins"): every built-in listed, none
  // on — the visitor's Settings → Plugins offers them.
  expect(
    (state.plugins as { id: string; enabled: boolean; active: boolean }[]).map((p) => [p.id, p.enabled, p.active]),
  ).toEqual([
    ["roadmap", false, false],
    ["tasks", false, false],
    ["notebook", false, false],
    ["issues", false, false],
    ["tests", false, false],
  ]);
});

test("a roadmap edit lands in the working copy; the snapshot is untouched", async () => {
  const state = await bootState();
  await enable("roadmap");
  const res = await api(`/api/roadmap/${encodeURIComponent("roadmap/usage-based-auto.md")}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: PRISTINE_PAGE + "\nAnd measure it.\n" }),
  });
  expect(res.status).toBe(200);
  expect(
    await readFile(join(state.dataRepo, "roadmap", "usage-based-auto.md"), "utf8"),
  ).toContain("And measure it.");
  expect(await readFile(join(source, "roadmap", "usage-based-auto.md"), "utf8")).toBe(
    PRISTINE_PAGE,
  );
});

test("edits land in the working copy; the pristine snapshot is untouched", async () => {
  const before = await snapshot(source);
  const state = await bootState();

  const res = await api("/api/readme", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "# Edited in the demo\n" }),
  });
  expect(res.status).toBe(200);

  expect(await readFile(join(state.dataRepo, "README.md"), "utf8")).toBe(
    "# Edited in the demo\n",
  );
  expect(await snapshot(source)).toEqual(before);
});

test("a page load reseeds — the edit is gone, the folder is a new generation", async () => {
  const first = await bootState();
  await api("/api/readme", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "scribbles\n" }),
  });

  const second = await bootState();
  expect(second.dataRepo).not.toBe(first.dataRepo);
  const readme = await (await api("/api/readme")).json();
  expect(readme.content).toBe(PRISTINE_README);
});

test("concurrent page loads serialize into consistent generations", async () => {
  const [a, b] = await Promise.all([bootState(), bootState()]);
  expect(basename(a.dataRepo)).toMatch(/^data-\d+$/);
  expect(basename(b.dataRepo)).toMatch(/^data-\d+$/);
  const settled = await readState(root);
  expect(basename(settled.dataRepo!)).toMatch(/^data-\d+$/);
});

test("publishing a feature succeeds locally and stays inside the working copy", async () => {
  const state = await bootState();
  const res = await api(`/api/features/${encodeURIComponent("specs/billing/quote.feature.md")}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: PRISTINE_FEATURE + "\nmore\n" }),
  });
  expect(res.status).toBe(200);
  expect(await readFile(join(source, "specs", "billing", "quote.feature.md"), "utf8")).toBe(
    PRISTINE_FEATURE,
  );
  expect(await readFile(join(state.dataRepo, "specs", "billing", "quote.feature.md"), "utf8")).toContain(
    "more",
  );
});

test("the data directory, git engine and sync server are pinned (403)", async () => {
  for (const body of [
    { dataRepo: join(root, "elsewhere") },
    { gitEngine: "cli" },
    { syncServerUrl: "wss://sync.example.com" },
  ]) {
    const res = await api("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
  }
  // A cosmetic setting still saves — the demo keeps the full editing feel.
  const ok = await api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioPreviewLines: 4 }),
  });
  expect(ok.status).toBe(200);
});

test("plugin folders, trust and marketplaces are pinned (403); switching plugins still saves", async () => {
  const folder = join(root, "visitor-plugin");
  for (const plugins of [
    { sources: [folder] },
    { trust: folder },
    { marketplaces: [{ name: "visitor", source: folder }] },
    { enabled: ["notebook"], sources: [folder] },
  ]) {
    const res = await api("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugins }),
    });
    expect(`${JSON.stringify(plugins)} → ${res.status}`).toBe(`${JSON.stringify(plugins)} → 403`);
  }
  const section = ((await readState(root)) as { plugins?: Record<string, unknown> })
    .plugins ?? {};
  expect(section.sources).toBeUndefined();
  expect(section.trusted).toBeUndefined();
  expect(section.marketplaces).toBeUndefined();

  // A visitor still switches and reorders the plugins on offer.
  const ok = await api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugins: { enabled: ["tasks", "roadmap"] } }),
  });
  expect(ok.status).toBe(200);
  const { dataRepo, plugins } = (await readState(root)) as {
    dataRepo: string;
    plugins: { repos: Record<string, { enabled: string[] }> };
  };
  expect(plugins.repos[dataRepo]!.enabled).toEqual(["tasks", "roadmap"]);
});

test("GitHub sign-in routes refuse in demo mode", async () => {
  for (const [method, path] of [
    ["POST", "/api/auth/github/start"],
    ["POST", "/api/auth/github/poll"],
    ["POST", "/api/auth/github/web/start"],
    ["POST", "/api/auth/github/web/poll"],
    ["GET", "/api/auth/github/callback"],
    ["DELETE", "/api/auth/github"],
  ] as const) {
    const res = await api(path, { method });
    expect(res.status).toBe(403);
  }
});

// The Issues tab is the one place the demo does reach GitHub: it reads the
// public release repo (src/server/demo.ts DEMO_ISSUES_REPO) so the tab has
// real issues to show. Writes stay refused — a visitor is signed in to
// nothing, so every one would be anonymous on someone else's repository.
test("the demo tracks the release repo's issues and refuses every write", async () => {
  await enable("issues");
  const { issuesRepo } = await (await api("/api/features")).json();
  expect(issuesRepo).toEqual({
    url: "https://github.com/SpecDriven/specdriven-app-release",
    owner: "SpecDriven",
    name: "specdriven-app-release",
  });

  for (const [method, path] of [
    ["POST", "/api/issues"],
    ["PUT", "/api/issues/1"],
    ["POST", "/api/issues/1/comments"],
  ] as const) {
    const res = await api(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "nope", body: "nope" }),
    });
    expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 403`);
  }
});

test("no native folder chooser — /api/choose-folder is 501", async () => {
  const res = await api("/api/choose-folder", { method: "POST" });
  expect(res.status).toBe(501);
});

test("state carries the app version — the demo shows it beside the user", async () => {
  const state = await bootState();
  expect(state.version).toBe(pkgVersion);
});

// specs/app/open-source-license.feature.md: the public demo is a network
// service, so the AGPL asks it to offer its source — the user menu links it.
test("state carries the source url of the running version", async () => {
  const state = await bootState();
  expect(state.sourceUrl).toBe(sourceUrl(pkgVersion));
});

test("the demo user is Test User, not the OS account", async () => {
  const state = await bootState();
  expect(state.user).toEqual({
    username: "Test User",
    login: null,
    name: "Test User",
    email: "test-user@specdriven.demo",
  });
});

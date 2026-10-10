// Automates specs/app/spec-proposals.feature.md: the public spec-proposals
// service (src/server/proposals/). A stand-in GitHub serves the sign-in
// pages, the REST endpoints the service calls (/user, collaborator
// permission) and the spec repo over smart-HTTP (helpers/gitHttpServer.ts),
// so the bot token really is the credential every clone and push carries.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { setGitEngine } from "../src/server/git";
import { parseFeature } from "../src/server/parser";
import {
  DEFAULT_GLOBAL_PER_DAY,
  DEFAULT_PER_DAY,
  isProposalsMode,
  readProposalsConfig,
} from "../src/server/proposalsMode";
import {
  appendScenario,
  assertAppendOnly,
  newFeatureText,
  ProposalError,
  proposedScenario,
  utcDayStart,
} from "../src/server/proposals/service";
import { startProposals, type StartedProposals } from "../src/server/proposals/setup";
import { createFileBackend, setTokenBackend } from "../src/server/tokenStore";
import { sourceUrl } from "../src/server/sourceUrl";
import { proposalsEnv } from "../src/gateway/proposals";
import { git, seededOrigin } from "./helpers/fixtures";
import { serveRepos, type GitHttpServer } from "./helpers/gitHttpServer";

const FEATURE = `# Export

Reviewers read features outside the app.

## Export as PDF @v1 [published]

- Given: a feature is open
- When: I export it as PDF
- Then: a PDF downloads

## Export as HTML @v1 [proposed]

- Given: a feature is open
- Then: an HTML page downloads
`;

const SEED = {
  "specs/app/export.feature.md": FEATURE,
  "specs/app/other.feature.md": "# Other\n",
};

// ---- pure rules -----------------------------------------------------------

describe("building a proposal", () => {
  test("a proposed scenario is always @v1 and proposed, with its body tidied", () => {
    const s = proposedScenario("  Export   as  CSV ", "- Given: x  \r\n- Then: y\n\n");
    expect(s).toEqual({ name: "Export as CSV", version: 1, status: "proposed", body: "- Given: x\n- Then: y", tests: [] });
  });

  test.each([
    ["no name", "", "- Then: x", 400],
    ["no body", "Name", "  ", 400],
    ["a heading in the body", "Name", "- Given: x\n## Sneaky @v1 [published]\nbody", 400],
    ["a feature heading in the body", "Name", "# Another feature", 400],
    ["a name over 120 characters", "x".repeat(121), "- Then: x", 400],
    ["a body over 8 KB", "Name", "x".repeat(8 * 1024 + 1), 400],
  ])("refuses %s", (_, name, body, status) => {
    try {
      proposedScenario(name, body);
      throw new Error("not refused");
    } catch (e) {
      expect(e).toBeInstanceOf(ProposalError);
      expect((e as ProposalError).status).toBe(status);
    }
  });

  test("appending keeps every existing scenario and adds the new one", () => {
    const next = appendScenario(FEATURE, proposedScenario("Export as CSV", "- Then: a CSV downloads"));
    const before = parseFeature(FEATURE);
    const after = parseFeature(next);
    const added = after.scenarios.find((s) => s.name === "Export as CSV")!;
    expect(after.scenarios.map((s) => [s.name, s.status]).sort()).toEqual([
      ["Export as CSV", "proposed"],
      ["Export as HTML", "proposed"],
      ["Export as PDF", "published"],
    ]);
    expect(() => assertAppendOnly(before, after, added)).not.toThrow();
  });

  test("a name the feature already has is refused, whatever its case", () => {
    expect(() => appendScenario(FEATURE, proposedScenario("export as pdf", "- Then: x"))).toThrow(/already has/);
  });

  test("a body that would sign the scenario as someone else is refused", () => {
    const s = proposedScenario("Signed", "**Created by:** mallory\n\n- Then: x");
    expect(() => appendScenario(FEATURE, s)).toThrow(/read back/);
  });

  test("a body that would add a ticket or a test link is refused", () => {
    expect(() =>
      appendScenario(FEATURE, proposedScenario("Ticket", "[Jira:ABC-1](https://x.atlassian.net/browse/ABC-1)\n\n- Then: x")),
    ).toThrow(/read back/);
    expect(() =>
      appendScenario(FEATURE, proposedScenario("Tested", "- Then: x\n\n[test: https://github.com/a/b/blob/main/t.ts#L1 ]")),
    ).toThrow(/read back/);
  });

  test("the append-only check catches a changed, removed or published scenario", () => {
    const before = parseFeature(FEATURE);
    const added = proposedScenario("New", "- Then: x");
    const ok = parseFeature(appendScenario(FEATURE, added));
    const changed = {
      ...ok,
      scenarios: ok.scenarios.map((s) => (s.name === "Export as PDF" ? { ...s, body: "tampered" } : s)),
    };
    expect(() => assertAppendOnly(before, changed, added)).toThrow(/existing scenario "Export as PDF"/);
    const removed = { ...ok, scenarios: ok.scenarios.filter((s) => s.name !== "Export as HTML") };
    expect(() => assertAppendOnly(before, removed, added)).toThrow();
    const published = { ...ok, scenarios: ok.scenarios.map((s) => (s.name === "New" ? { ...s, status: "published" as const } : s)) };
    expect(() => assertAppendOnly(before, published, added)).toThrow(/something other/);
    expect(() => assertAppendOnly(before, { ...ok, description: "new" }, added)).toThrow(/description/);
  });

  test("a new feature holds its name, description and one proposed scenario", () => {
    const { name, text } = newFeatureText(" Dark   mode ", "For night owls.", proposedScenario("Toggle", "- Then: dark"));
    expect(name).toBe("Dark mode");
    expect(text).toBe("# Dark mode\n\nFor night owls.\n\n## Toggle @v1 [proposed]\n\n- Then: dark\n");
  });

  test("a new feature name with a slash, or no letters, is refused", () => {
    const s = proposedScenario("Toggle", "- Then: dark");
    expect(() => newFeatureText("a/b", "", s)).toThrow(/cannot contain \//);
    expect(() => newFeatureText("!!!", "", s)).toThrow(/letters or digits/);
    expect(() => newFeatureText("Ok", "# heading", s)).toThrow(/headings/);
  });

  test("the day a quota counts is the UTC day", () => {
    const t = Date.UTC(2026, 9, 10, 23, 59, 59);
    expect(utcDayStart(t)).toBe(Date.UTC(2026, 9, 10));
  });
});

describe("configuration", () => {
  const env = { SPECDRIVEN_PROPOSALS_BOT_TOKEN: "t", PUBLIC_URL: "https://propose.example.com/" };

  test("proposals mode is SPECDRIVEN_PROPOSALS=1 or true", () => {
    expect(isProposalsMode({ SPECDRIVEN_PROPOSALS: "1" })).toBe(true);
    expect(isProposalsMode({ SPECDRIVEN_PROPOSALS: "true" })).toBe(true);
    expect(isProposalsMode({})).toBe(false);
  });

  test("the defaults are SpecDriven/specs-specdriven, 5 a day per account, 100 a day in all", () => {
    const config = readProposalsConfig(env);
    expect(config.repo).toEqual({
      owner: "SpecDriven",
      name: "specs-specdriven",
      url: "https://github.com/SpecDriven/specs-specdriven",
    });
    expect([config.perDay, config.globalPerDay]).toEqual([DEFAULT_PER_DAY, DEFAULT_GLOBAL_PER_DAY]);
    expect([DEFAULT_PER_DAY, DEFAULT_GLOBAL_PER_DAY]).toEqual([5, 100]);
    expect(config.publicUrl).toBe("https://propose.example.com");
  });

  test("the bot token and the public url are required; quotas must be whole numbers", () => {
    expect(() => readProposalsConfig({ PUBLIC_URL: "https://x" })).toThrow(/BOT_TOKEN/);
    expect(() => readProposalsConfig({ SPECDRIVEN_PROPOSALS_BOT_TOKEN: "t" })).toThrow(/PUBLIC_URL/);
    expect(() => readProposalsConfig({ ...env, SPECDRIVEN_PROPOSALS_PER_DAY: "0" })).toThrow(/positive/);
    expect(() => readProposalsConfig({ ...env, SPECDRIVEN_PROPOSALS_REPO: "not a repo" })).toThrow(/owner\/name/);
  });

  test("on the hosted image the service answers to its public domain only", () => {
    const e = proposalsEnv({ PUBLIC_URL: "https://propose.example.com" });
    expect(e.SPECDRIVEN_ALLOWED_HOSTS).toBe("propose.example.com");
    expect(e.SPECDRIVEN_HOST).toBe("0.0.0.0");
    expect(e.SPECDRIVEN_ROOT).toBe("/data/proposals");
    expect(e.HOME).toBe("/data/proposals/home");
  });
});

// ---- the service end to end ---------------------------------------------

const BOT = { token: "bot-token", login: "specdriven-bot", id: 1, name: "SpecDriven Bot" };
const VISITORS: Record<string, { login: string; id: number; name: string | null }> = {
  "ada-token": { login: "ada", id: 101, name: "Ada Lovelace" },
  "grace-token": { login: "grace", id: 102, name: null },
  "maint-token": { login: "maintainer", id: 103, name: "Maintainer" },
};
const CODES: Record<string, string> = { "code-ada": "ada-token", "code-grace": "grace-token", "code-maint": "maint-token" };

let root: string;
let origin: string;
let gitServer: GitHttpServer;
let stub: ReturnType<typeof Bun.serve>;
let started: StartedProposals;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "SPECDRIVEN_GITHUB_URL",
  "SPECDRIVEN_GITHUB_API_URL",
  "SPECDRIVEN_GITHUB_CLIENT_ID",
  "SPECDRIVEN_GITHUB_CLIENT_SECRET",
  "SPECDRIVEN_ROOT",
  "SPECDRIVEN_HOME",
  "SPECDRIVEN_REPOS_DIR",
];

/** The stand-in GitHub: sign-in, REST, and the repo over smart-HTTP behind them. */
function startStub(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/login/oauth/access_token") {
        const body = (await req.json()) as { code?: string; code_verifier?: string; client_secret?: string };
        const token = body.code ? CODES[body.code] : undefined;
        if (!token || !body.code_verifier || body.client_secret !== "secret") return Response.json({ error: "bad_verification_code" });
        return Response.json({ access_token: token });
      }
      if (url.pathname === "/user") {
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        if (token === BOT.token) return Response.json({ login: BOT.login, id: BOT.id, name: BOT.name, email: null });
        const v = VISITORS[token];
        return v ? Response.json({ ...v, email: `${v.login}@private.example` }) : new Response("no", { status: 401 });
      }
      const perm = url.pathname.match(/^\/repos\/SpecDriven\/specs-test\/collaborators\/([^/]+)\/permission$/);
      if (perm) {
        if (req.headers.get("authorization") !== `Bearer ${BOT.token}`) return new Response("no", { status: 401 });
        return perm[1] === "maintainer"
          ? Response.json({ permission: "write", role_name: "write" })
          : Response.json({ permission: "read", role_name: "read" });
      }
      // Everything else is git: hand it to the smart-HTTP server.
      const res = await fetch(`${gitServer.url}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" ? undefined : await req.arrayBuffer(),
      });
      return new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers });
    },
  });
}

const api = (path: string, init: RequestInit = {}) =>
  started.api.handle(new Request(`http://localhost:3000${path}`, init)).then((r) => r!);

/** Sign a visitor in through the browser flow; returns their session cookie. */
async function signIn(code: string): Promise<string> {
  const start = await api("/api/proposals/auth/start");
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location")!);
  const state = authorize.searchParams.get("state")!;
  const flow = start.headers.get("set-cookie")!.split(";")[0]!;
  const back = await api(`/api/proposals/auth/callback?code=${code}&state=${state}`, { headers: { cookie: flow } });
  expect(back.headers.get("location")).toBe("/");
  const session = back.headers.getSetCookie().find((c) => c.startsWith("sd_session="));
  expect(session).toBeDefined();
  return session!.split(";")[0]!;
}

const post = (path: string, cookie: string, body: unknown) =>
  api(path, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

const scenarioUrl = (file: string) => `/api/proposals/features/${encodeURIComponent(file)}/scenarios`;

/** The spec repo as the remote has it now. */
async function remoteFile(file: string): Promise<string> {
  return (await $`git --git-dir ${origin} show main:${file}`.quiet().nothrow()).stdout.toString();
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "specdriven-proposals-"));
  origin = await seededOrigin(root, "repos/SpecDriven/specs-test.git", SEED);
  gitServer = serveRepos(join(root, "repos"));
  stub = startStub();
  const base = `http://127.0.0.1:${stub.port}`;
  process.env.SPECDRIVEN_GITHUB_URL = base;
  process.env.SPECDRIVEN_GITHUB_API_URL = base;
  process.env.SPECDRIVEN_GITHUB_CLIENT_ID = "client";
  process.env.SPECDRIVEN_GITHUB_CLIENT_SECRET = "secret";
  process.env.SPECDRIVEN_ROOT = join(root, "app");
  delete process.env.SPECDRIVEN_HOME;
  delete process.env.SPECDRIVEN_REPOS_DIR;
  started = await startProposals({
    SPECDRIVEN_PROPOSALS: "1",
    SPECDRIVEN_PROPOSALS_REPO: "SpecDriven/specs-test",
    SPECDRIVEN_PROPOSALS_BOT_TOKEN: BOT.token,
    SPECDRIVEN_PROPOSALS_PER_DAY: "2",
    SPECDRIVEN_PROPOSALS_GLOBAL_PER_DAY: "5",
    SPECDRIVEN_PROPOSALS_DB: join(root, "proposals.db"),
    PUBLIC_URL: "http://localhost:3000",
  });
});

afterAll(() => {
  started?.stop();
  stub?.stop(true);
  gitServer?.stop();
  setTokenBackend(createFileBackend());
  setGitEngine(null);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("the proposals service", () => {
  test.each([
    ["GET", "/api/state"],
    ["PUT", "/api/state"],
    ["GET", "/api/features"],
    ["GET", "/api/features/specs%2Fapp%2Fexport.feature.md"],
    ["PUT", "/api/features/specs%2Fapp%2Fexport.feature.md"],
    ["DELETE", "/api/features/specs%2Fapp%2Fexport.feature.md"],
    ["POST", "/api/features"],
    ["POST", "/api/features/specs%2Fapp%2Fexport.feature.md/rename"],
    ["POST", "/api/reload"],
    ["POST", "/api/auth/github/web/start"],
    ["DELETE", "/api/auth/github"],
    ["POST", "/api/agent/chat"],
    ["POST", "/api/plugins/install"],
    ["GET", "/api/logs"],
    ["GET", "/api/roadmap"],
  ])("everything else is refused, %s %s → 403", async (method, path) => {
    const res = await api(path, { method });
    expect(res.status).toBe(403);
  });

  test("signed out, the session says so and proposing asks for a sign-in", async () => {
    const session = await (await api("/api/proposals/session")).json();
    expect(session.signedIn).toBe(false);
    expect(session.repo).toEqual({ owner: "SpecDriven", name: "specs-test", url: "https://github.com/SpecDriven/specs-test" });
    expect(session.sourceUrl).toBe(sourceUrl());
    const res = await post(scenarioUrl("specs/app/export.feature.md"), "", { name: "x", body: "- Then: y" });
    expect(res.status).toBe(401);
  });

  test("anyone can read the spec tree and a feature file — without the documents' drafts", async () => {
    const listing = await (await api("/api/proposals/features")).json();
    expect(listing.features.map((f: { fileName: string }) => f.fileName)).toEqual([
      "specs/app/export.feature.md",
      "specs/app/other.feature.md",
    ]);
    expect(listing.folders).toEqual(["specs/app"]);
    const one = await (await api("/api/proposals/features/specs%2Fapp%2Fexport.feature.md")).json();
    expect(one.content).toBe(FEATURE);
    expect((await api("/api/proposals/features/specs%2Fnope.feature.md")).status).toBe(404);
    expect((await api("/api/proposals/features/..%2Fetc%2Fpasswd")).status).toBe(404);
  });

  test("a callback that is not this browser's sign-in is refused", async () => {
    const start = await api("/api/proposals/auth/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    // No flow cookie: someone else's link.
    const forged = await api(`/api/proposals/auth/callback?code=code-ada&state=${state}`);
    expect(forged.headers.get("location")).toBe("/?signin=expired");
    expect(forged.headers.getSetCookie().some((c) => c.startsWith("sd_session="))).toBe(false);
    // The right cookie but a wrong state.
    const flow = start.headers.get("set-cookie")!.split(";")[0]!;
    const wrong = await api(`/api/proposals/auth/callback?code=code-ada&state=nope`, { headers: { cookie: flow } });
    expect(wrong.headers.get("location")).toBe("/?signin=expired");
  });

  test("sign-in goes to GitHub with PKCE and back with a session; no token is kept", async () => {
    const start = await api("/api/proposals/auth/start");
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.pathname).toBe("/login/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/proposals/auth/callback");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const cookie = await signIn("code-ada");
    const session = await (await api("/api/proposals/session", { headers: { cookie } })).json();
    expect(session).toMatchObject({ signedIn: true, user: { login: "ada", name: "Ada Lovelace" }, contributor: false });
    expect(session.quota).toMatchObject({ used: 0, limit: 2 });
    const db = await Bun.file(join(root, "proposals.db")).arrayBuffer();
    expect(Buffer.from(db).includes("ada-token")).toBe(false);
  });

  test("a proposed scenario lands on main as proposed, authored by the visitor and signed in its document", async () => {
    const cookie = await signIn("code-ada");
    const res = await post(scenarioUrl("specs/app/export.feature.md"), cookie, {
      name: "Export as CSV",
      body: "- Given: a feature is open\n- Then: a CSV downloads",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.file).toBe("specs/app/export.feature.md");
    expect(body.quota.used).toBe(1);

    const text = await remoteFile("specs/app/export.feature.md");
    const parsed = parseFeature(text);
    expect(parsed.scenarios.map((s) => [s.name, s.version, s.status]).sort()).toEqual([
      ["Export as CSV", 1, "proposed"],
      ["Export as HTML", 1, "proposed"],
      ["Export as PDF", 1, "published"],
    ]);
    expect(parsed.scenarios.find((s) => s.name === "Export as PDF")!.body).toBe("- Given: a feature is open\n- When: I export it as PDF\n- Then: a PDF downloads");

    const log = (await $`git --git-dir ${origin} log -1 --format=%an%n%ae%n%H%n%B main`.quiet()).stdout.toString();
    const [author, email, sha] = log.split("\n");
    expect(author).toBe("Ada Lovelace");
    expect(email).toBe("101+ada@users.noreply.github.com");
    expect(sha).toBe(body.commit);
    expect(log).toContain('Propose scenario "Export as CSV" in Export');
    expect(log).toContain("Proposed-by: @ada (GitHub id 101)");

    // The document travelled with the file, and names ada as the creator.
    const clone = join(root, "app", "repos", "specs-test");
    const doc = await loadFeatureDoc(clone, "specs/app/export.feature.md");
    const entry = doc!.doc.specs.find((s) => s.name === "Export as CSV");
    expect(entry?.createdBy).toBe("ada");
    const tracked = (await git(clone, "ls-tree", "-r", "--name-only", "origin/main")).stdout.toString();
    expect(tracked).toContain(".specdriven/automerge/specs/app/export.feature.md/");
  });

  test.each([
    ["a heading in the body", { name: "Sneaky", body: "## Other @v2 [published]\nx" }, 400],
    ["a name the feature has", { name: "Export as PDF", body: "- Then: x" }, 409],
    ["an authorship line", { name: "Spoofed", body: "**Created by:** grace\n\n- Then: x" }, 400],
  ])("refused, and nothing reaches the remote — %s", async (_, input, status) => {
    const cookie = await signIn("code-grace");
    const before = await remoteFile("specs/app/export.feature.md");
    const res = await post(scenarioUrl("specs/app/export.feature.md"), cookie, input);
    expect(res.status).toBe(status);
    expect(await remoteFile("specs/app/export.feature.md")).toBe(before);
  });

  test("a scenario for a feature that is not there is refused", async () => {
    const cookie = await signIn("code-grace");
    expect((await post(scenarioUrl("specs/app/nope.feature.md"), cookie, { name: "x", body: "- Then: y" })).status).toBe(404);
    expect((await post(scenarioUrl("../README.md"), cookie, { name: "x", body: "- Then: y" })).status).toBe(404);
  });

  test("a new feature lands in an existing folder with its first scenario", async () => {
    const cookie = await signIn("code-grace");
    const res = await post("/api/proposals/features", cookie, {
      folder: "specs/app",
      name: "Dark mode",
      description: "For night owls.",
      scenario: { name: "Toggle dark mode", body: "- When: I toggle it\n- Then: the app is dark" },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).file).toBe("specs/app/dark-mode.feature.md");
    const text = await remoteFile("specs/app/dark-mode.feature.md");
    expect(parseFeature(text)).toMatchObject({
      name: "Dark mode",
      description: "For night owls.",
      scenarios: [{ name: "Toggle dark mode", version: 1, status: "proposed" }],
    });
    const log = (await $`git --git-dir ${origin} log -1 --format=%an%n%B main`.quiet()).stdout.toString();
    expect(log).toStartWith("grace\n");
    expect(log).toContain('Propose feature "Dark mode"');
    expect(log).toContain("Proposed-by: @grace (GitHub id 102)");
  });

  test("a new feature in a folder that does not exist, or with a name that does, is refused", async () => {
    const cookie = await signIn("code-grace");
    const scenario = { name: "Toggle", body: "- Then: x" };
    expect((await post("/api/proposals/features", cookie, { folder: "specs/nope", name: "New", scenario })).status).toBe(400);
    expect((await post("/api/proposals/features", cookie, { folder: "specs/app", name: "Other", scenario })).status).toBe(409);
  });

  test("an account has a daily allowance, and a refused proposal does not use it", async () => {
    const cookie = await signIn("code-grace");
    // grace has made one proposal (the feature) out of 2; refusals cost nothing.
    let session = await (await api("/api/proposals/session", { headers: { cookie } })).json();
    expect(session.quota.used).toBe(1);
    const ok = await post(scenarioUrl("specs/app/other.feature.md"), cookie, { name: "First", body: "- Then: x" });
    expect(ok.status).toBe(201);
    const over = await post(scenarioUrl("specs/app/other.feature.md"), cookie, { name: "Second", body: "- Then: y" });
    expect(over.status).toBe(429);
    expect((await over.json()).error).toMatch(/00:00 UTC/);
    session = await (await api("/api/proposals/session", { headers: { cookie } })).json();
    expect(session.quota).toMatchObject({ used: 2, limit: 2 });
  });

  test("contributors have no per-account limit, but the service's daily cap holds for everyone", async () => {
    const cookie = await signIn("code-maint");
    const session = await (await api("/api/proposals/session", { headers: { cookie } })).json();
    expect(session.contributor).toBe(true);
    expect(session.quota.limit).toBeNull();
    // 3 proposals so far today (ada 1, grace 2); the cap is 5.
    for (const name of ["One", "Two"]) {
      expect((await post(scenarioUrl("specs/app/other.feature.md"), cookie, { name, body: "- Then: x" })).status).toBe(201);
    }
    const capped = await post(scenarioUrl("specs/app/other.feature.md"), cookie, { name: "Three", body: "- Then: x" });
    expect(capped.status).toBe(429);
    expect((await capped.json()).error).toMatch(/all the proposals it accepts today/);
  });

  test("signing out ends the session", async () => {
    const cookie = await signIn("code-ada");
    const out = await api("/api/proposals/logout", { method: "POST", headers: { cookie } });
    expect(out.status).toBe(200);
    const session = await (await api("/api/proposals/session", { headers: { cookie } })).json();
    expect(session.signedIn).toBe(false);
  });
});

describe("the proposals service under concurrency", () => {
  let fresh: StartedProposals;

  beforeAll(async () => {
    // A second service over the same remote with room in its quotas, so the
    // first describe's spent allowance does not get in the way.
    started.stop();
    process.env.SPECDRIVEN_ROOT = join(root, "app2");
    fresh = await startProposals({
      SPECDRIVEN_PROPOSALS: "1",
      SPECDRIVEN_PROPOSALS_REPO: "SpecDriven/specs-test",
      SPECDRIVEN_PROPOSALS_BOT_TOKEN: BOT.token,
      SPECDRIVEN_PROPOSALS_DB: join(root, "proposals2.db"),
      PUBLIC_URL: "http://localhost:3000",
    });
    started = fresh;
  });

  test("a push someone made directly, then two proposals at once, and all three land", async () => {
    // Someone works in the repo directly, after the service last synced.
    const direct = join(root, "direct");
    await $`git clone ${origin} ${direct}`.quiet();
    await git(direct, "config", "user.email", "dev@example.com");
    await git(direct, "config", "user.name", "Dev");
    await Bun.write(join(direct, "specs/app/direct.feature.md"), "# Direct\n");
    await git(direct, "add", ".");
    await git(direct, "commit", "-m", "direct");
    await git(direct, "push", "origin", "HEAD:main");

    const ada = await signIn("code-ada");
    const grace = await signIn("code-grace");
    const [a, g] = await Promise.all([
      post(scenarioUrl("specs/app/other.feature.md"), ada, { name: "From ada", body: "- Then: a" }),
      post(scenarioUrl("specs/app/other.feature.md"), grace, { name: "From grace", body: "- Then: g" }),
    ]);
    expect([a.status, g.status]).toEqual([201, 201]);
    const names = parseFeature(await remoteFile("specs/app/other.feature.md")).scenarios.map((s) => s.name);
    expect(names).toContain("From ada");
    expect(names).toContain("From grace");
    expect(await remoteFile("specs/app/direct.feature.md")).toBe("# Direct\n");
  });
});

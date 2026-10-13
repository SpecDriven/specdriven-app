// Personal access token sign-in (git-operations.md "Personal access token",
// specs/ui/app-start.feature.md "Clone from GitHub"): a pasted token is
// checked against its host's /user and becomes the app's sign-in, on
// github.com or a GitHub Enterprise host; git then offers it to that host
// only, on the built-in engine with no git installed and on system git. The
// Enterprise host is a loopback stub that serves both the REST API under
// /api/v3 and git smart-HTTP behind a token check.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAuth, signInWithToken, signOut } from "../src/server/auth";
import { handleApi } from "../src/server/api";
import { apiBase, newTokenUrl, webBase } from "../src/server/github";
import { cliGitAvailable, clone, commitAndPush, setGitEngine } from "../src/server/git";
import { parseGitHubUrl } from "../src/server/repo";
import { createFileBackend, parseRecord, setTokenBackend } from "../src/server/tokenStore";
import { git, seededOrigin } from "./helpers/fixtures";
import { serveRepos, type GitHttpServer } from "./helpers/gitHttpServer";

const TOKEN = "github_pat_good";
const BASIC = `Basic ${btoa(`x-access-token:${TOKEN}`)}`;
const realPath = process.env.PATH;
const savedApi = process.env.SPECDRIVEN_GITHUB_API_URL;

let dir: string;
let repos: GitHttpServer;
const servers: ReturnType<typeof Bun.serve>[] = [];
/** Authorization headers each stub saw on its git requests, by stub host. */
const seen = new Map<string, (string | null)[]>();

/**
 * A GitHub stand-in on loopback: `/user` (under `apiPrefix`) answers the
 * good token, and git requests are forwarded to the shared repo server —
 * after a Basic challenge when `requireAuth`.
 */
function stubHost(apiPrefix: string, requireAuth: boolean): string {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === `${apiPrefix}/user`) {
        if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        }
        return Response.json({ login: "ent-user", id: 7, name: "Ent User", email: null });
      }
      seen.get(url.host)!.push(req.headers.get("authorization"));
      if (requireAuth && req.headers.get("authorization") !== BASIC) {
        return new Response("auth required", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="GitHub"' },
        });
      }
      const forward = new URL(url.pathname + url.search, repos.url);
      return fetch(forward, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" ? undefined : await req.arrayBuffer(),
      });
    },
  });
  servers.push(server);
  const host = `127.0.0.1:${server.port}`;
  seen.set(host, []);
  return host;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-pat-"));
  setTokenBackend(createFileBackend(join(dir, "token.json")));
  repos = serveRepos(join(dir, "served"));
  await seededOrigin(join(dir, "served"), "team/specs.git");
});

afterEach(async () => {
  await signOut();
  setTokenBackend(createFileBackend());
  setGitEngine(null);
  process.env.PATH = realPath;
  if (savedApi === undefined) delete process.env.SPECDRIVEN_GITHUB_API_URL;
  else process.env.SPECDRIVEN_GITHUB_API_URL = savedApi;
  for (const s of servers.splice(0)) s.stop(true);
  seen.clear();
  repos.stop();
  await rm(dir, { recursive: true, force: true });
});

test("GitHub hosts map to their web, API and new-token urls", () => {
  expect(apiBase("acme.ghe.com")).toBe("https://api.acme.ghe.com");
  expect(apiBase("github.acme.com")).toBe("https://github.acme.com/api/v3");
  expect(webBase("github.acme.com")).toBe("https://github.acme.com");
  expect(webBase("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  expect(newTokenUrl("github.acme.com")).toBe(
    "https://github.acme.com/settings/personal-access-tokens/new",
  );
});

test("GitHub Enterprise repository urls parse with their host", () => {
  expect(parseGitHubUrl("https://github.acme.com/team/specs.git")).toEqual({
    url: "https://github.acme.com/team/specs",
    host: "github.acme.com",
    owner: "team",
    name: "specs",
  });
  expect(parseGitHubUrl("https://acme.ghe.com/team/specs")?.host).toBe("acme.ghe.com");
  expect(parseGitHubUrl("https://GitHub.com/team/specs")?.host).toBe("github.com");
  // A scheme is required off github.com, so a relative folder path never reads as a host...
  expect(parseGitHubUrl("team.specs/a/b")).toBeNull();
  // ...and plain http is a loopback test stub's only.
  expect(parseGitHubUrl("http://github.acme.com/team/specs")).toBeNull();
  expect(parseGitHubUrl("http://127.0.0.1:9/team/specs")?.url).toBe("http://127.0.0.1:9/team/specs");
});

test("a record saved before GitHub Enterprise reads as github.com", () => {
  const old = parseRecord(JSON.stringify({ token: "t", login: "a", name: null, email: null, id: 1 }));
  expect(old?.host).toBeUndefined(); // undefined is github.com everywhere it is read
  const ent = parseRecord(JSON.stringify({ token: "t", login: "a", id: 1, host: "github.acme.com" }));
  expect(ent?.host).toBe("github.acme.com");
});

test("a pasted token signs in to a GitHub Enterprise host", async () => {
  const host = stubHost("/api/v3", true);
  const identity = await signInWithToken(` ${TOKEN} `, host);
  expect(identity).toMatchObject({ login: "ent-user", host, token: TOKEN });
  // A hidden email falls back to the Enterprise host's own noreply address.
  expect(identity.email).toBe("7+ent-user@users.noreply.127.0.0.1");
  expect(await getAuth()).toEqual(identity);
});

test("a pasted token for github.com is stored without a host", async () => {
  process.env.SPECDRIVEN_GITHUB_API_URL = `http://${stubHost("", false)}`;
  const identity = await signInWithToken(TOKEN);
  expect(identity.host).toBeUndefined();
  expect(identity.email).toBe("7+ent-user@users.noreply.github.com");
});

test("POST /api/auth/github/token signs in, and refuses a bad token or host", async () => {
  const host = stubHost("/api/v3", true);
  const post = async (body: unknown) => {
    const res = (await handleApi(
      new Request("http://localhost/api/auth/github/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ))!;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const bad = await post({ token: "nope", host });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toBe("GitHub did not accept this token — check it and its expiry");
  expect(await getAuth()).toBeNull();

  expect((await post({ token: "", host })).status).toBe(400);
  expect((await post({ token: TOKEN, host: "not a host/" })).status).toBe(400);

  const ok = await post({ token: TOKEN, host });
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ signedIn: true, login: "ent-user", host });
  expect((await getAuth())?.host).toBe(host);
});

test("the built-in engine clones and pushes to GitHub Enterprise with the token, with no git installed", async () => {
  const host = stubHost("/api/v3", true);
  await signInWithToken(TOKEN, host);
  process.env.PATH = "/nonexistent";
  setGitEngine("js");

  const work = join(dir, "work");
  await clone(`http://${host}/team/specs.git`, work);
  await Bun.write(join(work, "specs/added.feature.md"), "# Added\n");
  expect(await commitAndPush(work, "specs/added.feature.md", "Add one")).toEqual({
    pushed: true,
    message: "committed and pushed",
  });
  expect(seen.get(host)).toContain(BASIC);

  process.env.PATH = realPath;
  const log = await git(join(dir, "served/team/specs.git"), "log", "-1", "--pretty=%s %an");
  expect(log.stdout.toString().trim()).toBe("Add one Ent User");
});

test("the token is never offered to another host", async () => {
  const ent = stubHost("/api/v3", true);
  const other = stubHost("/api/v3", false);
  await signInWithToken(TOKEN, ent);

  setGitEngine("js");
  await clone(`http://${other}/team/specs.git`, join(dir, "js-clone"));
  if (cliGitAvailable()) {
    setGitEngine("cli");
    await clone(`http://${other}/team/specs.git`, join(dir, "cli-clone"));
  }
  expect(seen.get(other)!.length).toBeGreaterThan(0);
  expect(seen.get(other)!.every((h) => h === null)).toBe(true);
});

test("system git hands the token to the sign-in's host through the scoped helper", async () => {
  if (!cliGitAvailable()) return;
  const host = stubHost("/api/v3", true);
  await signInWithToken(TOKEN, host);
  setGitEngine("cli");

  const work = join(dir, "work");
  await clone(`http://${host}/team/specs.git`, work);
  await Bun.write(join(work, "specs/added.feature.md"), "# Added\n");
  expect((await commitAndPush(work, "specs/added.feature.md", "Add one")).pushed).toBe(true);
  expect(seen.get(host)).toContain(BASIC);
});

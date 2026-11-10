// Which host an issues request goes to, and which token it carries
// (specs/app/github-issues.feature.md, "Requests to GitHub go to the code
// repo's host"): the API of the host the repository lives on, with the app's
// sign-in only when it was made on that host — or, with the GitHub CLI as the
// Git access, gh's token for the hosts gh is logged in to, and never the app's. Like git
// (tests/personalAccessToken.test.ts), a GitHub Enterprise token is never
// offered to another host. Every host is a loopback stub that records the
// Authorization header of each request.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signOut } from "../src/server/auth";
import { setGitEngine } from "../src/server/git";
import { resetGhCache } from "../src/server/git/gh";
import {
  enterpriseRepoOfRemote,
  getPullRequest,
  githubText,
  issuesToken,
  listIssues,
  readIssuesRepo,
} from "../src/server/issues";
import { parseGitHubUrl } from "../src/server/repo";
import { createFileBackend, saveToken, setTokenBackend } from "../src/server/tokenStore";
import { linkExecutable } from "./helpers/fakeBin";

const TOKEN = "github_pat_enterprise";
const GH_TOKEN = "gho_cli";
const realPath = process.env.PATH;
const savedApi = process.env.SPECDRIVEN_GITHUB_API_URL;

let dir: string;
const servers: ReturnType<typeof Bun.serve>[] = [];
/** Each stub's requests, by stub host: the path and the Authorization header. */
const seen = new Map<string, { path: string; auth: string | null }[]>();

/**
 * A GitHub stand-in on loopback answering under `apiPrefix` — `/api/v3` for
 * a GitHub Enterprise Server, nothing for github.com's API. Issues, a pull
 * request and a file's contents are served to any caller; the record says
 * who asked.
 */
function stubHost(apiPrefix: string): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.get(url.host)!.push({ path: url.pathname, auth: req.headers.get("authorization") });
      if (!url.pathname.startsWith(`${apiPrefix}/repos/`)) return Response.json({ message: "Not Found" }, { status: 404 });
      const rest = url.pathname.slice(apiPrefix.length);
      if (rest.endsWith("/issues")) return Response.json([]);
      if (rest.includes("/pulls/")) return Response.json({ number: 1, title: "A change", state: "open" });
      if (rest.includes("/contents/")) return new Response("test('x', () => {});\n");
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });
  servers.push(server);
  const host = `127.0.0.1:${server.port}`;
  seen.set(host, []);
  return host;
}

/** The repository `acme/app` on a host. */
const repoOn = (host: string) => parseGitHubUrl(`http://${host}/acme/app`)!;

async function signInOn(host?: string) {
  await saveToken({ token: TOKEN, login: "ent-user", name: null, email: null, id: 7, ...(host ? { host } : {}) });
}

/**
 * A gh on PATH that is signed in to github.com and to `hosts`, and hands out
 * GH_TOKEN for each of them — and nothing for any other `--hostname`.
 */
function fakeGh(hosts: string[] = []) {
  const bin = join(dir, "bin");
  const known = hosts.map((h) => `"${h}"`).join("|") || '"github.com"';
  linkExecutable(
    bin,
    "gh",
    `#!/bin/sh
if [ "$1 $2" != "auth token" ]; then exit 1; fi
if [ "$3" = "--hostname" ]; then case "$4" in ${known}) ;; *) exit 1 ;; esac; fi
echo ${GH_TOKEN}
`,
  );
  process.env.PATH = bin;
  resetGhCache();
}

let github: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-issues-host-"));
  await mkdir(join(dir, "bin"));
  setTokenBackend(createFileBackend(join(dir, "token.json")));
  github = stubHost("");
  process.env.SPECDRIVEN_GITHUB_API_URL = `http://${github}`;
  // An empty PATH keeps the machine's gh (and its token) out of the test.
  process.env.PATH = "";
  resetGhCache();
});

afterEach(async () => {
  await signOut();
  setTokenBackend(createFileBackend());
  setGitEngine(null);
  process.env.PATH = realPath;
  resetGhCache();
  if (savedApi === undefined) delete process.env.SPECDRIVEN_GITHUB_API_URL;
  else process.env.SPECDRIVEN_GITHUB_API_URL = savedApi;
  for (const s of servers.splice(0)) s.stop(true);
  seen.clear();
  await rm(dir, { recursive: true, force: true });
});

test("issues of a GitHub Enterprise repository are read from its host's API with its token", async () => {
  const ent = stubHost("/api/v3");
  await signInOn(ent);
  await listIssues(repoOn(ent));
  expect(seen.get(ent)).toEqual([{ path: "/api/v3/repos/acme/app/issues", auth: `Bearer ${TOKEN}` }]);
  expect(seen.get(github)).toEqual([]);
});

test("a GitHub Enterprise token never reaches another host", async () => {
  const ent = stubHost("/api/v3");
  const other = stubHost("/api/v3");
  await signInOn(ent);

  await listIssues(repoOn(other));
  // Pull request and test urls are github.com ones; their lookups go there.
  await getPullRequest("acme", "app", 1);
  await githubText("/repos/acme/app/contents/a.test.ts?ref=main");

  expect(seen.get(other)!.map((s) => s.auth)).toEqual([null]);
  expect(seen.get(github)!.map((s) => s.auth)).toEqual([null, null]);
  expect(seen.get(ent)).toEqual([]);
});

test("a github.com sign-in goes to github.com only", async () => {
  const ent = stubHost("/api/v3");
  await signInOn();
  await getPullRequest("acme", "app", 1);
  await listIssues(repoOn(ent));
  expect(seen.get(github)!.map((s) => s.auth)).toEqual([`Bearer ${TOKEN}`]);
  expect(seen.get(ent)!.map((s) => s.auth)).toEqual([null]);
});

test("with the GitHub CLI as the Git access, gh's token goes to each host gh is logged in to", async () => {
  const ent = stubHost("/api/v3");
  const other = stubHost("/api/v3");
  fakeGh([ent]);
  expect(await issuesToken()).toBe(GH_TOKEN);
  expect(await issuesToken(ent)).toBe(GH_TOKEN);
  expect(await issuesToken(other)).toBeNull();

  await getPullRequest("acme", "app", 1);
  await listIssues(repoOn(ent));
  expect(seen.get(github)!.map((s) => s.auth)).toEqual([`Bearer ${GH_TOKEN}`]);
  expect(seen.get(ent)!.map((s) => s.auth)).toEqual([`Bearer ${GH_TOKEN}`]);

  // The app's own token is another Git access: not used while gh is chosen.
  await signInOn(other);
  expect(await issuesToken(other)).toBeNull();

  // Choosing the token access (system git) leaves gh out entirely.
  setGitEngine("cli");
  expect(await issuesToken()).toBeNull();
  expect(await issuesToken(ent)).toBeNull();
  expect(await issuesToken(other)).toBe(TOKEN);
});

test("an Enterprise code repo has issues when the app is signed in on its host", async () => {
  const ent = stubHost("/api/v3");
  const code = join(dir, "code");
  await mkdir(join(code, ".git"), { recursive: true });
  await writeFile(join(code, ".git", "config"), `[remote "origin"]\n\turl = http://${ent}/acme/app.git\n`);
  const data = join(dir, "data");
  await mkdir(data);
  await writeFile(join(data, "project-settings.json"), JSON.stringify({ "code-repo": code }));

  expect(await readIssuesRepo(data)).toBeNull();
  await signInOn(ent);
  expect(await readIssuesRepo(data)).toEqual(repoOn(ent));
});

test("Enterprise remotes in every spelling name the repo on the sign-in's host only", () => {
  const expected = parseGitHubUrl("https://github.acme.com/team/app")!;
  for (const url of [
    "https://github.acme.com/team/app.git",
    "git@github.acme.com:team/app.git",
    "ssh://git@github.acme.com/team/app.git",
    "ssh://git@github.acme.com:2222/team/app",
  ]) {
    expect(enterpriseRepoOfRemote(url, "github.acme.com")).toEqual(expected);
    expect(enterpriseRepoOfRemote(url, "github.other.com")).toBeNull();
  }
  expect(enterpriseRepoOfRemote("https://github.com/team/app", "github.com")).toBeNull();
  expect(enterpriseRepoOfRemote("/srv/git/app.git", "github.acme.com")).toBeNull();
});

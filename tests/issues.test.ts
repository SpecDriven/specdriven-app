// specs/app/github-issues.feature.md on the server: which GitHub repository
// a data repo's code-repo pushes to (read from git config on disk, plain
// repos and worktrees alike), and the issue calls — list, open, create,
// update, close, comment — against a stub GitHub on loopback: what is sent,
// what comes back, and how a refusal is worded. No network, no real GitHub.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../src/server/api";
import { syncPlugins } from "../src/plugins/host/loader";
import {
  GitHubError,
  addComment,
  createIssue,
  getIssue,
  githubRepoOfRemote,
  listComments,
  listIssues,
  originUrl,
  parseIssueNumber,
  parseOriginUrl,
  readIssuesRepo,
  repoOfFolder,
  toIssue,
  updateIssue,
} from "../src/server/issues";
import { signOut } from "../src/server/auth";
import { normalizeIssues, writeState } from "../src/server/state";
import { createFileBackend, saveToken, setTokenBackend } from "../src/server/tokenStore";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-issues-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fake repository: `.git/config` with the given origin, no git needed. */
async function fakeRepo(dir: string, origin: string | null): Promise<void> {
  await mkdir(join(dir, ".git"), { recursive: true });
  const remote = origin === null ? "" : `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  await writeFile(join(dir, ".git", "config"), `[core]\n\tbare = false\n${remote}[branch "main"]\n\tremote = origin\n`);
}

describe("which repository", () => {
  test("the origin url is read from a git config", () => {
    const config = `[core]\n\trepositoryformatversion = 0\n[remote "upstream"]\n\turl = git@github.com:other/thing.git\n[remote "origin"]\n\turl = https://github.com/SpecDriven/specdriven_app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
    expect(parseOriginUrl(config)).toBe("https://github.com/SpecDriven/specdriven_app.git");
    expect(parseOriginUrl("[core]\n\tbare = false\n")).toBeNull();
  });

  test("GitHub remotes in every spelling name the repo; other hosts do not", () => {
    const expected = { owner: "SpecDriven", name: "specdriven_app", url: "https://github.com/SpecDriven/specdriven_app" };
    expect(githubRepoOfRemote("https://github.com/SpecDriven/specdriven_app.git")).toEqual(expected);
    expect(githubRepoOfRemote("https://github.com/SpecDriven/specdriven_app")).toEqual(expected);
    expect(githubRepoOfRemote("git@github.com:SpecDriven/specdriven_app.git")).toEqual(expected);
    expect(githubRepoOfRemote("ssh://git@github.com/SpecDriven/specdriven_app.git")).toEqual(expected);
    expect(githubRepoOfRemote("ssh://git@github.com:22/SpecDriven/specdriven_app.git")).toEqual(expected);
    expect(githubRepoOfRemote("https://gitlab.com/SpecDriven/specdriven_app.git")).toBeNull();
    expect(githubRepoOfRemote("/srv/git/specdriven_app.git")).toBeNull();
  });

  test("a plain repository's origin comes from .git/config", async () => {
    const dir = join(root, "code");
    await fakeRepo(dir, "git@github.com:acme/app.git");
    expect(await originUrl(dir)).toBe("git@github.com:acme/app.git");
    expect(await repoOfFolder(dir)).toEqual({ owner: "acme", name: "app", url: "https://github.com/acme/app" });
  });

  test("a worktree follows its gitdir pointer and commondir to the shared config", async () => {
    const main = join(root, "main");
    await fakeRepo(main, "https://github.com/acme/app.git");
    const wtGitDir = join(main, ".git", "worktrees", "feature");
    await mkdir(wtGitDir, { recursive: true });
    await writeFile(join(wtGitDir, "commondir"), "../..\n");
    const worktree = join(root, "feature");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);
    expect(await repoOfFolder(worktree)).toEqual({ owner: "acme", name: "app", url: "https://github.com/acme/app" });
  });

  test("no repo, no origin or a non-GitHub origin means no issues repo", async () => {
    await mkdir(join(root, "plain"), { recursive: true });
    expect(await repoOfFolder(join(root, "plain"))).toBeNull();
    expect(await repoOfFolder(join(root, "missing"))).toBeNull();
    await fakeRepo(join(root, "local"), null);
    expect(await repoOfFolder(join(root, "local"))).toBeNull();
    await fakeRepo(join(root, "gitlab"), "https://gitlab.com/acme/app.git");
    expect(await repoOfFolder(join(root, "gitlab"))).toBeNull();
  });

  test("the data repo's code-repo says which repository's issues to track", async () => {
    const data = join(root, "specs");
    await mkdir(data, { recursive: true });
    await fakeRepo(join(root, "app"), "https://github.com/acme/app.git");
    await writeFile(join(data, "project-settings.json"), JSON.stringify({ members: [], "code-repo": "../app" }));
    expect(await readIssuesRepo(data)).toEqual({ owner: "acme", name: "app", url: "https://github.com/acme/app" });
    // No code repo named: nothing to track.
    await writeFile(join(data, "project-settings.json"), JSON.stringify({ members: ["Ada"] }));
    expect(await readIssuesRepo(data)).toBeNull();
    // No settings file at all.
    await rm(join(data, "project-settings.json"));
    expect(await readIssuesRepo(data)).toBeNull();
  });
});

// --- The GitHub API ---------------------------------------------------------------------

const REPO = { owner: "acme", name: "app", url: "https://github.com/acme/app" };

function rawIssue(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: "open",
    state_reason: null,
    html_url: `https://github.com/acme/app/issues/${number}`,
    user: { login: "octo" },
    assignees: [{ login: "ada" }],
    labels: [{ name: "bug", color: "d73a4a" }, "triage"],
    comments: 2,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-02T10:00:00Z",
    closed_at: null,
    ...extra,
  };
}

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let seen: Seen[] = [];
/** What the stub answers next, per `${method} ${path}`; unlisted is 404. */
let answers: Record<string, { status?: number; body: unknown; headers?: Record<string, string> }> = {};
let tokenFile: string;
const savedApi = process.env.SPECDRIVEN_GITHUB_API_URL;
const savedRoot = process.env.SPECDRIVEN_ROOT;
const savedHome = process.env.SPECDRIVEN_HOME;
const savedPath = process.env.PATH;

function stubGitHub(): string {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = `${req.method} ${url.pathname}`;
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      seen.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), body });
      const answer = answers[key];
      if (!answer) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json(answer.body, { status: answer.status ?? 200, headers: answer.headers });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

describe("the GitHub API", () => {
  beforeEach(async () => {
    tokenFile = join(root, "token.json");
    setTokenBackend(createFileBackend(tokenFile));
    process.env.SPECDRIVEN_GITHUB_API_URL = stubGitHub();
    // An empty PATH keeps the machine's gh (and its token) out of the test.
    process.env.PATH = "";
    seen = [];
    answers = {};
  });

  afterEach(async () => {
    await signOut();
    server?.stop(true);
    server = null;
    setTokenBackend(createFileBackend());
    if (savedApi === undefined) delete process.env.SPECDRIVEN_GITHUB_API_URL;
    else process.env.SPECDRIVEN_GITHUB_API_URL = savedApi;
    process.env.PATH = savedPath ?? "";
  });

  async function signIn() {
    await saveToken({ token: "tok-123", login: "octo", name: null, email: null, id: 1 });
  }

  test("GitHub's issue becomes the app's, pull requests left out", async () => {
    const issue = toIssue(rawIssue(7));
    expect(issue).toEqual({
      number: 7,
      title: "Issue 7",
      body: "Body 7",
      state: "open",
      stateReason: null,
      url: "https://github.com/acme/app/issues/7",
      author: "octo",
      assignees: ["ada"],
      labels: [{ name: "bug", color: "d73a4a" }, { name: "triage", color: "" }],
      comments: 2,
      createdAt: "2026-09-01T10:00:00Z",
      updatedAt: "2026-09-02T10:00:00Z",
      closedAt: null,
    });
    answers["GET /repos/acme/app/issues"] = {
      body: [rawIssue(1), rawIssue(2, { pull_request: { url: "x" } }), rawIssue(3, { state: "closed", state_reason: "not_planned", body: null })],
    };
    const listed = await listIssues(REPO, "all");
    expect(listed.map((i) => i.number)).toEqual([1, 3]);
    expect(listed[1]!.state).toBe("closed");
    expect(listed[1]!.stateReason).toBe("not_planned");
    expect(listed[1]!.body).toBe("");
    expect(seen[0]!.path).toBe("/repos/acme/app/issues?state=all&sort=updated&direction=desc&per_page=100");
    // Signed out: no Authorization header, but the read still goes out.
    expect(seen[0]!.auth).toBeNull();
  });

  test("the sign-in token rides along on every call", async () => {
    await signIn();
    answers["GET /repos/acme/app/issues/4"] = { body: rawIssue(4) };
    answers["GET /repos/acme/app/issues/4/comments"] = {
      body: [{ id: 9, body: "Same here", html_url: "https://github.com/acme/app/issues/4#issuecomment-9", user: { login: "ada" }, created_at: "2026-09-03T10:00:00Z", updated_at: "2026-09-03T10:00:00Z" }],
    };
    expect((await getIssue(REPO, 4)).number).toBe(4);
    expect(await listComments(REPO, 4)).toEqual([
      { id: 9, body: "Same here", author: "ada", url: "https://github.com/acme/app/issues/4#issuecomment-9", createdAt: "2026-09-03T10:00:00Z", updatedAt: "2026-09-03T10:00:00Z" },
    ]);
    expect(seen.map((s) => s.auth)).toEqual(["Bearer tok-123", "Bearer tok-123"]);
  });

  // Scenario: create a new issue.
  test("creating an issue posts its title and body", async () => {
    await signIn();
    answers["POST /repos/acme/app/issues"] = { status: 201, body: rawIssue(10, { title: "Crash on save", body: "Steps…" }) };
    const issue = await createIssue(REPO, { title: "  Crash on save ", body: "Steps…" });
    expect(issue.number).toBe(10);
    expect(seen[0]!.body).toEqual({ title: "Crash on save", body: "Steps…" });
    // A blank body is left out rather than sent as an empty description.
    await createIssue(REPO, { title: "Bare", body: "  " });
    expect(seen[1]!.body).toEqual({ title: "Bare" });
    await expect(createIssue(REPO, { title: "  " })).rejects.toThrow("An issue needs a title");
    expect(seen).toHaveLength(2);
  });

  // Scenario: update an issue.
  test("updating an issue patches only what changed", async () => {
    await signIn();
    answers["PATCH /repos/acme/app/issues/5"] = { body: rawIssue(5, { title: "Renamed" }) };
    expect((await updateIssue(REPO, 5, { title: "Renamed" })).title).toBe("Renamed");
    expect(seen[0]!.body).toEqual({ title: "Renamed" });
    await updateIssue(REPO, 5, { body: "" });
    expect(seen[1]!.body).toEqual({ body: "" });
    await expect(updateIssue(REPO, 5, {})).rejects.toThrow("Nothing to change");
    await expect(updateIssue(REPO, 5, { state: "done" })).rejects.toThrow("state must be open or closed");
    await expect(updateIssue(REPO, 5, { body: 3 })).rejects.toThrow("body must be a string");
    expect(seen).toHaveLength(2);
  });

  // Scenario: close an issue — and reopen it.
  test("closing sends the state with a reason; reopening clears it", async () => {
    await signIn();
    answers["PATCH /repos/acme/app/issues/5"] = { body: rawIssue(5, { state: "closed", state_reason: "completed", closed_at: "2026-09-04T10:00:00Z" }) };
    const closed = await updateIssue(REPO, 5, { state: "closed" });
    expect(closed.state).toBe("closed");
    expect(closed.closedAt).toBe("2026-09-04T10:00:00Z");
    expect(seen[0]!.body).toEqual({ state: "closed", state_reason: "completed" });
    await updateIssue(REPO, 5, { state: "closed", stateReason: "not_planned" });
    expect(seen[1]!.body).toEqual({ state: "closed", state_reason: "not_planned" });
    await updateIssue(REPO, 5, { state: "open" });
    expect(seen[2]!.body).toEqual({ state: "open", state_reason: null });
  });

  test("a comment is posted, blank ones refused", async () => {
    await signIn();
    answers["POST /repos/acme/app/issues/5/comments"] = {
      status: 201,
      body: { id: 1, body: "Fixed in 1.2", html_url: "u", user: { login: "octo" }, created_at: "t", updated_at: "t" },
    };
    expect((await addComment(REPO, 5, " Fixed in 1.2 ")).body).toBe("Fixed in 1.2");
    expect(seen[0]!.body).toEqual({ body: "Fixed in 1.2" });
    await expect(addComment(REPO, 5, "")).rejects.toThrow("A comment needs some text");
  });

  test("GitHub's refusals are worded for the pane", async () => {
    answers["POST /repos/acme/app/issues"] = { status: 401, body: { message: "Requires authentication" } };
    const signedOut = await createIssue(REPO, { title: "x" }).catch((e: GitHubError) => e);
    expect(signedOut).toBeInstanceOf(GitHubError);
    expect((signedOut as GitHubError).status).toBe(401);
    expect((signedOut as GitHubError).message).toBe("Sign in to GitHub in Settings to work with issues.");

    answers["GET /repos/acme/app/issues"] = { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } };
    const limited = await listIssues(REPO).catch((e: GitHubError) => e);
    expect((limited as GitHubError).message).toContain("anonymous rate limit");

    await signIn();
    const badToken = await createIssue(REPO, { title: "x" }).catch((e: GitHubError) => e);
    expect((badToken as GitHubError).message).toContain("sign in again");
    const missing = await getIssue(REPO, 99).catch((e: GitHubError) => e);
    expect((missing as GitHubError).status).toBe(404);
    answers["GET /repos/acme/app/issues/8"] = { body: rawIssue(8, { pull_request: {} }) };
    await expect(getIssue(REPO, 8)).rejects.toThrow("pull request");
    answers["GET /repos/acme/app/issues/9"] = { status: 500, body: { message: "boom" } };
    const broken = await getIssue(REPO, 9).catch((e: GitHubError) => e);
    expect((broken as GitHubError).status).toBe(502);
    expect((broken as GitHubError).message).toBe("GitHub answered HTTP 500: boom");
  });

  test("an issue number is a positive integer", () => {
    expect(parseIssueNumber("12")).toBe(12);
    for (const bad of ["0", "-1", "1.5", "abc", "", undefined]) {
      expect(() => parseIssueNumber(bad)).toThrow("positive integer");
    }
  });

  // The routes: the data repo's code-repo picks the repository, and the
  // Issues tab has nothing to show for a data repo without a GitHub one.
  describe("/api/issues", () => {
    let appRoot: string;
    let home: string;

    beforeEach(async () => {
      appRoot = join(root, "approot");
      home = join(root, "home");
      await mkdir(appRoot, { recursive: true });
      await mkdir(home, { recursive: true });
      process.env.SPECDRIVEN_ROOT = appRoot;
      process.env.SPECDRIVEN_HOME = home;
    });

    afterEach(() => {
      if (savedRoot === undefined) delete process.env.SPECDRIVEN_ROOT;
      else process.env.SPECDRIVEN_ROOT = savedRoot;
      if (savedHome === undefined) delete process.env.SPECDRIVEN_HOME;
      else process.env.SPECDRIVEN_HOME = savedHome;
    });

    async function dataRepo(codeRepo: string | null): Promise<string> {
      const data = join(root, "specs");
      await mkdir(data, { recursive: true });
      await writeFile(join(data, "README.md"), "# Specs\n");
      await writeFile(join(data, "project-settings.json"), JSON.stringify(codeRepo ? { "code-repo": codeRepo } : {}));
      await writeState({ dataRepo: data, reloadFrequencySeconds: 0, issues: true }, appRoot);
      // The module is a plugin (specs/app/plugins.feature.md): the server
      // mounts it from the settings at startup and on every settings write;
      // a state written behind its back is followed by hand here.
      await syncPlugins({ issues: true });
      return data;
    }

    test("the GitHub issues setting is off unless explicitly turned on", () => {
      expect(normalizeIssues(undefined)).toBe(false);
      expect(normalizeIssues("true")).toBe(false);
      expect(normalizeIssues(false)).toBe(false);
      expect(normalizeIssues(true)).toBe(true);
    });

    test("the routes refuse while the switch is off, and the switch is saved through /api/state", async () => {
      await fakeRepo(join(root, "app"), "https://github.com/acme/app.git");
      const data = await dataRepo("../app");
      await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, appRoot);
      await syncPlugins({ issues: false });
      // Off, the plugin is not mounted and the route is not there: the
      // server answers 404 the way it does for any unknown path.
      expect(await handleApi(new Request("http://localhost/api/issues"))).toBeNull();
      expect(seen).toHaveLength(0);
      let state = await handleApi(new Request("http://localhost/api/state"));
      expect(((await state!.json()) as { issues: boolean }).issues).toBe(false);

      const on = await handleApi(
        new Request("http://localhost/api/state", { method: "PUT", body: JSON.stringify({ issues: true }), headers: { "Content-Type": "application/json" } }),
      );
      expect(on!.status).toBe(200);
      expect(((await on!.json()) as { issues: boolean }).issues).toBe(true);
      answers["GET /repos/acme/app/issues"] = { body: [] };
      expect((await handleApi(new Request("http://localhost/api/issues")))!.status).toBe(200);

      const bad = await handleApi(
        new Request("http://localhost/api/state", { method: "PUT", body: JSON.stringify({ issues: "yes" }), headers: { "Content-Type": "application/json" } }),
      );
      expect(bad!.status).toBe(400);
      await handleApi(
        new Request("http://localhost/api/state", { method: "PUT", body: JSON.stringify({ issues: false }), headers: { "Content-Type": "application/json" } }),
      );
      state = await handleApi(new Request("http://localhost/api/state"));
      expect(((await state!.json()) as { issues: boolean }).issues).toBe(false);
    });

    test("the features listing names the issues repo, and the routes serve it", async () => {
      await fakeRepo(join(root, "app"), "git@github.com:acme/app.git");
      await dataRepo("../app");
      const listing = await handleApi(new Request("http://localhost/api/features"));
      expect(listing!.status).toBe(200);
      expect(((await listing!.json()) as { issuesRepo: unknown }).issuesRepo).toEqual(REPO);

      answers["GET /repos/acme/app/issues"] = { body: [rawIssue(1)] };
      const res = await handleApi(new Request("http://localhost/api/issues?state=closed"));
      expect(res!.status).toBe(200);
      const data = (await res!.json()) as { repo: unknown; state: string; issues: { number: number }[] };
      expect(data.repo).toEqual(REPO);
      expect(data.state).toBe("closed");
      expect(data.issues.map((i) => i.number)).toEqual([1]);
      expect(seen[0]!.path).toContain("state=closed");
      // An unknown filter is the default, open.
      await handleApi(new Request("http://localhost/api/issues?state=weird"));
      expect(seen[1]!.path).toContain("state=open");

      await signIn();
      answers["POST /repos/acme/app/issues"] = { status: 201, body: rawIssue(2, { title: "New" }) };
      const created = await handleApi(
        new Request("http://localhost/api/issues", { method: "POST", body: JSON.stringify({ title: "New" }), headers: { "Content-Type": "application/json" } }),
      );
      expect(created!.status).toBe(201);
      answers["PATCH /repos/acme/app/issues/2"] = { body: rawIssue(2, { state: "closed", state_reason: "completed" }) };
      const closed = await handleApi(
        new Request("http://localhost/api/issues/2", { method: "PUT", body: JSON.stringify({ state: "closed" }), headers: { "Content-Type": "application/json" } }),
      );
      expect(closed!.status).toBe(200);
      expect(((await closed!.json()) as { issue: { state: string } }).issue.state).toBe("closed");
      answers["GET /repos/acme/app/issues/2"] = { body: rawIssue(2) };
      answers["GET /repos/acme/app/issues/2/comments"] = { body: [] };
      const one = await handleApi(new Request("http://localhost/api/issues/2"));
      expect(one!.status).toBe(200);
      expect(await one!.json()).toMatchObject({ issue: { number: 2 }, comments: [] });
      const bad = await handleApi(new Request("http://localhost/api/issues/nope"));
      expect(bad!.status).toBe(400);
      answers["POST /repos/acme/app/issues/2/comments"] = { status: 201, body: { id: 3, body: "ok", html_url: "u", user: null, created_at: "t", updated_at: "t" } };
      const commented = await handleApi(
        new Request("http://localhost/api/issues/2/comments", { method: "POST", body: JSON.stringify({ body: "ok" }), headers: { "Content-Type": "application/json" } }),
      );
      expect(commented!.status).toBe(201);
      expect(((await commented!.json()) as { comment: { author: null } }).comment.author).toBeNull();
    });

    test("a GitHub refusal keeps its status and wording", async () => {
      await fakeRepo(join(root, "app"), "https://github.com/acme/app.git");
      await dataRepo("../app");
      answers["POST /repos/acme/app/issues"] = { status: 401, body: { message: "Requires authentication" } };
      const res = await handleApi(
        new Request("http://localhost/api/issues", { method: "POST", body: JSON.stringify({ title: "x" }), headers: { "Content-Type": "application/json" } }),
      );
      expect(res!.status).toBe(401);
      expect(await res!.json()).toEqual({ error: "Sign in to GitHub in Settings to work with issues." });
    });

    test("without a GitHub code repo there are no issues", async () => {
      await dataRepo(null);
      const listing = await handleApi(new Request("http://localhost/api/features"));
      expect(((await listing!.json()) as { issuesRepo: unknown }).issuesRepo).toBeNull();
      const res = await handleApi(new Request("http://localhost/api/issues"));
      expect(res!.status).toBe(404);
      expect(((await res!.json()) as { error: string }).error).toContain("code-repo");
      expect(seen).toHaveLength(0);
    });
  });
});

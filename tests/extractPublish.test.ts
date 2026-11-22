// Automates specs/app/extract-specs-from-code.feature.md: a code project's
// specification folder gets a repository on GitHub — made under the
// project's own owner or the account signed in, cloned into place, and
// pushed to — and stays on this computer, with the reason said, when GitHub
// refuses; a folder left local is published later.
//
// GitHub is stood in for twice: a REST stub that "creates" a repository by
// making a bare one with a first commit, and a git smart-HTTP server over
// those bare repositories, so the clone and the push are real.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { signOut } from "../src/server/auth";
import { setGitEngine, type GitEngine } from "../src/server/git";
import { createRepo, GitHubRepoError, repoOwners } from "../src/server/githubRepos";
import { publishSpecsFolder } from "../src/server/intentRepo";
import { writeState } from "../src/server/state";
import { createFileBackend, saveToken, setTokenBackend } from "../src/server/tokenStore";
import { gitEngines } from "./helpers/engines";
import { git } from "./helpers/fixtures";
import { serveRepos, type GitHttpServer } from "./helpers/gitHttpServer";

let root: string;
let code: string;
let remotes: string;
let api: ReturnType<typeof Bun.serve> | null = null;
let gitServer: GitHttpServer | null = null;
/** What the REST stub was asked, as `METHOD path`, with the body of a POST. */
let seen: { line: string; auth: string | null; body: any }[] = [];
/** What a create answers instead of making the repository. */
let refusal: { status: number; body: unknown } | null = null;
/** Commits a repository made by the stub starts with. */
let firstCommits = 1;
const real = { ...process.env };

const put = async (dir: string, path: string, text = "") => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), text);
};

const call = async (method: string, path: string, body?: unknown) => {
  const res = (await handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  ))!;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

/** A bare repository with `commits` commits on main: what GitHub's auto_init leaves, or more. */
async function makeRemote(owner: string, name: string, commits = 1): Promise<void> {
  const bare = join(remotes, owner, `${name}.git`);
  await mkdir(bare, { recursive: true });
  await git(bare, "init", "--bare", "-b", "main");
  const work = await mkdtemp(join(tmpdir(), "specdriven-extract-seed-"));
  await git(work, "init", "-b", "main");
  for (let i = 0; i < commits; i++) {
    await writeFile(join(work, i === 0 ? "README.md" : `file${i}.txt`), `# ${name}\n`);
    await git(work, "add", "-A");
    await git(work, "-c", "user.name=GitHub", "-c", "user.email=noreply@github.com", "-c", "commit.gpgsign=false", "commit", "-m", i === 0 ? "Initial commit" : `More ${i}`);
  }
  await git(work, "push", bare, "main");
  await rm(work, { recursive: true, force: true });
}

const remoteExists = (owner: string, name: string) =>
  stat(join(remotes, owner, `${name}.git`)).then(
    () => true,
    () => false,
  );

/** The files on the remote's main branch, and its commit subjects, newest first. */
async function remoteState(owner: string, name: string): Promise<{ files: string[]; log: string[] }> {
  const bare = join(remotes, owner, `${name}.git`);
  const out = async (...args: string[]) => (await git(bare, ...args)).stdout.toString().split("\n").filter(Boolean);
  const files = (await out("ls-tree", "-r", "--name-only", "main")).sort();
  const log = await out("log", "--format=%s", "main");
  return { files, log };
}

function stubGitHub(): string {
  api = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      seen.push({ line: `${req.method} ${url.pathname}`, auth: req.headers.get("authorization"), body });
      if (url.pathname === "/user") return Response.json({ login: "octo" });
      if (url.pathname === "/user/orgs") return Response.json([{ login: "acme" }, { login: "widgets" }]);
      const repo = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/commits)?$/);
      if (req.method === "GET" && repo) {
        if (!(await remoteExists(repo[1]!, repo[2]!))) return Response.json({ message: "Not Found" }, { status: 404 });
        if (repo[3]) {
          const log = (await remoteState(repo[1]!, repo[2]!)).log;
          return Response.json(log.slice(0, 2).map((subject) => ({ commit: { message: subject } })));
        }
        return Response.json({ html_url: `https://github.com/${repo[1]}/${repo[2]}`, default_branch: "main" });
      }
      const create = url.pathname === "/user/repos" ? "octo" : url.pathname.match(/^\/orgs\/([^/]+)\/repos$/)?.[1];
      if (req.method === "POST" && create) {
        if (refusal) return Response.json(refusal.body, { status: refusal.status });
        await makeRemote(create, body.name, firstCommits);
        return Response.json({ html_url: `https://github.com/${create}/${body.name}`, default_branch: "main" }, { status: 201 });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${api.port}`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-extract-pub-"));
  remotes = join(root, "remotes");
  await mkdir(remotes, { recursive: true });
  await mkdir(join(root, "app"), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  process.env.SPECDRIVEN_ROOT = join(root, "app");
  process.env.SPECDRIVEN_HOME = join(root, "home");
  delete process.env.SPECDRIVEN_HOSTED;
  delete process.env.DEMO_MODE;
  await writeState({}, join(root, "app"));
  setTokenBackend(createFileBackend(join(root, "token.json")));
  await saveToken({ token: "tok-123", login: "octo", name: "Octo Cat", email: "octo@example.com", id: 1 });
  process.env.SPECDRIVEN_GITHUB_API_URL = stubGitHub();
  gitServer = serveRepos(remotes);
  process.env.SPECDRIVEN_GITHUB_URL = gitServer.url;
  seen = [];
  refusal = null;
  firstCommits = 1;
  code = join(root, "work", "shop");
  await put(code, "package.json", '{"name":"shop","workspaces":["packages/*"]}');
  await put(code, "packages/api/package.json", '{"name":"api"}');
  await put(code, "packages/api/src/server.ts", "export const a = 1;\n");
  await put(code, "packages/web/package.json", '{"name":"web"}');
  await put(code, "packages/web/src/App.tsx", "");
});

afterEach(async () => {
  reloader.stop();
  await signOut();
  setTokenBackend(createFileBackend());
  setGitEngine(null);
  api?.stop(true);
  api = null;
  gitServer?.stop();
  gitServer = null;
  await rm(root, { recursive: true, force: true });
  for (const name of ["SPECDRIVEN_ROOT", "SPECDRIVEN_HOME", "SPECDRIVEN_HOSTED", "DEMO_MODE", "SPECDRIVEN_GITHUB_API_URL", "SPECDRIVEN_GITHUB_URL"]) {
    if (real[name] === undefined) delete process.env[name];
    else process.env[name] = real[name];
  }
});

const folders = [
  { folder: "api", name: "API", modules: ["packages/api"], draft: true },
  { folder: "web", name: "Web", modules: ["packages/web"], draft: true },
];

describe("who a repository can be made under", () => {
  test("the account signed in, then its organisations", async () => {
    expect(await repoOwners(code)).toEqual({ host: "github.com", owners: ["octo", "acme", "widgets"] });
    expect(seen.every((s) => s.auth === "Bearer tok-123")).toBe(true);
  });

  test("the owner of the code project's own repository comes first", async () => {
    await git(code, "init", "-b", "main");
    await git(code, "remote", "add", "origin", "https://github.com/widgets/shop.git");
    expect((await repoOwners(code)).owners).toEqual(["widgets", "octo", "acme"]);
  });

  test("without a sign-in, the answer says so", async () => {
    await signOut();
    expect(await repoOwners(code)).toEqual({
      host: "github.com",
      owners: [],
      problem: "Sign in to GitHub in Settings to create a repository",
    });
    const res = await call("POST", "/api/extract/analyse", { codeDir: code });
    expect(res.body.github.problem).toBe("Sign in to GitHub in Settings to create a repository");
  });

  test("the analysis carries them for the dialog", async () => {
    expect((await call("POST", "/api/extract/analyse", { codeDir: code })).body.github).toEqual({
      host: "github.com",
      owners: ["octo", "acme", "widgets"],
    });
  });
});

describe("making the repository", () => {
  test("an account's own goes to /user/repos, an organisation's to /orgs", async () => {
    const mine = await createRepo({ host: "github.com", owner: "octo", name: "specs-a", private: true, description: "Specs" });
    expect(mine).toEqual({ url: "https://github.com/octo/specs-a", cloneUrl: `${gitServer!.url}/octo/specs-a.git`, branch: "main" });
    await createRepo({ host: "github.com", owner: "acme", name: "specs-b", private: false });
    const posts = seen.filter((s) => s.line.startsWith("POST"));
    expect(posts.map((p) => p.line)).toEqual(["POST /user/repos", "POST /orgs/acme/repos"]);
    expect(posts[0]!.body).toEqual({ name: "specs-a", private: true, description: "Specs", auto_init: true });
    expect(posts[1]!.body).toEqual({ name: "specs-b", private: false, auto_init: true });
  });

  test("one that holds someone's work is refused; one with only its first commit is taken", async () => {
    await makeRemote("octo", "specs-busy", 3);
    await expect(createRepo({ host: "github.com", owner: "octo", name: "specs-busy", private: true })).rejects.toThrow(
      "octo/specs-busy already exists on GitHub — choose another name",
    );
    await makeRemote("octo", "specs-fresh", 1);
    expect((await createRepo({ host: "github.com", owner: "octo", name: "specs-fresh", private: true })).url).toBe(
      "https://github.com/octo/specs-fresh",
    );
    expect(seen.some((s) => s.line.startsWith("POST"))).toBe(false);
  });

  test("a refusal is worded for the dialog", async () => {
    const said = async (status: number, body: unknown, owner = "acme") => {
      refusal = { status, body };
      try {
        await createRepo({ host: "github.com", owner, name: "specs-x", private: true });
        return "made";
      } catch (e) {
        return e instanceof GitHubRepoError ? e.message : String(e);
      }
    };
    expect(await said(403, { message: "Resource not accessible by integration" })).toBe(
      "GitHub did not let this sign-in create a repository for acme: Resource not accessible by integration",
    );
    expect(await said(404, { message: "Not Found" })).toBe(
      "acme is not an organisation this sign-in can create a repository in",
    );
    expect(await said(422, { message: "Repository creation failed.", errors: [{ message: "name is too long" }] }, "octo")).toBe(
      "octo/specs-x cannot be created: Repository creation failed.: name is too long",
    );
  });
});

for (const engine of gitEngines().filter((e) => e !== "gh") as GitEngine[]) {
  describe(`POST /api/extract/repo with GitHub (${engine} engine)`, () => {
    beforeEach(() => setGitEngine(engine));

    test("the folder is a clone of the new repository, set up and pushed in one commit", async () => {
      const res = await call("POST", "/api/extract/repo", {
        codeDir: code,
        name: "specs-shop",
        folders,
        github: { host: "github.com", owner: "acme", private: true },
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        dir: join(root, "work", "specs-shop"),
        folders: ["specs/api", "specs/web"],
        github: "https://github.com/acme/specs-shop",
      });
      const remote = await remoteState("acme", "specs-shop");
      expect(remote.log).toEqual(["Set up specifications for shop", "Initial commit"]);
      expect(remote.files).toEqual([
        ".specdriven/data-format.json",
        ".specdriven/data-format.yaml",
        "README.md",
        "project-settings.yaml",
        "specs/api/display-name.txt",
        "specs/web/display-name.txt",
      ]);
      // The README is the app's, not the one GitHub started the repository with.
      expect(await readFile(join(res.body.dir, "README.md"), "utf8")).toContain("Specifications for `shop`");
      expect(seen.find((s) => s.line === "POST /orgs/acme/repos")!.body).toMatchObject({
        name: "specs-shop",
        private: true,
        description: "Specifications for shop",
      });
    });

    test("when GitHub refuses, the folder is made on this computer and the reason is said", async () => {
      refusal = { status: 403, body: { message: "Resource not accessible by integration" } };
      const res = await call("POST", "/api/extract/repo", {
        codeDir: code,
        name: "specs-shop",
        folders,
        github: { host: "github.com", owner: "octo", private: true },
      });
      expect(res.status).toBe(201);
      expect(res.body.github).toBeNull();
      expect(res.body.githubProblem).toBe(
        "GitHub did not let this sign-in create a repository for octo: Resource not accessible by integration",
      );
      const dir = join(root, "work", "specs-shop");
      expect((await readdir(dir)).sort()).toEqual([".specdriven", "README.md", "project-settings.yaml", "specs"]);
    });

    test("a folder left on this computer is published later, with what it holds by then", async () => {
      const made = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-shop", folders });
      const dir = made.body.dir as string;
      await put(dir, "specs/api/orders.feature.md", "# Orders\n\n## S1: Place an order @v1 [proposed]\n\n- Given: a cart\n");
      await writeState({ dataRepo: dir }, join(root, "app"));
      const res = await call("POST", "/api/extract/publish", { github: { host: "github.com", owner: "octo", private: true } });
      expect(res).toEqual({ status: 200, body: { github: "https://github.com/octo/specs-shop" } });
      const remote = await remoteState("octo", "specs-shop");
      expect(remote.log).toEqual(["Set up specifications for shop", "Initial commit"]);
      expect(remote.files).toContain("specs/api/orders.feature.md");
      expect(remote.files).toContain("project-settings.yaml");
      // The clone it was published through is gone.
      expect((await readdir(join(root, "work"))).sort()).toEqual(["shop", "specs-shop"]);
      // A second ask finds the repository there, level, and has nothing to do but say so.
      const again = await call("POST", "/api/extract/publish", { github: { host: "github.com", owner: "octo", private: true } });
      expect(again.body.github).toBe(`${gitServer!.url}/octo/specs-shop`);
      expect((await remoteState("octo", "specs-shop")).log).toHaveLength(2);
    });

    test("an open folder on this computer is offered the accounts it could be published under", async () => {
      const made = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-shop", folders });
      await writeState({ dataRepo: made.body.dir }, join(root, "app"));
      // The code project's own owner first, as when the folder was made.
      await git(code, "init", "-b", "main");
      await git(code, "remote", "add", "origin", "https://github.com/widgets/shop.git");
      expect(await call("GET", "/api/extract/github")).toEqual({
        status: 200,
        body: { host: "github.com", owners: ["widgets", "octo", "acme"] },
      });
      expect((await call("GET", "/api/extract/draft")).body).toEqual({ job: null, published: false });
    });

    test("a folder that already pushes somewhere else is not published again", async () => {
      const made = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-shop", folders });
      await git(made.body.dir, "init", "-b", "main");
      await git(made.body.dir, "remote", "add", "origin", "https://example.com/other/specs.git");
      const published = publishSpecsFolder(made.body.dir, { host: "github.com", owner: "octo", private: true });
      await expect(published).rejects.toThrow(`${made.body.dir} is a repository already, pushing to https://example.com/other/specs.git`);
      expect(seen.some((s) => s.line.startsWith("POST"))).toBe(false);
    });

    test("publishing later refuses a repository that holds someone's work", async () => {
      const made = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-shop", folders });
      await writeState({ dataRepo: made.body.dir }, join(root, "app"));
      await makeRemote("octo", "specs-shop", 2);
      const res = await call("POST", "/api/extract/publish", { github: { host: "github.com", owner: "octo", private: true } });
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("octo/specs-shop already exists on GitHub — choose another name");
    });
  });
}

describe("an existing specification folder named by its GitHub url", () => {
  const realRepos = process.env.SPECDRIVEN_REPOS_DIR;
  beforeEach(() => {
    process.env.SPECDRIVEN_REPOS_DIR = join(root, "repos");
    setGitEngine("cli");
  });
  afterEach(() => {
    if (realRepos === undefined) delete process.env.SPECDRIVEN_REPOS_DIR;
    else process.env.SPECDRIVEN_REPOS_DIR = realRepos;
  });

  /** A repository on the stand-in GitHub that is a specification folder, or just a README. */
  async function seedRemote(name: string, asSpecs: boolean): Promise<void> {
    await makeRemote("acme", name, 1);
    if (!asSpecs) return;
    const work = await mkdtemp(join(tmpdir(), "specdriven-extract-existing-"));
    await git(work, "clone", join(remotes, "acme", `${name}.git`), ".");
    await put(work, ".specdriven/data-format.yaml", "format: 4\n");
    await put(work, "specs/billing/invoices.feature.md", "# Invoices\n");
    await git(work, "add", "-A");
    await git(work, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "Specs");
    await git(work, "push", "origin", "main");
    await rm(work, { recursive: true, force: true });
  }

  test("the repository is cloned, the folders added to it, and it opens by its url", async () => {
    await seedRemote("specs-acme", true);
    const res = await call("POST", "/api/extract/repo", {
      codeDir: code,
      existing: "https://github.com/acme/specs-acme",
      folders,
    });
    expect(res.status).toBe(201);
    const dir = join(root, "repos", "specs-acme");
    expect(res.body).toEqual({
      dir,
      open: "https://github.com/acme/specs-acme",
      existing: true,
      folders: ["specs/api", "specs/web"],
      github: null,
    });
    expect((await readdir(join(dir, "specs"))).sort()).toEqual(["api", "billing", "web"]);
    // What was written is committed and pushed, as an edit in the folder is.
    const remote = await remoteState("acme", "specs-acme");
    expect(remote.log[0]).toBe("Add spec folders for shop");
    expect(remote.files).toContain("specs/api/display-name.txt");
    expect(remote.files).toContain("project-settings.yaml");
    expect(remote.files).toContain("specs/billing/invoices.feature.md");
    // No repository was made: this one was there.
    expect(seen.some((s) => s.line.startsWith("POST"))).toBe(false);
  });

  test("a repository that is not a specification folder is refused", async () => {
    // More than GitHub starts a repository with: someone's work, not a fresh repository.
    await makeRemote("acme", "plain", 2);
    const res = await call("POST", "/api/extract/repo", { codeDir: code, existing: "https://github.com/acme/plain", folders });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${join(root, "repos", "plain")} is not a specification folder — it has no .specdriven and specs folders`);
  });

  test("an empty repository named by its url is asked about, then set up, pushed and opened by its url", async () => {
    const bare = join(remotes, "acme", "specs-jitter.git");
    await mkdir(bare, { recursive: true });
    await git(bare, "init", "--bare", "-b", "main");
    const url = "https://github.com/acme/specs-jitter";
    const dir = join(root, "repos", "specs-jitter");
    const asked = await call("POST", "/api/extract/repo", { codeDir: code, existing: url, folders });
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ initialize: true, dir });
    const res = await call("POST", "/api/extract/repo", { codeDir: code, existing: url, folders, initialize: true });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ dir, open: url, existing: true, setUp: true, folders: ["specs/api", "specs/web"], github: null });
    const remote = await remoteState("acme", "specs-jitter");
    expect(remote.log).toEqual(["Set up specifications for shop"]);
    expect(remote.files).toContain("specs/api/display-name.txt");
    expect(remote.files).toContain("project-settings.yaml");
    expect(remote.files).toContain("README.md");
    expect(seen.some((s) => s.line.startsWith("POST"))).toBe(false);
  });
});

test("a repository's owner and host are checked before anything is made", async () => {
  for (const github of [{ host: "github.com", owner: "../x", private: true }, { host: "github.com/evil", owner: "octo" }, { host: "github.com" }]) {
    expect((await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-shop", folders, github })).status).toBe(400);
  }
  expect(await readdir(join(root, "work"))).toEqual(["shop"]);
  expect(seen.some((s) => s.line.startsWith("POST"))).toBe(false);
});

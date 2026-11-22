// Automates specs/app/extract-specs-from-code.feature.md: a code project
// read from disk into a proposal, and its specification folder made beside
// it — set up, pointed back at the project, and holding the chosen folders
// — through the two routes the dialog calls, with what they refuse.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { readDataFormat } from "../src/server/dataFormat";
import { createSpecFolders } from "../src/server/features";
import { extractRoutes } from "../src/server/intentApi";
import { EXTRACT_SPECS_EVENT } from "../src/server/intentNames";
import {
  chosenFolders,
  addToSpecsFolder,
  createSpecsFolder,
  existingSpecsFor,
  ExtractError,
  publishTo,
  resolveCodeProject,
  resolveSpecsFolder,
  specsTarget,
  suggestedSpecsName,
} from "../src/server/intentRepo";
import { scanProject } from "../src/server/intentScan";
import { setGitEngine } from "../src/server/git";
import { readProjectSettings } from "../src/server/members";
import { writeState } from "../src/server/state";
import { git } from "./helpers/fixtures";

let root: string;
let code: string;
const real = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
  SPECDRIVEN_HOSTED: process.env.SPECDRIVEN_HOSTED,
  DEMO_MODE: process.env.DEMO_MODE,
};

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-extract-"));
  process.env.SPECDRIVEN_ROOT = join(root, "app");
  process.env.SPECDRIVEN_HOME = join(root, "home");
  delete process.env.SPECDRIVEN_HOSTED;
  delete process.env.DEMO_MODE;
  await mkdir(join(root, "app"), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  await writeState({}, join(root, "app"));
  code = join(root, "work", "shop");
  await put(code, "package.json", '{"name":"shop","workspaces":["packages/*"]}');
  await put(code, "packages/api/package.json", '{"name":"@acme/api","description":"The storefront API"}');
  await put(code, "packages/api/src/server.ts", "export const a = 1;\n");
  await put(code, "packages/api/src/server.test.ts", "");
  await put(code, "packages/web/package.json", '{"name":"@acme/web"}');
  await put(code, "packages/web/src/App.tsx", "");
  await put(code, "packages/web/node_modules/react/index.js", "");
  await put(code, ".gitignore", "node_modules\n");
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(real)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("reading a project", () => {
  test("the snapshot holds the files the project does not ignore, and its build files", async () => {
    await put(code, ".env", "SECRET=1");
    await put(code, "dist/bundle.js", "");
    await symlink(join(root, "elsewhere"), join(code, "specs"));
    const snapshot = await scanProject(code);
    expect(snapshot.name).toBe("shop");
    expect(snapshot.files.map((f) => f.path)).toEqual([
      "package.json",
      "packages/api/package.json",
      "packages/api/src/server.test.ts",
      "packages/api/src/server.ts",
      "packages/web/package.json",
      "packages/web/src/App.tsx",
    ]);
    expect(snapshot.files.find((f) => f.path === "packages/api/src/server.ts")!.size).toBe(20);
    expect(Object.keys(snapshot.manifests).sort()).toEqual([
      "package.json",
      "packages/api/package.json",
      "packages/web/package.json",
    ]);
    expect(snapshot.truncated).toBeUndefined();
  });
});

describe("POST /api/extract/analyse", () => {
  test("proposes the project's modules and the specification folder it would get", async () => {
    const res = await call("POST", "/api/extract/analyse", { codeDir: code });
    expect(res.status).toBe(200);
    expect(res.body.codeDir).toBe(code);
    expect(res.body.proposal.folders.map((f: any) => [f.name, f.reason])).toEqual([
      ["API", "npm workspace listed in package.json"],
      ["Web", "npm workspace listed in package.json"],
    ]);
    expect(res.body.proposal.languages).toEqual(["typescript"]);
    expect(res.body.name).toBe("specs-shop");
    expect(res.body.target).toBe(join(root, "work", "specs-shop"));
    expect(res.body.targetState).toBe("free");
    expect(res.body.specsLink).toBe("missing");
    expect(res.body.problem).toBeUndefined();
  });

  test("says so when the project holds no code it can read", async () => {
    const docs = join(root, "work", "docs");
    await put(docs, "README.md", "# Docs\n");
    await put(docs, "main.go", "package main\n");
    const res = await call("POST", "/api/extract/analyse", { codeDir: docs });
    expect(res.status).toBe(200);
    expect(res.body.problem).toBe(`No Java, JavaScript, TypeScript or Python code was found in ${docs}`);
    expect(res.body.proposal.skipped).toEqual([{ what: "Go", files: 1 }]);
  });

  test("a specification folder that is already there is reported", async () => {
    await mkdir(join(root, "work", "specs-shop", ".specdriven"), { recursive: true });
    await mkdir(join(root, "work", "specs-shop", "specs"), { recursive: true });
    expect((await call("POST", "/api/extract/analyse", { codeDir: code })).body.targetState).toBe("spec");
  });

  test("refuses a folder that is not there, a relative path and a specification folder", async () => {
    expect(await call("POST", "/api/extract/analyse", { codeDir: join(root, "nowhere") })).toMatchObject({
      status: 404,
      body: { error: `There is no folder at ${join(root, "nowhere")}` },
    });
    expect((await call("POST", "/api/extract/analyse", { codeDir: "shop" })).status).toBe(400);
    expect((await call("POST", "/api/extract/analyse", {})).body.error).toBe("Choose the code project's folder");
    const specs = join(root, "work", "specs-old");
    await mkdir(join(specs, ".specdriven"), { recursive: true });
    await mkdir(join(specs, "specs"), { recursive: true });
    expect((await call("POST", "/api/extract/analyse", { codeDir: specs })).body.error).toBe(
      `${specs} is a specification folder, not a code project`,
    );
  });

  test("is not offered in the demo or a hosted worker", async () => {
    process.env.DEMO_MODE = "1";
    expect((await call("POST", "/api/extract/analyse", { codeDir: code })).status).toBe(403);
    delete process.env.DEMO_MODE;
    process.env.SPECDRIVEN_HOSTED = "1";
    expect((await call("POST", "/api/extract/analyse", { codeDir: code })).status).toBe(403);
  });
});

describe("POST /api/extract/repo", () => {
  const folders = [
    { folder: "web", name: "Storefront", modules: ["packages/web"], draft: true },
    { folder: "api", name: "API", modules: ["packages/api"], draft: true },
  ];

  test("makes the specification folder beside the project, set up and pointing back at it", async () => {
    const res = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-shop", folders });
    expect(res.status).toBe(201);
    const dir = join(root, "work", "specs-shop");
    expect(res.body).toEqual({ dir, folders: ["specs/web", "specs/api"], github: null });
    expect((await readdir(dir)).sort()).toEqual([".specdriven", "README.md", "project-settings.yaml", "specs"]);
    // The code project is its code repository, stored relative so it holds for a teammate.
    const settings = await readProjectSettings(dir);
    expect(settings.codeRepo).toBe(code);
    expect(await readFile(join(dir, "project-settings.yaml"), "utf8")).toContain("../shop");
    expect((await readDataFormat(dir))?.format).toBeGreaterThan(1);
    expect(await readFile(join(dir, "README.md"), "utf8")).toContain("Specifications for `shop`");
    // The chosen folders, named and in the order chosen.
    expect(await readFile(join(dir, "specs/web/display-name.txt"), "utf8")).toBe("Storefront\n");
    expect(await readFile(join(dir, "specs/api/display-name.txt"), "utf8")).toBe("API\n");
    expect(await readFile(join(dir, "specs/folder-order.txt"), "utf8")).toBe("web\napi\n");
    // Nothing is written into the code project.
    expect(await lstat(join(code, "specs")).catch(() => null)).toBeNull();
  });

  test("makes the project's specs link when asked", async () => {
    const res = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-shop", folders, link: true });
    expect(res.status).toBe(201);
    expect(await readlink(join(code, "specs"))).toBe("../specs-shop/specs");
    expect(res.body.linkProblem).toBeUndefined();
  });

  test("a link that cannot be made is reported, and the folder is still made", async () => {
    await mkdir(join(code, "specs"));
    const res = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-shop", folders, link: true });
    expect(res.status).toBe(201);
    expect(res.body.linkProblem).toContain("already exists and is not a symlink");
  });

  test("nested folders are made under their parents", async () => {
    const res = await call("POST", "/api/extract/repo", {
      codeDir: code,
      name: "specs-shop",
      folders: [
        { folder: "storefront", name: "Storefront", modules: [], draft: false },
        { folder: "storefront/api", name: "API", modules: ["packages/api"], draft: true },
        { folder: "storefront/web", name: "web", modules: ["packages/web"], draft: true },
      ],
    });
    expect(res.body.folders).toEqual(["specs/storefront", "specs/storefront/api", "specs/storefront/web"]);
    const dir = join(root, "work", "specs-shop", "specs", "storefront");
    expect((await readdir(dir)).sort()).toEqual(["api", "display-name.txt", "web"]);
    // A display name that is the folder's own is not written.
    expect(await readdir(join(dir, "web"))).toEqual([]);
  });

  test("a name that is taken is refused, a specification folder there named as one", async () => {
    await put(join(root, "work", "specs-shop"), "notes.txt", "mine");
    const taken = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-shop", folders });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ existing: "taken", error: `There is already something at ${join(root, "work", "specs-shop")} — choose another name` });
    await mkdir(join(root, "work", "specs-two", ".specdriven"), { recursive: true });
    await mkdir(join(root, "work", "specs-two", "specs"), { recursive: true });
    const spec = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-two", folders });
    expect(spec.status).toBe(409);
    expect(spec.body.existing).toBe("spec");
  });

  test("a name a repository cannot have is refused", async () => {
    for (const name of ["", "specs shop", "../elsewhere", "a/b", "specs.git"]) {
      expect((await call("POST", "/api/extract/repo", { codeDir: code, name, folders })).status).toBe(400);
    }
    expect(await readdir(join(root, "work"))).toEqual(["shop"]);
  });

  test("folders may only draw on code the project has, each piece once", async () => {
    const invented = await call("POST", "/api/extract/repo", {
      codeDir: code,
      name: "specs-shop",
      folders: [{ folder: "x", name: "X", modules: ["../../etc"], draft: true }],
    });
    expect(invented).toMatchObject({ status: 400, body: { error: "x names code the project does not have: ../../etc" } });
    expect(await readdir(join(root, "work"))).toEqual(["shop"]);
  });
});

describe("POST /api/extract/repo with a specification folder that already exists", () => {
  let specs: string;
  let other: string;
  const chosen = [
    { folder: "api", name: "API", modules: ["packages/api"], draft: true },
    { folder: "web", name: "Storefront", modules: ["packages/web"], draft: true },
  ];

  beforeEach(async () => {
    specs = join(root, "work", "specs-acme");
    other = join(root, "work", "other");
    await mkdir(join(specs, ".specdriven"), { recursive: true });
    await put(specs, "README.md", "# Acme specs\n");
    await put(specs, "project-settings.yaml", "members: []\ncode-repos:\n  - ../other\n");
    await put(specs, "specs/api/display-name.txt", "Public API\n");
    await put(specs, "specs/api/orders.feature.md", "# Orders\n");
    await put(other, "package.json", "{}");
  });

  test("the chosen folders are added, and what the folder holds stays as it is", async () => {
    const res = await call("POST", "/api/extract/repo", { codeDir: code, existing: specs, folders: chosen });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ dir: specs, existing: true, folders: ["specs/api", "specs/web"], github: null });
    // Its own README, its own name for a folder that was there, its features.
    expect(await readFile(join(specs, "README.md"), "utf8")).toBe("# Acme specs\n");
    expect(await readFile(join(specs, "specs/api/display-name.txt"), "utf8")).toBe("Public API\n");
    expect(await readFile(join(specs, "specs/api/orders.feature.md"), "utf8")).toBe("# Orders\n");
    expect(await readFile(join(specs, "specs/web/display-name.txt"), "utf8")).toBe("Storefront\n");
    // No folder of the new name was made beside the project.
    expect((await readdir(join(root, "work"))).sort()).toEqual(["other", "shop", "specs-acme"]);
  });

  test("the code project joins the folder's code repositories, the default staying what it was", async () => {
    await call("POST", "/api/extract/repo", { codeDir: code, existing: specs, folders: chosen });
    const settings = await readProjectSettings(specs);
    expect(settings.codeRepos.map((r) => [r.path, r.isDefault])).toEqual([
      ["../other", true],
      ["../shop", false],
    ]);
    expect(settings.codeRepo).toBe(other);
    // A second time changes nothing.
    await call("POST", "/api/extract/repo", { codeDir: code, existing: specs, folders: chosen });
    expect((await readProjectSettings(specs)).codeRepos).toHaveLength(2);
  });

  test("a folder that names no code repository gets the project as its default", async () => {
    await put(specs, "project-settings.yaml", "members: []\ncode-repos: []\n");
    await call("POST", "/api/extract/repo", { codeDir: code, existing: specs, folders: chosen });
    expect((await readProjectSettings(specs)).codeRepo).toBe(code);
  });

  test("the specs link is made into the existing folder when asked", async () => {
    await call("POST", "/api/extract/repo", { codeDir: code, existing: specs, folders: chosen, link: true });
    expect(await readlink(join(code, "specs"))).toBe("../specs-acme/specs");
  });

  test("only a specification folder can be added to", async () => {
    const said = async (existing: unknown) => {
      const res = await call("POST", "/api/extract/repo", { codeDir: code, existing, folders: chosen });
      return [res.status, res.body.error];
    };
    expect(await said(other)).toEqual([400, `${other} is not a specification folder — it has no .specdriven and specs folders`]);
    expect(await said(join(root, "work", "nowhere"))).toEqual([404, `There is no folder at ${join(root, "work", "nowhere")}`]);
    expect(await said("specs-acme")).toEqual([400, "The specification folder must be an absolute path or a GitHub url"]);
    expect(await said("  ")).toEqual([400, "Name the specification folder to add to"]);
    expect(await said(code)).toEqual([400, "That is the code project's own folder"]);
    expect(await said("https://gitlab.example.com/a/b/c/d")).toMatchObject([400, expect.stringContaining("Unsupported data repo URL")]);
  });

  test("the analysis names the specification folder a project already has", async () => {
    expect((await call("POST", "/api/extract/analyse", { codeDir: code })).body.existing).toBeNull();
    // By the project's specs link.
    await symlink("../specs-acme/specs", join(code, "specs"));
    expect((await call("POST", "/api/extract/analyse", { codeDir: code })).body.existing).toBe(specs);
    await rm(join(code, "specs"));
    // By a folder of the suggested name beside it.
    await mkdir(join(root, "work", "specs-shop", ".specdriven"), { recursive: true });
    await mkdir(join(root, "work", "specs-shop", "specs"), { recursive: true });
    expect((await call("POST", "/api/extract/analyse", { codeDir: code })).body.existing).toBe(join(root, "work", "specs-shop"));
  });

  test("a specs link that leads nowhere useful names no specification folder", async () => {
    expect(await existingSpecsFor(code)).toBeNull();
    // Into a folder that is not a specification folder.
    await mkdir(join(other, "specs"), { recursive: true });
    await symlink("../other/specs", join(code, "specs"));
    expect(await existingSpecsFor(code)).toBeNull();
    await rm(join(code, "specs"));
    // To a specification folder itself, not its specs folder.
    await symlink("../specs-acme", join(code, "specs"));
    expect(await existingSpecsFor(code)).toBeNull();
    await rm(join(code, "specs"));
    // A real folder called specs in the project is the project's own.
    await mkdir(join(code, "specs"));
    expect(await existingSpecsFor(code)).toBeNull();
    await rm(join(code, "specs"), { recursive: true });
    // The link as written decides, an absolute one too.
    await symlink(join(specs, "specs"), join(code, "specs"));
    expect(await existingSpecsFor(code)).toBe(specs);
  });

  test("the folder is named by its path, and opens by that path", async () => {
    expect(await resolveSpecsFolder(` ${specs}/ `, code, join(root, "app"))).toEqual({ dir: specs, open: specs });
    const refusal = (input: unknown) =>
      resolveSpecsFolder(input, code, join(root, "app")).then(
        () => null,
        (e: ExtractError) => [e.status, e.message],
      );
    expect(await refusal(join(specs, "README.md"))).toEqual([400, `${join(specs, "README.md")} is not a folder`]);
    expect(await refusal(42)).toEqual([400, "Name the specification folder to add to"]);
    expect(await refusal("~/no-such-folder-for-specdriven-tests")).toEqual([
      404,
      `There is no folder at ${join(process.env.HOME ?? "", "no-such-folder-for-specdriven-tests")}`,
    ]);
  });

  test("a specs link that cannot be made is said, and the folders are added all the same", async () => {
    // The project has a real folder called specs: it is left as it is.
    await put(code, "specs/notes.md", "ours\n");
    const added = await addToSpecsFolder({ codeDir: code, dir: specs, folders: chosen, link: true });
    expect(added).toMatchObject({ dir: specs, existing: true, folders: ["specs/api", "specs/web"], github: null });
    expect(added.linkProblem).toContain("specs");
    expect(await readFile(join(code, "specs/notes.md"), "utf8")).toBe("ours\n");
    expect(await readFile(join(specs, "specs/web/display-name.txt"), "utf8")).toBe("Storefront\n");
    // Nothing chosen: only the project is added to the folder's code repositories.
    const again = await addToSpecsFolder({ codeDir: other, dir: specs, folders: [] });
    expect(again).toEqual({ dir: specs, existing: true, folders: [], github: null });
    expect((await readProjectSettings(specs)).codeRepos.map((r) => r.path)).toEqual(["../other", "../shop"]);
  });
});

describe("the chosen folders", () => {
  const known = new Set(["packages/api", "packages/web", "."]);
  const refusal = (input: unknown) => {
    try {
      chosenFolders(input, known);
      return null;
    } catch (e) {
      return e instanceof ExtractError ? e.message : String(e);
    }
  };

  test("are slug paths, each named once", () => {
    expect(refusal([])).toBe("Choose at least one folder");
    expect(refusal([{ folder: "Web UI", name: "x", modules: [] }])).toBe("Not a folder path: Web UI");
    expect(refusal([{ folder: "a/../b", name: "x", modules: [] }])).toBe("Not a folder path: a/../b");
    expect(refusal([{ folder: "a//b", name: "x", modules: [] }])).toBe("Not a folder path: a//b");
    expect(refusal([{ folder: "a", name: "x", modules: [] }, { folder: "a", name: "y", modules: [] }])).toBe(
      "Two folders share the path a",
    );
  });

  test("draw on each analysed folder at most once", () => {
    expect(
      refusal([
        { folder: "a", name: "A", modules: ["packages/api"], draft: true },
        { folder: "b", name: "B", modules: ["packages/api"], draft: true },
      ]),
    ).toBe("packages/api is in two folders");
  });

  test("a folder with no code of its own is made but not drafted", () => {
    expect(
      chosenFolders(
        [
          { folder: "group", name: "  Group\nname ", modules: [], draft: true },
          { folder: "group/api", name: "API", modules: ["packages/api", "."], draft: true },
        ],
        known,
      ),
    ).toEqual([
      { folder: "group", name: "Group name", modules: [], draft: false },
      { folder: "group/api", name: "API", modules: ["packages/api", "."], draft: true },
    ]);
  });
});

describe("the specification folder's place", () => {
  test("it is named after the project and goes beside it, wherever the project is", async () => {
    expect(suggestedSpecsName(code)).toBe("specs-shop");
    expect(suggestedSpecsName("/work/My Project")).toBe("specs-My-Project");
    expect(await specsTarget(code, "specs-shop")).toEqual({ dir: join(root, "work", "specs-shop"), state: "free" });
    // An empty folder, or one holding only what Finder leaves, is free; a file there is not.
    await mkdir(join(root, "work", "specs-empty"));
    await writeFile(join(root, "work", "specs-empty", ".DS_Store"), "");
    expect((await specsTarget(code, "specs-empty")).state).toBe("free");
    await writeFile(join(root, "work", "specs-file"), "");
    expect((await specsTarget(code, "specs-file")).state).toBe("taken");
  });

  test("a code project is named by an absolute path, a leading tilde being the home folder", async () => {
    expect(await resolveCodeProject(`${code}/`)).toBe(code);
    const refusal = async (input: unknown) => resolveCodeProject(input).then(() => null, (e: ExtractError) => [e.status, e.message]);
    expect(await refusal("~/no-such-folder-for-specdriven-tests")).toEqual([
      404,
      `There is no folder at ${join(process.env.HOME ?? "", "no-such-folder-for-specdriven-tests")}`,
    ]);
    expect(await refusal(join(code, "package.json"))).toEqual([400, `${join(code, "package.json")} is not a folder`]);
    expect(await refusal(42)).toEqual([400, "Choose the code project's folder"]);
  });

  test("the code project's own folder cannot be its specification folder", async () => {
    const made = createSpecsFolder({ codeDir: code, name: "shop", folders: [] });
    await expect(made).rejects.toThrow("That is the code project's own folder");
  });
});

describe("what a request says of GitHub", () => {
  test("no repository unless asked for; a private one unless it says otherwise", () => {
    expect(publishTo(null)).toBeNull();
    expect(publishTo(undefined)).toBeNull();
    expect(publishTo({ host: "github.com", owner: "acme" })).toEqual({ host: "github.com", owner: "acme", private: true });
    expect(publishTo({ host: " ghe.acme.com ", owner: " acme-inc ", private: false })).toEqual({
      host: "ghe.acme.com",
      owner: "acme-inc",
      private: false,
    });
  });
});

describe("making several spec folders at once", () => {
  test("folders already there keep their names, and an order by name writes no order file", async () => {
    const data = join(root, "data");
    await put(data, "specs/billing/display-name.txt", "Billing & Invoices\n");
    const made = await createSpecFolders(data, [
      { path: "billing", name: "Billing" },
      { path: "specs/orders", name: "Orders!" },
      { path: "orders", name: "again" },
    ]);
    expect(made).toEqual({ folders: ["specs/billing", "specs/orders"], files: ["specs/orders/display-name.txt"] });
    expect(await readFile(join(data, "specs/billing/display-name.txt"), "utf8")).toBe("Billing & Invoices\n");
    expect(await readFile(join(data, "specs/orders/display-name.txt"), "utf8")).toBe("Orders!\n");
    expect((await readdir(join(data, "specs"))).sort()).toEqual(["billing", "orders"]);
  });
});

describe("the routes", () => {
  test("every one refuses a hosted worker, and the ones on an open folder go through it", () => {
    const hosted: string[] = [];
    const onFolder: string[] = [];
    const routes = extractRoutes({
      unlessHosted: (handler) => {
        hosted.push("x");
        return handler;
      },
      withDataDir: () => {
        onFolder.push("x");
        return () => new Response("{}");
      },
    });
    expect(routes.map(([method, path]) => `${method} ${path}`)).toEqual([
      "POST /api/extract/analyse",
      "POST /api/extract/refine",
      "GET /api/extract/refine/:id",
      "DELETE /api/extract/refine/:id",
      "POST /api/extract/repo",
      "POST /api/extract/publish",
      "GET /api/extract/github",
      "POST /api/extract/draft/cancel",
      "POST /api/extract/draft/retry",
      "POST /api/extract/draft",
      "GET /api/extract/draft",
      "DELETE /api/extract/draft",
      "GET /api/extract/tests",
      "POST /api/extract/tests",
    ]);
    expect(hosted).toHaveLength(routes.length);
    expect(onFolder).toHaveLength(9);
  });

  test("the desktop app's menu and the page agree on the event that starts the dialog", () => {
    expect(EXTRACT_SPECS_EVENT).toBe("specdriven:extract-specs");
  });
});

// specs/app/extract-specs-from-code.feature.md "Target specs repo is not
// initialized": a fresh repository named as the existing folder is asked
// about, not refused, and set up once the user agrees.
describe("a fresh repository named as the existing folder", () => {
  let fresh: string;
  let remote: string;
  const chosen = [
    { folder: "api", name: "API", modules: ["packages/api"], draft: true },
    { folder: "web", name: "Storefront", modules: ["packages/web"], draft: true },
  ];
  const log = async (dir: string, ref = "HEAD") =>
    (await git(dir, "log", "--format=%s", ref)).stdout.toString().split("\n").filter(Boolean);

  beforeEach(async () => {
    setGitEngine("cli");
    // An empty repository, cloned: what a repository just made on GitHub is before anyone pushes.
    remote = join(root, "remote", "specs-jitter.git");
    await mkdir(remote, { recursive: true });
    await git(remote, "init", "--bare", "-b", "main");
    fresh = join(root, "work", "specs-jitter");
    await git(join(root, "work"), "clone", remote, fresh);
    // Whoever commits there: the user's own git identity, in a real clone.
    await git(fresh, "config", "user.name", "Ada");
    await git(fresh, "config", "user.email", "ada@example.com");
    await git(fresh, "config", "commit.gpgsign", "false");
  });
  afterEach(() => setGitEngine(null));

  test("an empty repository is asked about, and nothing is written until the user agrees", async () => {
    const res = await call("POST", "/api/extract/repo", { codeDir: code, existing: fresh, folders: chosen });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: `${fresh} is not set up as a specification folder yet`, initialize: true, dir: fresh });
    expect(await readdir(fresh)).toEqual([".git"]);
    expect(await resolveSpecsFolder(fresh, code, root, true)).toEqual({ dir: fresh, open: fresh, setUp: true });
  });

  test("once agreed, it is set up, the folders added, and all of it pushed as one commit", async () => {
    const res = await call("POST", "/api/extract/repo", { codeDir: code, existing: fresh, folders: chosen, initialize: true });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ dir: fresh, existing: true, setUp: true, folders: ["specs/api", "specs/web"], github: null });
    expect((await readDataFormat(fresh))?.format).toBeGreaterThan(1);
    expect(await readFile(join(fresh, "specs/web/display-name.txt"), "utf8")).toBe("Storefront\n");
    expect(await readFile(join(fresh, "README.md"), "utf8")).toStartWith("# specs-jitter\n");
    expect((await readProjectSettings(fresh)).codeRepo).toBe(code);
    // The empty repository's first push starts its main branch.
    expect(await log(remote, "main")).toEqual(["Set up specifications for shop"]);
    const files = (await git(remote, "ls-tree", "-r", "--name-only", "main")).stdout.toString();
    for (const file of ["README.md", "project-settings.yaml", "specs/api/display-name.txt", ".specdriven/data-format.yaml"]) {
      expect(files).toContain(file);
    }
    // Set up, it is an ordinary specification folder: a second add only adds.
    const again = await call("POST", "/api/extract/repo", { codeDir: code, existing: fresh, folders: [{ ...chosen[0]!, folder: "more" }] });
    expect(again.status).toBe(201);
    expect(again.body.setUp).toBeUndefined();
  });

  test("a repository holding only what GitHub starts one with keeps its README", async () => {
    const started = join(root, "work", "specs-started");
    await put(started, "README.md", "# specs-started\n\nOurs.\n");
    await put(started, "LICENSE", "MIT\n");
    await put(started, ".gitignore", "*.log\n");
    expect((await specsTarget(code, "specs-started")).state).toBe("unset");
    expect((await call("POST", "/api/extract/repo", { codeDir: code, existing: started, folders: chosen })).body.initialize).toBe(true);
    const res = await call("POST", "/api/extract/repo", { codeDir: code, existing: started, folders: chosen, initialize: true });
    expect(res.status).toBe(201);
    expect(await readFile(join(started, "README.md"), "utf8")).toBe("# specs-started\n\nOurs.\n");
    expect((await readdir(join(started, "specs"))).sort()).toEqual(["api", "web"]);
  });

  test("a folder holding anything else, or a code repository's specs link, is still refused", async () => {
    await put(fresh, "notes.txt", "mine\n");
    const notes = await call("POST", "/api/extract/repo", { codeDir: code, existing: fresh, folders: chosen, initialize: true });
    expect(notes.status).toBe(400);
    expect(notes.body.error).toBe(`${fresh} is not a specification folder — it has no .specdriven and specs folders`);
    expect((await specsTarget(code, "specs-jitter")).state).toBe("taken");
    await rm(join(fresh, "notes.txt"));
    await symlink(join(root, "elsewhere"), join(fresh, "specs"));
    expect((await call("POST", "/api/extract/repo", { codeDir: code, existing: fresh, folders: chosen, initialize: true })).status).toBe(400);
  });

  test("a new folder is not made over it; the answer offers to add to it instead", async () => {
    expect(await specsTarget(code, "specs-jitter")).toEqual({ dir: fresh, state: "unset" });
    const res = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-jitter", folders: chosen, github: null });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ existing: "unset", dir: fresh });
    expect(await readdir(fresh)).toEqual([".git"]);
  });
});

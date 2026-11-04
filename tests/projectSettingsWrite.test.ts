// The project settings file as the app writes it (src/server/members.ts;
// specs/app/project-settings.feature.md): made empty for every data folder
// the reload tick opens, the code repos listed with their default, the
// members, and the older single `code-repo` key read and migrated.
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_SETTINGS_FILE,
  ensureProjectSettings,
  normalizeCodeRepos,
  readProjectSettings,
  storedCodeRepoPath,
  updateProjectSettings,
  writeAuthorsInMarkdown,
  writeCodeRepos,
  writeMembers,
} from "../src/server/members";
import { syncDataDir } from "../src/server/reload";
import { twoClones } from "./helpers/fixtures";

let root: string;
let data: string;
const file = () => join(data, PROJECT_SETTINGS_FILE);
const raw = async () => JSON.parse(await readFile(file(), "utf8"));
const realDemo = process.env.DEMO_MODE;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-project-settings-"));
  data = join(root, "acme-specs");
  await mkdir(data, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (realDemo === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = realDemo;
});

describe("reading the code repos", () => {
  test("code-repos lists several, the first the default unless default-code-repo says otherwise", () => {
    const repos = normalizeCodeRepos({ "code-repos": ["../app", "/srv/mobile/", " ", 7, "../app"] }, data);
    expect(repos).toEqual([
      { path: "../app", dir: join(root, "app"), isDefault: true },
      { path: "/srv/mobile/", dir: "/srv/mobile", isDefault: false },
    ]);
    const picked = normalizeCodeRepos(
      { "code-repos": ["../app", "../mobile"], "default-code-repo": "../mobile" },
      data,
    );
    expect(picked.map((r) => [r.path, r.isDefault])).toEqual([
      ["../app", false],
      ["../mobile", true],
    ]);
    // The default may name the folder by another spelling of the same path.
    const byDir = normalizeCodeRepos(
      { codeRepos: ["../app", "../mobile"], defaultCodeRepo: join(root, "mobile") },
      data,
    );
    expect(byDir.find((r) => r.isDefault)?.path).toBe("../mobile");
    // One that names none of them falls back to the first.
    const stray = normalizeCodeRepos({ "code-repos": ["../app"], "default-code-repo": "../nowhere" }, data);
    expect(stray[0]!.isDefault).toBe(true);
  });

  test("the older single code-repo key reads as a list of one", async () => {
    await writeFile(file(), JSON.stringify({ "code-repo": "../app" }));
    const settings = await readProjectSettings(data);
    expect(settings.codeRepos).toEqual([{ path: "../app", dir: join(root, "app"), isDefault: true }]);
    expect(settings.defaultCodeRepo).toBe("../app");
    expect(settings.codeRepo).toBe(join(root, "app"));
    // The list wins over the single key when both are there.
    expect(normalizeCodeRepos({ "code-repo": "../old", "code-repos": ["../new"] }, data).map((r) => r.path)).toEqual([
      "../new",
    ]);
    expect(normalizeCodeRepos({ "code-repos": [] }, data)).toEqual([]);
  });
});

describe("ensureProjectSettings", () => {
  test("makes the empty settings once and never touches a file that is there", async () => {
    expect(await ensureProjectSettings(data)).toBe(true);
    expect(await raw()).toEqual({ members: [], "code-repos": [] });
    expect(await ensureProjectSettings(data)).toBe(false);

    await writeFile(file(), "{ not json");
    expect(await ensureProjectSettings(data)).toBe(false);
    expect(await readFile(file(), "utf8")).toBe("{ not json");
  });

  test("the reload tick makes it for a data folder that has none, but not in the demo", async () => {
    const repos = await twoClones(join(root, "clones"));
    // The demo first, before any clone has pushed the file for the other to pull.
    process.env.DEMO_MODE = "1";
    await syncDataDir(repos.b);
    expect(await readFile(join(repos.b, PROJECT_SETTINGS_FILE), "utf8").catch(() => null)).toBeNull();

    delete process.env.DEMO_MODE;
    await syncDataDir(repos.a);
    expect(JSON.parse(await readFile(join(repos.a, PROJECT_SETTINGS_FILE), "utf8"))).toEqual({
      members: [],
      "code-repos": [],
    });
    // Pushed with the tick, so the teammate's next pull brings it.
    await syncDataDir(repos.b);
    expect(await readFile(join(repos.b, PROJECT_SETTINGS_FILE), "utf8").catch(() => null)).not.toBeNull();
  });
});

describe("writing", () => {
  test("code repos are stored relative when beside the data repo, the default only when not first", async () => {
    await writeFile(file(), JSON.stringify({ members: ["Ada"], "code-repo": "../app" }));
    expect(await writeCodeRepos(data, [join(root, "app"), "../mobile", "/srv/elsewhere", "../app"], "../mobile")).toBe(
      true,
    );
    expect(await raw()).toEqual({
      members: ["Ada"],
      "code-repos": ["../app", "../mobile", "/srv/elsewhere"],
      "default-code-repo": "../mobile",
    });
    // The default named by its absolute folder, and first: the key goes.
    await writeCodeRepos(data, ["../app", "../mobile"], join(root, "app"));
    expect(await raw()).toEqual({ members: ["Ada"], "code-repos": ["../app", "../mobile"] });
    // Nothing changed: no write.
    expect(await writeCodeRepos(data, ["../app", "../mobile"], null)).toBe(false);
    // A default that is not in the list is ignored.
    await writeCodeRepos(data, ["../app"], "../nowhere");
    expect(await raw()).toEqual({ members: ["Ada"], "code-repos": ["../app"] });
  });

  test("a sibling path, a nested one and a stranger's are stored as the file should hold them", () => {
    expect(storedCodeRepoPath(join(root, "app"), data)).toBe("../app");
    expect(storedCodeRepoPath(join(root, "team", "app"), data)).toBe("../team/app");
    expect(storedCodeRepoPath("/srv/app", data)).toBe("/srv/app");
    expect(storedCodeRepoPath(" ../typed ", data)).toBe("../typed");
    expect(storedCodeRepoPath(root, data)).toBe(root);
  });

  test("members are written as objects, in order, without duplicates", async () => {
    expect(await writeMembers(data, ["Ada", { name: "Grace", email: "g@acme.example" }, "ada", ""])).toBe(true);
    expect(await raw()).toEqual({ members: [{ name: "Ada" }, { name: "Grace", email: "g@acme.example" }] });
    expect((await readProjectSettings(data)).members).toEqual([{ name: "Ada" }, { name: "Grace", email: "g@acme.example" }]);
  });

  test("a file that does not parse is refused rather than overwritten", async () => {
    await writeFile(file(), "{ not json");
    await expect(writeCodeRepos(data, ["../app"], null)).rejects.toThrow("not valid JSON");
    await expect(writeMembers(data, ["Ada"])).rejects.toThrow("not valid JSON");
    await writeFile(file(), "42");
    await expect(updateProjectSettings(data, () => {})).rejects.toThrow("JSON object");
    expect(await readFile(file(), "utf8")).toBe("42");
  });

  test("a bare member list becomes an object, and the authorship switch keeps the other keys", async () => {
    await writeFile(file(), JSON.stringify(["Ada"]));
    await writeCodeRepos(data, ["../app"], null);
    expect(await raw()).toEqual({ members: ["Ada"], "code-repos": ["../app"] });
    await writeAuthorsInMarkdown(data, true);
    expect(await raw()).toEqual({ members: ["Ada"], "code-repos": ["../app"], "authors-in-markdown": true });
  });
});

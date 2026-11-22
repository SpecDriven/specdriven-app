// The project settings file as the app writes it (src/server/members.ts;
// specs/app/project-settings.feature.md): made empty for every data folder
// the reload tick opens, the code repos listed with their default, the
// members, the older single `code-repo` key read and migrated, and a
// project-settings.json from before YAML converted.
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  LEGACY_PROJECT_SETTINGS_FILE,
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
import { git, twoClones } from "./helpers/fixtures";

let root: string;
let data: string;
const file = () => join(data, PROJECT_SETTINGS_FILE);
const legacy = () => join(data, LEGACY_PROJECT_SETTINGS_FILE);
const raw = async () => parse(await readFile(file(), "utf8"));
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
    expect(await ensureProjectSettings(data)).toBe("created");
    expect(await readFile(file(), "utf8")).toBe("members: []\ncode-repos: []\n");
    expect(await ensureProjectSettings(data)).toBeNull();

    await writeFile(file(), "{ not yaml");
    expect(await ensureProjectSettings(data)).toBeNull();
    expect(await readFile(file(), "utf8")).toBe("{ not yaml");
  });

  test("a project-settings.json from before YAML is converted to the same settings, and the JSON file removed", async () => {
    const settings = {
      members: [{ name: "Ada", email: "ada@acme.example" }, "Grace"],
      "code-repos": ["../app", "../mobile"],
      "default-code-repo": "../mobile",
      "authors-in-markdown": true,
      "a-key-the-app-does-not-know": { kept: "true" },
    };
    await writeFile(legacy(), JSON.stringify(settings, null, 2));
    // Read as it is until it is converted.
    expect((await readProjectSettings(data)).defaultCodeRepo).toBe("../mobile");
    expect(await ensureProjectSettings(data)).toBe("converted");
    expect(existsSync(legacy())).toBe(false);
    expect(await raw()).toEqual(settings);
    expect(await readFile(file(), "utf8")).toContain("default-code-repo: ../mobile\n");
    expect(await ensureProjectSettings(data)).toBeNull();
  });

  test("a JSON file that does not parse is left for someone to fix, and a stray one beside the YAML is not read", async () => {
    await writeFile(legacy(), "{ not json");
    expect(await ensureProjectSettings(data)).toBeNull();
    expect(await readFile(legacy(), "utf8")).toBe("{ not json");
    expect(existsSync(file())).toBe(false);
    await expect(writeMembers(data, ["Ada"])).rejects.toThrow("project-settings.json is not valid JSON");

    await writeFile(legacy(), JSON.stringify({ members: ["Grace"] }));
    await writeFile(file(), "members:\n  - Ada\n");
    expect(await ensureProjectSettings(data)).toBeNull();
    expect((await readProjectSettings(data)).members).toEqual([{ name: "Ada" }]);
    expect(existsSync(legacy())).toBe(true);
  });

  test("a save through the app converts a JSON file the tick has not", async () => {
    await writeFile(legacy(), JSON.stringify({ members: ["Ada"], "code-repo": "../app" }));
    expect(await writeAuthorsInMarkdown(data, true)).toBe(true);
    expect(existsSync(legacy())).toBe(false);
    expect(await raw()).toEqual({ members: ["Ada"], "code-repo": "../app", "authors-in-markdown": true });
  });

  test("the reload tick converts a teammate's project-settings.json and pushes it", async () => {
    const repos = await twoClones(join(root, "clones"));
    await writeFile(join(repos.a, LEGACY_PROJECT_SETTINGS_FILE), JSON.stringify({ members: ["Ada"], "code-repos": ["../app"] }));
    await git(repos.a, "add", "-A");
    await git(repos.a, "commit", "-qm", "settings from an older app");
    await git(repos.a, "push", "-q");

    await syncDataDir(repos.b);
    expect(existsSync(join(repos.b, LEGACY_PROJECT_SETTINGS_FILE))).toBe(false);
    expect(parse(await readFile(join(repos.b, PROJECT_SETTINGS_FILE), "utf8"))).toEqual({
      members: ["Ada"],
      "code-repos": ["../app"],
    });
    const subject = (await git(repos.b, "log", "--format=%s%n%b")).stdout.toString();
    expect(subject).toContain("Convert project settings to YAML");
    expect(subject).not.toContain("Delete project settings");

    await syncDataDir(repos.a);
    expect(existsSync(join(repos.a, LEGACY_PROJECT_SETTINGS_FILE))).toBe(false);
    expect((await readProjectSettings(repos.a)).members).toEqual([{ name: "Ada" }]);
  });

  test("the reload tick makes it for a data folder that has none, but not in the demo", async () => {
    const repos = await twoClones(join(root, "clones"));
    // The demo first, before any clone has pushed the file for the other to pull.
    process.env.DEMO_MODE = "1";
    await syncDataDir(repos.b);
    expect(await readFile(join(repos.b, PROJECT_SETTINGS_FILE), "utf8").catch(() => null)).toBeNull();

    delete process.env.DEMO_MODE;
    await syncDataDir(repos.a);
    expect(parse(await readFile(join(repos.a, PROJECT_SETTINGS_FILE), "utf8"))).toEqual({
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
    await writeFile(file(), "{ not yaml");
    await expect(writeCodeRepos(data, ["../app"], null)).rejects.toThrow("not valid YAML");
    await expect(writeMembers(data, ["Ada"])).rejects.toThrow("not valid YAML");
    await writeFile(file(), "42");
    await expect(updateProjectSettings(data, () => {})).rejects.toThrow("YAML object");
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

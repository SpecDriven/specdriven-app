// "View settings file…" (specs/app/user-info-settings.feature.md "view the
// settings file"): GET /api/settings-file reads ~/.specdriven/settings.json
// as written — always the home file — through readSettingsFileView.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchApi } from "../src/server/api";
import { readSettingsFileView } from "../src/server/state";

let home: string;
let root: string;
const saved = {
  home: process.env.SPECDRIVEN_HOME,
  homeOnly: process.env.SPECDRIVEN_HOME_SETTINGS,
  hosted: process.env.SPECDRIVEN_HOSTED,
};
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "specdriven-settings-home-"));
  root = await mkdtemp(join(tmpdir(), "specdriven-settings-root-"));
  process.env.SPECDRIVEN_HOME = home;
  delete process.env.SPECDRIVEN_HOME_SETTINGS;
  delete process.env.SPECDRIVEN_HOSTED;
});

afterEach(async () => {
  restore("SPECDRIVEN_HOME", saved.home);
  restore("SPECDRIVEN_HOME_SETTINGS", saved.homeOnly);
  restore("SPECDRIVEN_HOSTED", saved.hosted);
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("readSettingsFileView", () => {
  test("reads the home settings file as written, without upgrading it", async () => {
    // A version-0 file: readState would upgrade recentDataRepos away.
    const raw = { recentDataRepos: ["/a/specs"], featureFlags: true };
    await writeFile(join(home, "settings.json"), JSON.stringify(raw));
    const view = await readSettingsFileView(root);
    expect(view.path).toBe(join(home, "settings.json"));
    expect(view.exists).toBe(true);
    expect(view.settings).toEqual(raw);
    expect(view.activePath).toBeUndefined();
  });

  test("shows the home file even when a project settings file is the one in effect", async () => {
    await writeFile(join(home, "settings.json"), JSON.stringify({ codeGen: false }));
    await mkdir(join(root, ".specdriven"));
    await writeFile(join(root, ".specdriven", "settings.json"), JSON.stringify({ codeGen: true }));
    const view = await readSettingsFileView(root);
    expect(view.path).toBe(join(home, "settings.json"));
    expect(view.settings).toEqual({ codeGen: false });
    expect(view.activePath).toBe(join(root, ".specdriven", "settings.json"));
  });

  test("with no home file it says so, and does not fall back to the project file", async () => {
    await mkdir(join(root, ".specdriven"));
    await writeFile(join(root, ".specdriven", "settings.json"), JSON.stringify({ codeGen: true }));
    const view = await readSettingsFileView(root);
    expect(view.exists).toBe(false);
    expect(view.settings).toEqual({});
  });

  test("a file that is not JSON is reported, not thrown", async () => {
    await writeFile(join(home, "settings.json"), "{ not json");
    const view = await readSettingsFileView(root);
    expect(view.exists).toBe(true);
    expect(view.error).toBe("The file is not valid JSON.");
  });
});

describe("GET /api/settings-file", () => {
  test("is a GET route", () => {
    expect(matchApi("GET", "/api/settings-file")).not.toBeNull();
    expect(matchApi("PUT", "/api/settings-file")).toBeNull();
  });

  test("answers with the home file", async () => {
    await writeFile(join(home, "settings.json"), JSON.stringify({ ghostty: true }));
    const m = matchApi("GET", "/api/settings-file")!;
    const res = await m.handler(new Request("http://x/api/settings-file"), m.params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(join(home, "settings.json"));
    expect(body.settings).toEqual({ ghostty: true });
  });

  test("the hosted app refuses it", async () => {
    process.env.SPECDRIVEN_HOSTED = "1";
    const m = matchApi("GET", "/api/settings-file")!;
    const res = await m.handler(new Request("http://x/api/settings-file"), m.params);
    expect(res.status).toBe(403);
  });
});

// Automates app-startup.md "App Starts with existing specs
// folder selected": with a data folder already configured, the app opens on
// the folder's README.md in an editor, and the editor's autosaves are plain
// local writes that the reload cron's sync commits and pushes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, matchApi, reloader } from "../src/server/api";
import { setGitEngine } from "../src/server/git";
import { readReadme, readmeFileName, writeReadme } from "../src/server/readme";
import { syncDataDir } from "../src/server/reload";
import { writeState } from "../src/server/state";
import { git, stopServers, twoClones } from "./helpers/fixtures";

let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-startup-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-startup-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  reloader.stop();
  stopServers();
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function getReadme(): Promise<Response> {
  return (await handleApi(new Request("http://localhost/api/readme")))!;
}

async function putReadme(body: unknown): Promise<Response> {
  return (await handleApi(
    new Request("http://localhost/api/readme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ))!;
}

test("the README routes match GET and PUT only", () => {
  expect(matchApi("GET", "/api/readme")).not.toBeNull();
  expect(matchApi("PUT", "/api/readme")).not.toBeNull();
  expect(matchApi("POST", "/api/readme")).toBeNull();
  expect(matchApi("DELETE", "/api/readme")).toBeNull();
});

test("the configured data folder's README.md is served to the home editor", async () => {
  const data = join(root, "data");
  await Bun.write(join(data, "README.md"), "# My specs\n\nRead me.\n");
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);

  const res = await getReadme();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ content: "# My specs\n\nRead me.\n", exists: true });
});

test("a data folder without a README opens on an empty editor", async () => {
  const data = join(root, "data");
  await Bun.write(join(data, "specs/seed.feature.md"), "# Seed\n");
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);

  const res = await getReadme();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ content: "", exists: false });
});

test("without a data folder there is no README to open", async () => {
  await writeState({ reloadFrequencySeconds: 0 }, root);
  expect((await getReadme()).status).toBe(409);
  expect((await putReadme({ content: "x" })).status).toBe(409);
});

test("an autosave writes the README locally, creating it when missing", async () => {
  const data = join(root, "data");
  await Bun.write(join(data, "specs/seed.feature.md"), "# Seed\n");
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);

  const created = await putReadme({ content: "# Fresh\n" });
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({ content: "# Fresh\n", exists: true });
  expect(await Bun.file(join(data, "README.md")).text()).toBe("# Fresh\n");

  // The next tick rewrites the same file — never a second one.
  expect((await putReadme({ content: "# Fresh\n\nMore.\n" })).status).toBe(200);
  expect(await Bun.file(join(data, "README.md")).text()).toBe("# Fresh\n\nMore.\n");
  expect((await readdir(data)).filter((f) => /readme/i.test(f))).toEqual(["README.md"]);
  expect(await (await getReadme()).json()).toEqual({ content: "# Fresh\n\nMore.\n", exists: true });
});

// An edit made to README.md on disk is only shown on the next reload tick,
// and a dirty home editor skips that tick — so an autosave must fold the
// disk edit in rather than write over it (the feature save's foldDiskEdit).
describe("a README save racing an unsynced disk edit", () => {
  const seed = "# Specs\n\nintro\n";
  let data: string;

  beforeEach(async () => {
    data = join(root, "data");
    await Bun.write(join(data, "README.md"), seed);
    await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);
  });

  test("keeps the disk edit alongside the save", async () => {
    await Bun.write(join(data, "README.md"), "# Specs\n\nintro\n\nfrom disk\n");
    const res = await putReadme({ from: seed, content: "# Specs\n\nintro edited here\n" });
    expect(res.status).toBe(200);
    const written = (await res.json()) as { content: string };
    expect(written.content).toContain("from disk");
    expect(written.content).toContain("intro edited here");
    expect(await Bun.file(join(data, "README.md")).text()).toBe(written.content);
  });

  test("an editor that already holds the disk edit saves it once", async () => {
    const onDisk = "# Specs\n\nintro\n\nfrom disk\n";
    await Bun.write(join(data, "README.md"), onDisk);
    const res = await putReadme({ from: seed, content: onDisk });
    expect(res.status).toBe(200);
    expect(await Bun.file(join(data, "README.md")).text()).toBe(onDisk);
  });

  test("a save with no disk edit writes the buffer", async () => {
    const res = await putReadme({ from: seed, content: "# Specs\n\nintro\n\nmore\n" });
    expect(res.status).toBe(200);
    expect(await Bun.file(join(data, "README.md")).text()).toBe("# Specs\n\nintro\n\nmore\n");
  });

  // The user typed on while the folding save was away, so the editor never
  // showed the fold. Its next save names what it sent as `from` — not what
  // came back — and the disk edit is folded in again rather than lost.
  test("a buffer that moved on during the fold keeps the disk edit", async () => {
    await Bun.write(join(data, "README.md"), "# Specs\n\nintro\n\nfrom disk\n");
    const first = "# Specs\n\nintro edited here\n";
    expect((await putReadme({ from: seed, content: first })).status).toBe(200);
    const res = await putReadme({ from: first, content: `${first}\nand typed on\n` });
    expect(res.status).toBe(200);
    const onDisk = await Bun.file(join(data, "README.md")).text();
    expect(onDisk).toContain("from disk");
    expect(onDisk).toContain("intro edited here");
    expect(onDisk).toContain("and typed on");
  });

  test("a README gone from disk is recreated as the editor holds it", async () => {
    await rm(join(data, "README.md"));
    const content = "# Specs\n\nintro edited here\n";
    const res = await putReadme({ from: seed, content });
    expect(res.status).toBe(200);
    expect(await Bun.file(join(data, "README.md")).text()).toBe(content);
  });

  test("a save without from replaces the file outright", async () => {
    await Bun.write(join(data, "README.md"), "# Specs\n\nintro\n\nfrom disk\n");
    const res = await putReadme({ content: "# Replaced\n" });
    expect(res.status).toBe(200);
    expect(await Bun.file(join(data, "README.md")).text()).toBe("# Replaced\n");
  });
});

test("a save without content is refused", async () => {
  const data = join(root, "data");
  await Bun.write(join(data, "specs/seed.feature.md"), "# Seed\n");
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);

  expect((await putReadme({})).status).toBe(400);
  expect((await putReadme({ content: 42 })).status).toBe(400);
  expect(await Bun.file(join(data, "README.md")).exists()).toBe(false);
});

test("a repo's own spelling of the README is read and saved in place", async () => {
  const data = join(root, "data");
  await Bun.write(join(data, "readme.md"), "lower\n");

  expect(await readmeFileName(data)).toBe("readme.md");
  expect(await readReadme(data)).toEqual({ content: "lower\n", exists: true });
  await writeReadme(data, "still lower\n");
  expect(await Bun.file(join(data, "readme.md")).text()).toBe("still lower\n");
  expect((await readdir(data)).filter((f) => /readme/i.test(f))).toEqual(["readme.md"]);
});

test("README autosaves are committed and pushed by the sync tick", async () => {
  setGitEngine("cli");
  const { a, b } = await twoClones(root);
  await writeState({ dataRepo: b, reloadFrequencySeconds: 0 }, root);

  expect((await putReadme({ content: "# Shared specs\n" })).status).toBe(200);
  await syncDataDir(b);

  await git(a, "pull", "origin", "main");
  expect(await Bun.file(join(a, "README.md")).text()).toBe("# Shared specs\n");
});

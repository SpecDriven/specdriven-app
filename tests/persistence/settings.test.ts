// The settings file as an Effect service (src/server/persistence/Settings.ts),
// run with fixed home paths: which file is read and written, without a test
// touching process.env.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../src/server/persistence/Settings";
import { errorOf, exitOf, valueOf } from "../helpers/persistence";

let root: string; // a project root
let home: string; // stands in for ~/.specdriven

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "specdriven-settings-"));
  root = join(base, "project");
  home = join(base, "home");
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, Settings>, homeSettingsOnly = false) =>
  exitOf(effect, { appHome: home, homeSettingsOnly });

describe("Settings service", () => {
  test("no settings file anywhere reads as empty state and names no file", async () => {
    expect(valueOf(await run(Settings.use((s) => s.read(root))))).toEqual({});
    expect(valueOf(await run(Settings.use((s) => s.file(root))))).toBe(null);
  });

  test("a write with no file anywhere creates the project file, and a read finds it", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const settings = yield* Effect.service(Settings);
        yield* settings.write({ dataRepo: "/data/specs" }, root);
        return { state: yield* settings.read(root), file: yield* settings.file(root) };
      }),
    );
    const { state, file } = valueOf(exit);
    expect(state.dataRepo).toBe("/data/specs");
    expect(file).toBe(join(root, ".specdriven/settings.yaml"));
  });

  test("the home file is the fallback, and a write goes back to it", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "settings.yaml"), "dataRepo: /from/home\n");
    const exit = await run(
      Effect.gen(function* () {
        const settings = yield* Effect.service(Settings);
        const before = yield* settings.read(root);
        yield* settings.write({ ...before, dataRepo: "/changed" }, root);
        return { before, directory: yield* settings.directory(root) };
      }),
    );
    const { before, directory } = valueOf(exit);
    expect(before.dataRepo).toBe("/from/home");
    expect(directory).toBe(home);
    expect(await readFile(join(home, "settings.yaml"), "utf8")).toContain("/changed");
  });

  test("the project file wins over the home one", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "settings.yaml"), "dataRepo: /from/home\n");
    await mkdir(join(root, ".specdriven"), { recursive: true });
    await writeFile(join(root, ".specdriven/settings.yaml"), "dataRepo: /from/project\n");
    expect(valueOf(await run(Settings.use((s) => s.read(root)))).dataRepo).toBe("/from/project");
  });

  test("where the home file is the only one, the project file is not written", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const settings = yield* Effect.service(Settings);
        yield* settings.write({ dataRepo: "/desktop" }, root);
        return yield* settings.file(root);
      }),
      true,
    );
    expect(valueOf(exit)).toBe(join(home, "settings.yaml"));
    expect(await Bun.file(join(root, ".specdriven/settings.yaml")).exists()).toBe(false);
  });

  test("a settings file that does not parse is empty state, not a reason to read the home file", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "settings.yaml"), "dataRepo: /from/home\n");
    await mkdir(join(root, ".specdriven"), { recursive: true });
    await writeFile(join(root, ".specdriven/settings.yaml"), "{ not yaml");
    expect(valueOf(await run(Settings.use((s) => s.read(root))))).toEqual({});
  });

  test("a write that cannot reach its folder fails as a FileIoError, with no temp file left", async () => {
    // The project "root" is a plain file, so .specdriven cannot be made in it.
    const blocked = join(root, "not-a-folder");
    await writeFile(blocked, "");
    const exit = await run(Settings.use((s) => s.write({ dataRepo: "/x" }, blocked)));
    const error = errorOf(exit);
    expect(error?._tag).toBe("FileIoError");
    expect(error?.code).toBe("ENOTDIR");
  });

  test("a root whose package.json names this app is an app checkout, so the home file is the only one", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "specdriven" }));
    expect(valueOf(await run(Settings.use((s) => s.isAppCheckout(root))))).toBe(true);
    expect(valueOf(await run(Settings.use((s) => s.homeSettingsOnly(root))))).toBe(true);
    await writeFile(join(root, "package.json"), "{ not json");
    expect(valueOf(await run(Settings.use((s) => s.isAppCheckout(root))))).toBe(false);
  });

  test("the file view shows the home file as written and says when it is not a settings object", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "settings.yaml"), "- a list\n");
    const view = valueOf(await exitOf(Settings.use((s) => s.fileView(root)), { appHome: home, userHome: "/users/me" }));
    expect(view.path).toBe(join(home, "settings.yaml"));
    expect(view.home).toBe("/users/me");
    expect(view.exists).toBe(true);
    expect(view.error).toBe("The file does not hold a settings object.");
  });
});

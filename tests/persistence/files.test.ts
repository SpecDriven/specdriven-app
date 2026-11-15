// The storage core's file programs (src/server/persistence/Files.ts) and
// their Promise forms (src/server/fsx.ts): the same results and the same
// thrown errors as the node:fs/promises helpers they replaced.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { Effect, Exit, Option } from "effect";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryExists, fileExists, readTextFile, replaceTextFile, writeTextFile } from "../../src/server/fsx";
import * as Files from "../../src/server/persistence/Files";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-files-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run a file program on Node's file system and return how it ended. */
const exitOf = <A, E>(effect: Effect.Effect<A, E, Effect.Services<ReturnType<typeof Files.readBytes>>>) =>
  Effect.runPromiseExit(Effect.provide(effect, NodeFileSystem.layer));

describe("file programs", () => {
  test("a failed read is a FileIoError that names the errno code and keeps the exception", async () => {
    const exit = await exitOf(Files.readBytes(join(dir, "missing.bin")));
    expect(Exit.isFailure(exit)).toBe(true);
    const found = Option.getOrNull(Exit.findErrorOption(exit));
    expect(found?._tag).toBe("FileIoError");
    expect(found?.code).toBe("ENOENT");
    expect(found?.reason).toBe("NotFound");
    expect(found?.absent).toBe(true);
    expect((found?.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  test("readText is null for a missing path, a directory and a path under a file", async () => {
    await writeFile(join(dir, "plain.txt"), "x");
    for (const path of [join(dir, "missing.txt"), dir, join(dir, "plain.txt", "below.txt")]) {
      const exit = await exitOf(Files.readText(path));
      expect(Exit.isSuccess(exit) && exit.value).toBe(null);
    }
  });

  test("replaceText leaves no temp file behind when the rename fails", async () => {
    // A directory is in the way of the target, so the rename cannot succeed.
    await mkdir(join(dir, "settings.yaml", "inside"), { recursive: true });
    const exit = await exitOf(Files.replaceText(join(dir, "settings.yaml"), "a: 1\n"));
    expect(Exit.isFailure(exit)).toBe(true);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("fsx Promise helpers", () => {
  test("writeTextFile creates missing parent directories", async () => {
    const path = join(dir, "a/b/c.txt");
    await writeTextFile(path, "hello");
    expect(await readFile(path, "utf8")).toBe("hello");
  });

  test("readTextFile keeps a leading byte-order mark, as readFile with utf8 does", async () => {
    const path = join(dir, "bom.txt");
    await writeFile(path, "\uFEFFtext");
    expect(await readTextFile(path)).toBe("\uFEFFtext");
  });

  test("readTextFile is null for a missing path, a directory and a path under a file", async () => {
    await writeFile(join(dir, "plain.txt"), "x");
    expect(await readTextFile(join(dir, "missing.txt"))).toBe(null);
    expect(await readTextFile(dir)).toBe(null);
    expect(await readTextFile(join(dir, "plain.txt", "below.txt"))).toBe(null);
  });

  test.if(process.platform !== "win32" && process.getuid?.() !== 0)(
    "readTextFile rejects with the errno exception for an unreadable file",
    async () => {
      const path = join(dir, "locked.txt");
      await writeFile(path, "secret");
      await chmod(path, 0o000);
      const error = await readTextFile(path).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
      expect((error as { _tag?: string })._tag).toBeUndefined();
    },
  );

  test("replaceTextFile swaps the content in and leaves only the file", async () => {
    const path = join(dir, "nested/settings.yaml");
    await replaceTextFile(path, "a: 1\n");
    await replaceTextFile(path, "a: 2\n");
    expect(await readFile(path, "utf8")).toBe("a: 2\n");
    expect(await readdir(join(dir, "nested"))).toEqual(["settings.yaml"]);
  });

  test("fileExists and directoryExists tell a file from a directory from nothing", async () => {
    await writeFile(join(dir, "f"), "");
    expect(await fileExists(join(dir, "f"))).toBe(true);
    expect(await fileExists(dir)).toBe(false);
    expect(await fileExists(join(dir, "nope"))).toBe(false);
    expect(await directoryExists(dir)).toBe(true);
    expect(await directoryExists(join(dir, "f"))).toBe(false);
    expect(await directoryExists(join(dir, "nope"))).toBe(false);
  });
});

// The document store as an Effect service (src/server/persistence/DocStore.ts)
// and the contract its Promise forms keep (src/server/automerge/store.ts):
// failures are typed for an Effect caller and are the same thrown errors as
// ever for a Promise caller.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as A from "@automerge/automerge";
import { Effect } from "effect";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, type FeatureDoc } from "../../src/server/automerge/schema";
import {
  createFeatureDoc,
  docDir,
  loadFeatureDoc,
  loadRawDoc,
  newFeatureDoc,
  onDocSaved,
  saveFeatureDoc,
} from "../../src/server/automerge/store";
import { DataTooNewError, resetDataFormatFlags } from "../../src/server/dataFormat";
import { DocStore } from "../../src/server/persistence/DocStore";
import { errorOf, exitOf, valueOf } from "../helpers/persistence";

const FILE = "specs/login.feature.md";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-docstore-"));
});

afterEach(async () => {
  resetDataFormatFlags();
  await rm(root, { recursive: true, force: true });
});

function freshDoc(): A.Doc<FeatureDoc> {
  return newFeatureDoc({ name: "Login", description: "", specs: [] });
}

const run = <A, E>(effect: Effect.Effect<A, E, DocStore>) => exitOf(effect, { appHome: join(root, "home") });

describe("DocStore service", () => {
  test("create, save and load round-trip a document and its identity", async () => {
    const doc = freshDoc();
    const exit = await run(
      Effect.gen(function* () {
        const store = yield* Effect.service(DocStore);
        const created = yield* store.create(root, "features", FILE, doc);
        const edited = A.change(created.doc, (d) => {
          d.name = "Sign in";
        });
        yield* store.save(root, "features", FILE, edited, created.heads);
        return yield* store.load<FeatureDoc>(root, "features", FILE);
      }),
    );
    const loaded = valueOf(exit);
    expect(loaded?.doc.name).toBe("Sign in");
    expect(loaded?.docId).toBe(doc.id);
    expect(loaded?.skippedChunks).toEqual([]);
    const files = await readdir(docDir(root, FILE));
    expect(files.filter((f) => f.startsWith("changes-")).length).toBe(1);
  });

  test("a document with no chunks loads as null, not as a failure", async () => {
    const exit = await run(DocStore.use((store) => store.load(root, "features", FILE)));
    expect(valueOf(exit)).toBe(null);
  });

  test("an unreadable chunk is skipped and named, and the rest still loads", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const store = yield* Effect.service(DocStore);
        yield* store.create(root, "features", FILE, freshDoc());
        // Automerge quietly ignores bytes it cannot decode, so the unreadable
        // chunk is one the file system refuses: a directory with a chunk's name.
        yield* Effect.promise(() => mkdir(join(docDir(root, FILE), "changes-deadbeef.bin")));
        return yield* store.load<FeatureDoc>(root, "features", FILE);
      }),
    );
    const loaded = valueOf(exit);
    expect(loaded?.doc.name).toBe("Login");
    expect(loaded?.skippedChunks).toEqual(["changes-deadbeef.bin"]);
  });

  test("a document the caller's check refuses fails as DocumentRejected with the check's error", async () => {
    const refusal = new Error("too new for this test");
    const exit = await run(
      Effect.gen(function* () {
        const store = yield* Effect.service(DocStore);
        yield* store.create(root, "features", FILE, freshDoc());
        return yield* store.load<FeatureDoc>(root, "features", FILE, {
          migrate: () => {
            throw refusal;
          },
        });
      }),
    );
    const error = errorOf(exit);
    expect(error?._tag).toBe("DocumentRejected");
    expect(error?._tag === "DocumentRejected" && error.cause).toBe(refusal);
  });

  test("a raw load of a path that leaves the store fails as InvalidDocPath", async () => {
    for (const dirRel of ["../outside", "specs/../../outside", "/abs", ".hidden/doc", ""]) {
      const exit = await run(DocStore.use((store) => store.loadRaw(root, dirRel)));
      expect(errorOf(exit)?._tag).toBe("InvalidDocPath");
    }
  });

  test("a create that cannot write fails as a FileIoError naming the errno code", async () => {
    // A plain file sits where the store's root directory would go.
    await mkdir(join(root, ".specdriven"), { recursive: true });
    await writeFile(join(root, ".specdriven/automerge"), "in the way");
    const exit = await run(DocStore.use((store) => store.create(root, "features", FILE, freshDoc())));
    const error = errorOf(exit);
    expect(error?._tag).toBe("FileIoError");
    expect(error?._tag === "FileIoError" && error.code).toMatch(/^(ENOTDIR|EEXIST)$/);
  });

  test("onSaved hears feature documents only, until it is told to stop", async () => {
    const heard: string[] = [];
    await run(
      Effect.gen(function* () {
        const store = yield* Effect.service(DocStore);
        const stop = yield* store.onSaved((_dir, fileName) => heard.push(fileName));
        yield* store.create(root, "features", FILE, freshDoc());
        yield* store.create(root, "docs", "roadmap/now.md", freshDoc());
        stop();
        yield* store.create(root, "features", "specs/other.feature.md", freshDoc());
      }),
    );
    expect(heard).toEqual([FILE]);
  });
});

describe("store Promise functions", () => {
  test("a too-new document rejects with the DataTooNewError itself", async () => {
    const doc = A.change(freshDoc(), (d) => {
      d.schemaVersion = SCHEMA_VERSION + 1;
    });
    await createFeatureDoc(root, FILE, doc);
    const error = await loadFeatureDoc(root, FILE).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DataTooNewError);
  });

  test("a raw load of a path that leaves the store rejects with a plain 'invalid document path' error", async () => {
    const error = await loadRawDoc(root, "../outside").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("invalid document path");
    expect((error as { _tag?: string })._tag).toBeUndefined();
  });

  test("a create that cannot write rejects with the errno exception", async () => {
    await mkdir(join(root, ".specdriven"), { recursive: true });
    await writeFile(join(root, ".specdriven/automerge"), "in the way");
    const error = await createFeatureDoc(root, FILE, freshDoc()).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as NodeJS.ErrnoException).code).toMatch(/^(ENOTDIR|EEXIST)$/);
    expect((error as NodeJS.ErrnoException).syscall).toBe("mkdir");
  });

  test("onDocSaved hears a save and stops when unsubscribed", async () => {
    const heard: string[] = [];
    const stop = onDocSaved((_dir, fileName) => heard.push(fileName));
    try {
      const created = await createFeatureDoc(root, FILE, freshDoc());
      const edited = A.change(created.doc, (d) => {
        d.name = "Sign in";
      });
      await saveFeatureDoc(root, FILE, edited, created.heads);
    } finally {
      stop();
    }
    await createFeatureDoc(root, "specs/later.feature.md", freshDoc());
    expect(heard).toEqual([FILE, FILE]);
  });
});

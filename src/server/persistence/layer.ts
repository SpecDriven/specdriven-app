// The storage core's services as one layer. runtime.ts used to build the
// app's only Effect runtime from this alone; the app runtime
// (src/server/effect/runtime.ts) now adds the sync services beside it.

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { Layer } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { SecretStores, TokenStore } from "./Credentials";
import { DocStore } from "./DocStore";
import { HomePaths } from "./HomePaths";
import { Settings } from "./Settings";

/**
 * Every service of the storage core, on the file system and home paths
 * `platform` provides — Node's and the process's for the app, a temp
 * directory and fixed paths for a test.
 */
export const persistenceOn = <E, R>(platform: Layer.Layer<FileSystem | HomePaths, E, R>) =>
  Layer.mergeAll(DocStore.layer, Settings.layer, TokenStore.layer, SecretStores.layer).pipe(
    Layer.provideMerge(platform),
  );

/** The storage core as the app runs it: Node's file system, the process's own home. */
export const PersistenceLive = persistenceOn(Layer.mergeAll(NodeFileSystem.layer, HomePaths.layer));

/** What a storage program may depend on. */
export type Persistence = Layer.Success<typeof PersistenceLive>;

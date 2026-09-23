// What a plugin's host half imports as `@specdriven/host`
// (roadmap/plugin-architecture.md "Package shape"): the app's own helpers,
// so a plugin that keeps files in the data repo reads, writes, commits and
// keeps Automerge documents exactly as the core does — the same store, the
// same git engine, the same logger. The build points the specifier at a
// shim over what the loader publishes (src/plugins/host/build.ts), so the
// plugin shares these modules instead of bundling copies; Automerge above
// all, whose documents would not cross between two copies. Types the
// services use come along for authors typing against them.

export * as A from "@automerge/automerge";
export { json } from "../../server/http";
export type { Handler, Params } from "../../server/http";
export {
  createFileDoc,
  fileDocDirRel,
  hasFileDoc,
  listFileDocs,
  loadFileDoc,
  newFileDoc,
  removeFileDoc,
  saveFileDoc,
} from "../../server/automerge/store";
export type { LoadedDoc } from "../../server/automerge/store";
export { createFeature } from "../../server/features";
export { fileExists, readTextFile, writeTextFile } from "../../server/fsx";
export { commitAndPush, removeAndPush } from "../../server/git";
export { slugify, titleFromFileName } from "../../server/parser";
export { getLogger, withSpan } from "../../server/telemetry";
export type { Context, Disposer, Plugin } from "../kernel";
export type {
  DataAccess,
  RouteRegistry,
  SearchScopes,
  SessionContributor,
  SessionParts,
  ShellPaths,
  SyncHooks,
} from "../host/services";
export type { SearchSource } from "../../server/search";
export type { SessionSection } from "../../server/agent";

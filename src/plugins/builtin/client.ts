// The built-in plugins' browser halves, in load order — the twin of
// src/plugins/builtin/host.ts, kept apart so the server never imports React.

import type { Context, Plugin } from "../kernel";
import type { PluginManifest } from "../manifest";
import issues from "./issues/client";
import { manifest as issuesManifest } from "./issues/manifest";
import models from "./models/client";
import { manifest as modelsManifest } from "./models/manifest";
import { pagesClient } from "./pages/client";
import { notebookManifest, roadmapManifest, tasksManifest } from "./pages/manifest";
import tests from "./tests/client";
import { manifest as testsManifest } from "./tests/manifest";
import { NOTEBOOK_TAB, ROADMAP_TAB, TASKS_TAB } from "../../frontend/pages/pages";

export interface ClientPlugin {
  manifest: PluginManifest;
  plugin: Plugin<Context>;
}

export const builtinClientPlugins: ClientPlugin[] = [
  // The special folders: one plugin each, from the pages factory.
  { manifest: roadmapManifest, plugin: pagesClient(ROADMAP_TAB) as Plugin<Context> },
  { manifest: tasksManifest, plugin: pagesClient(TASKS_TAB) as Plugin<Context> },
  { manifest: notebookManifest, plugin: pagesClient(NOTEBOOK_TAB) as Plugin<Context> },
  { manifest: issuesManifest, plugin: issues },
  { manifest: modelsManifest, plugin: models },
  { manifest: testsManifest, plugin: tests },
];

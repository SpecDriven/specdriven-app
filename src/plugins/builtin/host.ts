// The built-in plugins' host halves, in load order (roadmap/plugin-
// architecture.md "Phases"): each module that has moved behind the kernel is
// listed here with its manifest. The client halves are listed apart
// (src/plugins/builtin/client.ts), since a server must not import React.

import type { Context, Plugin } from "../kernel";
import type { PluginManifest } from "../manifest";
import type { HostConfig } from "../host/loader";
import issues from "./issues/host";
import { manifest as issuesManifest } from "./issues/manifest";
import { pagesHost } from "./pages/host";
import { notebookManifest, roadmapManifest, tasksManifest } from "./pages/manifest";
import selfFix from "./self-fix/host";
import { manifest as selfFixManifest } from "./self-fix/manifest";
import specs, { hasSpecs } from "./specs/host";
import { manifest as specsManifest } from "./specs/manifest";
import tests from "./tests/host";
import { manifest as testsManifest } from "./tests/manifest";
import { NOTEBOOK, ROADMAP, TASKS, pageFiles, type PageFolder } from "../../server/pages";
import { readTesting } from "../../server/testing";

export interface HostPlugin {
  manifest: PluginManifest;
  /** Mounted with a HostConfig like an external plugin; most ignore it. */
  plugin: Plugin<Context, HostConfig> | Plugin<Context>;
  /**
   * Whether a data folder holds anything of the plugin's — what picks a
   * folder's plugins the first time it is opened (specs/app/plugins.feature
   * .md "A folder's plugins are picked from its data the first time it
   * opens"). Read from the files, never written. Absent for a plugin that
   * keeps nothing in the folder.
   */
  hasData?: (dataDir: string) => Promise<boolean>;
}

/** Whether a special folder holds a page. */
const hasPages = (kind: PageFolder) => async (dataDir: string) =>
  (await pageFiles(dataDir, kind.folder)).length > 0;

/** Whether the test management module holds a case or a plan. */
async function hasTests(dataDir: string): Promise<boolean> {
  const { cases, plans } = await readTesting(dataDir);
  return cases.length > 0 || plans.length > 0;
}

export const builtinHostPlugins: HostPlugin[] = [
  // Specs: the tab's switch; its routes are the core's.
  { manifest: specsManifest, plugin: specs, hasData: hasSpecs },
  // The special folders: one plugin each, from the pages factory.
  { manifest: roadmapManifest, plugin: pagesHost(ROADMAP), hasData: hasPages(ROADMAP) },
  { manifest: tasksManifest, plugin: pagesHost(TASKS), hasData: hasPages(TASKS) },
  { manifest: notebookManifest, plugin: pagesHost(NOTEBOOK), hasData: hasPages(NOTEBOOK) },
  { manifest: issuesManifest, plugin: issues },
  { manifest: testsManifest, plugin: tests, hasData: hasTests },
  { manifest: selfFixManifest, plugin: selfFix },
  // The coding agents are marketplace plugins (specs/agents/agent-plugins
  // .feature.md): the app installs them where it finds their commands
  // (src/plugins/host/autoInstall.ts).
];

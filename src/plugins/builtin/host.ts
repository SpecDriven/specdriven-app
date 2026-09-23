// The built-in plugins' host halves, in load order (roadmap/plugin-
// architecture.md "Phases"): each module that has moved behind the kernel is
// listed here with its manifest. The client halves are listed apart
// (src/plugins/builtin/client.ts), since a server must not import React.

import type { Context, Plugin } from "../kernel";
import type { PluginManifest } from "../manifest";
import issues from "./issues/host";
import { manifest as issuesManifest } from "./issues/manifest";
import tests from "./tests/host";
import { manifest as testsManifest } from "./tests/manifest";

export interface HostPlugin {
  manifest: PluginManifest;
  plugin: Plugin<Context>;
}

export const builtinHostPlugins: HostPlugin[] = [
  { manifest: issuesManifest, plugin: issues },
  { manifest: testsManifest, plugin: tests },
];

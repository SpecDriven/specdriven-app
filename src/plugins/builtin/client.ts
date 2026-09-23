// The built-in plugins' browser halves, in load order — the twin of
// src/plugins/builtin/host.ts, kept apart so the server never imports React.

import type { Context, Plugin } from "../kernel";
import type { PluginManifest } from "../manifest";
import issues from "./issues/client";
import { manifest as issuesManifest } from "./issues/manifest";
import tests from "./tests/client";
import { manifest as testsManifest } from "./tests/manifest";

export interface ClientPlugin {
  manifest: PluginManifest;
  plugin: Plugin<Context>;
}

export const builtinClientPlugins: ClientPlugin[] = [
  { manifest: issuesManifest, plugin: issues },
  { manifest: testsManifest, plugin: tests },
];

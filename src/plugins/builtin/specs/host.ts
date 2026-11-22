// Specs' host half (specs/app/plugins.feature.md "Specs is a built-in
// plugin"). It registers nothing: the spec routes and the sync stay the
// core's and keep running while the tab is switched off — the switch hides
// the tab, not the data. Mounted all the same, so the loader reports the
// plugin active and the browser mounts its tab.

import type { Context, Plugin } from "../../kernel";
import { walk } from "../../../server/walk";
import { manifest } from "./manifest";

const plugin: Plugin<Context> = {
  name: manifest.id,
  apply() {},
};

export default plugin;

/** Whether a data folder holds any feature file. */
export async function hasSpecs(dataDir: string): Promise<boolean> {
  return (await walk(dataDir)).files.length > 0;
}

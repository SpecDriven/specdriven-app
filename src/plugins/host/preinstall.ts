// Marketplace plugins an operator chose for a hosted site — the demo's
// (src/server/demo.ts) and the public read-only site's
// (src/server/readOnly.ts) — installed at start the way Install does
// (src/plugins/host/marketplace.ts: the marketplace cloned through the
// app's git engine, the plugin staged, checked against this app and moved
// into `plugins/`). The operator chose them, so there is no consent step.

import { confirmInstall } from "./marketplace";
import { rescanPlugins } from "./loader";
import { discoverPlugins } from "./sources";
import type { MarketplaceRef } from "../marketplace";
import { version as appVersion } from "../../../package.json";

/** A plugin to install: the index row's name in the marketplace and the id its manifest declares. */
export interface PreinstalledPlugin {
  marketplace: string;
  name: string;
  id: string;
}

/**
 * Install each plugin not already in the home's `plugins/` — a restart
 * keeps /tmp — then rescan, so the loader mounts what arrived and tells open
 * pages. Meant to run without being awaited: the server answers meanwhile.
 * A plugin that cannot be fetched is logged under `label` and its tab stays
 * away; the rest of the site is unaffected.
 */
export async function preinstallPlugins(
  wanted: readonly PreinstalledPlugin[],
  marketplaces: readonly MarketplaceRef[],
  label: string,
): Promise<void> {
  const present = await discoverPlugins({ dataDir: null, paths: [], appVersion });
  for (const want of wanted) {
    if (present.some((p) => p.id === want.id && !p.error)) continue;
    const entry = marketplaces.find((m) => m.name === want.marketplace);
    try {
      if (!entry) throw new Error(`no marketplace named "${want.marketplace}"`);
      await confirmInstall(entry, want.name);
    } catch (e) {
      console.error(`[${label}] could not install ${want.name} from ${want.marketplace}: ${(e as Error).message}`);
    }
  }
  await rescanPlugins();
}

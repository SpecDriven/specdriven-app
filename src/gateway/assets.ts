// The gateway's pages (pages/*.html), bundled once at start with Bun.build
// and served from memory. Built rather than served as Bun HTML imports so
// every page goes out with the gateway's security headers (server.ts).

import { join } from "node:path";

export const ASSET_PREFIX = "/_gw/";
export const PAGES = ["login", "signup", "forgot", "set-password", "account", "admin"] as const;
export type PageName = (typeof PAGES)[number];

export interface Asset {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

export interface GatewayAssets {
  page(name: PageName): Asset;
  /** A bundled script or stylesheet under ASSET_PREFIX, or null. */
  file(pathname: string): Asset | null;
}

export async function buildAssets(production: boolean): Promise<GatewayAssets> {
  const dir = join(import.meta.dir, "pages");
  const result = await Bun.build({
    entrypoints: PAGES.map((p) => join(dir, `${p}.html`)),
    publicPath: ASSET_PREFIX,
    minify: production,
    naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
  });
  if (!result.success) {
    throw new Error(`Building the gateway pages failed:\n${result.logs.map(String).join("\n")}`);
  }
  const pages = new Map<string, Asset>();
  const files = new Map<string, Asset>();
  for (const output of result.outputs) {
    const name = output.path.replace(/^\.\//, "");
    const asset = { body: new Uint8Array(await output.arrayBuffer()), type: output.type };
    if (name.endsWith(".html")) pages.set(name.slice(0, -".html".length), asset);
    else files.set(ASSET_PREFIX + name, asset);
  }
  return {
    page(name) {
      const asset = pages.get(name);
      if (!asset) throw new Error(`No gateway page ${name}`);
      return asset;
    },
    file(pathname) {
      return files.get(pathname) ?? null;
    },
  };
}

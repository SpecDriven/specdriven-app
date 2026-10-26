// Files the bundled main process reads at runtime, shipped beside the bundle
// (scripts/build-desktop.ts copies them into dist/electron): Automerge's
// wasm and cbor-extract's prebuilt native extractor. Bun's bundler would
// otherwise bake each dependency's build-time `__dirname` into the bundle, an
// absolute path into the builder's node_modules that no other machine has.
// `import.meta.url` here is the bundle's own location once bundled — inside
// app.asar, under an installed source's dist/electron, or wherever a copied
// .app sits — so these resolve wherever the bundle runs.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The path of a file shipped beside the running bundle. */
export function bundleAssetPath(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), name);
}

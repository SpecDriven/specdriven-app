// Building a filesystem plugin (specs/app/plugins.feature.md "A plugin loads
// from a local folder", roadmap/plugin-architecture.md "Package shape"): a
// plugin written in TypeScript is built by the app itself when the server
// runs on Bun — the dev server and the compiled binary. The browser half is
// bundled with `react`, `react-dom` and the JSX runtime pointed at shims
// that re-export what src/plugins/client/sdk.ts published on the page, so
// the output has no bare specifier — a plain `import(url)` loads it — and
// there is one React. The Electron main process runs on node and cannot
// build; it loads a prebuilt `dist/` only.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { SDK_GLOBAL, SHARED_MODULES, type SharedModule } from "../shared";

export { SDK_GLOBAL, SHARED_MODULES, type SharedModule };

/** Whether this runtime can build: Bun with its bundler, not node. */
export function canBuild(): boolean {
  return typeof Bun !== "undefined" && typeof Bun.build === "function" && !buildDisabled;
}

let buildDisabled = false;
/** For tests: behave like the node runtime, which loads `dist/` only. */
export function setBuildDisabled(disabled: boolean): void {
  buildDisabled = disabled;
}

/**
 * The named exports each shared module has, read once from the app's own
 * copies — the same packages the page publishes — so a shim can re-export
 * them by name, which ESM needs statically.
 */
let sharedExportsCache: Promise<Record<SharedModule, string[]>> | null = null;
export function sharedExports(): Promise<Record<SharedModule, string[]>> {
  sharedExportsCache ??= (async () => {
    const [react, reactDom, reactDomClient, jsxRuntime, jsxDevRuntime] = await Promise.all([
      import("react"),
      import("react-dom"),
      import("react-dom/client"),
      import("react/jsx-runtime"),
      import("react/jsx-dev-runtime"),
    ]);
    // React's own internals (`__CLIENT_INTERNALS…`) stay out: no plugin needs
    // them, and their names are what marks a bundle that carries its own React.
    const names = (mod: object) =>
      Object.keys(mod).filter((k) => k !== "default" && /^[A-Za-z$][\w$]*$/.test(k) && !k.startsWith("__"));
    return {
      react: names(react),
      "react-dom": names(reactDom),
      "react-dom/client": names(reactDomClient),
      "react/jsx-runtime": names(jsxRuntime),
      "react/jsx-dev-runtime": names(jsxDevRuntime),
    };
  })();
  return sharedExportsCache;
}

/** The source of the shim standing in for one shared module. */
export function shimSource(name: SharedModule, exportNames: readonly string[]): string {
  const lines = [
    `const m = globalThis.${SDK_GLOBAL}?.modules?.[${JSON.stringify(name)}];`,
    `if (!m) throw new Error(${JSON.stringify(`SpecDriven did not publish ${name} for plugins`)});`,
    `export default m.default ?? m;`,
  ];
  for (const n of exportNames) lines.push(`export const ${n} = m.${n};`);
  return `${lines.join("\n")}\n`;
}

const SHIM_NAMESPACE = "specdriven-shim";
const sharedFilter = new RegExp(
  `^(${SHARED_MODULES.map((m) => m.replace(/[/.]/g, "\\$&")).join("|")})$`,
);

/** The Bun.build plugin that points the shared modules at their shims. */
export async function shimPlugin(): Promise<import("bun").BunPlugin> {
  const exports = await sharedExports();
  return {
    name: "specdriven-shared-react",
    setup(build) {
      build.onResolve({ filter: sharedFilter }, (args) => ({
        path: args.path,
        namespace: SHIM_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: SHIM_NAMESPACE }, (args) => ({
        loader: "js",
        contents: shimSource(args.path as SharedModule, exports[args.path as SharedModule] ?? []),
      }));
    },
  };
}

/**
 * Why a browser bundle is refused: it carries a React of its own, which
 * would give the plugin's components a second renderer and break hooks
 * across the boundary. Names React's own code keeps in every build.
 */
export function bundledReactReason(code: string): string | null {
  return /ReactSharedInternals|__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE|react-stack-top-frame/.test(
    code,
  )
    ? "the browser bundle carries its own React; import react from the app instead (build it with `specdriven plugin build`, which shares the app's React)"
    : null;
}

export interface BuildResult {
  /** Files written, relative to `outDir`. */
  files: string[];
}

/** Bundle a browser half to `outDir/client.js`, the shared modules shimmed. */
export async function buildClient(entry: string, outDir: string): Promise<void> {
  await bundle({
    entrypoints: [entry],
    outdir: outDir,
    naming: "client.js",
    target: "browser",
    format: "esm",
    // Production JSX (`jsx`, not `jsxDEV`) and no dev-only branches.
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [await shimPlugin()],
    sourcemap: "linked",
  });
}

/** Bundle a host half to `outDir/host.js`, loadable by Bun and by node. */
export async function buildHost(entry: string, outDir: string): Promise<void> {
  await bundle({
    entrypoints: [entry],
    outdir: outDir,
    naming: "host.js",
    target: "node",
    format: "esm",
    external: ["electron", "bun", "bun:*"],
    sourcemap: "linked",
  });
}

async function bundle(config: import("bun").BuildConfig): Promise<void> {
  if (!canBuild()) throw new Error("this runtime cannot build plugins; build it with `specdriven plugin build`");
  const out = await Bun.build({ ...config, throw: false });
  if (!out.success) {
    const lines = out.logs.map((log) => String(log.message ?? log)).filter(Boolean);
    throw new Error(`build failed: ${lines.join("; ") || "unknown error"}`);
  }
}

/**
 * A revision for a set of files: a short content hash over their relative
 * paths and bytes, so an unchanged source is the same revision and an edit
 * a new one. Directories are walked; `node_modules`, `dist` and dotfolders
 * are skipped.
 */
export async function revisionOf(root: string, entries: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      for (const file of await walk(path)) files.push(file);
    } else {
      files.push(path);
    }
  }
  for (const file of [...new Set(files)].sort()) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.isDirectory()) out.push(...(await walk(path)));
      else out.push(path);
    } catch {
      // gone
    }
  }
  return out;
}

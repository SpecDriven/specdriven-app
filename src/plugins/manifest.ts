// What a plugin says about itself, shared by both halves and by the loaders
// (specs/app/plugins.feature.md). A built-in plugin declares this in code;
// a packaged one carries it under `specdriven` in its package.json, which
// `parsePackageManifest` reads and checks against this app.

export interface PluginManifest {
  /** Stable id: the tab id, the profile entry, the scope name. */
  id: string;
  /** The kernel contract the plugin was written against. */
  api: "1";
  displayName: string;
  description: string;
  /**
   * Whether the plugin is on for a profile that never named it — a settings
   * file from before plugins with no switch for it, or none at all
   * (specs/app/plugins.feature.md "The profile lists enabled plugins in tab
   * order"); for a plugin found in a folder, whether it goes on when it is
   * first found.
   */
  defaultEnabled: boolean;
  /**
   * The Settings key the module's switch lived under before the profile
   * (`testing`, `issues`, …). A settings file that still has it is read as
   * the matching profile once, and `PUT /api/state` keeps taking the key as
   * an alias for one release (src/plugins/profile.ts).
   */
  legacyKey?: string;
  /**
   * Url prefixes the plugin's views live under (`/tests`). The server serves
   * the app shell for them whether or not the plugin is on, so a deep link
   * to a switched-off module still lands in the app and goes home there.
   */
  paths?: string[];
  /** The package's version; a built-in's is the app's. */
  version?: string;
  /** The oldest app the plugin runs in. */
  minAppVersion?: string;
  /** Declarative in v1 — plugins are trusted and run in process. */
  permissions?: string[];
  /** The prebuilt host half, relative to the package (`./dist/host.js`). */
  host?: string;
  /** The prebuilt browser half, relative to the package. */
  client?: string;
  /** The TypeScript sources the app builds itself when it runs on Bun. */
  src?: { host?: string; client?: string };
}

/** The kernel contract this app speaks; a manifest's `api` major must match. */
export const API_MAJOR = 1;

/**
 * A plugin id: a package-like name, scoped or not — `tests`, `jira-tab`,
 * `@acme/jira-tab`. It names the profile entry, the scope, the tab and the
 * bundle url, where it travels encoded as one path segment.
 */
export const PLUGIN_ID_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** The `specdriven` section a package.json carries, as far as the loader reads it. */
export interface PackageManifestJson {
  name?: unknown;
  version?: unknown;
  specdriven?: unknown;
}

/**
 * Read a package.json's `specdriven` section as a manifest, refusing one
 * the app cannot load: no section, a bad id, an `api` major the kernel does
 * not speak, a `minAppVersion` newer than this app, a half that points
 * outside the package, or no half at all. The error's message is the reason
 * Settings → Plugins shows.
 */
export function parsePackageManifest(raw: unknown, appVersion: string): PluginManifest {
  if (!raw || typeof raw !== "object") throw new Error("package.json is not an object");
  const pkg = raw as PackageManifestJson;
  const section = pkg.specdriven;
  if (!section || typeof section !== "object") {
    throw new Error('package.json has no "specdriven" section');
  }
  const s = section as Record<string, unknown>;
  const id = typeof s.id === "string" ? s.id : typeof pkg.name === "string" ? pkg.name : "";
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error(
      id
        ? `"${id}" is not a plugin id (lowercase letters, digits, ".", "_", "-", optionally @scope/)`
        : "the manifest names no id",
    );
  }
  const api = s.api === undefined ? "" : String(s.api);
  const major = Number.parseInt(api, 10);
  if (!api || Number.isNaN(major)) throw new Error('the manifest names no "api" version');
  if (major !== API_MAJOR) {
    throw new Error(`the plugin needs plugin api ${api}; this app speaks api ${API_MAJOR}`);
  }
  const minAppVersion = typeof s.minAppVersion === "string" ? s.minAppVersion : undefined;
  if (minAppVersion && compareVersions(appVersion, minAppVersion) < 0) {
    throw new Error(`the plugin needs SpecDriven ${minAppVersion} or newer; this is ${appVersion}`);
  }
  const rel = (key: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value) throw new Error(`"${key}" must be a relative path`);
    if (!isInsidePackage(value)) throw new Error(`"${key}" must stay inside the package: ${value}`);
    return value;
  };
  const host = rel("host", s.host);
  const client = rel("client", s.client);
  let src: PluginManifest["src"];
  if (s.src !== undefined) {
    if (!s.src || typeof s.src !== "object") throw new Error('"src" must name host and/or client');
    const o = s.src as Record<string, unknown>;
    src = { host: rel("src.host", o.host), client: rel("src.client", o.client) };
  }
  if (!host && !client && !src?.host && !src?.client) {
    throw new Error("the manifest names neither a host nor a client half");
  }
  const paths = Array.isArray(s.paths)
    ? s.paths.filter((p): p is string => typeof p === "string" && p.startsWith("/"))
    : undefined;
  const permissions = Array.isArray(s.permissions)
    ? s.permissions.filter((p): p is string => typeof p === "string")
    : undefined;
  return {
    id,
    api: "1",
    displayName: typeof s.displayName === "string" && s.displayName ? s.displayName : id,
    description: typeof s.description === "string" ? s.description : "",
    // A plugin someone put in a folder is meant to run: on unless it says not.
    defaultEnabled: s.defaultEnabled !== false,
    ...(paths?.length ? { paths } : {}),
    ...(typeof pkg.version === "string" ? { version: pkg.version } : {}),
    ...(minAppVersion ? { minAppVersion } : {}),
    ...(permissions ? { permissions } : {}),
    ...(host ? { host } : {}),
    ...(client ? { client } : {}),
    ...(src ? { src } : {}),
  };
}

/** A relative path with no `..` segment and no drive or root. */
function isInsidePackage(path: string): boolean {
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.startsWith("\\")) return false;
  return !path.split(/[\\/]/).some((segment) => segment === "..");
}

/** Compare dotted versions numerically: negative when a < b, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

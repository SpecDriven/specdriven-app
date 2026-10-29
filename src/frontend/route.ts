// Deep-link urls (specs/ui/navigation.feature.md):
//
//   /                                               home
//   /features/<feature>                             feature page
//   /features/<feature>/scenarios/<scenario>        latest version of the scenario
//   /features/<feature>/scenarios/<scenario>/v<N>   exactly version N
//
// A plugin's views (`/roadmap`, `/tasks`, `/notebook`, `/tests`, `/issues`,
// `/models`, specs/app/plugins.feature.md) are parsed by the plugin itself,
// before this; App asks the mounted tabs first.
//
// <feature> is the file path *within the spec tree* minus `.feature.md`, and
// may span several segments when the feature lives in a folder
// (`billing/quotes` for `specs/billing/quotes.feature.md`); <scenario> is
// slugify(scenario name). Features are stored under `specs/` but addressed
// without it, so links minted before that move still resolve; the prefix is
// added by `parseRoute` and stripped by `featurePath`, and nothing between
// them needs to know. The first `scenarios` segment with something after it
// splits feature from scenario — so a folder literally named `scenarios` is
// not addressable by deep link. Segments after the scenario version are
// ignored, and a path that doesn't start with a known shape is home.

import { slugify } from "../server/parser";
import type { Scenario } from "../server/parser";

export interface ScenarioRef {
  slug: string;
  /** Absent means "latest version of this name". */
  version?: number;
}

export interface Route {
  /** Feature file name, with the `.feature.md` suffix restored. */
  feature?: string;
  scenario?: ScenarioRef;
}

const VERSION_SEG = /^v([1-9]\d*)$/;

/** Decode a path segment; a malformed escape is kept as-is rather than thrown. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseRoute(pathname: string): Route {
  const segs = pathname.split("/").filter(Boolean).map(decode);
  if (segs[0] !== "features" || !segs[1]) return {};
  // The feature path runs up to the first `scenarios` segment that has a slug
  // after it (folders make feature paths multi-segment).
  let split = segs.findIndex((s, i) => i >= 2 && s === "scenarios" && segs[i + 1]);
  if (split === -1) {
    // No scenario ref: the whole tail is the feature path, except a trailing
    // bare `scenarios` — that's a mangled scenario link tail, not a folder.
    const last = segs.length - 1;
    split = last >= 2 && segs[last] === "scenarios" ? last : segs.length;
  }
  const parts = segs.slice(1, split);
  // Accept a stem that already carries the `.feature.md` (or legacy
  // `.feature`) suffix — hand-edited links shouldn't double it up.
  const stem = parts.join("/").replace(/\.feature(\.md)?$/, "");
  // Urls address a feature by its path *within* the spec tree, so the storage
  // prefix goes back on here. A hand-typed `/features/specs/...` is tolerated
  // rather than doubled.
  const within = stem === SPECS_FOLDER || stem.startsWith(`${SPECS_FOLDER}/`)
    ? stem.slice(SPECS_FOLDER.length + 1)
    : stem;
  const route: Route = { feature: `${SPECS_FOLDER}/${within}.feature.md` };
  if (segs[split] !== "scenarios" || !segs[split + 1]) return route;
  route.scenario = { slug: segs[split + 1]! };
  const version = segs[split + 2]?.match(VERSION_SEG);
  if (version) route.scenario.version = Number(version[1]);
  return route;
}

/**
 * Scheme the desktop app registers with the OS (specs/ui/navigation.feature.md
 * "links from outside the app"). Inside the desktop window the origin is
 * `app://specdriven`, which nothing else on the machine can reach, so links
 * meant to be shared use this scheme over the same paths.
 */
export const DESKTOP_SCHEME = "specdriven";

/**
 * Query flag the desktop shell puts on a path that came from a
 * `specdriven://` link (src/electron/linkRouting.ts). Such a path may
 * name its spec folder first; the window's own urls — a reload, Back — never
 * do, so only a flagged path is read for one (splitRepoPath). The app drops
 * the flag as soon as it has read it.
 */
export const LINK_PARAM = "link";

/** `/specs-insurance/tasks/ship` -> `/specs-insurance/tasks/ship?link`. */
export function linkEntry(path: string): string {
  return `${path}?${LINK_PARAM}`;
}

/** Whether a url's query (`location.search`) marks it as a link from outside. */
export function isLinkEntry(search: string): boolean {
  return new URLSearchParams(search).has(LINK_PARAM);
}

/**
 * `/features/quotes` -> `specdriven://<repo>/features/quotes`. A link leaves
 * the window, where nothing says which spec folder it belongs to, so it
 * names the folder first — `repo` is the data repo as configured (a path or
 * a GitHub url), shortened to its display name. Without one the link is the
 * bare path, the shape links had before they carried the folder.
 */
export function desktopLink(path: string, repo?: string | null): string {
  const rest = path.replace(/^\/+/, "");
  const name = repo ? repoDisplayName(repo) : "";
  if (!name) return `${DESKTOP_SCHEME}://${rest}`;
  return `${DESKTOP_SCHEME}://${encodeURIComponent(name)}${rest ? `/${rest}` : ""}`;
}

/** An app path split into the spec folder a desktop link names and the rest. */
export interface RepoPath {
  /** The configured data repo the first segment names, or null for none. */
  repo: string | null;
  path: string;
}

/**
 * Read the spec folder off the front of a desktop link's path
 * (`/specs-insurance/tasks/ship` -> `specs-insurance`, `/tasks/ship`). The
 * first segment names a folder when it is the display name of one of
 * `repos` — the folders this machine knows, the open one first so it wins a
 * name two folders share. Case is ignored: some url parsers lowercase a
 * host. Anything else is a path from before links carried the folder, and
 * is returned as is.
 *
 * Only a link from outside may name its folder (see `LINK_PARAM`); the
 * window's own urls never do. Links without a folder are still about
 * (`specdriven://features/quotes`), so when a folder shares its name with a
 * route word the path is read as that route if `isRoute` says it names a
 * view and the rest would not — `/features/quotes` stays a feature even with
 * a folder named "features", while `/features` alone, `/tasks/features/
 * quotes` and a folder's own plugin view (not mounted in this window yet)
 * still split.
 */
export function splitRepoPath(
  pathname: string,
  repos: readonly string[],
  isRoute?: (path: string) => boolean,
): RepoPath {
  const segs = pathname.split("/").filter(Boolean);
  const first = segs[0];
  if (!first) return { repo: null, path: pathname };
  const name = decode(first).toLowerCase();
  const repo = repos.find((r) => repoDisplayName(r).toLowerCase() === name);
  if (!repo) return { repo: null, path: pathname };
  const rest = `/${segs.slice(1).join("/")}`;
  if (isRoute && isRoute(pathname) && !isRoute(rest)) return { repo: null, path: pathname };
  return { repo, path: rest };
}

/**
 * Sidebar display name for the configured data repo
 * (specs/ui/app-start.feature.md): just the folder or GitHub repo name — the
 * parent folders stay in the header's tooltip and in the edit dialog.
 */
export function repoDisplayName(repo: string): string {
  return repo.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.git$/, "") || repo;
}

/**
 * The spec tree's folder, shared with the server (src/server/walk.ts). Urls
 * never carry it — see `featurePath` — so it appears only where a route is
 * converted to or from a repo-relative file name.
 */
export const SPECS_FOLDER = "specs";

export function featurePath(fileName: string): string {
  const stem = fileName.replace(/\.feature\.md$/, "");
  // The spec tree's prefix is storage, not address: urls name a feature by its
  // path within `specs/`, so links minted before the move still resolve.
  const within = stem.startsWith(`${SPECS_FOLDER}/`)
    ? stem.slice(SPECS_FOLDER.length + 1)
    : stem;
  // Folder segments keep their `/`s; anything a url can't carry is escaped.
  return `/features/${within.split("/").map(encodeURIComponent).join("/")}`;
}

export function scenarioPath(
  fileName: string,
  scenario: Pick<Scenario, "name" | "version">,
): string {
  return `${featurePath(fileName)}/scenarios/${slugify(scenario.name)}/v${scenario.version}`;
}

/**
 * The url of what is on screen (specs/ui/navigation.feature.md "URL scheme"):
 * the scenario's own url while its page is open, otherwise the feature's, and
 * `/` with no feature open. A plugin's view — a roadmap page or a task, say —
 * takes the same pane a feature does and owns its own url, which the plugin
 * mints (src/plugins/builtin/pages/route.ts).
 */
export function pagePath(
  fileName: string | null,
  scenario: Pick<Scenario, "name" | "version"> | null,
): string {
  if (!fileName) return "/";
  return scenario ? scenarioPath(fileName, scenario) : featurePath(fileName);
}

/**
 * Resolve a scenario ref against a parsed feature: exact version when the ref
 * has one, otherwise the highest version of that name. On slug collisions the
 * first match in file order wins (specs/ui/navigation.feature.md). Returns the
 * scenario's list index, or null if nothing matches.
 */
export function resolveScenario(scenarios: Scenario[], ref: ScenarioRef): number | null {
  let best: number | null = null;
  scenarios.forEach((s, i) => {
    if (slugify(s.name) !== ref.slug) return;
    if (ref.version !== undefined) {
      if (s.version === ref.version && best === null) best = i;
    } else if (best === null || s.version > scenarios[best]!.version) {
      best = i;
    }
  });
  return best;
}

/**
 * The app's own pages (specs/user-info-settings.feature.md "open Settings",
 * "open Plugins"): Settings and Plugins take the editor pane the way a
 * feature does, each at its own url, so Back leaves them and a reload
 * reopens them. They are checked before the plugins' urls, so no plugin can
 * claim them.
 */
export type AppPage = "settings" | "plugins" | "observability" | "data" | "images";

export const APP_PAGES: readonly AppPage[] = ["settings", "plugins", "observability", "data", "images"];

export function appPagePath(page: AppPage): string {
  return `/${page}`;
}

/** The app page a url names — `/settings`, `/plugins/` — or null. */
export function matchAppPage(pathname: string): AppPage | null {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length !== 1) return null;
  return APP_PAGES.find((p) => p === segs[0]) ?? null;
}

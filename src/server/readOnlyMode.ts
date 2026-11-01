// Read-only mode (SPECDRIVEN_READONLY=1): the app runs as a public site
// that shows one spec repository to anyone, signed in to nothing — the
// features and the roadmap, browsed, never changed (specs.specdriven.app,
// docs/deployment-railway.md "Public read-only site"). The repository is a
// public GitHub one, cloned anonymously and kept current by
// src/server/readOnly.ts; the app serves a .git-less copy of it, so no
// git operation of its own can ever commit or push.
//
// Kept apart from readOnly.ts for the same reason as demoMode.ts: the API,
// the user module and the gateway only need to ask "is this the read-only
// site?", and readOnly.ts reaches the sync tick and the plugin loader.

type Env = Record<string, string | undefined>;

export function isReadOnlyMode(env: Env = process.env): boolean {
  const v = env.SPECDRIVEN_READONLY;
  return v === "1" || v === "true";
}

/** What every request outside the site's allowlist is answered with. */
export const READ_ONLY_REFUSAL = "This site is read-only";

export const DEFAULT_READ_ONLY_REPO = "https://github.com/SpecDriven/specs-specdriven";
export const DEFAULT_READ_ONLY_BRANCH = "main";
export const DEFAULT_READ_ONLY_REFRESH_SECONDS = 60;

/** The plugins the site shows beside Specs, in tab order. */
export const READ_ONLY_PLUGINS: readonly string[] = ["roadmap"];

/**
 * The visitor every page names: a public site has no account behind it, and
 * the container's OS user and git identity are nobody's business.
 */
export const READ_ONLY_USER = {
  username: "Visitor",
  login: null,
  name: "Visitor",
  email: null,
} as const;

export interface ReadOnlyConfig {
  /** The public GitHub repository shown — an https url, cloned anonymously (or a local path). */
  repo: string;
  /** The branch shown. */
  branch: string;
  /** How often the repository is fetched; 0 never refreshes it. */
  refreshSeconds: number;
}

const REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/;
/** A local repository's absolute path — for local runs and the tests. */
const LOCAL_RE = /^\/[^\0]*$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * The site's settings, read once at start. A repo that is not a GitHub
 * https url, or a branch git would read as an option, is a startup failure.
 */
export function readReadOnlyConfig(env: Env = process.env): ReadOnlyConfig {
  const repo = env.SPECDRIVEN_READONLY_REPO?.trim() || DEFAULT_READ_ONLY_REPO;
  if (!REPO_RE.test(repo) && !LOCAL_RE.test(repo)) {
    throw new Error(`SPECDRIVEN_READONLY_REPO must be a https://github.com/owner/repo url, not "${repo}"`);
  }
  const branch = env.SPECDRIVEN_READONLY_BRANCH?.trim() || DEFAULT_READ_ONLY_BRANCH;
  if (!BRANCH_RE.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new Error(`SPECDRIVEN_READONLY_BRANCH is not a branch name: "${branch}"`);
  }
  const raw = env.SPECDRIVEN_READONLY_REFRESH_SECONDS?.trim();
  const refreshSeconds = raw ? Number(raw) : DEFAULT_READ_ONLY_REFRESH_SECONDS;
  if (!Number.isInteger(refreshSeconds) || refreshSeconds < 0) {
    throw new Error(`SPECDRIVEN_READONLY_REFRESH_SECONDS must be a whole number of seconds, not "${raw}"`);
  }
  return { repo: repo.replace(/\/+$/, ""), branch, refreshSeconds };
}

/**
 * The routes the site answers, as `METHOD pattern` the way they are
 * registered (src/server/api.ts coreRoutes, the roadmap plugin's in
 * src/plugins/builtin/pages/host.ts, the loader's in src/plugins/host/
 * loader.ts). Reads only, and only of what the site shows; everything else
 * — every write, the logs, the data viewer, settings, sign-in, agents — is
 * refused before its handler runs.
 */
const ALLOWED = new Set([
  "GET /api/state",
  "GET /api/features",
  "GET /api/features/:file",
  "GET /api/images/:name",
  "GET /api/scenario-files/:name",
  "GET /api/search",
  "GET /api/readme",
  "GET /api/test-name",
  "GET /api/pull-request",
  "GET /api/roadmap",
  "GET /api/roadmap/:file",
  "GET /api/plugins/events",
  // The agent pane's session list, which the client reads at start: empty here.
  "GET /api/agent/chat",
  "GET /plugins/:id/client.js",
]);

/** Whether the read-only site answers a matched route. HEAD is read as GET. */
export function readOnlyAllows(method: string, pattern: string): boolean {
  return ALLOWED.has(`${method === "HEAD" ? "GET" : method} ${pattern}`);
}

let site: ReadOnlyConfig | null = null;

/** The site's settings once setup has read them (src/server/readOnly.ts). */
export function setReadOnlySite(config: ReadOnlyConfig | null): void {
  site = config;
}

/** The repository the site shows and how often it is fetched; null before setup. */
export function readOnlySite(): ReadOnlyConfig | null {
  return site;
}

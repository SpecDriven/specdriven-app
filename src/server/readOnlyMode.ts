// Read-only mode (SPECDRIVEN_READONLY=1): the app runs as a public site
// that shows spec repositories to anyone, signed in to nothing — the
// features and the roadmap, browsed, never changed (specs.specdriven.app,
// docs/deployment-railway.md "Public read-only site"). Each repository is a
// public GitHub one, cloned anonymously and kept current by
// src/server/readOnly.ts; the app serves a .git-less copy of it, so no
// git operation of its own can ever commit or push.
//
// One site can show several projects (SPECDRIVEN_READONLY_PROJECTS): each
// is a workspace of its own (src/server/workspace.ts), the way a desktop
// window is, and a visitor's request runs in the one their project cookie
// names — the first project's when it names none.
//
// Kept apart from readOnly.ts for the same reason as demoMode.ts: the API,
// the user module and the gateway only need to ask "is this the read-only
// site?", and readOnly.ts reaches the sync tick and the plugin loader.

import type { Workspace } from "./workspace";

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

/** The plugins the site shows, in tab order: Specs and the roadmap. */
export const READ_ONLY_PLUGINS: readonly string[] = ["specs", "roadmap"];

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

/** One spec repository the site shows. */
export interface ReadOnlyProject {
  /** What the visitor's cookie and a `?project=` link name it by: the repo's name unless the list says otherwise. */
  id: string;
  /** The public GitHub repository — an https url, cloned anonymously (or a local path). */
  repo: string;
  /** The branch shown. */
  branch: string;
}

export interface ReadOnlyConfig {
  /** The projects shown, in the order the list names them; the first is a new visitor's. */
  projects: ReadOnlyProject[];
  /** How often each repository is fetched; 0 never refreshes them. */
  refreshSeconds: number;
}

const REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/;
/** A local repository's absolute path — for local runs and the tests. */
const LOCAL_RE = /^\/[^\0]*$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
/** A project id: safe in a cookie, a query string and a folder name. */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The cookie naming a visitor's project (src/frontend/readOnlyProject.ts sets it). */
export const PROJECT_COOKIE = "specdriven-project";

function checkRepo(repo: string, name: string): string {
  if (!REPO_RE.test(repo) && !LOCAL_RE.test(repo)) {
    throw new Error(`${name} must be a https://github.com/owner/repo url, not "${repo}"`);
  }
  return repo.replace(/\/+$/, "");
}

function checkBranch(branch: string, name: string): string {
  if (!BRANCH_RE.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new Error(`${name} is not a branch name: "${branch}"`);
  }
  return branch;
}

/** A repository's name, as the default id of its project: `acme/specs.git` → `specs`. */
function repoName(repo: string): string {
  const last = repo.split("/").filter(Boolean).pop() ?? "";
  return last.replace(/\.git$/, "").toLowerCase();
}

/**
 * The project list, SPECDRIVEN_READONLY_PROJECTS: entries apart by commas
 * or white space, each `[id=]repo[#branch]` — the id the repo's name, the
 * branch SPECDRIVEN_READONLY_BRANCH's (main) unless the entry names them.
 */
export function parseReadOnlyProjects(list: string, defaultBranch: string): ReadOnlyProject[] {
  const name = "SPECDRIVEN_READONLY_PROJECTS";
  const projects: ReadOnlyProject[] = [];
  for (const entry of list.split(/[\s,]+/).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const named = eq > 0 && !entry.slice(0, eq).includes("/");
    const rest = named ? entry.slice(eq + 1) : entry;
    const hash = rest.lastIndexOf("#");
    const repo = checkRepo(hash >= 0 ? rest.slice(0, hash) : rest, name);
    const branch = hash >= 0 ? checkBranch(rest.slice(hash + 1), `The branch in ${name}`) : defaultBranch;
    const id = named ? entry.slice(0, eq).trim().toLowerCase() : repoName(repo);
    if (!PROJECT_ID_RE.test(id)) {
      throw new Error(`${name}: "${id}" cannot name a project — letters, digits, ".", "_" and "-" only`);
    }
    if (projects.some((p) => p.id === id)) {
      throw new Error(`${name} names two projects "${id}" — give one another name with <id>=<repo>`);
    }
    projects.push({ id, repo, branch });
  }
  if (projects.length === 0) throw new Error(`${name} names no project`);
  return projects;
}

/**
 * The site's settings, read once at start: the projects of
 * SPECDRIVEN_READONLY_PROJECTS, or the one SPECDRIVEN_READONLY_REPO names
 * (SpecDriven's own spec repo when neither is set). A repo that is not a
 * GitHub https url, a branch git would read as an option, or two projects
 * of one name is a startup failure.
 */
export function readReadOnlyConfig(env: Env = process.env): ReadOnlyConfig {
  const branch = checkBranch(
    env.SPECDRIVEN_READONLY_BRANCH?.trim() || DEFAULT_READ_ONLY_BRANCH,
    "SPECDRIVEN_READONLY_BRANCH",
  );
  const list = env.SPECDRIVEN_READONLY_PROJECTS?.trim();
  const single = env.SPECDRIVEN_READONLY_REPO?.trim();
  if (list && single) {
    throw new Error("Set SPECDRIVEN_READONLY_PROJECTS or SPECDRIVEN_READONLY_REPO, not both");
  }
  let projects: ReadOnlyProject[];
  if (list) projects = parseReadOnlyProjects(list, branch);
  else {
    const repo = checkRepo(single || DEFAULT_READ_ONLY_REPO, "SPECDRIVEN_READONLY_REPO");
    projects = [{ id: repoName(repo) || "specs", repo, branch }];
  }
  const raw = env.SPECDRIVEN_READONLY_REFRESH_SECONDS?.trim();
  const refreshSeconds = raw ? Number(raw) : DEFAULT_READ_ONLY_REFRESH_SECONDS;
  if (!Number.isInteger(refreshSeconds) || refreshSeconds < 0) {
    throw new Error(`SPECDRIVEN_READONLY_REFRESH_SECONDS must be a whole number of seconds, not "${raw}"`);
  }
  return { projects, refreshSeconds };
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
/** Each project's workspace, by project id; registered by setup. */
const spaces = new Map<string, Workspace>();

/** The site's settings once setup has read them (src/server/readOnly.ts). */
export function setReadOnlySite(config: ReadOnlyConfig | null): void {
  site = config;
  spaces.clear();
}

/** The repositories the site shows and how often they are fetched; null before setup. */
export function readOnlySite(): ReadOnlyConfig | null {
  return site;
}

/** Setup registers the workspace a project's requests run in. */
export function setReadOnlyWorkspace(id: string, workspace: Workspace): void {
  spaces.set(id, workspace);
}

/** The project a workspace shows, or null: none of the site's. */
export function readOnlyProjectOf(workspace: Workspace | null): ReadOnlyProject | null {
  if (!workspace || !site) return null;
  for (const [id, w] of spaces) if (w === workspace) return site.projects.find((p) => p.id === id) ?? null;
  return null;
}

/** The project id a request's cookie names, if it is one. */
export function projectFromCookie(header: string | null): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== PROJECT_COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    return PROJECT_ID_RE.test(value) ? value : null;
  }
  return null;
}

/**
 * The workspace a visitor's request runs in: their cookie's project, or the
 * first project when it names none the site shows. Null before setup.
 */
export function readOnlyWorkspace(req: Request): Workspace | null {
  if (!site) return null;
  const asked = projectFromCookie(req.headers.get("cookie"));
  return (asked ? spaces.get(asked) : undefined) ?? spaces.get(site.projects[0]!.id) ?? null;
}

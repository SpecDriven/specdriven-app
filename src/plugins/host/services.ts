// The host half's extension points (roadmap/plugin-architecture.md
// "Extension points"): the route table, the shell paths, the sync tick's
// drift hook, data-repo access, the search scopes and a code gen session's
// prompt sections, each a service on the kernel context and each
// registration a disposer. api.ts registers the core rows first, so core
// routes match before a plugin's.

import type { Disposer } from "../kernel";
import type { SessionSection } from "../../server/agent";
import type { Handler, Params } from "../../server/http";
import type { SearchSource } from "../../server/search";

export interface ApiMatch {
  handler: Handler;
  params: Params;
  /** The route's pattern as registered (`/api/features/:file`). */
  pattern: string;
}

export interface RouteRegistry {
  /** Pattern segments starting with `:` bind the (decoded) path segment. */
  add(method: string, pattern: string, handler: Handler): Disposer;
  match(method: string, pathname: string): ApiMatch | null;
}

export interface ShellPaths {
  /** Serve the app shell under this prefix (`/tests` covers `/tests/*`). */
  add(prefix: string): Disposer;
  matches(pathname: string): boolean;
  prefixes(): string[];
  /** Hear of a prefix added or removed — a plugin folder came or went. */
  subscribe(listener: () => void): Disposer;
}

export interface SyncHooks {
  /**
   * Run on every sync tick after the specs' own drift pass, with the data
   * dir; whatever string it returns joins the tick's log line.
   */
  drift(fn: (dir: string) => Promise<string | void>): Disposer;
  /** The tick's side: every hook in registration order. */
  run(dir: string): Promise<string[]>;
  /**
   * A top-level folder of the data repo the plugin owns: the specs-folder
   * migration (src/server/migrate.ts) never takes a `.feature.md` in it
   * for a stray spec.
   */
  reserve(folder: string): Disposer;
  /** The folders reserved now. */
  reserved(): string[];
  /**
   * Hear which features the specs-folder migration moved (old path to new),
   * to rewrite a plugin file that names them.
   */
  moved(fn: (dir: string, moved: ReadonlyMap<string, string>) => Promise<void>): Disposer;
  /** The migration's side: every hook in registration order. */
  runMoved(dir: string, moved: ReadonlyMap<string, string>): Promise<void>;
}

/**
 * The search scopes beyond the specs and the special folders
 * (src/server/search.ts): `GET /api/search?scope=<name>` searches the
 * plugin's files, one hit per file — the Models tab's palette searches the
 * models this way.
 */
export interface SearchScopes {
  add(scope: string, source: SearchSource): Disposer;
}

/**
 * What a code gen session bundles beyond the specs (src/server/agent.ts
 * buildSessionPrompt). A tab names what is open on it (the client's
 * `TabPlugin.session`) and the request carries those names under the
 * plugin's id; every contributor is asked, with its own names — none when
 * the session came from elsewhere — and the session's spec files, and
 * answers with prompt sections and any specs to take on whole.
 */
export interface SessionContributor {
  (
    dir: string,
    request: { refs: string[]; specFiles: string[] },
  ): Promise<{ sections: SessionSection[]; features: string[] }>;
}

export interface SessionParts {
  add(id: string, contributor: SessionContributor): Disposer;
  /** The contributors, by plugin id, in registration order. */
  entries(): [string, SessionContributor][];
}

export interface DataAccess {
  /** Wrap a handler so it runs against the resolved data dir, or answers
      409 / 502 the way every core route does. */
  withDir(
    handler: (dir: string, req: Request, params: Params) => Response | Promise<Response>,
  ): Handler;
  /** The resolved data dir, or null while none is configured or reachable. */
  dir(): Promise<string | null>;
}

declare module "../kernel" {
  interface Services {
    routes: RouteRegistry;
    shell: ShellPaths;
    sync: SyncHooks;
    data: DataAccess;
    search: SearchScopes;
    sessions: SessionParts;
  }
}

/** Remove one entry from a list, if it is still there. */
function drop<T>(list: T[], item: T): void {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}

export function createRouteRegistry(): RouteRegistry {
  const rows: { method: string; pattern: string; handler: Handler }[] = [];
  return {
    add(method, pattern, handler) {
      const row = { method, pattern, handler };
      rows.push(row);
      return () => {
        const i = rows.indexOf(row);
        if (i >= 0) rows.splice(i, 1);
      };
    },
    // Segments are matched before decoding, so an encoded `/` in a parameter
    // (`billing%2Fq.feature.md`) stays one segment — the params come out
    // decoded. First match wins, in registration order.
    match(method, pathname) {
      const segments = pathname.split("/");
      for (const { method: m, pattern, handler } of rows) {
        if (m !== method) continue;
        const want = pattern.split("/");
        if (want.length !== segments.length) continue;
        const params: Params = {};
        let ok = true;
        for (let i = 0; i < want.length; i++) {
          const w = want[i]!;
          const got = segments[i]!;
          if (w.startsWith(":")) {
            try {
              params[w.slice(1)] = decodeURIComponent(got);
            } catch {
              ok = false; // malformed percent-encoding
              break;
            }
          } else if (w !== got) {
            ok = false;
            break;
          }
        }
        if (ok) return { handler, params, pattern };
      }
      return null;
    },
  };
}

export function createShellPaths(): ShellPaths {
  const prefixes: string[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  return {
    add(prefix) {
      const clean = `/${prefix.replace(/^\/+|\/+$/g, "")}`;
      prefixes.push(clean);
      notify();
      return () => {
        const i = prefixes.indexOf(clean);
        if (i >= 0) prefixes.splice(i, 1);
        notify();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    matches(pathname) {
      return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
    },
    prefixes() {
      return [...prefixes];
    },
  };
}

export function createSyncHooks(): SyncHooks {
  const hooks: ((dir: string) => Promise<string | void>)[] = [];
  const folders: string[] = [];
  const movedHooks: ((dir: string, moved: ReadonlyMap<string, string>) => Promise<void>)[] = [];
  return {
    drift(fn) {
      hooks.push(fn);
      return () => drop(hooks, fn);
    },
    async run(dir) {
      const lines: string[] = [];
      for (const hook of [...hooks]) {
        const line = await hook(dir);
        if (line) lines.push(line);
      }
      return lines;
    },
    reserve(folder) {
      folders.push(folder);
      return () => drop(folders, folder);
    },
    reserved() {
      return [...new Set(folders)];
    },
    moved(fn) {
      movedHooks.push(fn);
      return () => drop(movedHooks, fn);
    },
    async runMoved(dir, moved) {
      for (const hook of [...movedHooks]) await hook(dir, moved);
    },
  };
}

export function createSessionParts(): SessionParts {
  const rows: [string, SessionContributor][] = [];
  return {
    add(id, contributor) {
      const row: [string, SessionContributor] = [id, contributor];
      rows.push(row);
      return () => drop(rows, row);
    },
    entries() {
      return [...rows];
    },
  };
}

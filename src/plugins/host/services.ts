// The host half's extension points (roadmap/plugin-architecture.md
// "Extension points"): the route table, the shell paths, the sync tick's
// drift hook and data-repo access, each a service on the kernel context and
// each registration a disposer. api.ts registers the core rows first, so
// core routes match before a plugin's.

import type { Disposer } from "../kernel";
import type { Handler, Params } from "../../server/http";

export interface ApiMatch {
  handler: Handler;
  params: Params;
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
  }
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
        if (ok) return { handler, params };
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
  return {
    drift(fn) {
      hooks.push(fn);
      return () => {
        const i = hooks.indexOf(fn);
        if (i >= 0) hooks.splice(i, 1);
      };
    },
    async run(dir) {
      const lines: string[] = [];
      for (const hook of [...hooks]) {
        const line = await hook(dir);
        if (line) lines.push(line);
      }
      return lines;
    },
  };
}

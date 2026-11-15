// The Promise forms of the SiteTokens service
// (src/server/persistence/Credentials.ts) for one kind of site. jiraTokens.ts,
// confluenceTokens.ts, ahaTokens.ts and qtestTokens.ts each make one and
// export its functions under the names the app and the tests use.
//
// The default backend is a 0600 JSON file under the app's home; the desktop
// app swaps in an OS-encrypted one (Electron safeStorage) through
// `setBackend` before the server starts.

import type { Effect } from "effect";
import { siteTokenFile, SiteTokens, type SiteTokenStore } from "./persistence/Credentials";
import type { Throwable } from "./persistence/errors";
import { run, runSync } from "./persistence/runtime";
import { siteTokenPath, type SiteTokenBackend, type SiteTokenKind, type SiteTokenRecord } from "./siteTokenModel";

/** One kind's token store, for code that awaits Promises. */
export interface SiteTokenFunctions {
  /** The default token file: under ~/.specdriven ($SPECDRIVEN_HOME). */
  path(): string;
  /**
   * The file backend: the web server's, and the desktop's fallback. The path
   * is resolved per call so a changed $SPECDRIVEN_HOME (tests) is honored.
   */
  fileBackend(fixedPath?: string): SiteTokenBackend;
  /** Swap the storage backend (Electron safeStorage, tests); what was remembered is forgotten. */
  setBackend(next: SiteTokenBackend): void;
  /** The sites with a token, and who each signs in as — never the token. */
  list(): Promise<{ base: string; user: string }[]>;
  /** The token for a site, or null. */
  token(base: string): Promise<SiteTokenRecord | null>;
  /** Keep a token, replacing the one this site had. */
  save(record: SiteTokenRecord): Promise<void>;
  /** Forget a site's token. */
  clear(base: string): Promise<void>;
  /** Hear every change to the saved records; null stops it. */
  onChanged(fn: ((records: SiteTokenRecord[]) => void) | null): void;
  /** The records, tokens included, as a 0600 file at `path`; answers the path. */
  exportTo(path: string): Promise<string>;
}

export function siteTokens(kind: SiteTokenKind): SiteTokenFunctions {
  let listener: ((records: SiteTokenRecord[]) => void) | null = null;
  const where = (fixedPath?: string) => fixedPath ?? siteTokenPath(kind);
  const on = <A>(use: (store: SiteTokenStore) => Effect.Effect<A, Throwable>): Promise<A> =>
    run(SiteTokens.use((sites) => use(sites.store(kind))));

  return {
    path: () => siteTokenPath(kind),
    fileBackend: (fixedPath) => ({
      load: async () => (await run(siteTokenFile.load(where(fixedPath)))) ?? [],
      save: (records) => run(siteTokenFile.save(where(fixedPath), records)),
      clear: () => run(siteTokenFile.clear(where(fixedPath))),
    }),
    setBackend(next) {
      runSync(SiteTokens.use((sites) => sites.setBackend(kind, next)));
    },
    list: async () => (await on((store) => store.all)).map(({ base, user }) => ({ base, user })),
    token: (base) => on((store) => store.find(base)),
    async save(record) {
      const now = await on((store) => store.save(record));
      listener?.(now);
    },
    async clear(base) {
      const now = await on((store) => store.clear(base));
      listener?.(now);
    },
    onChanged(fn) {
      listener = fn;
    },
    async exportTo(path) {
      await run(siteTokenFile.save(path, await on((store) => store.all)));
      return path;
    },
  };
}

// Where qTest bearer tokens live (specs/external-links/qtest-test-cases
// .feature.md "One qTest token is kept on this device"): stored per
// site, though the Settings route keeps one only, on this device only. Like
// the Confluence tokens (./confluenceTokens.ts) they are never part of
// settings.yaml or the data repo. The default backend is a 0600 JSON file next to the home settings
// file; the desktop app swaps in an OS-encrypted backend (Electron
// safeStorage) via setQtestTokenBackend.
//
// The store is the SiteTokens service (src/server/persistence/
// Credentials.ts), shared with the other per-site tokens; the functions
// here are its Promise forms for qTest (./siteTokens.ts).

import { QTEST_TOKENS, type SiteTokenBackend, type SiteTokenRecord } from "./siteTokenModel";
import { siteTokens } from "./siteTokens";

export { parseSiteRecords as parseQtestRecords } from "./siteTokenModel";

/**
 * A qTest site (src/server/qtestUrl.ts normalizeQtestBase), the token for
 * it, and — as `user` — what the token reached when it was saved
 * ("3 projects"), for Settings to show.
 */
export type QtestTokenRecord = SiteTokenRecord;

export type QtestTokenBackend = SiteTokenBackend;

export const QTEST_TOKEN_FILE = QTEST_TOKENS.file;

/**
 * The token alone, from what was pasted: qTest's API & SDK page shows it as
 * "Bearer <token>", so a leading "Bearer " (any case) comes off.
 */
export function bareQtestToken(pasted: string): string {
  return pasted.trim().replace(/^bearer\s+/i, "").trim();
}

const qtest = siteTokens(QTEST_TOKENS);

/** The default token file: ~/.specdriven/qtest-tokens.json ($SPECDRIVEN_HOME). */
export const qtestTokenPath = qtest.path;

/** File backend, used by the web server and as the desktop fallback. */
export const createQtestFileBackend = qtest.fileBackend;

/** Swap the storage backend (Electron safeStorage, tests); resets the cache. */
export const setQtestTokenBackend = qtest.setBackend;

/** The sites with a token, and what each reaches — never the token. */
export const listQtestTokens = qtest.list;

/** The token for a site, or null. */
export const qtestToken = qtest.token;

/** Keep a token, replacing the one this site had. */
export const saveQtestToken = qtest.save;

/** Forget a site's token. */
export const clearQtestToken = qtest.clear;

// Where Aha! API keys live (specs/external-links/aha-import.feature.md "An
// Aha! API key is kept per site on this device"): one per Aha! site, on
// this device only. Like the Confluence and qTest tokens
// (./confluenceTokens.ts, ./qtestTokens.ts) they are never part of
// settings.yaml or the data repo. The default backend is a 0600 JSON file
// next to the home settings file; the desktop app swaps in an OS-encrypted
// backend (Electron safeStorage) via setAhaTokenBackend.
//
// The store is the SiteTokens service (src/server/persistence/
// Credentials.ts), shared with the other per-site tokens; the functions
// here are its Promise forms for Aha! (./siteTokens.ts).

import { AHA_TOKENS, type SiteTokenBackend, type SiteTokenRecord } from "./siteTokenModel";
import { siteTokens } from "./siteTokens";

export { parseSiteRecords as parseAhaRecords } from "./siteTokenModel";

/** An Aha! site (src/server/ahaUrl.ts normalizeAhaBase), the API key for it, and who the key signs in as. */
export type AhaTokenRecord = SiteTokenRecord;

export type AhaTokenBackend = SiteTokenBackend;

export const AHA_TOKEN_FILE = AHA_TOKENS.file;

const aha = siteTokens(AHA_TOKENS);

/** The default token file: ~/.specdriven/aha-tokens.json ($SPECDRIVEN_HOME). */
export const ahaTokenPath = aha.path;

/** File backend, used by the web server and as the desktop fallback. */
export const createAhaFileBackend = aha.fileBackend;

/** Swap the storage backend (Electron safeStorage, tests); resets the cache. */
export const setAhaTokenBackend = aha.setBackend;

/** The sites with a key, and who each signs in as — never the key. */
export const listAhaTokens = aha.list;

/** The key for a site, or null. */
export const ahaToken = aha.token;

/** Keep a key, replacing the one this site had. */
export const saveAhaToken = aha.save;

/** Forget a site's key. */
export const clearAhaToken = aha.clear;

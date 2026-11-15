// Where Confluence personal access tokens live
// (specs/external-links/confluence-wiki.feature.md): one per wiki, on this
// device only. Like the GitHub token (./tokenStore.ts) they are never part of
// settings.yaml or the data repo. The default backend is a 0600 JSON file
// next to the home settings file; the desktop app swaps in an OS-encrypted
// backend (Electron safeStorage) via setConfluenceTokenBackend.
//
// The store is the SiteTokens service (src/server/persistence/
// Credentials.ts), shared with the other per-site tokens; the functions
// here are its Promise forms for Confluence (./siteTokens.ts). The
// Confluence MCP server (src/mcp), which only reads a token file, takes the
// parser and the path from ./siteTokenModel.ts and so loads none of this.

import { CONFLUENCE_TOKENS, type SiteTokenBackend, type SiteTokenRecord } from "./siteTokenModel";
import { siteTokens } from "./siteTokens";

export { parseSiteRecords as parseConfluenceRecords } from "./siteTokenModel";

/** A wiki (src/server/confluenceUrl.ts normalizeConfluenceBase), the token for it, and who the token signs in as. */
export type ConfluenceTokenRecord = SiteTokenRecord;

export type ConfluenceTokenBackend = SiteTokenBackend;

export const CONFLUENCE_TOKEN_FILE = CONFLUENCE_TOKENS.file;

const confluence = siteTokens(CONFLUENCE_TOKENS);

/** The default token file: ~/.specdriven/confluence-tokens.json ($SPECDRIVEN_HOME). */
export const confluenceTokenPath = confluence.path;

/** File backend, used by the web server and as the desktop fallback. */
export const createConfluenceFileBackend = confluence.fileBackend;

/** Hear every change to the saved records (the desktop app refreshes its export, below). */
export const onConfluenceTokensChanged = confluence.onChanged;

/** Swap the storage backend (Electron safeStorage, tests); resets the cache. */
export const setConfluenceTokenBackend = confluence.setBackend;

/** The wikis with a token, and who each signs in as — never the token. */
export const listConfluenceTokens = confluence.list;

/** The token for a wiki, or null. */
export const confluenceToken = confluence.token;

/** Keep a token, replacing the one this wiki had. */
export const saveConfluenceToken = confluence.save;

/** Forget a wiki's token. */
export const clearConfluenceToken = confluence.clear;

/**
 * The records, tokens included, as a 0600 file at `path` — what the
 * Confluence MCP server (src/mcp) reads where the app itself keeps them
 * encrypted (src/electron/main.ts). Returns the path.
 */
export const exportConfluenceTokens = confluence.exportTo;

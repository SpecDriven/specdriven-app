// Where Jira personal access tokens live
// (specs/external-links/jira-wiki-import.feature.md "A Jira token is kept per
// site on this device"): one per site, on this device only. Like the
// Confluence tokens (./confluenceTokens.ts) they are never part of
// settings.yaml or the data repo. The default backend is a 0600 JSON file
// next to the home settings file; the desktop app swaps in an OS-encrypted
// backend (Electron safeStorage) via setJiraTokenBackend.
//
// The store is the SiteTokens service (src/server/persistence/
// Credentials.ts), shared with the other per-site tokens; the functions
// here are its Promise forms for Jira (./siteTokens.ts).

import { JIRA_TOKENS, type SiteTokenBackend, type SiteTokenRecord } from "./siteTokenModel";
import { siteTokens } from "./siteTokens";

export { parseSiteRecords as parseJiraRecords } from "./siteTokenModel";

/** A Jira site (src/server/jiraUrl.ts normalizeJiraBase), the token for it, and who the token signs in as. */
export type JiraTokenRecord = SiteTokenRecord;

export type JiraTokenBackend = SiteTokenBackend;

export const JIRA_TOKEN_FILE = JIRA_TOKENS.file;

const jira = siteTokens(JIRA_TOKENS);

/** The default token file: ~/.specdriven/jira-tokens.json ($SPECDRIVEN_HOME). */
export const jiraTokenPath = jira.path;

/** File backend, used by the web server and as the desktop fallback. */
export const createJiraFileBackend = jira.fileBackend;

/** Swap the storage backend (Electron safeStorage, tests); resets the cache. */
export const setJiraTokenBackend = jira.setBackend;

/** The sites with a token, and who each signs in as — never the token. */
export const listJiraTokens = jira.list;

/** The token for a site, or null. */
export const jiraToken = jira.token;

/** Keep a token, replacing the one this site had. */
export const saveJiraToken = jira.save;

/** Forget a site's token. */
export const clearJiraToken = jira.clear;

// Tokens kept per site — a Jira, a Confluence wiki, an Aha! site, a qTest
// site — as data: what a record is, how a stored list is read back, where
// its file lives, and the four kinds there are. No I/O beyond naming a path,
// and nothing here loads Effect, so the Confluence MCP server (src/mcp),
// which only reads a token file, imports this and not the stores.
//
// The stores are the SiteTokens service (src/server/persistence/
// Credentials.ts); jiraTokens.ts, confluenceTokens.ts, ahaTokens.ts and
// qtestTokens.ts are its Promise forms, one per kind.

import { homedir } from "node:os";
import { join } from "node:path";
import { sameAhaBase } from "./ahaUrl";
import { sameBase } from "./confluenceUrl";
import { sameJiraBase } from "./jiraUrl";
import { sameQtestBase } from "./qtestUrl";
import { STATE_DIR } from "./settingsModel";

/** A site, the token for it, and who the token signs in as. */
export interface SiteTokenRecord {
  /** The site's base url, normalized by its kind's url module. */
  base: string;
  token: string;
  /** Who, or what, the token reached when it was saved, for Settings to show. */
  user: string;
}

/** How one kind's records are kept, as the app is handed it (Electron safeStorage, a test's file). */
export interface SiteTokenBackend {
  load(): Promise<SiteTokenRecord[]>;
  save(records: SiteTokenRecord[]): Promise<void>;
  clear(): Promise<void>;
}

/** One kind of site: what its store is called, its file, and when two base urls are one site. */
export interface SiteTokenKind {
  readonly name: string;
  /** The file under the app's home the records are kept in by default. */
  readonly file: string;
  readonly same: (a: string, b: string) => boolean;
}

export const JIRA_TOKENS: SiteTokenKind = { name: "jira", file: "jira-tokens.json", same: sameJiraBase };

export const CONFLUENCE_TOKENS: SiteTokenKind = {
  name: "confluence",
  file: "confluence-tokens.json",
  same: sameBase,
};

export const AHA_TOKENS: SiteTokenKind = { name: "aha", file: "aha-tokens.json", same: sameAhaBase };

export const QTEST_TOKENS: SiteTokenKind = { name: "qtest", file: "qtest-tokens.json", same: sameQtestBase };

/** A kind's default file as the process sees it now: under $SPECDRIVEN_HOME, else ~/.specdriven. */
export function siteTokenPath(kind: SiteTokenKind): string {
  return join(process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR), kind.file);
}

/** The stored records, dropping any that are not one; null when the text is not a list at all. */
export function parseSiteRecords(raw: string): SiteTokenRecord[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((r: Partial<SiteTokenRecord> | null) =>
      r && typeof r.base === "string" && r.base && typeof r.token === "string" && r.token
        ? [{ base: r.base, token: r.token, user: typeof r.user === "string" ? r.user : "" }]
        : [],
    );
  } catch {
    return null; // a corrupt file means no tokens, never a crash
  }
}

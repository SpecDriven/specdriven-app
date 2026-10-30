// Where Jira personal access tokens live
// (specs/external-links/jira-wiki-import.feature.md "A Jira token is kept per
// site on this device"): one per site, on this device only. Like the
// Confluence tokens (./confluenceTokens.ts) they are never part of
// settings.json or the data repo. The default backend is a 0600 JSON file
// next to the home settings file; the desktop app swaps in an OS-encrypted
// backend (Electron safeStorage) via setJiraTokenBackend.

import { chmod, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeTextFile } from "./fsx";
import { sameJiraBase } from "./jiraUrl";
import { STATE_DIR } from "./state";

/** A Jira site, the token for it, and who the token signs in as. */
export interface JiraTokenRecord {
  /** The site's base url (src/server/jiraUrl.ts normalizeJiraBase). */
  base: string;
  token: string;
  /** The user the token signed in as when it was saved, for Settings to show. */
  user: string;
}

export interface JiraTokenBackend {
  load(): Promise<JiraTokenRecord[]>;
  save(records: JiraTokenRecord[]): Promise<void>;
  clear(): Promise<void>;
}

export const JIRA_TOKEN_FILE = "jira-tokens.json";

/** The default token file: ~/.specdriven/jira-tokens.json ($SPECDRIVEN_HOME). */
export function jiraTokenPath(): string {
  return join(process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR), JIRA_TOKEN_FILE);
}

/** The stored records, dropping any that are not one; a corrupt file is none. */
export function parseJiraRecords(raw: string): JiraTokenRecord[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((r: Partial<JiraTokenRecord> | null) =>
      r && typeof r.base === "string" && r.base && typeof r.token === "string" && r.token
        ? [{ base: r.base, token: r.token, user: typeof r.user === "string" ? r.user : "" }]
        : [],
    );
  } catch {
    return null;
  }
}

/** File backend, used by the web server and as the desktop fallback. */
export function createJiraFileBackend(fixedPath?: string): JiraTokenBackend {
  const where = () => fixedPath ?? jiraTokenPath();
  return {
    async load() {
      try {
        return parseJiraRecords(await readFile(where(), "utf8")) ?? [];
      } catch {
        return [];
      }
    },
    async save(records) {
      const path = where();
      await writeTextFile(path, JSON.stringify(records, null, 2) + "\n");
      await chmod(path, 0o600); // tokens are credentials — owner-only
    },
    async clear() {
      await rm(where(), { force: true });
    },
  };
}

let backend: JiraTokenBackend = createJiraFileBackend();
let cached: JiraTokenRecord[] | undefined;

/** Swap the storage backend (Electron safeStorage, tests); resets the cache. */
export function setJiraTokenBackend(next: JiraTokenBackend): void {
  backend = next;
  cached = undefined;
}

async function records(): Promise<JiraTokenRecord[]> {
  if (cached === undefined) cached = await backend.load();
  return cached;
}

/** The sites with a token, and who each signs in as — never the token. */
export async function listJiraTokens(): Promise<{ base: string; user: string }[]> {
  return (await records()).map(({ base, user }) => ({ base, user }));
}

/** The token for a site, or null. */
export async function jiraToken(base: string): Promise<JiraTokenRecord | null> {
  return (await records()).find((r) => sameJiraBase(r.base, base)) ?? null;
}

/** Keep a token, replacing the one this site had. */
export async function saveJiraToken(record: JiraTokenRecord): Promise<void> {
  const next = [...(await records()).filter((r) => !sameJiraBase(r.base, record.base)), record];
  await backend.save(next);
  cached = next;
}

/** Forget a site's token. */
export async function clearJiraToken(base: string): Promise<void> {
  const next = (await records()).filter((r) => !sameJiraBase(r.base, base));
  if (next.length === 0) await backend.clear();
  else await backend.save(next);
  cached = next;
}

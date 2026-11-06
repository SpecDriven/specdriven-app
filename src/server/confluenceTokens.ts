// Where Confluence personal access tokens live
// (specs/external-links/confluence-wiki.feature.md): one per wiki, on this
// device only. Like the GitHub token (./tokenStore.ts) they are never part of
// settings.json or the data repo. The default backend is a 0600 JSON file
// next to the home settings file; the desktop app swaps in an OS-encrypted
// backend (Electron safeStorage) via setConfluenceTokenBackend.

import { chmod, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sameBase } from "./confluenceUrl";
import { writeTextFile } from "./fsx";
import { STATE_DIR } from "./state";

/** A wiki, the token for it, and who the token signs in as. */
export interface ConfluenceTokenRecord {
  /** The wiki's base url (src/server/confluenceUrl.ts normalizeConfluenceBase). */
  base: string;
  token: string;
  /** The user the token signed in as when it was saved, for Settings to show. */
  user: string;
}

export interface ConfluenceTokenBackend {
  load(): Promise<ConfluenceTokenRecord[]>;
  save(records: ConfluenceTokenRecord[]): Promise<void>;
  clear(): Promise<void>;
}

export const CONFLUENCE_TOKEN_FILE = "confluence-tokens.json";

/** The default token file: ~/.specdriven/confluence-tokens.json ($SPECDRIVEN_HOME). */
export function confluenceTokenPath(): string {
  return join(process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR), CONFLUENCE_TOKEN_FILE);
}

/** The stored records, dropping any that are not one; a corrupt file is none. */
export function parseConfluenceRecords(raw: string): ConfluenceTokenRecord[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((r: Partial<ConfluenceTokenRecord> | null) =>
      r && typeof r.base === "string" && r.base && typeof r.token === "string" && r.token
        ? [{ base: r.base, token: r.token, user: typeof r.user === "string" ? r.user : "" }]
        : [],
    );
  } catch {
    return null;
  }
}

/** File backend, used by the web server and as the desktop fallback. */
export function createConfluenceFileBackend(fixedPath?: string): ConfluenceTokenBackend {
  const where = () => fixedPath ?? confluenceTokenPath();
  return {
    async load() {
      try {
        return parseConfluenceRecords(await readFile(where(), "utf8")) ?? [];
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

let backend: ConfluenceTokenBackend = createConfluenceFileBackend();
let cached: ConfluenceTokenRecord[] | undefined;
let listener: ((records: ConfluenceTokenRecord[]) => void) | null = null;

/** Hear every change to the saved records (the desktop app refreshes its export, below). */
export function onConfluenceTokensChanged(fn: ((records: ConfluenceTokenRecord[]) => void) | null): void {
  listener = fn;
}

/** Swap the storage backend (Electron safeStorage, tests); resets the cache. */
export function setConfluenceTokenBackend(next: ConfluenceTokenBackend): void {
  backend = next;
  cached = undefined;
}

async function records(): Promise<ConfluenceTokenRecord[]> {
  if (cached === undefined) cached = await backend.load();
  return cached;
}

/** The wikis with a token, and who each signs in as — never the token. */
export async function listConfluenceTokens(): Promise<{ base: string; user: string }[]> {
  return (await records()).map(({ base, user }) => ({ base, user }));
}

/** The token for a wiki, or null. */
export async function confluenceToken(base: string): Promise<ConfluenceTokenRecord | null> {
  return (await records()).find((r) => sameBase(r.base, base)) ?? null;
}

/** Keep a token, replacing the one this wiki had. */
export async function saveConfluenceToken(record: ConfluenceTokenRecord): Promise<void> {
  const next = [...(await records()).filter((r) => !sameBase(r.base, record.base)), record];
  await backend.save(next);
  cached = next;
  listener?.(next);
}

/** Forget a wiki's token. */
export async function clearConfluenceToken(base: string): Promise<void> {
  const next = (await records()).filter((r) => !sameBase(r.base, base));
  if (next.length === 0) await backend.clear();
  else await backend.save(next);
  cached = next;
  listener?.(next);
}

/**
 * The records, tokens included, as a 0600 file at `path` — what the
 * Confluence MCP server (src/mcp) reads where the app itself keeps them
 * encrypted (src/electron/main.ts). Returns the path.
 */
export async function exportConfluenceTokens(path: string): Promise<string> {
  await writeTextFile(path, JSON.stringify(await records(), null, 2) + "\n");
  await chmod(path, 0o600);
  return path;
}

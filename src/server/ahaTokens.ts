// Where Aha! API keys live (specs/external-links/aha-import.feature.md "An
// Aha! API key is kept per site on this device"): one per Aha! site, on
// this device only. Like the Confluence and qTest tokens
// (./confluenceTokens.ts, ./qtestTokens.ts) they are never part of
// settings.json or the data repo. The default backend is a 0600 JSON file
// next to the home settings file; the desktop app swaps in an OS-encrypted
// backend (Electron safeStorage) via setAhaTokenBackend.

import { chmod, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sameAhaBase } from "./ahaUrl";
import { writeTextFile } from "./fsx";
import { STATE_DIR } from "./state";

/** An Aha! site, the API key for it, and who the key signs in as. */
export interface AhaTokenRecord {
  /** The site's base url (src/server/ahaUrl.ts normalizeAhaBase). */
  base: string;
  token: string;
  /** The user the key signed in as when it was saved, for Settings to show. */
  user: string;
}

export interface AhaTokenBackend {
  load(): Promise<AhaTokenRecord[]>;
  save(records: AhaTokenRecord[]): Promise<void>;
  clear(): Promise<void>;
}

export const AHA_TOKEN_FILE = "aha-tokens.json";

/** The default token file: ~/.specdriven/aha-tokens.json ($SPECDRIVEN_HOME). */
export function ahaTokenPath(): string {
  return join(process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR), AHA_TOKEN_FILE);
}

/** The stored records, dropping any that are not one; a corrupt file is none. */
export function parseAhaRecords(raw: string): AhaTokenRecord[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((r: Partial<AhaTokenRecord> | null) =>
      r && typeof r.base === "string" && r.base && typeof r.token === "string" && r.token
        ? [{ base: r.base, token: r.token, user: typeof r.user === "string" ? r.user : "" }]
        : [],
    );
  } catch {
    return null;
  }
}

/** File backend, used by the web server and as the desktop fallback. */
export function createAhaFileBackend(fixedPath?: string): AhaTokenBackend {
  const where = () => fixedPath ?? ahaTokenPath();
  return {
    async load() {
      try {
        return parseAhaRecords(await readFile(where(), "utf8")) ?? [];
      } catch {
        return [];
      }
    },
    async save(records) {
      const path = where();
      await writeTextFile(path, JSON.stringify(records, null, 2) + "\n");
      await chmod(path, 0o600); // keys are credentials — owner-only
    },
    async clear() {
      await rm(where(), { force: true });
    },
  };
}

let backend: AhaTokenBackend = createAhaFileBackend();
let cached: AhaTokenRecord[] | undefined;

/** Swap the storage backend (Electron safeStorage, tests); resets the cache. */
export function setAhaTokenBackend(next: AhaTokenBackend): void {
  backend = next;
  cached = undefined;
}

async function records(): Promise<AhaTokenRecord[]> {
  if (cached === undefined) cached = await backend.load();
  return cached;
}

/** The sites with a key, and who each signs in as — never the key. */
export async function listAhaTokens(): Promise<{ base: string; user: string }[]> {
  return (await records()).map(({ base, user }) => ({ base, user }));
}

/** The key for a site, or null. */
export async function ahaToken(base: string): Promise<AhaTokenRecord | null> {
  return (await records()).find((r) => sameAhaBase(r.base, base)) ?? null;
}

/** Keep a key, replacing the one this site had. */
export async function saveAhaToken(record: AhaTokenRecord): Promise<void> {
  const next = [...(await records()).filter((r) => !sameAhaBase(r.base, record.base)), record];
  await backend.save(next);
  cached = next;
}

/** Forget a site's key. */
export async function clearAhaToken(base: string): Promise<void> {
  const next = (await records()).filter((r) => !sameAhaBase(r.base, base));
  if (next.length === 0) await backend.clear();
  else await backend.save(next);
  cached = next;
}

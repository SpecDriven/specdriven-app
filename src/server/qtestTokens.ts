// Where qTest bearer tokens live (specs/external-links/qtest-test-cases
// .feature.md "A qTest token is kept per site on this device"): one per
// qTest site, on this device only. Like the Confluence tokens
// (./confluenceTokens.ts) they are never part of settings.yaml or the data
// repo. The default backend is a 0600 JSON file next to the home settings
// file; the desktop app swaps in an OS-encrypted backend (Electron
// safeStorage) via setQtestTokenBackend.

import { chmod, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sameQtestBase } from "./qtestUrl";
import { writeTextFile } from "./fsx";
import { STATE_DIR } from "./state";

/** A qTest site, the token for it, and what the token could see when saved. */
export interface QtestTokenRecord {
  /** The site's base url (src/server/qtestUrl.ts normalizeQtestBase). */
  base: string;
  token: string;
  /** What the token reached when it was saved ("3 projects"), for Settings to show. */
  user: string;
}

export interface QtestTokenBackend {
  load(): Promise<QtestTokenRecord[]>;
  save(records: QtestTokenRecord[]): Promise<void>;
  clear(): Promise<void>;
}

export const QTEST_TOKEN_FILE = "qtest-tokens.json";

/** The default token file: ~/.specdriven/qtest-tokens.json ($SPECDRIVEN_HOME). */
export function qtestTokenPath(): string {
  return join(process.env.SPECDRIVEN_HOME || join(homedir(), STATE_DIR), QTEST_TOKEN_FILE);
}

/**
 * The token alone, from what was pasted: qTest's API & SDK page shows it as
 * "Bearer <token>", so a leading "Bearer " (any case) comes off.
 */
export function bareQtestToken(pasted: string): string {
  return pasted.trim().replace(/^bearer\s+/i, "").trim();
}

/** The stored records, dropping any that are not one; a corrupt file is none. */
export function parseQtestRecords(raw: string): QtestTokenRecord[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((r: Partial<QtestTokenRecord> | null) =>
      r && typeof r.base === "string" && r.base && typeof r.token === "string" && r.token
        ? [{ base: r.base, token: r.token, user: typeof r.user === "string" ? r.user : "" }]
        : [],
    );
  } catch {
    return null;
  }
}

/** File backend, used by the web server and as the desktop fallback. */
export function createQtestFileBackend(fixedPath?: string): QtestTokenBackend {
  const where = () => fixedPath ?? qtestTokenPath();
  return {
    async load() {
      try {
        return parseQtestRecords(await readFile(where(), "utf8")) ?? [];
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

let backend: QtestTokenBackend = createQtestFileBackend();
let cached: QtestTokenRecord[] | undefined;

/** Swap the storage backend (Electron safeStorage, tests); resets the cache. */
export function setQtestTokenBackend(next: QtestTokenBackend): void {
  backend = next;
  cached = undefined;
}

async function records(): Promise<QtestTokenRecord[]> {
  if (cached === undefined) cached = await backend.load();
  return cached;
}

/** The sites with a token, and what each reaches — never the token. */
export async function listQtestTokens(): Promise<{ base: string; user: string }[]> {
  return (await records()).map(({ base, user }) => ({ base, user }));
}

/** The token for a site, or null. */
export async function qtestToken(base: string): Promise<QtestTokenRecord | null> {
  return (await records()).find((r) => sameQtestBase(r.base, base)) ?? null;
}

/** Keep a token, replacing the one this site had. */
export async function saveQtestToken(record: QtestTokenRecord): Promise<void> {
  const next = [...(await records()).filter((r) => !sameQtestBase(r.base, record.base)), record];
  await backend.save(next);
  cached = next;
}

/** Forget a site's token. */
export async function clearQtestToken(base: string): Promise<void> {
  const next = (await records()).filter((r) => !sameQtestBase(r.base, base));
  if (next.length === 0) await backend.clear();
  else await backend.save(next);
  cached = next;
}

// Each user's secrets (docs/deployment-railway.md "Credential storage"): the
// GitHub token their specs repository is reached with and the API keys of
// the remote agents they use. Sealed at rest (crypto.ts) and write-only from
// the browser — the account page sees a name, the last four characters and,
// for GitHub, the account the token belongs to. Plaintext exists only in the
// gateway while it starts that user's worker (workers.ts).

import type { Database } from "bun:sqlite";
import type { TokenRecord } from "../server/tokenStore";
import { open, seal, secretAad, type Keyring } from "./crypto";

export const GITHUB_SECRET = "github";
export const MAX_AGENT_KEYS = 20;
export const MAX_SECRET_LENGTH = 4096;
const AGENT_KEY_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export type SecretKind = "github" | "agent_key";

export interface SecretSummary {
  name: string;
  kind: SecretKind;
  /** The last four characters, to tell keys apart. */
  hint: string;
  meta: Record<string, unknown>;
  updatedAt: number;
}

export interface UserSecrets {
  github: TokenRecord | null;
  /** By the name the user gave each key. */
  agentKeys: Record<string, string>;
}

interface Row {
  name: string;
  kind: SecretKind;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  keyId: string;
  meta: string;
  updatedAt: number;
}

/** Why an agent key name is refused, or null when it is fine. */
export function agentKeyNameProblem(name: string): string | null {
  if (name === GITHUB_SECRET) return `"${GITHUB_SECRET}" is reserved for the GitHub token`;
  return AGENT_KEY_NAME.test(name)
    ? null
    : "Name it with lowercase letters, digits and dashes, starting with a letter (at most 40)";
}

export class SecretStore {
  constructor(
    private db: Database,
    private keyring: Keyring,
    private now: () => number = Date.now,
  ) {}

  private rows(userId: string): Row[] {
    return this.db
      .query(
        `SELECT name, kind, ciphertext, iv, key_id AS keyId, meta, updated_at AS updatedAt
         FROM secrets WHERE user_id = ? ORDER BY kind, name`,
      )
      .all(userId) as Row[];
  }

  /** What the account page shows: never a secret's value. */
  async list(userId: string): Promise<SecretSummary[]> {
    const out: SecretSummary[] = [];
    for (const row of this.rows(userId)) {
      const plain = await this.openRow(userId, row).catch(() => null);
      out.push({
        name: row.name,
        kind: row.kind,
        hint: plain ? plain.slice(-4) : "????",
        meta: JSON.parse(row.meta) as Record<string, unknown>,
        updatedAt: row.updatedAt,
      });
    }
    return out;
  }

  agentKeyCount(userId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM secrets WHERE user_id = ? AND kind = 'agent_key'")
      .get(userId) as { n: number };
    return row.n;
  }

  async put(userId: string, name: string, kind: SecretKind, value: string, meta: Record<string, unknown> = {}): Promise<void> {
    const sealed = await seal(this.keyring, value, secretAad(userId, name));
    this.db
      .query(
        `INSERT INTO secrets (user_id, name, kind, ciphertext, iv, key_id, meta, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, name) DO UPDATE SET kind = excluded.kind, ciphertext = excluded.ciphertext,
           iv = excluded.iv, key_id = excluded.key_id, meta = excluded.meta, updated_at = excluded.updated_at`,
      )
      .run(userId, name, kind, sealed.ciphertext, sealed.iv, sealed.keyId, JSON.stringify(meta), this.now());
  }

  /** Whether there was such a secret to delete. */
  delete(userId: string, name: string): boolean {
    return this.db.query("DELETE FROM secrets WHERE user_id = ? AND name = ?").run(userId, name).changes > 0;
  }

  /** Every secret of a user, opened — for their worker's environment only. */
  async values(userId: string): Promise<UserSecrets> {
    const out: UserSecrets = { github: null, agentKeys: {} };
    for (const row of this.rows(userId)) {
      const plain = await this.openRow(userId, row);
      if (row.kind === "github") {
        const meta = JSON.parse(row.meta) as Partial<TokenRecord>;
        out.github = {
          token: plain,
          login: meta.login ?? "",
          name: meta.name ?? null,
          email: meta.email ?? null,
          id: meta.id ?? 0,
        };
      } else {
        out.agentKeys[row.name] = plain;
      }
    }
    return out;
  }

  /** Re-seal every row still under an older master key; how many were. */
  async reseal(): Promise<number> {
    const stale = this.db
      .query(
        `SELECT user_id AS userId, name, kind, ciphertext, iv, key_id AS keyId, meta, updated_at AS updatedAt
         FROM secrets WHERE key_id != ?`,
      )
      .all(this.keyring.current.id) as (Row & { userId: string })[];
    for (const row of stale) {
      const plain = await this.openRow(row.userId, row);
      const sealed = await seal(this.keyring, plain, secretAad(row.userId, row.name));
      this.db
        .query("UPDATE secrets SET ciphertext = ?, iv = ?, key_id = ? WHERE user_id = ? AND name = ?")
        .run(sealed.ciphertext, sealed.iv, sealed.keyId, row.userId, row.name);
    }
    return stale.length;
  }

  private openRow(userId: string, row: Row): Promise<string> {
    return open(
      this.keyring,
      { ciphertext: new Uint8Array(row.ciphertext), iv: new Uint8Array(row.iv), keyId: row.keyId },
      secretAad(userId, row.name),
    );
  }
}

// Where a repository's sync server keeps its documents: the SQLite database
// that belongs to its Durable Object. It is durable and private to that one
// object, so what peers sent is still there after the object has slept — no
// R2 bucket or other store is involved. Written against the two calls it
// needs (`exec`, and a transaction), so the app's tests can run it on
// bun:sqlite.

import type { Chunk, StorageAdapterInterface, StorageKey } from "@automerge/automerge-repo/slim";

/** The part of a Durable Object's `ctx.storage` this adapter uses. */
export interface SqlStore {
  /** `ctx.storage.sql.exec`: run one statement, `?` placeholders bound in order. */
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  /** `ctx.storage.transactionSync`: all of `work`'s writes, or none of them. */
  transactionSync<T>(work: () => T): T;
}

/**
 * The most one row holds. A value larger than this is cut into rows of this
 * size, well under what a Durable Object accepts for a single row.
 */
export const ROW_BYTES = 1024 * 1024;

/** A key as one string: its parts, escaped so none holds a `/`, joined by `/`. */
function encodeKey(key: StorageKey): string {
  return key.map((part) => encodeURIComponent(part)).join("/");
}

function decodeKey(text: string): StorageKey {
  return text.split("/").map((part) => decodeURIComponent(part));
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("A stored chunk is not binary");
}

function joined(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
}

export class SqlStorageAdapter implements StorageAdapterInterface {
  readonly #store: SqlStore;

  constructor(store: SqlStore) {
    this.#store = store;
    store.exec(
      "CREATE TABLE IF NOT EXISTS chunks (key TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, seq))",
    );
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const rows = this.#store.exec("SELECT data FROM chunks WHERE key = ? ORDER BY seq", encodeKey(key)).toArray();
    if (rows.length === 0) return undefined;
    return joined(rows.map((row) => bytesOf(row.data)));
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    const name = encodeKey(key);
    this.#store.transactionSync(() => {
      this.#store.exec("DELETE FROM chunks WHERE key = ?", name);
      let seq = 0;
      // An empty value is still a value: one empty row says the key exists.
      do {
        const row = data.subarray(seq * ROW_BYTES, (seq + 1) * ROW_BYTES);
        this.#store.exec("INSERT INTO chunks (key, seq, data) VALUES (?, ?, ?)", name, seq, row);
        seq++;
      } while (seq * ROW_BYTES < data.byteLength);
    });
  }

  async remove(key: StorageKey): Promise<void> {
    this.#store.exec("DELETE FROM chunks WHERE key = ?", encodeKey(key));
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const rows =
      keyPrefix.length === 0
        ? this.#store.exec("SELECT key, data FROM chunks ORDER BY key, seq").toArray()
        : this.#store
            .exec(
              "SELECT key, data FROM chunks WHERE key = ? OR (key >= ? AND key < ?) ORDER BY key, seq",
              ...rangeOf(keyPrefix),
            )
            .toArray();
    const byKey = new Map<string, Uint8Array[]>();
    for (const row of rows) {
      const name = String(row.key);
      byKey.set(name, [...(byKey.get(name) ?? []), bytesOf(row.data)]);
    }
    return [...byKey].map(([name, parts]) => ({ key: decodeKey(name), data: joined(parts) }));
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    if (keyPrefix.length === 0) {
      this.#store.exec("DELETE FROM chunks");
      return;
    }
    this.#store.exec("DELETE FROM chunks WHERE key = ? OR (key >= ? AND key < ?)", ...rangeOf(keyPrefix));
  }
}

/**
 * The key itself, and the bounds of every key under it: those that go on
 * with a `/`. `0` is the character after `/`, and no escaped part holds a
 * `/`, so `["ab"]` is not taken for a key under `["a"]`.
 */
function rangeOf(keyPrefix: StorageKey): [string, string, string] {
  const name = encodeKey(keyPrefix);
  return [name, `${name}/`, `${name}0`];
}

// Secrets at rest (docs/deployment-railway.md "Credential storage"): every
// GitHub token and agent key is sealed with AES-256-GCM under the master key
// from SPECDRIVEN_MASTER_KEY — a Railway variable, never written to the
// volume, so a copy of the database or a volume backup alone reveals
// nothing. Each secret gets a fresh 12-byte IV, and its owner and name are
// bound in as associated data, so a ciphertext copied to another user's row
// or another slot fails to open. Each key is known by a short id (the start
// of its SHA-256) stored beside the ciphertext: rotating means moving the
// old key to SPECDRIVEN_MASTER_KEYS_PREVIOUS and a new one into place, and
// the gateway re-seals old rows under the new key at start.

type Env = Record<string, string | undefined>;

export interface MasterKey {
  id: string;
  key: CryptoKey;
}

export interface Keyring {
  current: MasterKey;
  /** Every key that may still open a row, by id — the current one included. */
  byId: Map<string, MasterKey>;
}

export interface Sealed {
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  keyId: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A fresh master key, base64 — what `bun src/gateway/index.ts genkey` prints. */
export function generateMasterKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

async function importKey(b64: string, what: string): Promise<MasterKey> {
  const raw = Buffer.from(b64.trim(), "base64");
  if (raw.length !== 32) throw new Error(`${what} must be 32 bytes, base64-encoded`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const id = Buffer.from(digest.subarray(0, 4)).toString("hex");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { id, key };
}

/**
 * The keyring from the environment. Outside production a missing key is
 * replaced by a throwaway one (logged), so `bun run dev:hosted` starts with
 * no setup — secrets stored that way do not survive a restart.
 */
export async function loadKeyring(env: Env = process.env, production = false): Promise<Keyring> {
  let currentB64 = env.SPECDRIVEN_MASTER_KEY?.trim();
  if (!currentB64) {
    if (production) throw new Error("SPECDRIVEN_MASTER_KEY is required");
    console.warn("SPECDRIVEN_MASTER_KEY is not set — using a throwaway key for this run");
    currentB64 = generateMasterKey();
  }
  const current = await importKey(currentB64, "SPECDRIVEN_MASTER_KEY");
  const byId = new Map([[current.id, current]]);
  for (const old of (env.SPECDRIVEN_MASTER_KEYS_PREVIOUS ?? "").split(",").filter((k) => k.trim())) {
    const key = await importKey(old, "SPECDRIVEN_MASTER_KEYS_PREVIOUS");
    if (!byId.has(key.id)) byId.set(key.id, key);
  }
  return { current, byId };
}

/** What a secret is bound to: its owner and its name. */
export function secretAad(userId: string, name: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`specdriven-secret|${userId}|${name}`);
}

export async function seal(keyring: Keyring, plaintext: string, aad: Uint8Array<ArrayBuffer>): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      keyring.current.key,
      encoder.encode(plaintext),
    ),
  );
  return { ciphertext, iv, keyId: keyring.current.id };
}

/** The plaintext, or a thrown error when the key is unknown or the data was altered. */
export async function open(keyring: Keyring, sealed: Sealed, aad: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = keyring.byId.get(sealed.keyId);
  if (!key) throw new Error(`No master key with id ${sealed.keyId} — add it to SPECDRIVEN_MASTER_KEYS_PREVIOUS`);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.iv, additionalData: aad },
    key.key,
    sealed.ciphertext,
  );
  return decoder.decode(plain);
}

/** A random url-safe token (32 bytes) for sessions and email links. */
export function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** What the database stores for a token: its SHA-256, hex. */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

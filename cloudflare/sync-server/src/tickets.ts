// The pass a peer shows to open its WebSocket: which repository it is good
// for and until when, signed by this server (HMAC-SHA-256) so the Worker can
// check it without asking GitHub again. Web Crypto only, so it runs the same
// in workerd and in the app's own tests.

export interface TicketClaims {
  /** The repository the pass opens: `<host>/<owner>/<name>`, lower case. */
  repo: string;
  /** When it stops working, in seconds since the epoch. */
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function keyOf(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** A pass for `claims`, signed with the server's secret. */
export async function signTicket(secret: string, claims: TicketClaims): Promise<string> {
  const payload = encoder.encode(JSON.stringify({ repo: claims.repo, exp: claims.exp }));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await keyOf(secret), payload));
  return `${toBase64Url(payload)}.${toBase64Url(signature)}`;
}

/**
 * What a pass says, when this server signed it, it is for `repo` and it has
 * not run out at `nowSeconds`; null for anything else — forged, altered,
 * another repository's, expired or not a pass at all.
 */
export async function verifyTicket(
  secret: string,
  ticket: string,
  repo: string,
  nowSeconds: number,
): Promise<TicketClaims | null> {
  const [payloadText, signatureText, ...rest] = ticket.split(".");
  if (!payloadText || !signatureText || rest.length > 0) return null;
  const payload = fromBase64Url(payloadText);
  const signature = fromBase64Url(signatureText);
  if (!payload || !signature) return null;
  if (!(await crypto.subtle.verify("HMAC", await keyOf(secret), signature, payload))) return null;
  let claims: { repo?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(decoder.decode(payload)) as typeof claims;
  } catch {
    return null;
  }
  if (typeof claims.repo !== "string" || typeof claims.exp !== "number") return null;
  if (claims.repo !== repo || claims.exp <= nowSeconds) return null;
  return { repo: claims.repo, exp: claims.exp };
}

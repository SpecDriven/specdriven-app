// GitHub sign-in (specs/git-operations.spec.md), two flows over the same
// GitHub App: the browser (web application) flow — Settings opens
// github.com/login/oauth/authorize, GitHub redirects back to this server's
// callback route — and the device flow, where the user enters a short code
// at github.com/login/device. Either way the resulting user token is the
// HTTPS credential the system-git and built-in engines authenticate with,
// and the identity that authors data-repo commits. The GitHub CLI engine
// gets both from gh instead. Tokens are stored through tokenStore
// (OS-encrypted in the desktop app).

import { createHash, randomBytes } from "node:crypto";
import {
  CLIENT_ID_PLACEHOLDER,
  githubApiBase,
  githubClientId,
  githubClientSecret,
  githubWebBase,
} from "./github";
import { clearToken, loadToken, saveToken } from "./tokenStore";
import type { TokenRecord } from "./tokenStore";

export interface DeviceFlowStart {
  userCode: string;
  verificationUri: string;
  /** Seconds the client should wait between polls. */
  interval: number;
  expiresIn: number;
}

export type PollStatus = "pending" | "authorized" | "expired" | "denied";

export interface PollResult {
  status: PollStatus;
  user?: { login: string; name: string | null; email: string | null };
}

const JSON_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": "SpecDriven",
};

interface PendingFlow {
  deviceCode: string;
  interval: number;
  expiresAt: number;
}

let pending: PendingFlow | null = null;

/** Begin a device flow: ask GitHub for a user code to show in Settings. */
export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const clientId = githubClientId();
  if (clientId === CLIENT_ID_PLACEHOLDER) {
    throw new Error(
      "GitHub sign-in is not configured — set SPECDRIVEN_GITHUB_CLIENT_ID to a GitHub App client id",
    );
  }
  const res = await fetch(`${githubWebBase()}/login/device/code`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!res.ok) throw new Error(`GitHub sign-in failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    interval?: number;
    expires_in?: number;
    error?: string;
  };
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(`GitHub sign-in failed: ${data.error ?? "unexpected response"}`);
  }
  const interval = data.interval ?? 5;
  const expiresIn = data.expires_in ?? 900;
  pending = { deviceCode: data.device_code, interval, expiresAt: Date.now() + expiresIn * 1000 };
  return { userCode: data.user_code, verificationUri: data.verification_uri, interval, expiresIn };
}

/**
 * One poll of the pending device flow. `slow_down` bumps the stored
 * interval and still reads as pending; a granted authorization stores the
 * token together with the GitHub identity it belongs to.
 */
export async function pollDeviceFlow(): Promise<PollResult> {
  if (!pending) return { status: "expired" };
  if (Date.now() > pending.expiresAt) {
    pending = null;
    return { status: "expired" };
  }
  const res = await fetch(`${githubWebBase()}/login/oauth/access_token`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      client_id: githubClientId(),
      device_code: pending.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    interval?: number;
  };
  if (data.access_token) {
    pending = null;
    const identity = await fetchIdentity(data.access_token);
    await saveToken(identity);
    return {
      status: "authorized",
      user: { login: identity.login, name: identity.name, email: identity.email },
    };
  }
  switch (data.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      pending.interval = data.interval ?? pending.interval + 5;
      return { status: "pending" };
    case "access_denied":
      pending = null;
      return { status: "denied" };
    default: // expired_token, incorrect_device_code, unexpected errors
      pending = null;
      return { status: "expired" };
  }
}

// ---------------------------------------------------------------------------
// Browser sign-in (web application flow): startWebFlow builds the authorize
// url Settings opens in the browser; GitHub sends the user back to
// /api/auth/github/callback, whose handler calls handleWebCallback; the
// Settings dialog polls pollWebFlow until the outcome arrives. PKCE and a
// state nonce bind the callback to the flow this server started.

interface PendingWebFlow {
  state: string;
  /** PKCE code verifier; its S256 hash rode along on the authorize url. */
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

/** What one poll reports; `error` carries an exchange failure's message. */
export interface WebPollResult extends PollResult {
  error?: string;
}

let pendingWeb: PendingWebFlow | null = null;
/** Outcome recorded by the callback, delivered to the next poll. */
let webOutcome: WebPollResult | null = null;

const base64url = (buf: Buffer) => buf.toString("base64url");

/**
 * Begin a browser sign-in: remember state + PKCE verifier and hand back the
 * GitHub authorize url for the browser. The callback must return to the
 * origin the app is being used at — that url (shown in Settings) is what the
 * GitHub App needs among its callback URLs.
 */
export function startWebFlow(origin: string): { authorizeUrl: string } {
  const clientId = githubClientId();
  if (clientId === CLIENT_ID_PLACEHOLDER) {
    throw new Error(
      "GitHub sign-in is not configured — set SPECDRIVEN_GITHUB_CLIENT_ID to a GitHub App client id",
    );
  }
  if (!githubClientSecret()) {
    throw new Error(
      "Browser sign-in is not configured — set SPECDRIVEN_GITHUB_CLIENT_SECRET to the GitHub App's client secret, or sign in with a device code instead",
    );
  }
  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(32));
  const redirectUri = `${origin}/api/auth/github/callback`;
  pendingWeb = { state, verifier, redirectUri, expiresAt: Date.now() + 10 * 60 * 1000 };
  webOutcome = null;
  const url = new URL(`${githubWebBase()}/login/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", base64url(createHash("sha256").update(verifier).digest()));
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizeUrl: url.toString() };
}

/**
 * Complete the browser sign-in with what GitHub sent to the callback url.
 * The returned message is for the browser tab; the same outcome reaches the
 * Settings dialog through pollWebFlow. A state mismatch changes nothing —
 * a stray or forged request must not cancel the flow the user is inside.
 */
export async function handleWebCallback(
  params: URLSearchParams,
): Promise<{ ok: boolean; message: string }> {
  if (!pendingWeb || Date.now() > pendingWeb.expiresAt) {
    pendingWeb = null;
    return { ok: false, message: "This sign-in link expired — start again from Settings." };
  }
  if (params.get("state") !== pendingWeb.state) {
    return { ok: false, message: "This sign-in link does not match the one in progress — start again from Settings." };
  }
  const flow = pendingWeb;
  pendingWeb = null;
  // The user clicked "Cancel" on GitHub's authorize page.
  if (params.get("error") || !params.get("code")) {
    webOutcome = { status: "denied" };
    return { ok: false, message: "Sign-in was denied on GitHub." };
  }
  try {
    const res = await fetch(`${githubWebBase()}/login/oauth/access_token`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        client_id: githubClientId(),
        client_secret: githubClientSecret(),
        code: params.get("code"),
        redirect_uri: flow.redirectUri,
        code_verifier: flow.verifier,
      }),
    });
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (!data.access_token) {
      throw new Error(`GitHub did not issue a token: ${data.error ?? `HTTP ${res.status}`}`);
    }
    const identity = await fetchIdentity(data.access_token);
    await saveToken(identity);
    webOutcome = {
      status: "authorized",
      user: { login: identity.login, name: identity.name, email: identity.email },
    };
    return { ok: true, message: `Connected to GitHub as ${identity.login}.` };
  } catch (e) {
    webOutcome = { status: "denied", error: (e as Error).message };
    return { ok: false, message: (e as Error).message };
  }
}

/** One poll of the browser sign-in; a recorded outcome is delivered once. */
export function pollWebFlow(): WebPollResult {
  if (webOutcome) {
    const out = webOutcome;
    webOutcome = null;
    return out;
  }
  if (!pendingWeb) return { status: "expired" };
  if (Date.now() > pendingWeb.expiresAt) {
    pendingWeb = null;
    return { status: "expired" };
  }
  return { status: "pending" };
}

/**
 * The GitHub identity a token belongs to. A hidden email falls back to the
 * account's noreply address so commits still attribute to the account.
 */
export async function fetchIdentity(token: string): Promise<TokenRecord> {
  const res = await fetch(`${githubApiBase()}/user`, {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GitHub identity lookup failed: HTTP ${res.status}`);
  const user = (await res.json()) as {
    login?: string;
    id?: number;
    name?: string | null;
    email?: string | null;
  };
  if (!user.login) throw new Error("GitHub identity lookup failed: no login in response");
  const id = user.id ?? 0;
  return {
    token,
    login: user.login,
    name: user.name ?? null,
    email: user.email ?? `${id}+${user.login}@users.noreply.github.com`,
    id,
  };
}

/** The stored sign-in, or null when signed out. */
export function getAuth(): Promise<TokenRecord | null> {
  return loadToken();
}

export async function signOut(): Promise<void> {
  pending = null;
  pendingWeb = null;
  webOutcome = null;
  await clearToken();
}

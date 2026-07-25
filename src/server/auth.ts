// GitHub sign-in via the GitHub App device flow
// (specs/git-operations.spec.md): the user enters a short code at
// github.com/login/device; the resulting user token is the HTTPS credential
// the system-git engine authenticates with, and the identity that authors
// data-repo commits. The GitHub CLI engine gets both from gh instead.
// Tokens are stored through tokenStore (OS-encrypted in the desktop app).

import { CLIENT_ID_PLACEHOLDER, githubApiBase, githubClientId, githubWebBase } from "./github";
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
  await clearToken();
}

// GitHub endpoints and app identity (git-operations.md). The
// device-flow client id identifies the SpecDriven GitHub App; it is public
// by design (device flow needs no secret). The base-url overrides exist so
// tests can point sign-in and git transport at local stub servers.

/**
 * Placeholder until the SpecDriven GitHub App is registered; sign-in
 * reports a clear configuration error while this is the effective id.
 */
export const CLIENT_ID_PLACEHOLDER = "specdriven-app-not-registered";

/** GitHub App client id for the device flow; public, overridable for tests. */
export function githubClientId(): string {
  return process.env.SPECDRIVEN_GITHUB_CLIENT_ID || CLIENT_ID_PLACEHOLDER;
}

/**
 * GitHub App client secret, needed only by the browser (web application)
 * sign-in flow: GitHub requires it when exchanging the authorization code,
 * even with PKCE. Empty when not configured — the device flow still works
 * without it.
 */
export function githubClientSecret(): string {
  return process.env.SPECDRIVEN_GITHUB_CLIENT_SECRET || "";
}

/** Base url for github.com itself: sign-in pages and git smart-HTTP. */
export function githubWebBase(): string {
  return (process.env.SPECDRIVEN_GITHUB_URL || "https://github.com").replace(/\/+$/, "");
}

/** Base url for the GitHub REST API. */
export function githubApiBase(): string {
  return (process.env.SPECDRIVEN_GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

/** Clone/push url for a repository on its GitHub host (github.com by default). */
export function remoteUrl(owner: string, name: string, host?: string): string {
  return `${webBase(host)}/${owner}/${name}.git`;
}

/** The host of github.com itself, which every sign-in had before GitHub Enterprise. */
export const GITHUB_HOST = "github.com";

/**
 * Base url of a GitHub host: github.com itself (with its test override), or
 * a GitHub Enterprise server — GHES at its own name, GHE.com under
 * `<name>.ghe.com`. A loopback host (a test's stub server) is plain http.
 */
export function webBase(host: string = GITHUB_HOST): string {
  if (host === GITHUB_HOST) return githubWebBase();
  return `${isLoopbackHost(host) ? "http" : "https"}://${host}`;
}

/** `localhost` or `127.0.0.1`, with or without a port. */
export function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
}

/**
 * REST API base of a GitHub host: api.github.com for github.com, the
 * `api.` subdomain on GHE.com, and `/api/v3` on a GitHub Enterprise Server.
 */
export function apiBase(host: string = GITHUB_HOST): string {
  if (host === GITHUB_HOST) return githubApiBase();
  if (/\.ghe\.com$/i.test(host)) return `https://api.${host}`;
  return `${webBase(host)}/api/v3`;
}

/** Where a person makes a fine-grained personal access token on that host. */
export function newTokenUrl(host: string = GITHUB_HOST): string {
  return `${webBase(host)}/settings/personal-access-tokens/new`;
}

/**
 * Whether a sign-in made on `signInHost` (absent: github.com, as on every
 * record saved before GitHub Enterprise) belongs to `host` — the only host
 * its token may be sent to, by git or by an API call.
 */
export function sameHost(signInHost: string | undefined, host: string): boolean {
  return (signInHost ?? GITHUB_HOST).toLowerCase() === host.toLowerCase();
}

/** Whether `url` points at `host` — the one place a sign-in's token may go. */
export function urlOnHost(url: string, host: string = GITHUB_HOST): boolean {
  try {
    const base = new URL(webBase(host));
    const target = new URL(url);
    return target.protocol === base.protocol && target.host.toLowerCase() === base.host.toLowerCase();
  } catch {
    return false;
  }
}

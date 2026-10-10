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

/** Clone/push url for a repository under the effective GitHub base. */
export function remoteUrl(owner: string, name: string): string {
  return `${githubWebBase()}/${owner}/${name}.git`;
}

// Hosted mode (SPECDRIVEN_HOSTED=1): this server runs as one user's worker
// behind the hosted gateway (src/gateway, docs/deployment-railway.md). The
// gateway signs the user in, owns their GitHub token and agent keys, and
// gives each user a worker of their own over a private socket. Several
// users' workers share one container, so nothing a worker serves may run
// code or reach outside that user's folder: local coding agents, plugin
// installs, the native folder chooser, IntelliJ and local-folder data repos
// are all off, and GitHub sign-in is the gateway's, not the worker's.

export function isHostedMode(): boolean {
  const v = process.env.SPECDRIVEN_HOSTED;
  return v === "1" || v === "true";
}

/** The refusal a hosted worker answers a route that is off there with. */
export const HOSTED_REFUSAL = "This is not available in the hosted app";

// Hosted mode (SPECDRIVEN_HOSTED=1): this server runs as one user's worker
// behind the hosted gateway (src/gateway, docs/deployment-railway.md). The
// gateway signs the user in, owns their GitHub access, and gives each user a
// worker of their own over a private socket. Several
// users' workers share one container, so nothing a worker serves may run
// code or reach outside that user's folder: local coding agents, plugin
// installs, the native folder chooser, IntelliJ and local-folder data repos
// are all off, and GitHub sign-in is the gateway's, not the worker's.

import { timingSafeEqual } from "node:crypto";

export function isHostedMode(): boolean {
  const v = process.env.SPECDRIVEN_HOSTED;
  return v === "1" || v === "true";
}

/** The refusal a hosted worker answers a route that is off there with. */
export const HOSTED_REFUSAL = "This is not available in the hosted app";

/** The header a hosted worker's gateway proves itself with (src/gateway/workers.ts). */
const WORKER_KEY_HEADER = "x-specdriven-worker-key";

/**
 * The check a hosted worker makes of every request when its gateway gave it
 * a key (SPECDRIVEN_WORKER_KEY): the refusal for a request that does not
 * carry it, or null. Several people's workers share one container, and each
 * worker owns the folder its socket is in — so a worker someone has taken
 * over could put a link to another person's socket where its own belongs,
 * and the gateway would forward the attacker's requests there. Those carry
 * the attacker's worker's key, which this worker refuses.
 */
export function workerKeyGuard(key: string | undefined): (req: Request) => Response | null {
  const expected = key?.trim() ? Buffer.from(key.trim()) : null;
  return (req) => {
    if (!expected) return null;
    const given = Buffer.from(req.headers.get(WORKER_KEY_HEADER) ?? "");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return null;
    return Response.json({ error: "This request is not from this workspace's gateway" }, { status: 401 });
  };
}

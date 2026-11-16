// The hosted image's first process, as root (docs/hosted-tenant-isolation.md
// "Step 2"): it readies the volume, listens for the gateway on a unix
// socket (spawnerSocket.ts), and starts the gateway itself as a uid that is
// not root — the process that answers the internet, signs people in and
// holds the master key. From then on root does three things when asked:
// start a person's worker, stop it, report on it (spawner.ts).
//
// It stays the parent of both: a stop from the platform reaches it, it
// passes it to the gateway, and when the gateway has gone it ends whatever
// worker is left and goes too.

import { join } from "node:path";
import type { GatewayConfig } from "./config";
import { randomToken } from "./crypto";
import { asUser, GATEWAY_UID, runAs } from "./limits";
import { Spawner } from "./spawner";
import { serveSpawner, SPAWNER_KEY_ENV, SPAWNER_SOCKET_ENV } from "./spawnerSocket";
import { prepareVolume } from "./volume";

type Env = Record<string, string | undefined>;

export const DEFAULT_SPAWNER_SOCKET = "/run/specdriven/spawner.sock";

/** Whether workers are confined beyond their uid (sandbox.ts); SPECDRIVEN_WORKER_SANDBOX=off turns it off. */
export function workerSandbox(env: Env = process.env): boolean {
  return env.SPECDRIVEN_WORKER_SANDBOX !== "off";
}

/** Runs the spawner, and the gateway under it, until the gateway exits. */
export async function runSpawner(config: GatewayConfig): Promise<never> {
  // Everything root makes here is its own unless it says otherwise.
  process.umask(0o077);
  const stateDir = await prepareVolume(config.dataDir, GATEWAY_UID);

  const sandbox = workerSandbox();
  if (sandbox) {
    // Tried as a uid with nothing to lose, and said once: what this kernel
    // holds a worker to (sandboxCheck.ts).
    const check = await runAs(GATEWAY_UID, [process.execPath, join(import.meta.dir, "sandboxCheck.ts")], 60_000);
    const line = check.stdout.trim() || check.stderr.trim().slice(0, 500) || "no answer";
    (check.exitCode === 0 ? console.log : console.error)(`workers: a uid each; ${line}`);
  } else {
    console.error("workers: a uid each, and nothing more: SPECDRIVEN_WORKER_SANDBOX=off");
  }

  const spawner = new Spawner({ dataDir: config.dataDir, entry: config.workerEntry, gatewayGid: GATEWAY_UID, sandbox });
  const path = process.env[SPAWNER_SOCKET_ENV]?.trim() || DEFAULT_SPAWNER_SOCKET;
  const key = randomToken();
  const server = await serveSpawner(spawner, { path, key, gid: GATEWAY_UID });

  const gateway = Bun.spawn([...asUser(GATEWAY_UID), process.execPath, join(import.meta.dir, "index.ts")], {
    env: { ...process.env, [SPAWNER_SOCKET_ENV]: path, [SPAWNER_KEY_ENV]: key, HOME: join(stateDir, "home") },
    stdio: ["inherit", "inherit", "inherit"],
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => gateway.kill(signal));

  const code = await gateway.exited;
  await spawner.stopAll();
  await server.close();
  process.exit(code);
}

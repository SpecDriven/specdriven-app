// The spec-proposals service on the hosted image (docs/deployment-railway.md
// "Spec proposals service"). railway.json builds every service from
// Dockerfile.hosted, so the gateway's entry point is what a
// SPECDRIVEN_PROPOSALS=1 service starts — and, like the demo (demo.ts), it
// hands over to the single-process app (src/index.ts), which runs the
// service. The image runs as root; the service has no use for that, so its
// folder on the volume is handed to the unprivileged `bun` user and the app
// drops to it.

import { chown, mkdir } from "node:fs/promises";
import { demoCommand } from "./demo";

type Env = Record<string, string | undefined>;

/** The environment the service runs with: listening publicly, answering to its own domain. */
export function proposalsEnv(env: Env): Env {
  let host = "";
  try {
    host = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).host : "";
  } catch {
    // readProposalsConfig reports a bad PUBLIC_URL when the app starts
  }
  const dataDir = env.SPECDRIVEN_DATA_DIR || "/data";
  const root = env.SPECDRIVEN_ROOT || `${dataDir}/proposals`;
  return {
    ...env,
    SPECDRIVEN_ROOT: root,
    // git reads $HOME/.gitconfig: after dropping from root it must not be
    // pointed at /root, which the bun user cannot read.
    HOME: `${root}/home`,
    SPECDRIVEN_PROPOSALS_DB: env.SPECDRIVEN_PROPOSALS_DB || `${dataDir}/proposals/proposals.db`,
    SPECDRIVEN_LOG_FILE: env.SPECDRIVEN_LOG_FILE || "0",
    SPECDRIVEN_HOST: env.SPECDRIVEN_HOST || "0.0.0.0",
    SPECDRIVEN_ALLOWED_HOSTS: env.SPECDRIVEN_ALLOWED_HOSTS || host,
  };
}

async function bunIds(): Promise<{ uid: number; gid: number } | null> {
  const passwd = await Bun.file("/etc/passwd").text().catch(() => "");
  const line = passwd.split("\n").find((l) => l.startsWith("bun:"));
  if (!line) return null;
  const [, , uid, gid] = line.split(":");
  return { uid: Number(uid), gid: Number(gid) };
}

/** Runs the proposals service in the gateway's place and exits with it. */
export async function runProposals(): Promise<never> {
  const env = proposalsEnv(process.env);
  const isRoot = process.getuid?.() === 0;
  const ids = isRoot ? await bunIds() : null;
  await mkdir(env.HOME!, { recursive: true, mode: 0o700 });
  if (ids) for (const dir of [env.SPECDRIVEN_ROOT!, env.HOME!]) await chown(dir, ids.uid, ids.gid);
  const child = Bun.spawn(demoCommand(isRoot, Bun.which("setpriv"), ids !== null), {
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  process.exit(await child.exited);
}

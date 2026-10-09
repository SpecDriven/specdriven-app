// The public demo on the hosted image. railway.json builds every Railway
// service from this repository with Dockerfile.hosted, the demo service
// included, so the gateway's entry point is what a DEMO_MODE=1 service starts.
// The demo is the single-user app (src/index.ts, as Dockerfile runs it), not
// the sign-in gateway: hand over to it with the settings Dockerfile gives it.
//
// The hosted image runs as root (for the gateway's per-user workers); the
// demo has no use for that, so it drops to the image's unprivileged `bun`
// user, as Dockerfile does with USER bun.

import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** The environment the demo app runs with: Dockerfile's, unless set already. */
export function demoEnv(env: Env): Env {
  return {
    ...env,
    SPECDRIVEN_ROOT: env.SPECDRIVEN_ROOT || "/tmp/specdriven-demo",
    SPECDRIVEN_LOG_FILE: env.SPECDRIVEN_LOG_FILE || "0",
    SPECDRIVEN_HOST: env.SPECDRIVEN_HOST || "0.0.0.0",
    SPECDRIVEN_ALLOWED_HOSTS: env.SPECDRIVEN_ALLOWED_HOSTS || "*",
  };
}

/**
 * The demo app's command line: as the bun user when started as root and the
 * image has both that user and setpriv, else as whoever started it.
 */
export function demoCommand(isRoot: boolean, setpriv: string | null, hasBunUser: boolean): string[] {
  const app = [process.execPath, join(import.meta.dir, "..", "index.ts")];
  if (!isRoot) return app;
  if (!setpriv || !hasBunUser) {
    console.error("DEMO_MODE runs as root: install setpriv and add a bun user to run it unprivileged");
    return app;
  }
  return [setpriv, "--reuid=bun", "--regid=bun", "--init-groups", "--no-new-privs", "--", ...app];
}

async function bunUserExists(): Promise<boolean> {
  const passwd = await Bun.file("/etc/passwd").text().catch(() => "");
  return passwd.split("\n").some((line) => line.startsWith("bun:"));
}

/** Runs the demo app in the gateway's place and exits with it. */
export async function runDemo(): Promise<never> {
  const isRoot = process.getuid?.() === 0;
  const child = Bun.spawn(demoCommand(isRoot, Bun.which("setpriv"), isRoot && (await bunUserExists())), {
    env: demoEnv(process.env),
    stdio: ["inherit", "inherit", "inherit"],
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  process.exit(await child.exited);
}

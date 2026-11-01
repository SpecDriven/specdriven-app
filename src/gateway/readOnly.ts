// The public read-only spec site on the hosted image (docs/deployment-railway.md
// "Public read-only site"). railway.json builds every service from
// Dockerfile.hosted, so the gateway's entry point is what a
// SPECDRIVEN_READONLY=1 service starts — and, like the demo (demo.ts), it
// hands over to the single-process app (src/index.ts), which clones the spec
// repo and serves it (src/server/readOnly.ts). The image runs as root; the
// site has no use for that and drops to the unprivileged `bun` user.

import { demoCommand } from "./demo";

type Env = Record<string, string | undefined>;

/**
 * The environment the site runs with: listening publicly under whatever
 * domain the platform routes to it — every write is refused, so there is no
 * cross-site request to guard against — with its clone and settings under
 * /tmp, nothing on a volume.
 */
export function readOnlyEnv(env: Env): Env {
  const root = env.SPECDRIVEN_ROOT || "/tmp/specdriven-readonly";
  return {
    ...env,
    SPECDRIVEN_ROOT: root,
    // git reads $HOME/.gitconfig: after dropping from root it must not be
    // pointed at /root, which the bun user cannot read.
    HOME: `${root}/home`,
    SPECDRIVEN_LOG_FILE: env.SPECDRIVEN_LOG_FILE || "0",
    SPECDRIVEN_HOST: env.SPECDRIVEN_HOST || "0.0.0.0",
    SPECDRIVEN_ALLOWED_HOSTS: env.SPECDRIVEN_ALLOWED_HOSTS || "*",
    // No agent plugins are fetched from the marketplace for a visitor.
    SPECDRIVEN_NO_AUTO_INSTALL: "1",
  };
}

async function bunUserExists(): Promise<boolean> {
  const passwd = await Bun.file("/etc/passwd").text().catch(() => "");
  return passwd.split("\n").some((line) => line.startsWith("bun:"));
}

/** Runs the read-only site in the gateway's place and exits with it. */
export async function runReadOnly(): Promise<never> {
  const isRoot = process.getuid?.() === 0;
  const child = Bun.spawn(demoCommand(isRoot, Bun.which("setpriv"), isRoot && (await bunUserExists())), {
    env: readOnlyEnv(process.env),
    stdio: ["inherit", "inherit", "inherit"],
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  process.exit(await child.exited);
}

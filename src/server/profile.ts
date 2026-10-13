// `--profile <dir>` (README "Settings"): run the app on a settings folder of
// its own, e.g. `bun run dev --profile /tmp/try-clone`, so trying the
// first-run screen or a pasted token never touches the real settings, GitHub
// token or clones. It only fills in the variables every location is already
// read from at call time — SPECDRIVEN_ROOT, SPECDRIVEN_HOME and
// SPECDRIVEN_REPOS_DIR — and one set explicitly still wins.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** The `--profile` folder named on the command line, or null. */
export function profileArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--profile=")) return arg.slice("--profile=".length) || null;
    if (arg === "--profile") return argv[i + 1] ?? null;
  }
  return null;
}

/**
 * Point settings (`<dir>/.specdriven/settings.json`), the home folder (the
 * fallback settings file, the GitHub token, logs, plugins) and GitHub clones
 * into `dir`. Returns the absolute folder, or null with no `--profile`.
 */
export function applyProfile(
  argv: string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const named = profileArg(argv);
  if (!named) return null;
  const dir = resolve(named);
  env.SPECDRIVEN_ROOT ||= dir;
  env.SPECDRIVEN_HOME ||= join(dir, "home");
  env.SPECDRIVEN_REPOS_DIR ||= join(dir, "repos");
  for (const d of [env.SPECDRIVEN_ROOT, env.SPECDRIVEN_HOME, env.SPECDRIVEN_REPOS_DIR]) {
    mkdirSync(d!, { recursive: true });
  }
  return dir;
}

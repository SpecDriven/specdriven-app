#!/usr/bin/env bun
/**
 * Bumps the release version (roadmap/deployment.md "Versioning"):
 *
 *   bun run bump patch     0.1.0 -> 0.1.1
 *   bun run bump minor     0.1.0 -> 0.2.0
 *   bun run bump major     0.1.0 -> 1.0.0
 *   bun run bump 1.2.3     an explicit version
 *
 * package.json is the one place the version lives — it is what
 * electron-builder names the desktop artifacts after, what the release is
 * tagged as, and what install.sh looks for under releases/download/v<version>.
 * This writes it, commits that one file, and tags v<version>.
 *
 * Pushing is left to you, since pushing the tag is what publishes the release:
 *
 *   git push origin <branch> --follow-tags
 *
 * Pass --no-git to write package.json alone, or --dry-run to see what would
 * happen without touching anything.
 */
import { $ } from "bun";

const PKG = "package.json";

/** Release versions are plain X.Y.Z — no prerelease or build metadata. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export interface Options {
  /** "major", "minor", "patch", or an explicit X.Y.Z. */
  bump: string;
  /** Commit and tag, not just rewrite package.json. */
  git: boolean;
  dryRun: boolean;
}

export function parseArgs(args: string[]): Options {
  const known = ["--no-git", "--dry-run"];
  const flags = args.filter((a) => a.startsWith("-"));
  const rest = args.filter((a) => !a.startsWith("-"));

  const unknown = flags.find((f) => !known.includes(f));
  if (unknown) throw new Error(`unknown option ${unknown} — expected ${known.join(", ")}`);
  if (rest.length === 0) {
    throw new Error("say what to bump — major, minor, patch, or a version like 1.2.3");
  }
  if (rest.length > 1) throw new Error(`expected one version argument, got: ${rest.join(" ")}`);

  return {
    bump: rest[0]!,
    git: !flags.includes("--no-git"),
    dryRun: flags.includes("--dry-run"),
  };
}

function parts(version: string): [number, number, number] {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`"${version}" is not a X.Y.Z version`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative, zero or positive as `a` sorts before, with, or after `b`. */
function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * The version `bump` moves `current` to. An explicit version has to come
 * after the current one: released versions name immutable artifacts, so a
 * version that goes backwards would overwrite a build people already have.
 */
export function nextVersion(current: string, bump: string): string {
  let major: number, minor: number, patch: number;
  try {
    [major, minor, patch] = parts(current);
  } catch {
    throw new Error(`${PKG} version "${current}" is not a X.Y.Z version`);
  }

  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;

  if (!SEMVER.test(bump)) {
    throw new Error(`"${bump}" is neither major, minor, patch, nor a version like 1.2.3`);
  }
  if (compare(parts(bump), [major, minor, patch]) <= 0) {
    throw new Error(`${bump} does not come after the current ${current}`);
  }
  return bump;
}

export function readVersion(pkgJson: string): string {
  const version = JSON.parse(pkgJson).version;
  if (typeof version !== "string") throw new Error(`${PKG} has no version field`);
  return version;
}

/**
 * Rewrites the version in package.json's *text* rather than reserializing the
 * parsed object, so indentation, key order and the trailing newline survive
 * a bump untouched — the diff is one line.
 */
export function setVersion(pkgJson: string, next: string): string {
  const current = readVersion(pkgJson);
  const pattern = new RegExp(`("version"\\s*:\\s*")${current.replace(/\./g, "\\.")}(")`);
  if (!pattern.test(pkgJson)) throw new Error(`could not find the version line in ${PKG}`);

  const out = pkgJson.replace(pattern, `$1${next}$2`);
  // The first match is the top-level one; confirm that is what moved.
  if (readVersion(out) !== next) throw new Error(`rewriting the version in ${PKG} did not take`);
  return out;
}

async function assertGitReady(tag: string): Promise<void> {
  const status = await $`git status --porcelain`.nothrow().quiet();
  if (status.exitCode !== 0) {
    throw new Error(`not a git repository — pass --no-git to bump ${PKG} alone`);
  }
  const dirty = status.text().trim();
  if (dirty) {
    throw new Error(
      `working tree is not clean — commit or stash first, so the release commit ` +
        `is the bump alone:\n${dirty}`,
    );
  }
  const exists = await $`git rev-parse -q --verify refs/tags/${tag}`.nothrow().quiet();
  if (exists.exitCode === 0) throw new Error(`tag ${tag} already exists`);
}

async function run(opts: Options): Promise<void> {
  const pkgJson = await Bun.file(PKG).text();
  const current = readVersion(pkgJson);
  const next = nextVersion(current, opts.bump);
  const tag = `v${next}`;

  if (opts.git) await assertGitReady(tag);

  if (opts.dryRun) {
    console.log(`Would bump ${current} -> ${next} in ${PKG}`);
    if (opts.git) console.log(`Would commit ${PKG} and tag ${tag}`);
    return;
  }

  await Bun.write(PKG, setVersion(pkgJson, next));
  console.log(`  ✓ ${PKG}  ${current} -> ${next}`);

  if (!opts.git) return;

  await $`git commit -q -m ${`chore: release ${tag}`} -- ${PKG}`;
  await $`git tag -a ${tag} -m ${tag}`;
  console.log(`  ✓ committed and tagged ${tag}`);

  const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
  console.log(`\nPush when ready:\n  git push origin ${branch} --follow-tags`);
}

if (import.meta.main) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`bump: ${(e as Error).message}`);
    process.exit(1);
  }
}

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
 * This writes it, adds the new version's release notes to CHANGELOG.md — the
 * pull requests merged since the last release tag (scripts/release-notes.ts)
 * — commits the two files, and tags v<version>.
 *
 * Pushing is left to you, since pushing the tag is what publishes the release:
 *
 *   git push origin <branch> --follow-tags
 *
 * Pass --no-git to write package.json alone, or --dry-run to see what would
 * happen, notes included, without touching anything.
 */
import { $ } from "bun";
import { compareVersions, parseVersion, SEMVER } from "../src/server/version";
import { changelogSection, prependSection } from "../src/frontend/releaseNotes";
import { CHANGELOG, notesSince, today } from "./release-notes";

const PKG = "package.json";

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
  const p = parseVersion(version);
  if (!p) throw new Error(`"${version}" is not a X.Y.Z version`);
  return p;
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
  if (compareVersions(bump, current) <= 0) {
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
        `is the bump and its notes alone:\n${dirty}`,
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

  // The notes come from git history, so --no-git writes none.
  const notes = opts.git ? await notesSince(next, today()) : null;
  const changelogFile = Bun.file(CHANGELOG);
  const changelog = notes && (await changelogFile.exists()) ? await changelogFile.text() : "";
  const nextChangelog = notes ? prependSection(changelog, notes) : null;

  if (opts.dryRun) {
    console.log(`Would bump ${current} -> ${next} in ${PKG}`);
    if (notes) {
      console.log(`Would add to ${CHANGELOG}:\n\n${changelogSection(notes)}`);
      console.log(`Would commit ${PKG} and ${CHANGELOG} and tag ${tag}`);
    }
    return;
  }

  await Bun.write(PKG, setVersion(pkgJson, next));
  console.log(`  ✓ ${PKG}  ${current} -> ${next}`);

  if (!opts.git || !notes || nextChangelog === null) return;

  await Bun.write(CHANGELOG, nextChangelog);
  const count = notes.entries.length;
  console.log(`  ✓ ${CHANGELOG}  ${count} change${count === 1 ? "" : "s"} since the last release`);

  await $`git add -- ${CHANGELOG}`.quiet();
  await $`git commit -q -m ${`chore: release ${tag}`} -- ${PKG} ${CHANGELOG}`;
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

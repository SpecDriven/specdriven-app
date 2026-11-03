// Release versions (specs/app/app-updates.feature.md, docs/releasing.md):
// plain X.Y.Z, no prerelease or build metadata, compared numerically. Shared
// by the bump script (scripts/bump-version.ts), which refuses a version that
// goes backwards, and the update check (src/server/appUpdate.ts), which asks
// whether the newest release comes after the one running.

/** Release versions are plain X.Y.Z — no prerelease or build metadata. */
export const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export type VersionParts = [number, number, number];

/** The three numbers of an X.Y.Z version, or null for anything else. */
export function parseVersion(version: string): VersionParts | null {
  const m = SEMVER.exec(version);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative, zero or positive as `a` sorts before, with, or after `b`; throws on a malformed version. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa) throw new Error(`"${a}" is not a X.Y.Z version`);
  if (!pb) throw new Error(`"${b}" is not a X.Y.Z version`);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

/** Whether `candidate` comes after `current`; a malformed candidate never does. */
export function isNewer(candidate: string, current: string): boolean {
  if (!parseVersion(candidate) || !parseVersion(current)) return false;
  return compareVersions(candidate, current) > 0;
}

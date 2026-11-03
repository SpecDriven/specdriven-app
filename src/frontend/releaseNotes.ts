// Release notes (specs/app/release-notes.feature.md): CHANGELOG.md at the
// repository root lists what each release changed, newest first. `bun run
// bump` writes each version's section (scripts/release-notes.ts), the release
// workflow copies it onto the GitHub release, and the What's new page reads
// it from the build. This module is the file's format, both ways — pure, so
// the frontend bundle and the scripts share it.

export const PULL_URL = "https://github.com/SpecDriven/specdriven-app/pull/";

export const CHANGELOG_HEADER =
  "# Changelog\n\n" +
  "What changed in each release of SpecDriven, newest first. `bun run bump` writes\n" +
  "each version's section from the pull requests merged since the version before\n" +
  "it ([docs/releasing.md](docs/releasing.md)).\n";

/** Said for a release that merged no pull request of note. */
export const NO_CHANGES = "Maintenance release.";

export interface ReleaseEntry {
  title: string;
  /** The pull request the change was merged in, when it has one. */
  pr: number | null;
}

export interface Release {
  /** X.Y.Z, without the v. */
  version: string;
  /** YYYY-MM-DD, or null when the heading carries none. */
  date: string | null;
  entries: ReleaseEntry[];
}

const HEADING = /^## v(\d+\.\d+\.\d+)(?:\s+[—-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
const ENTRY = /^- (.*?)(?: \(\[#(\d+)\]\([^)]*\)\))?\s*$/;

export function formatEntry(entry: ReleaseEntry): string {
  return entry.pr === null
    ? `- ${entry.title}`
    : `- ${entry.title} ([#${entry.pr}](${PULL_URL}${entry.pr}))`;
}

/** One version's section: its heading and a line per change. */
export function changelogSection(release: Release): string {
  const heading = `## v${release.version}${release.date ? ` — ${release.date}` : ""}`;
  const lines = release.entries.length ? release.entries.map(formatEntry) : [`- ${NO_CHANGES}`];
  return `${heading}\n\n${lines.join("\n")}\n`;
}

/** The whole file for these releases, newest first as given. */
export function formatChangelog(releases: Release[]): string {
  return [CHANGELOG_HEADER, ...releases.map(changelogSection)].join("\n");
}

/**
 * Every release the file lists, in file order (newest first). Lines that
 * are neither a version heading nor a change — the header, blank lines —
 * are skipped, so a hand-edited file still reads.
 */
export function parseChangelog(text: string): Release[] {
  const releases: Release[] = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      releases.push({ version: heading[1]!, date: heading[2] ?? null, entries: [] });
      continue;
    }
    const current = releases[releases.length - 1];
    const entry = current && ENTRY.exec(line);
    if (!current || !entry) continue;
    if (entry[1] === NO_CHANGES && !entry[2]) continue;
    current.entries.push({ title: entry[1]!, pr: entry[2] ? Number(entry[2]) : null });
  }
  return releases;
}

/** The lines under `## v<version>`, without the heading, or null when absent. */
export function sectionFor(text: string, version: string): string | null {
  const want = version.replace(/^v/, "");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => HEADING.exec(l)?.[1] === want);
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim() + "\n";
}

/**
 * The changelog with `section` added as its newest release, right under the
 * header. A version already listed is refused: each release is written once.
 */
export function prependSection(changelog: string, release: Release): string {
  if (sectionFor(changelog, release.version) !== null) {
    throw new Error(`CHANGELOG.md already has a section for v${release.version}`);
  }
  const section = changelogSection(release);
  const text = changelog.trim() ? changelog : CHANGELOG_HEADER;
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.startsWith("## "));
  if (first === -1) return `${text.trimEnd()}\n\n${section}`;
  return [...lines.slice(0, first), section, ...lines.slice(first)].join("\n");
}

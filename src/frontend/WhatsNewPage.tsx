// What's new (specs/app/release-notes.feature.md): every release's notes,
// newest first, in an editor-pane page opened from the user menu like Data.
// The notes are CHANGELOG.md, bundled into the build — `bun run bump` writes
// each version's section from the pull requests merged since the version
// before it — so the page needs no server and the read-only site and the
// demo show it as they are. The running version is marked as the one
// installed; a version the user has not seen yet marks the menu entry and
// the version beside the user name until the page is opened.

import changelog from "../../CHANGELOG.md" with { type: "text" };
import { AppPageLayout, PageSection } from "./AppPage";
import { PULL_URL, parseChangelog, type Release } from "./releaseNotes";

/** How many releases the section nav lists; the page itself shows them all. */
export const NAV_RELEASES = 12;

/** The releases CHANGELOG.md lists, newest first. */
export const RELEASES: Release[] = parseChangelog(changelog);

/** Where the last version the user opened What's new on is kept, per browser. */
const SEEN_KEY = "specdriven.whatsNewSeen";

/**
 * Whether `version`'s notes are news to this browser: a version the user has
 * not opened What's new on since it was installed. The first version a
 * browser runs is recorded as seen — a fresh install has nothing new to
 * point at — and storage that cannot be read marks nothing.
 */
export function hasUnseenNotes(version: string | null, storage: Storage | null = safeStorage()): boolean {
  if (!version || !storage) return false;
  try {
    const seen = storage.getItem(SEEN_KEY);
    if (seen === null) {
      storage.setItem(SEEN_KEY, version);
      return false;
    }
    return seen !== version;
  } catch {
    return false;
  }
}

/** Record that the user has seen `version`'s notes. */
export function markNotesSeen(version: string | null, storage: Storage | null = safeStorage()): void {
  if (!version || !storage) return;
  try {
    storage.setItem(SEEN_KEY, version);
  } catch {
    // No storage here: the mark simply comes back next time.
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const sectionId = (version: string) => `release-${version.replace(/\./g, "-")}`;

export function WhatsNewPage({
  installed,
  releases = RELEASES,
  onClose,
}: {
  /** The running app's version, marked on its release. */
  installed: string | null;
  releases?: Release[];
  onClose(): void;
}) {
  return (
    <AppPageLayout
      title="What's new"
      className="whats-new"
      sections={releases.slice(0, NAV_RELEASES).map((r) => ({ id: sectionId(r.version), title: `v${r.version}` }))}
      onClose={onClose}
    >
      {releases.length === 0 && <p className="page-empty">No release notes in this build.</p>}
      {releases.map((r) => (
        <PageSection
          key={r.version}
          id={sectionId(r.version)}
          title={`v${r.version}`}
          hint={
            <>
              {r.date}
              {r.version === installed && <span className="release-installed">Installed</span>}
            </>
          }
          className="release-notes"
        >
          <ul>
            {r.entries.length === 0 ? (
              <li className="release-note-empty">Maintenance release.</li>
            ) : (
              r.entries.map((e, i) => (
                <li key={i}>
                  {e.title}
                  {e.pr !== null && (
                    <>
                      {" "}
                      <a className="release-note-pr" href={`${PULL_URL}${e.pr}`} target="_blank" rel="noreferrer">
                        #{e.pr}
                      </a>
                    </>
                  )}
                </li>
              ))
            )}
          </ul>
        </PageSection>
      ))}
    </AppPageLayout>
  );
}

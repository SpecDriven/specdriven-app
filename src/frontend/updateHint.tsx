// A newer release the app knows of (specs/app/app-updates.feature.md "checks
// once a day"): the version chip beside the user chip carries a dot for it,
// and on the desktop app the chip itself is the way to the Updates page. The
// server's daily check, or a manual one, puts the newer version on
// /api/state as `updateAvailable`; what the dot says on hover is the version
// itself. Pure markup, so tests render it without a DOM.
import type { ReactNode } from "react";

/** What the dot says on hover: which version is out. */
export function updateTitle(version: string): string {
  return `SpecDriven ${version} is available`;
}

/** The accent dot, where a newer version is known; nothing otherwise. */
export function UpdateDot({ version }: { version: string | null }): ReactNode {
  if (!version) return null;
  return <span className="update-dot" role="img" aria-label={updateTitle(version)} title={updateTitle(version)} />;
}

/**
 * The build on screen, right of the user name: `v<version>`, a dot for
 * release notes not read yet (What's new), and a dot for a newer release.
 * Given `onOpen` — the desktop app, which can replace itself — it is a
 * button that opens the Updates page (Check for Updates…).
 */
export function VersionChip({
  version,
  notesUnseen,
  updateAvailable,
  onOpen,
}: {
  version: string;
  notesUnseen: boolean;
  updateAvailable: string | null;
  onOpen?: () => void;
}): ReactNode {
  const content = (
    <>
      v{version}
      {/* An update whose notes are not read yet (What's new). */}
      {notesUnseen && <span className="unseen-dot" role="img" aria-label="new release notes" />}
      <UpdateDot version={updateAvailable} />
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        className="app-version"
        title={updateAvailable ? updateTitle(updateAvailable) : "Check for Updates…"}
        onClick={onOpen}
      >
        {content}
      </button>
    );
  }
  return (
    <span className="app-version" title={updateAvailable ? updateTitle(updateAvailable) : undefined}>
      {content}
    </span>
  );
}

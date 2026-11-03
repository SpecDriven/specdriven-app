// A newer release the app knows of (specs/app/app-updates.feature.md "checks
// once a day"): the version chip on the user chip and the Check for Updates…
// menu item each carry a dot for it. The server's daily check, or a manual
// one, puts the newer version on /api/state as `updateAvailable`; what the
// dot says on hover is the version itself. Pure markup, so tests render it
// without a DOM.
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { MenuItem } from "./Menu";

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
 */
export function VersionChip({
  version,
  notesUnseen,
  updateAvailable,
}: {
  version: string;
  notesUnseen: boolean;
  updateAvailable: string | null;
}): ReactNode {
  return (
    <span className="app-version" title={updateAvailable ? updateTitle(updateAvailable) : undefined}>
      v{version}
      {/* An update whose notes are not read yet (What's new). */}
      {notesUnseen && <span className="unseen-dot" role="img" aria-label="new release notes" />}
      <UpdateDot version={updateAvailable} />
    </span>
  );
}

/** Check for Updates… on the user menu, marked when a newer release is known; opens the Updates page. */
export function checkForUpdatesMenuItem(updateAvailable: string | null, open: () => void): MenuItem {
  return {
    id: "updates",
    label: (
      <span className="whats-new-label">
        Check for Updates…
        <UpdateDot version={updateAvailable} />
      </span>
    ),
    icon: <RefreshCw size={13} />,
    title: updateAvailable ? updateTitle(updateAvailable) : undefined,
    onSelect: open,
  };
}

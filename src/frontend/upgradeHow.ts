// How to install a newer SpecDriven by hand, per platform
// (specs/app/installation.feature.md): shared by the update screen
// (src/frontend/AppOutdated.tsx) and the Updates page
// (src/frontend/UpdatesPage.tsx).

export const RELEASE_REPO_URL = "https://github.com/SpecDriven/specdriven-app";
const LATEST_RELEASE_URL = `${RELEASE_REPO_URL}/releases/latest`;
const RAW_URL = "https://raw.githubusercontent.com/SpecDriven/specdriven-app/main";

export type UpgradePlatform = "desktop" | "windows" | "unix";

export interface UpgradeHow {
  /** The installer one-liner, when the platform has one. */
  command: string | null;
  /** The releases page, for the desktop download and as a fallback. */
  url: string;
}

/** What to tell the user to run on their platform (app/installation.feature.md). */
export function upgradeInstructions(platform: UpgradePlatform): UpgradeHow {
  if (platform === "windows") {
    return { command: `irm ${RAW_URL}/install.ps1 | iex`, url: LATEST_RELEASE_URL };
  }
  if (platform === "unix") {
    return { command: `curl -fsSL ${RAW_URL}/install.sh | sh`, url: LATEST_RELEASE_URL };
  }
  return { command: null, url: LATEST_RELEASE_URL };
}

/** This page's platform, from what main.tsx and the browser say. */
export function currentPlatform(): UpgradePlatform {
  if (document.documentElement.dataset.desktop) return "desktop";
  return navigator.userAgent.includes("Windows") ? "windows" : "unix";
}

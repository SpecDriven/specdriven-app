// Data saved by a newer app (specs/app/data-format.feature.md): the server
// stops syncing and writing to the folder, and this screen takes the place of
// the app until the user installs a newer version or opens another folder.

import { useState } from "react";

/** The header the server sets on every API answer while the folder is blocked. */
export const DATA_TOO_NEW_HEADER = "X-SpecDriven-Data-Too-New";

export const RELEASE_REPO_URL = "https://github.com/SpecDriven/specdriven-app-release";
const LATEST_RELEASE_URL = `${RELEASE_REPO_URL}/releases/latest`;
const RAW_URL = "https://raw.githubusercontent.com/SpecDriven/specdriven-app-release/main";

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

/**
 * Watch every API answer for the blocked-folder header, so a folder a
 * teammate's newer app has just raised is caught by whatever request comes
 * next — the feature list's routine refresh, a save, a plugin's read.
 * Returns the function that stops watching.
 */
export function watchDataTooNew(onTooNew: (minAppVersion: string | null) => void): () => void {
  const original = globalThis.fetch;
  const watching = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args);
    const marked = res.headers?.get(DATA_TOO_NEW_HEADER);
    if (marked !== null && marked !== undefined) onTooNew(marked || null);
    return res;
  }, original) as typeof fetch;
  globalThis.fetch = watching;
  return () => {
    if (globalThis.fetch === watching) globalThis.fetch = original;
  };
}

export function AppOutdated({
  appVersion,
  minAppVersion,
  platform = currentPlatform(),
  checking,
  onCheckAgain,
  onOtherFolder,
}: {
  appVersion: string | null;
  minAppVersion: string | null;
  platform?: UpgradePlatform;
  checking: boolean;
  onCheckAgain: () => void;
  onOtherFolder: () => void;
}) {
  const how = upgradeInstructions(platform);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!how.command) return;
    try {
      await navigator.clipboard.writeText(how.command);
      setCopied(true);
    } catch {
      // No clipboard here — the command is on screen to select by hand.
    }
  };
  return (
    <main className="centered">
      <section className="repo-prompt app-outdated" role="alert" aria-label="Update required">
        <h1>Update SpecDriven</h1>
        <p>
          This folder was saved by a newer version of SpecDriven
          {minAppVersion ? (
            <>
              {" "}
              and needs <strong>{minAppVersion}</strong> or later
            </>
          ) : null}
          {appVersion ? <>. You are running {appVersion}.</> : "."}
        </p>
        <p>
          To keep your team's specs safe, this version won't sync or change the folder. Install the
          latest version to keep working.
        </p>
        {how.command ? (
          <>
            <p>{platform === "windows" ? "In PowerShell, run:" : "In a terminal, run:"}</p>
            <div className="input-row">
              <code className="upgrade-command">{how.command}</code>
              <button type="button" className="browse" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p>
              Or download it from the{" "}
              <a href={how.url} target="_blank" rel="noreferrer">
                releases page
              </a>
              .
            </p>
          </>
        ) : (
          <p>
            Download the latest desktop app from the{" "}
            <a href={how.url} target="_blank" rel="noreferrer">
              releases page
            </a>
            .
          </p>
        )}
        <div className="input-row">
          <button type="button" onClick={onCheckAgain} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </button>
          <button type="button" className="browse" onClick={onOtherFolder}>
            Open another folder
          </button>
        </div>
      </section>
    </main>
  );
}

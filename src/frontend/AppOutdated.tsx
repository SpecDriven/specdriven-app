// Data saved by a newer app (specs/app/data-format.feature.md): the server
// stops syncing and writing to the folder, and this screen takes the place of
// the app until the user installs a newer version — with Install & restart
// where the app can update itself, as on the Updates page
// (src/frontend/UpdatesPage.tsx), and the one-liner or releases page always.

import { useEffect, useState } from "react";
import { appUpdate, updateStage, type UpdateControl, type UpdateStore } from "./appUpdate";
import { UpdateStatus, useUpdateFlow } from "./UpdatesPage";
import { currentPlatform, upgradeInstructions, type UpgradePlatform } from "./upgradeHow";

export { RELEASE_REPO_URL, currentPlatform, upgradeInstructions } from "./upgradeHow";
export type { UpgradeHow, UpgradePlatform } from "./upgradeHow";

/** The header the server sets on every API answer while the folder is blocked. */
export const DATA_TOO_NEW_HEADER = "X-SpecDriven-Data-Too-New";

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

/** The screen, wired to the app's updater: it asks once whether this machine can install. */
export function AppOutdated({
  appVersion,
  minAppVersion,
  checking,
  onCheckAgain,
}: {
  appVersion: string | null;
  minAppVersion: string | null;
  checking: boolean;
  onCheckAgain: () => void;
}) {
  const { store, onControl } = useUpdateFlow();
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    void appUpdate.load();
  }, []);
  return (
    <AppOutdatedView
      appVersion={appVersion}
      minAppVersion={minAppVersion}
      platform={currentPlatform()}
      checking={checking}
      onCheckAgain={onCheckAgain}
      update={store}
      updating={updating}
      onInstall={() => {
        setUpdating(true);
        void appUpdate.updateNow();
      }}
      onControl={onControl}
    />
  );
}

/** The release check is the folder's Check again here, so the updater's own is left out. */
const FOLDER_SCREEN_CONTROLS = (c: UpdateControl) => c !== "check" && c !== "check-again";

/** The screen for a store snapshot — rendered on its own by the tests. */
export function AppOutdatedView({
  appVersion,
  minAppVersion,
  platform,
  checking,
  onCheckAgain,
  update,
  updating,
  onInstall,
  onControl,
}: {
  appVersion: string | null;
  minAppVersion: string | null;
  platform: UpgradePlatform;
  checking: boolean;
  onCheckAgain: () => void;
  update: UpdateStore;
  /** Install & restart was pressed: the updater's progress replaces the instructions. */
  updating: boolean;
  onInstall: () => void;
  onControl: (control: UpdateControl) => void;
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
  const canInstall = Boolean(update.index?.canInstall);
  // An install already under way or done (from the Updates page, or before
  // a reload) shows where it stands rather than offering to start again.
  const stage = updateStage(update);
  const inFlight = stage.kind === "installing" || stage.kind === "ready" || stage.kind === "restarting";
  const showStatus = updating || inFlight;
  return (
    <main className="centered">
      <section className="repo-prompt app-outdated" role="alert" aria-label="Update required">
        <h1>Update to latest version</h1>
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
        {showStatus ? (
          <UpdateStatus store={update} platform={platform} onControl={onControl} only={FOLDER_SCREEN_CONTROLS} />
        ) : how.command ? (
          <>
            <p>{platform === "windows" ? "In PowerShell, run:" : "In a terminal, run:"}</p>
            <div className="input-row">
              <code className="upgrade-command">{how.command}</code>
              <button type="button" className="btn" onClick={() => void copy()}>
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
          {canInstall && !showStatus && (
            <button type="button" className="btn btn-primary" onClick={onInstall}>
              Install & restart
            </button>
          )}
          <button
            type="button"
            className={canInstall || showStatus ? "btn" : "btn btn-primary"}
            onClick={onCheckAgain}
            disabled={checking}
          >
            {checking ? "Checking…" : "Check again"}
          </button>
        </div>
      </section>
    </main>
  );
}

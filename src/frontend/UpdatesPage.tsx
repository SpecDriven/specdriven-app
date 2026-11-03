// The Updates page (specs/app/app-updates.feature.md): Check for Updates…
// from the user menu or the app menu lands here. One section: the version
// running, the newest release once checked, Install & restart where the
// desktop app can replace itself — with the installer's output as it builds
// — and the installer one-liner where it cannot, as the data-too-new
// screen offers it (src/frontend/AppOutdated.tsx).

import { useEffect, useState } from "react";
import { AppPageLayout, PageSection } from "./AppPage";
import { currentPlatform, upgradeInstructions, type UpgradePlatform } from "./AppOutdated";
import {
  appUpdate,
  logTail,
  POLL_MS,
  updateControls,
  updateHeadline,
  updateStage,
  useAppUpdate,
  type UpdateControl,
  type UpdateIndex,
  type UpdateStore,
} from "./appUpdate";

const SECTION = "updates-release";

/** The one-liner for a machine the app cannot update from inside, with Copy. */
export function ManualUpgrade({ platform, reasons }: { platform: UpgradePlatform; reasons: string[] }) {
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
    <div className="update-manual">
      {reasons.length > 0 && (
        <ul className="self-fix-hints">
          {reasons.map((r) => (
            <li key={r} className="muted">
              {r}
            </li>
          ))}
        </ul>
      )}
      {how.command ? (
        <>
          <p>{platform === "windows" ? "To update, in PowerShell, run:" : "To update, in a terminal, run:"}</p>
          <div className="input-row">
            <code className="upgrade-command">{how.command}</code>
            <button type="button" className="btn" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </>
      ) : null}
      <p>
        Or download it from the{" "}
        <a href={how.url} target="_blank" rel="noreferrer">
          releases page
        </a>
        .
      </p>
    </div>
  );
}

const CONTROL_LABELS: Record<UpdateControl, string> = {
  check: "Check for Updates",
  "check-again": "Check again",
  install: "Install & restart",
  restart: "Restart now",
};

/** The section's body for a store snapshot — rendered on its own by the tests. */
export function UpdateStatus({
  store,
  platform,
  onControl,
}: {
  store: UpdateStore;
  platform: UpgradePlatform;
  onControl: (control: UpdateControl) => void;
}) {
  const stage = updateStage(store);
  const index = store.index;
  const canInstall = Boolean(index?.canInstall);
  const controls = updateControls(stage, canInstall);
  const install = index?.install ?? null;
  const showLog = install && (stage.kind === "installing" || stage.kind === "failed") && install.log.length > 0;
  return (
    <div className="update-status">
      <p className="update-headline" role="status" aria-live="polite">
        {updateHeadline(stage)}
      </p>
      {stage.kind === "available" && (
        <p className="muted">
          <a href={stage.url} target="_blank" rel="noreferrer">
            Release notes
          </a>
          {canInstall ? " — installing downloads the release, verifies it and builds the app here; it fetches Electron and takes a few minutes." : null}
        </p>
      )}
      {stage.kind === "installing" && <p className="muted">This fetches Electron and takes a few minutes. The app keeps working meanwhile.</p>}
      {stage.kind === "ready" && <p className="muted">The app quits and starts again as the new version; the one running stays beside it to go back to.</p>}
      {stage.kind === "failed" && <p className="update-error">{stage.error}</p>}
      {store.error && <p className="update-error">{store.error}</p>}
      {store.manual && (
        <p className="update-error">
          {store.manual.reason}
          {store.manual.path ? ` — the new app is at ${store.manual.path}` : ""}
        </p>
      )}
      {showLog && (
        <pre className="update-log" aria-label="Installer output">
          {logTail(install).join("\n")}
        </pre>
      )}
      {controls.length > 0 && (
        <div className="input-row">
          {controls.map((c, i) => (
            <button key={c} type="button" className={i === 0 ? "btn btn-primary" : "btn"} onClick={() => onControl(c)}>
              {CONTROL_LABELS[c]}
            </button>
          ))}
        </div>
      )}
      {index && !canInstall && (stage.kind === "available" || stage.kind === "failed") && (
        <ManualUpgrade platform={platform} reasons={index.reasons} />
      )}
    </div>
  );
}

/** The one-liner's platform: the server's, once known — the desktop app's remedy is the installer too — else the browser's guess. */
export function upgradePlatform(index: UpdateIndex | null): UpgradePlatform {
  if (!index) return currentPlatform();
  return index.platform === "win32" ? "windows" : "unix";
}

export function UpdatesPage({ onClose, platform: given }: { onClose: () => void; platform?: UpgradePlatform }) {
  const store = useAppUpdate();
  const platform = given ?? upgradePlatform(store.index);
  const installing = store.index?.install.phase === "installing";

  // The machine's state first, then the check — Check for Updates… was
  // chosen to find out — unless an install is already under way.
  useEffect(() => {
    void appUpdate.load().then((index) => {
      if (index && index.install.phase === "idle" && !index.check) void appUpdate.check();
    });
  }, []);

  // While the installer runs, its output and outcome come by polling.
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => void appUpdate.load(), POLL_MS);
    return () => clearInterval(timer);
  }, [installing]);

  const onControl = (control: UpdateControl) => {
    const latest = store.index?.check?.latest;
    if (control === "check" || control === "check-again") void appUpdate.check();
    else if (control === "install" && latest) void appUpdate.install(latest);
    else if (control === "restart") void appUpdate.restart();
  };

  return (
    <AppPageLayout title="Updates" sections={[{ id: SECTION, title: "Release" }]} onClose={onClose}>
      <PageSection id={SECTION} title="Release" hint="Releases are source zips, built on this machine with Bun.">
        <UpdateStatus store={store} platform={platform} onControl={onControl} />
      </PageSection>
    </AppPageLayout>
  );
}

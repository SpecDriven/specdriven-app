// Plugin updates at start (specs/app/plugins.feature.md "Plugins with an
// update are offered in a dialog at start"): once the server's start has
// pulled the marketplaces, GET /api/plugins/updates names the installed
// marketplace plugins whose index row moved on. The app asks once per run:
// each one ticked, with the version installed and the version offered;
// Update fetches the ticked ones one after another through the same route
// the marketplace list's Update uses (the server remounts each, and the
// plugins' event stream tells the app), a failure shown beside its row
// while the others go on; Not now changes nothing. Either answer is posted
// back, so a reload in the same run does not ask again.

import { useEffect, useState } from "react";
import type { PluginUpdate } from "../plugins/marketplace";
import { backdropDismiss } from "./backdropDismiss";
import { useFocusTrap } from "./useFocusTrap";

type RowStatus = { kind: "idle" } | { kind: "updating" } | { kind: "done" } | { kind: "failed"; error: string };

async function postJson(url: string): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  throw new Error(typeof data.error === "string" ? data.error : `${res.status} ${res.statusText}`);
}

/** Update one plugin to the ref its index names now. */
export const updatePlugin = (id: string): Promise<void> => postJson(`/api/plugins/${encodeURIComponent(id)}/update`);

/** Tell the server the dialog was answered in this run. */
export const dismissPluginUpdates = (): Promise<void> => postJson("/api/plugins/updates/dismiss").catch(() => {});

/** The start's offer: the updates the server found, or [] (none, or a server that offers none). */
export async function fetchPluginUpdates(): Promise<PluginUpdate[]> {
  try {
    const res = await fetch("/api/plugins/updates");
    if (!res.ok) return [];
    const data = (await res.json()) as { updates?: unknown };
    return Array.isArray(data.updates) ? (data.updates as PluginUpdate[]) : [];
  } catch {
    return [];
  }
}

/** Ask the server once, on mount, which plugins have an update: null until it answers with some. */
export function usePluginUpdatesOffer(enabled: boolean): [PluginUpdate[] | null, () => void] {
  const [updates, setUpdates] = useState<PluginUpdate[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetchPluginUpdates().then((found) => {
      if (live && found.length > 0) setUpdates(found);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return [updates, () => setUpdates(null)];
}

/** "1.2.0 → 1.3.0", or "→ 1.3.0" when the installed one has no version. */
export function versionStep(update: PluginUpdate): string {
  return update.from ? `${update.from} → ${update.to}` : `→ ${update.to}`;
}

export function PluginUpdatesDialog({
  updates,
  onClose,
  update = updatePlugin,
}: {
  updates: PluginUpdate[];
  /** The dialog was answered — Update finished, or Not now. */
  onClose: () => void;
  update?: (id: string) => Promise<void>;
}) {
  const trapRef = useFocusTrap(true);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(updates.map((u) => u.id)));
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [phase, setPhase] = useState<"ask" | "working" | "finished">("ask");

  const statusOf = (id: string): RowStatus => status[id] ?? { kind: "idle" };

  const run = async () => {
    setPhase("working");
    let failed = false;
    for (const u of updates) {
      if (!ticked.has(u.id)) continue;
      setStatus((s) => ({ ...s, [u.id]: { kind: "updating" } }));
      try {
        await update(u.id);
        setStatus((s) => ({ ...s, [u.id]: { kind: "done" } }));
      } catch (e) {
        failed = true;
        setStatus((s) => ({ ...s, [u.id]: { kind: "failed", error: (e as Error).message } }));
      }
    }
    if (failed) setPhase("finished");
    else onClose();
  };

  const dismiss = () => {
    if (phase !== "working") onClose();
  };

  const toggle = (id: string) =>
    setTicked((t) => {
      const next = new Set(t);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const count = updates.length;
  return (
    <div
      className="dialog-backdrop"
      {...backdropDismiss(dismiss)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          dismiss();
        }
      }}
    >
      <div
        className="dialog modal-dialog plugin-updates-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Plugin updates"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Plugin updates</h3>
        <p className="hint">
          {count === 1 ? "An installed plugin has" : `${count} installed plugins have`} a newer version in the
          marketplace.
        </p>
        <ul className="plugin-updates-list">
          {updates.map((u) => {
            const s = statusOf(u.id);
            return (
              <li key={u.id} data-plugin={u.id}>
                <label className="plugin-updates-row">
                  <input
                    type="checkbox"
                    checked={ticked.has(u.id)}
                    disabled={phase !== "ask"}
                    onChange={() => toggle(u.id)}
                  />
                  <span className="plugin-updates-name">{u.displayName}</span>
                  <span className="plugin-updates-version">{versionStep(u)}</span>
                  <span className="plugin-updates-status" aria-live="polite">
                    {s.kind === "updating" ? "Updating…" : s.kind === "done" ? "Updated" : s.kind === "failed" ? "Failed" : ""}
                  </span>
                </label>
                {s.kind === "failed" && <p className="error plugin-updates-error">{s.error}</p>}
              </li>
            );
          })}
        </ul>
        <div className="dialog-actions">
          {phase === "finished" ? (
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-secondary" disabled={phase === "working"} onClick={dismiss}>
                Not now
              </button>
              <button
                type="button"
                className="btn btn-primary"
                autoFocus
                disabled={phase === "working" || ticked.size === 0}
                onClick={() => void run()}
              >
                {phase === "working" ? "Updating…" : "Update"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Plugins → Marketplaces (specs/app/plugins.feature.md "The
// marketplace is a git repository with an index", "A plugin from the
// marketplace is installed with consent"): the git urls this machine reads,
// each cloned or pulled through the app's git engine when the list is
// opened or refreshed, and every plugin an index lists with its name,
// version, category and description — marked when installed, with Install,
// Update or Remove beside it. Install shows what the manifest declares and a
// note that the plugin runs with the app's own rights, and fetches nothing
// into the profile until the user confirms. Not offered in the hosted demo.

import { useCallback, useEffect, useState } from "react";
import type { PluginStatus } from "../plugins/client/loader";
import type { MarketplaceIndex, MarketplaceRef } from "../plugins/marketplace";
import { marketplaceNameFor } from "../plugins/marketplace";
import type { ConfirmOptions, PromptOptions } from "./ModalPrompts";

interface MarketplaceStatus extends MarketplaceRef {
  index?: MarketplaceIndex;
  error?: string;
}

interface InstallPreview {
  id: string;
  displayName: string;
  description: string;
  version: string;
  permissions: string[];
  ref?: string;
}

export interface PluginMarketplaceProps {
  marketplaces: MarketplaceRef[];
  plugins: PluginStatus[];
  patchSettings(patch: Record<string, unknown>): Promise<boolean>;
  prompt(opts: PromptOptions): Promise<string | null>;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /**
   * A plugin the profile lists but nothing provides (a built-in that moved
   * to the marketplace): Browse opens, the rows of that name are marked and
   * scrolled to, so installing it is one click and its consent away.
   */
  wanted?: string | null;
  /** Re-read the plugins after an install, update or removal. */
  onChanged(): Promise<void>;
}

async function call(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `${res.status} ${res.statusText}`);
  return data;
}

const post = (url: string, body: unknown) =>
  call(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** The consent text: what the plugin is and what installing it means. */
export function consentBody(preview: InstallPreview, marketplace: string): string {
  const lines = [preview.description || `${preview.id} from ${marketplace}.`];
  lines.push(
    preview.permissions.length
      ? `Permissions it declares: ${preview.permissions.join(", ")}.`
      : "It declares no permissions.",
  );
  lines.push(
    "This is a third-party plugin. It runs inside SpecDriven with the app's own rights: your files, your git and GitHub access, this machine." +
      (preview.ref ? ` It is pinned to ${preview.ref} and is not updated on its own.` : " It is not updated on its own."),
  );
  return lines.join("\n\n");
}

export function PluginMarketplace({
  marketplaces,
  plugins,
  wanted = null,
  patchSettings,
  prompt,
  confirm,
  onChanged,
}: PluginMarketplaceProps) {
  const [open, setOpen] = useState(false);
  const [statuses, setStatuses] = useState<MarketplaceStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const data = await call(`/api/plugins/marketplaces${refresh ? "?refresh=1" : ""}`);
      setStatuses(Array.isArray(data.marketplaces) ? (data.marketplaces as MarketplaceStatus[]) : []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const key = marketplaces.map((m) => `${m.name}=${m.source}`).join("\n");
  useEffect(() => {
    if (open) void load(false);
  }, [open, key, load]);

  // Asked for a plugin by name: browse, and bring its row into view once listed.
  useEffect(() => {
    if (wanted) setOpen(true);
  }, [wanted]);
  const listedWanted =
    wanted !== null && (statuses ?? []).some((m) => m.index?.plugins.some((row) => row.name === wanted));
  useEffect(() => {
    if (!wanted || !listedWanted) return;
    document
      .querySelector(`.plugin-market-row[data-plugin="${CSS.escape(wanted)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [wanted, listedWanted]);

  /** The installed plugin an index row corresponds to, by its install record. */
  const installedFor = (marketplace: string, name: string): PluginStatus | undefined =>
    plugins.find((p) => p.install?.marketplace === marketplace && p.install?.name === name);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const install = (marketplace: string, name: string) =>
    run(`${marketplace}/${name}`, async () => {
      const staged = await post("/api/plugins/install", { marketplace, name, step: "stage" });
      const preview = staged.preview as InstallPreview;
      const ok = await confirm({
        title: `Install ${preview.displayName}${preview.version ? ` ${preview.version}` : ""}?`,
        body: consentBody(preview, marketplace),
        confirmLabel: "Install",
      });
      if (!ok) {
        await post("/api/plugins/install", { marketplace, name, step: "cancel" });
        return;
      }
      await post("/api/plugins/install", { marketplace, name, step: "confirm" });
      await onChanged();
    });

  const update = (plugin: PluginStatus) =>
    run(plugin.id, async () => {
      await post(`/api/plugins/${encodeURIComponent(plugin.id)}/update`, {});
      await onChanged();
    });

  const remove = (plugin: PluginStatus) =>
    run(plugin.id, async () => {
      const ok = await confirm({
        title: `Remove ${plugin.displayName ?? plugin.id}?`,
        body: "Its tab, routes and shortcuts go now, and its folder under ~/.specdriven/plugins is deleted. Its files in the data folder stay.",
        confirmLabel: "Remove",
      });
      if (!ok) return;
      await call(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: "DELETE" });
      await onChanged();
    });

  const addMarketplace = async () => {
    const result = await prompt({
      title: "Add a marketplace",
      hint: "The git url of a repository with a marketplace.json at its root.",
      placeholder: "https://github.com/SpecDriven/plugins",
      confirmLabel: "Add",
    });
    const source = result?.trim();
    if (!source) return;
    let name = marketplaceNameFor(source);
    if (!name) {
      setError(`Cannot make a marketplace name out of ${source}`);
      return;
    }
    if (marketplaces.some((m) => m.source === source)) return;
    for (let n = 2; marketplaces.some((m) => m.name === name); n++) name = `${marketplaceNameFor(source)}-${n}`;
    await patchSettings({ plugins: { marketplaces: [...marketplaces, { name, source }] } });
  };

  const removeMarketplace = (name: string) =>
    patchSettings({ plugins: { marketplaces: marketplaces.filter((m) => m.name !== name) } });

  return (
    <div className="settings-row plugin-marketplaces" data-testid="plugin-marketplaces">
      <span className="settings-row-label">
        {/* The page's section says what a marketplace is; this row lists them. */}
        <span>Configured</span>
        {marketplaces.length === 0 && (
          <span className="settings-row-hint">None — add the git url of one to browse its plugins.</span>
        )}
        {marketplaces.length > 0 && (
          <ul className="plugin-source-list">
            {marketplaces.map((m) => (
              <li key={m.name}>
                <code title={m.source}>
                  {m.name} · {m.source}
                </code>
                <button
                  type="button"
                  className="link"
                  aria-label={`Remove marketplace ${m.name}`}
                  onClick={() => void removeMarketplace(m.name)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <span className="settings-row-hint plugin-row-error" role="alert">
            {error}
          </span>
        )}
        {open && loading && statuses === null && <span className="settings-row-hint">Reading the marketplaces…</span>}
        {open && wanted && statuses !== null && !loading && !listedWanted && (
          <span className="settings-row-hint plugin-row-error" role="alert">
            No marketplace here lists {wanted}. Add the one that does, or Refresh.
          </span>
        )}
        {open &&
          statuses?.map((m) => (
            <div className="plugin-market" key={m.name} data-marketplace={m.name}>
              <span className="plugin-market-title">
                {m.index?.name ?? m.name}
                {m.index?.owner && (
                  <span className="plugin-row-meta">
                    {m.index.owner.url ? (
                      <a href={m.index.owner.url} target="_blank" rel="noreferrer">
                        {m.index.owner.name}
                      </a>
                    ) : (
                      m.index.owner.name
                    )}
                  </span>
                )}
              </span>
              {m.error && (
                <span className="settings-row-hint plugin-row-error" role="alert">
                  {m.error}
                </span>
              )}
              {m.index && m.index.plugins.length === 0 && (
                <span className="settings-row-hint">This marketplace lists no plugins yet.</span>
              )}
              {m.index?.plugins.map((row) => {
                const installed = installedFor(m.name, row.name);
                const id = `${m.name}/${row.name}`;
                const working = busy === id || (installed !== undefined && busy === installed.id);
                return (
                  <div
                    className={`plugin-market-row${row.name === wanted && !installed ? " wanted" : ""}`}
                    key={row.name}
                    data-plugin={row.name}
                  >
                    <span className="settings-row-label">
                      <span className="plugin-row-name">
                        {row.name}
                        <span className="plugin-row-meta">
                          {row.version ? `v${row.version}` : ""}
                          {row.version && row.category ? " · " : ""}
                          {row.category ?? ""}
                          {installed ? (row.version || row.category ? " · " : "") + "Installed" : ""}
                          {installed?.install?.version && installed.install.version !== row.version
                            ? ` (v${installed.install.version})`
                            : ""}
                        </span>
                      </span>
                      {row.description && <span className="settings-row-hint">{row.description}</span>}
                    </span>
                    {installed ? (
                      <span className="plugin-market-actions">
                        <button type="button" className="link" disabled={working} onClick={() => void update(installed)}>
                          Update
                        </button>
                        <button type="button" className="link" disabled={working} onClick={() => void remove(installed)}>
                          Remove
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="link" disabled={working} onClick={() => void install(m.name, row.name)}>
                        {working ? "Installing…" : "Install"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
      </span>
      <span className="plugin-market-actions">
        <button type="button" className="link" onClick={() => void addMarketplace()}>
          Add marketplace…
        </button>
        <button
          type="button"
          className="link"
          disabled={loading || marketplaces.length === 0}
          onClick={() => (open ? void load(true) : setOpen(true))}
        >
          {open ? (loading ? "Refreshing…" : "Refresh") : "Browse plugins"}
        </button>
      </span>
    </div>
  );
}

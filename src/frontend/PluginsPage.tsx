// Plugins (specs/app/plugins.feature.md "A built-in module is a plugin like
// any other", specs/user-info-settings.feature.md "open Plugins"): its own
// page in the editor pane, opened from the user menu. Every module the app
// has, built-in or not, with its switch, its version and a line saying what
// it adds — the ones on first, in tab order, which the arrows change; then
// the ones off. Off, a plugin's tab, routes and shortcuts are gone and its
// files in the data folder stay. An id in the profile that no plugin
// provides is reported here and otherwise ignored — or, for a module that
// moved to the marketplace (the Event Models), found there to install.
// Below them, the folders plugins load from and the marketplaces — the
// hosted demo shows the marketplaces alone, to browse: it installed its
// marketplace plugins itself when it started.

import { useState } from "react";
import { ChevronDown, ChevronUp, Settings } from "lucide-react";
import type { PluginStatus } from "../plugins/client/loader";
import type { MarketplaceRef } from "../plugins/marketplace";
import { AppPageLayout, PageSection } from "./AppPage";
import type { ConfirmOptions, PromptOptions } from "./ModalPrompts";
import { PluginMarketplace } from "./PluginMarketplace";

export interface PluginsPageProps {
  /** A marketplace plugin's id to open scrolled to — the agent pane sent the user to install it. */
  initialWanted?: string | null;
  plugins: PluginStatus[];
  /** Browser halves that failed to load, by plugin id. */
  loadErrors: ReadonlyMap<string, string>;
  /** Whether the data folder names a GitHub code repo — the Issues tab needs one. */
  hasIssuesRepo: boolean;
  demo: boolean;
  sources: string[];
  marketplaces: MarketplaceRef[];
  /** A change the server refused, from the last patch. */
  error: string | null;
  setEnabled(id: string, on: boolean): Promise<void>;
  move(id: string, delta: -1 | 1): Promise<void>;
  patchSettings(patch: Record<string, unknown>): Promise<boolean>;
  prompt(opts: PromptOptions): Promise<string | null>;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** The native folder chooser, where the host has one. */
  browseFolder?: () => Promise<string | null>;
  onChanged(): Promise<void>;
  onOpenSettings(): void;
  onClose(): void;
}

/** Where a plugin came from — the one thing that tells a built-in from one loaded from a folder. */
function originOf(plugin: PluginStatus): string {
  if (plugin.builtin) return "Built-in";
  if (plugin.installed === false) return "Not installed";
  if (plugin.source === "repo") return "Data folder";
  if (plugin.source === "path") return "Linked folder";
  if (plugin.install) return `Marketplace ${plugin.install.marketplace}`;
  return "Installed";
}

export function PluginsPage(props: PluginsPageProps) {
  const { plugins, demo } = props;
  // The id a not-installed row asked the marketplaces for.
  const [wanted, setWanted] = useState<string | null>(props.initialWanted ?? null);
  const on = plugins.filter((p) => p.enabled);
  const off = plugins.filter((p) => !p.enabled);

  const sections = [
    { id: "plugins-on", title: "In the sidebar" },
    ...(off.length > 0 ? [{ id: "plugins-off", title: "Switched off" }] : []),
    ...(demo ? [] : [{ id: "plugins-folders", title: "Plugin folders" }]),
    { id: "plugins-marketplaces", title: "Marketplaces" },
  ];

  const row = (plugin: PluginStatus, rank: number | null) => {
    const name = plugin.displayName ?? plugin.id;
    const installed = plugin.installed !== false;
    const untrusted = installed && plugin.trusted === false;
    const loadError = props.loadErrors.get(plugin.id);
    // The Issues plugin's tab needs a GitHub code repo besides its switch
    // (specs/app/github-issues.feature.md).
    const note =
      plugin.id === "issues" && plugin.enabled && !props.hasIssuesRepo
        ? "The data folder's project-settings.json names no GitHub code repo yet, so the tab stays hidden until it does."
        : null;
    return (
      <div className="settings-row plugin-row" key={plugin.id} data-plugin={plugin.id}>
        {rank !== null && (
          <span className="plugin-row-rank" aria-hidden="true">
            {rank + 1}
          </span>
        )}
        <span className="settings-row-label">
          <span className="plugin-row-name">
            {name}
            <span className="plugin-row-meta" title={plugin.dir}>
              {originOf(plugin)}
              {plugin.version ? ` · v${plugin.version}` : ""}
            </span>
          </span>
          {plugin.description && <span className="settings-row-hint">{plugin.description}</span>}
          {!plugin.builtin && plugin.dir && (
            <code className="plugin-row-dir" title={plugin.dir}>
              {plugin.dir}
            </code>
          )}
          {note && <span className="settings-row-hint">{note}</span>}
          {untrusted && (
            <span className="settings-row-hint">
              This plugin came with the data folder, which is pulled from GitHub. It runs with the app's own
              rights once trusted
              {plugin.permissions?.length ? ` and asks for ${plugin.permissions.join(", ")}` : ""}.
            </span>
          )}
          {plugin.error && (
            <span className="settings-row-hint plugin-row-error" role="alert">
              {plugin.error}
            </span>
          )}
          {loadError && !plugin.error && (
            <span className="settings-row-hint plugin-row-error" role="alert">
              {loadError}
            </span>
          )}
        </span>
        {rank !== null && installed && (
          <span className="plugin-row-order">
            <button
              type="button"
              className="plugin-row-move"
              aria-label={`Move ${name} up`}
              title="Move up"
              disabled={rank === 0}
              onClick={() => void props.move(plugin.id, -1)}
            >
              <ChevronUp size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="plugin-row-move"
              aria-label={`Move ${name} down`}
              title="Move down"
              disabled={rank >= on.length - 1}
              onClick={() => void props.move(plugin.id, 1)}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </span>
        )}
        {untrusted ? (
          <button
            type="button"
            className="link"
            onClick={() => void props.patchSettings({ plugins: { trust: plugin.dir } })}
          >
            Trust and load
          </button>
        ) : installed ? (
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-label={name}
              checked={plugin.enabled}
              onChange={(e) => void props.setEnabled(plugin.id, e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </label>
        ) : (
          <span className="plugin-market-actions">
            {!demo && (
              <button type="button" className="link" onClick={() => setWanted(plugin.id)}>
                Find in marketplace
              </button>
            )}
            <button type="button" className="link" onClick={() => void props.setEnabled(plugin.id, false)}>
              Remove from list
            </button>
          </span>
        )}
      </div>
    );
  };

  return (
    <AppPageLayout
      title="Plugins"
      sections={sections}
      onClose={props.onClose}
      actions={
        <span className="app-page-status">
          {on.length} of {plugins.length} on
        </span>
      }
      aside={
        <button type="button" className="app-page-nav-link" onClick={props.onOpenSettings}>
          <Settings size={13} aria-hidden="true" /> Settings
        </button>
      }
    >
      <PageSection
        id="plugins-on"
        title="In the sidebar"
        hint="Each plugin adds a sidebar tab, in this order after Specs. Switching one off takes its tab, shortcuts and routes away and leaves its files in the data folder alone."
        className="settings-plugins"
      >
        {on.length === 0 ? (
          <p className="settings-row page-empty">No plugin is on — the sidebar shows Specs alone.</p>
        ) : (
          on.map((p, i) => row(p, i))
        )}
      </PageSection>
      {off.length > 0 && (
        <PageSection
          id="plugins-off"
          title="Switched off"
          hint="Switch one on and its tab goes last in the sidebar."
          className="settings-plugins"
        >
          {off.map((p) => row(p, null))}
        </PageSection>
      )}
      {/* The explicit plugin folders (specs/app/plugins.feature.md "A
          plugin loads from a local folder"): the vibe-coded plugin under
          development, linked by path — `specdriven plugin link` does the
          same. Not in the demo, whose host is shared. */}
      {!demo && (
        <PageSection
          id="plugins-folders"
          title="Plugin folders"
          hint={
            <>
              Plugins load from <code>~/.specdriven/plugins</code>, the data folder's{" "}
              <code>.specdriven/plugins</code> and the folders linked here. A TypeScript plugin is built here and
              rebuilt as you edit it.
            </>
          }
        >
          <div className="settings-row plugin-sources" data-testid="plugin-sources">
            <span className="settings-row-label">
              <span>Linked folders</span>
              {props.sources.length === 0 ? (
                <span className="settings-row-hint">None yet — link the folder holding a plugin's package.json.</span>
              ) : (
                <ul className="plugin-source-list">
                  {props.sources.map((path) => (
                    <li key={path}>
                      <code title={path}>{path}</code>
                      <button
                        type="button"
                        className="link"
                        aria-label={`Unlink ${path}`}
                        onClick={() =>
                          void props.patchSettings({
                            plugins: { sources: props.sources.filter((p) => p !== path) },
                          })
                        }
                      >
                        Unlink
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </span>
            <button
              type="button"
              className="link"
              onClick={async () => {
                const path = await props.prompt({
                  title: "Link a plugin folder",
                  hint: "The absolute path of a folder holding the plugin's package.json.",
                  placeholder: "/Users/me/dev/my-plugin",
                  confirmLabel: "Link",
                  browse: props.browseFolder,
                });
                const clean = path?.trim();
                if (clean) void props.patchSettings({ plugins: { sources: [...props.sources, clean] } });
              }}
            >
              Add folder…
            </button>
          </div>
        </PageSection>
      )}
      {/* The marketplaces (specs/app/plugins.feature.md "The marketplace is
          a git repository with an index"): browse, install with consent,
          update, remove — in the demo, browse alone. */}
      <PageSection
        id="plugins-marketplaces"
        title="Marketplaces"
        hint="Git repositories with a marketplace.json, read through the app's git engine. A plugin installed from one is pinned to the ref the index names and runs with the app's own rights; nothing updates on its own."
      >
        <PluginMarketplace
          marketplaces={props.marketplaces}
          plugins={plugins}
          wanted={wanted}
          readOnly={demo}
          patchSettings={props.patchSettings}
          prompt={props.prompt}
          confirm={props.confirm}
          onChanged={props.onChanged}
        />
      </PageSection>
      {props.error && <p className="error settings-error">{props.error}</p>}
    </AppPageLayout>
  );
}

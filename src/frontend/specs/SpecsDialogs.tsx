// The Specs tab's own dialogs — a publish the server refused over a merge
// conflict, publishing a feature or a folder to Confluence and qTest, and
// the imports into a spec folder — rendered whatever the pane shows: an
// import opens from the tree or the palette while the pane is the folder's
// README (src/plugins/client/tabs.ts Overlay). Which one is open is in
// ./dialogs.ts and ./editorState.ts.

import type { TabApp } from "../../plugins/client/tabs";
import { AhaImportDialog } from "../AhaImportDialog";
import { ConfluenceFolderPublishDialog } from "../ConfluenceFolderPublishDialog";
import { ConfluencePublishDialog } from "../ConfluencePublishDialog";
import { ImportFromJiraWikiDialog } from "../ImportFromJiraWikiDialog";
import { OpenSpecImportDialog, importSummary } from "../OpenSpecImportDialog";
import { QtestPublishDialog } from "../QtestPublishDialog";
import { toast } from "../Toasts";
import { WikiQtestPublishDialog } from "../WikiQtestPublishDialog";
import { backdropDismiss } from "../backdropDismiss";
import { useSpellCheck } from "../spellCheckPref";
import { useFocusTrap } from "../useFocusTrap";
import {
  setAhaImportOpen,
  setConfluenceFolder,
  setConfluencePublishOpen,
  setImportOpen,
  setOpenSpecImportOpen,
  setQtestPublishOpen,
  setWikiQtestPublishOpen,
  useSpecsDialogs,
} from "./dialogs";
import { setConflictDraft, useEditorState } from "./editorState";
import type { SpecsActions } from "./host";
import { setDirty, setFeature, useOpenFeature } from "./openFeature";
import { featureFromResponse } from "./scenarioEdit";
import { setResourceLinksOn } from "./settings";
import { setCollapsed } from "./treeState";

export function SpecsDialogs({ app, actions }: { app: TabApp; actions: SpecsActions }) {
  const { conflict, resolving, conflictDraft } = useEditorState();
  const {
    confluencePublishOpen,
    confluenceFolder,
    qtestPublishOpen,
    wikiQtestPublishOpen,
    ahaImportOpen,
    openSpecImportOpen,
    importOpen,
  } = useSpecsDialogs();
  const { selected, feature } = useOpenFeature();
  const spellCheckOn = useSpellCheck();
  const conflictTrapRef = useFocusTrap(conflict !== null);
  const confluenceTrapRef = useFocusTrap(confluencePublishOpen);
  const confluenceFolderTrapRef = useFocusTrap(confluenceFolder !== null);
  const qtestTrapRef = useFocusTrap(qtestPublishOpen);
  const wikiQtestTrapRef = useFocusTrap(wikiQtestPublishOpen);
  const ahaTrapRef = useFocusTrap(ahaImportOpen !== null);
  const openSpecTrapRef = useFocusTrap(openSpecImportOpen !== null);
  const importTrapRef = useFocusTrap(importOpen !== null);
  // What App.tsx still owns (./host.ts SpecsActions).
  const {
    agentModels,
    agents,
    ahaSites,
    confluencePublished,
    confluenceWikis,
    dismissConflict,
    jiraSites,
    markSaved,
    openObservability,
    qtestParentUrl,
    qtestPublished,
    qtestSites,
    resolveWith,
  } = actions;
  return (
    <>
    {/* crud-feature.md "Publish feature with merge conflict": a
        dialog rather than a strip appended to the page, so the two sides
        never push the resolutions out of view. The dialog is capped to the
        window; each side scrolls inside its own pane and the three
        resolutions stay pinned at the bottom (specs/ui/ui.feature.md "Merge
        conflict dialog"). */}
    {conflict && (
      <div className="dialog-backdrop" {...backdropDismiss(() => resolving === null && dismissConflict())}>
        <div
          className="dialog conflict-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Merge conflict"
          ref={conflictTrapRef}
          onClick={(e) => e.stopPropagation()}
        >
          <h3>Merge conflict</h3>
          <p className="hint">
            Compare the two sides, then accept one or publish an edit that combines them.
            {conflict.message ? ` — ${conflict.message}` : ""}
          </p>
          <div className="conflict-panes">
            <section className="conflict-pane">
              <header>
                <h4>Yours</h4>
                <span className="hint">what you are publishing</span>
              </header>
              <pre>{conflict.ours}</pre>
            </section>
            <section className="conflict-pane">
              <header>
                <h4>Theirs</h4>
                <span className="hint">what is on the remote</span>
              </header>
              {conflict.theirs ? (
                <pre>{conflict.theirs}</pre>
              ) : (
                <pre className="conflict-missing">No such file on the remote.</pre>
              )}
            </section>
          </div>
          <section className="conflict-edit">
            <header>
              <h4>Manual edit</h4>
              <span className="hint">
                Start from{" "}
                <button className="link" onClick={() => setConflictDraft(conflict.ours)}>
                  yours
                </button>{" "}
                or{" "}
                <button className="link" onClick={() => setConflictDraft(conflict.theirs)}>
                  theirs
                </button>
              </span>
            </header>
            <textarea
              className="conflict-draft"
              value={conflictDraft}
              onChange={(e) => setConflictDraft(e.target.value)}
              spellCheck={spellCheckOn}
            />
          </section>
          <div className="dialog-actions conflict-actions">
            <button
              className="btn btn-secondary"
              onClick={dismissConflict}
              disabled={resolving !== null}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void resolveWith("ours", conflict.ours)}
              disabled={resolving !== null}
            >
              {resolving === "ours" ? "Publishing…" : "Accept yours"}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void resolveWith("theirs", conflict.theirs)}
              disabled={resolving !== null}
            >
              {resolving === "theirs" ? "Publishing…" : "Accept theirs"}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void resolveWith("draft", conflictDraft)}
              disabled={resolving !== null}
            >
              {resolving === "draft" ? "Publishing…" : "Publish manual edit"}
            </button>
          </div>
        </div>
      </div>
    )}
    {confluencePublishOpen && selected && feature && (
      <ConfluencePublishDialog
        file={selected}
        featureName={feature.name}
        linkedUrl={feature.confluence?.url}
        initialParentUrl={feature.confluencePage?.parentUrl ?? ""}
        wikis={confluenceWikis}
        trapRef={confluenceTrapRef}
        onClose={() => setConfluencePublishOpen(false)}
        onOpenLogs={() => {
          setConfluencePublishOpen(false);
          openObservability("confluence");
        }}
        onPublished={(data) => {
          confluencePublished(data);
          setConfluencePublishOpen(false);
        }}
      />
    )}
    {confluenceFolder && (
      <ConfluenceFolderPublishDialog
        key={`${confluenceFolder.path}:${confluenceFolder.features === null ? "loading" : "ready"}`}
        folderLabel={confluenceFolder.label}
        features={confluenceFolder.features}
        wikis={confluenceWikis}
        trapRef={confluenceFolderTrapRef}
        onClose={() => setConfluenceFolder(null)}
        onOpenLogs={() => {
          setConfluenceFolder(null);
          openObservability("confluence");
        }}
        onPublished={(file, data) => {
          // The open feature now links its page: show it as saved.
          if (file !== selected) return;
          setFeature(featureFromResponse(data, selected));
          setDirty(false);
          markSaved();
        }}
        onFinished={(results) => {
          setConfluenceFolder(null);
          const created = results.filter((r) => r.created).length;
          const parts = [
            ...(created > 0 ? [`published ${created}`] : []),
            ...(results.length - created > 0 ? [`updated ${results.length - created}`] : []),
          ];
          const said = parts.join(", ");
          toast.success(`${said.charAt(0).toUpperCase()}${said.slice(1)} in Confluence`);
          const warnings = results.flatMap((r) => (r.warning ? [`${r.title}: ${r.warning}`] : []));
          if (warnings.length > 0) toast.error(warnings.join(" "));
        }}
      />
    )}
    {qtestPublishOpen && selected && feature && (
      <QtestPublishDialog
        file={selected}
        featureName={feature.name}
        linkedUrl={feature.qtest?.url}
        initialParentUrl={feature.qtestModule?.parentUrl ?? qtestParentUrl}
        sites={qtestSites}
        trapRef={qtestTrapRef}
        onClose={() => setQtestPublishOpen(false)}
        onOpenLogs={() => {
          setQtestPublishOpen(false);
          openObservability("qtest");
        }}
        onPublished={(data) => {
          qtestPublished(data);
          // A test case qTest refused keeps the dialog open on it, with its details.
          if (!data.failure) setQtestPublishOpen(false);
        }}
      />
    )}
    {wikiQtestPublishOpen && selected && feature && (
      <WikiQtestPublishDialog
        file={selected}
        featureName={feature.name}
        linkedPageUrl={feature.confluence?.url}
        linkedModuleUrl={feature.qtest?.url}
        initialParentPageUrl={feature.confluencePage?.parentUrl ?? ""}
        initialParentModuleUrl={feature.qtestModule?.parentUrl ?? qtestParentUrl}
        wikis={confluenceWikis}
        sites={qtestSites}
        trapRef={wikiQtestTrapRef}
        onClose={() => setWikiQtestPublishOpen(false)}
        onOpenLogs={(service) => {
          setWikiQtestPublishOpen(false);
          openObservability(service);
        }}
        onPagePublished={confluencePublished}
        onCasesPublished={(data) => {
          qtestPublished(data);
          if (!data.failure) setWikiQtestPublishOpen(false);
        }}
      />
    )}
    {ahaImportOpen !== null && (
      <AhaImportDialog
        folder={ahaImportOpen.folder}
        sites={ahaSites}
        trapRef={ahaTrapRef}
        onClose={() => setAhaImportOpen(null)}
        onImported={(data) => {
          const { folder } = ahaImportOpen;
          setAhaImportOpen(null);
          // The import switched Aha! links on server-side, so the chips show.
          if (data.ahaLinks) setResourceLinksOn((prev) => ({ ...prev, aha: true }));
          // Reveal the new feature: a selected folder may be collapsed.
          if (folder) {
            setCollapsed((prev) => {
              const next = new Set(prev);
              next.delete(folder);
              return next;
            });
          }
          void app.featureCreated(data.fileName);
          const open = { label: "Open in Aha!", run: () => window.open(data.url, "_blank", "noreferrer") };
          const what = data.scenarios > 0 ? ` with ${data.scenarios} scenario${data.scenarios === 1 ? "" : "s"}` : "";
          toast.success(`Imported “${data.title}” from Aha!${what}`, { action: open });
          if (data.warning) toast.error(data.warning);
        }}
      />
    )}
    {openSpecImportOpen !== null && (
      <OpenSpecImportDialog
        folder={openSpecImportOpen.folder}
        trapRef={openSpecTrapRef}
        onClose={() => setOpenSpecImportOpen(null)}
        onImported={(data) => {
          const { folder } = openSpecImportOpen;
          setOpenSpecImportOpen(null);
          // Reveal the new features: a selected folder may be collapsed.
          if (folder) {
            setCollapsed((prev) => {
              const next = new Set(prev);
              next.delete(folder);
              return next;
            });
          }
          void app.featureCreated(data.created[0]!.fileName);
          if (data.failed.length > 0) toast.error(importSummary(data));
          else toast.success(importSummary(data));
        }}
      />
    )}
    {importOpen !== null && (
      <ImportFromJiraWikiDialog
        folder={importOpen.folder}
        mode={importOpen.mode}
        jiraSites={jiraSites}
        wikis={confluenceWikis}
        agents={agents}
        agentModels={agentModels}
        trapRef={importTrapRef}
        onClose={() => setImportOpen(null)}
        onCreated={(data) => {
          const { folder } = importOpen;
          setImportOpen(null);
          // Reveal the new feature: a selected folder may be collapsed.
          if (folder) {
            setCollapsed((prev) => {
              const next = new Set(prev);
              next.delete(folder);
              return next;
            });
          }
          void app.featureCreated(data.fileName);
          toast.success(`Imported “${data.title}” with ${data.scenarios} scenario${data.scenarios === 1 ? "" : "s"}`);
        }}
      />
    )}
    </>
  );
}

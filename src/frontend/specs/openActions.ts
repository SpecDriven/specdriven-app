// Opening a feature (specs/ui/navigation.feature.md): reading its file,
// leaving the editor pane the way `<` does, showing the feature with the
// scenario a link named, and saying so when the file is gone; and the
// read-only site's re-opening of a scenario's page when its feature changed.
// Moved out of App.tsx as they were, into a hook App.tsx calls: each handler
// sees the same render's values it saw there.

import { type Dispatch, type RefObject, type SetStateAction } from "react";
import { SPECS_TAB } from "../../plugins/builtin/specs/client";
import { type PluginView } from "../../plugins/client/tabs";
import { type Scenario, slugify } from "../../server/parser";
import { missedFeatureNote } from "../linkSync";
import { type AppPage, featurePath, resolveScenario } from "../route";
import { toast } from "../Toasts";
import { setConflict } from "./editorState";
import { setRenameDraft } from "./featurePageState";
import { type Listing } from "./listing";
import {
  type OpenOptions,
  setDirty,
  setEditing,
  setFeature,
  setFeatureLoading,
  setPaneRequest,
  setSelected,
  setSelectedScenario,
  useOpenFeature,
} from "./openFeature";
import { type Placement, featureFromResponse } from "./scenarioEdit";

export interface OpenFeatureActionsDeps {
  editorRef: RefObject<{ close: () => Promise<{ ok: boolean; placed: Placement; }> | null; back: () => void; flush: () => Promise<void>; seal: () => void; }>;
  loadFeatures: () => Promise<Listing | null>;
  openDescriptionEditor: (file: string, text: string) => void;
  selectSidebarTab: (tab: string) => void;
  setAppPage: Dispatch<SetStateAction<AppPage | null>>;
  setPluginView: Dispatch<SetStateAction<PluginView | null>>;
  unsealFeatureEditors: () => void;
}

export function useOpenFeatureActions(deps: OpenFeatureActionsDeps) {
  const { feature, selected } = useOpenFeature();
  const {
    editorRef,
    loadFeatures,
    openDescriptionEditor,
    selectSidebarTab,
    setAppPage,
    setPluginView,
    unsealFeatureEditors,
  } = deps;
  const openFeature = async (file: string, opts: OpenOptions = {}) => {
    setFeatureLoading(true);
    const res = await fetch(`/api/features/${encodeURIComponent(file)}`).finally(() =>
      setFeatureLoading(false),
    );
    if (res.ok) {
      const data = await res.json();
      const parsed = featureFromResponse(data, file);
      // An open editor pane leaves the way `<` does — its last save goes out
      // now (specs/editor/spec-editor.feature.md "Spec editor pane"). Before
      // the selection moves on: the save places its scenario in the feature
      // it belongs to with a synchronous setFeature, which the feature opened
      // here must land on top of, not under. And not before the fetch, or
      // the old feature page would show for the duration of the request.
      editorRef.current.close();
      // A move / rename-file sealed the editors so the close above could not
      // PUT the retired path after git-mv. This is a live feature again.
      unsealFeatureEditors();
      // Opening a feature leaves the open plugin view — a page saves what
      // its editor still holds as it unmounts, the same courtesy the README
      // editor gets. An app page — Settings, Plugins — leaves too.
      setPluginView(null);
      setAppPage(null);
      // A new feature shows up in the tree, so the sidebar turns to the Specs
      // tab; a same-file refresh (sync, cron) leaves the tab where it is.
      if (file !== selected) selectSidebarTab(SPECS_TAB);
      setSelected(file);
      setFeature(parsed);
      let missingScenario: string | null = null;
      if (opts.scenario !== undefined) {
        // Deep link (specs/ui/navigation.feature.md): resolve slug (+ version)
        // to a card; a miss opens the feature with no selection and a note.
        const idx = opts.scenario === null ? null : resolveScenario(parsed.scenarios, opts.scenario);
        if (opts.scenario !== null && idx === null) missingScenario = opts.scenario.slug;
        setSelectedScenario(idx);
        // A scenario link opens that scenario's page
        // (specs/ui/navigation.feature.md "open a scenario link") — the whole
        // point of the card's "Copy link".
        setPaneRequest(
          opts.pane && idx !== null
            ? { scenario: parsed.scenarios[idx]!, terms: opts.terms ?? null }
            : null,
        );
      } else {
        // Keep the keyboard highlight across a same-file refresh (sync, cron);
        // drop it when switching files or when the list shrank past it.
        setSelectedScenario((prev) =>
          file === selected && prev !== null && prev < parsed.scenarios.length ? prev : null,
        );
      }
      if (opts.push && location.pathname !== featurePath(file)) {
        history.pushState(null, "", featurePath(file));
      }
      setDirty(false);
      // A same-file refresh keeps a feature name being edited in the header.
      if (file !== selected) setRenameDraft(null);
      setConflict(null);
      if (opts.editDescription) openDescriptionEditor(file, parsed.description);
      if (missingScenario) {
        toast.error(
          `Scenario "${missingScenario}" not found — it may have been renamed or deleted.`,
        );
      }
    } else {
      // The file is gone — deleted, renamed by the `.feature.md` migration, or
      // a stale deep link. Drop a stale selection rather than re-fetching it
      // on every reload tick; a link or click that misses leaves a note.
      unsealFeatureEditors();
      if (file === selected) {
        // The file is gone, so an editor open on it has nothing to save into.
        setEditing(null);
        setSelected(null);
        setFeature(null);
        setSelectedScenario(null);
      }
      if (opts.push || opts.scenario !== undefined) {
        // Said by what the app knows (linkSync.ts): "stale" only for a file
        // that is not there in a folder that was pulled.
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        toast.error(
          missedFeatureNote(file, res.status, {
            pullProblem: opts.pullProblem ?? null,
            error: typeof body?.error === "string" ? body.error : null,
          }),
        );
      }
      await loadFeatures();
    }
  };

  /**
   * The read-only site's tick for an open scenario page: the feature as the
   * server has it now, and when it differs from the one on screen, the same
   * scenario's page opened again on it — by name and version, the way its
   * link resolves, so a scenario that is gone says so and closes.
   */
  const refreshReadOnlyPane = async (file: string, open: Scenario): Promise<void> => {
    const res = await fetch(`/api/features/${encodeURIComponent(file)}`).catch(() => null);
    if (!res?.ok) return;
    const fresh = featureFromResponse(await res.json(), file);
    if (JSON.stringify(fresh) === JSON.stringify(feature)) return;
    await openFeature(file, { scenario: { slug: slugify(open.name), version: open.version }, pane: true });
  };
  return {
    openFeature,
    refreshReadOnlyPane,
  };
}

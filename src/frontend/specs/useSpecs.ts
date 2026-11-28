// The Specs tab's hooks, called together and in the order they stood in
// App.tsx: the refs they share, the effects that follow the editor pane,
// opening a feature, the session's selection, the folder and feature
// operations, publishing, saving and autosaving, the description editor,
// the fields' saves, the test links, the scenario operations, the tree's
// rows, the keys and the palette actions. One hook, so the shell calls
// Specs in one place, takes one typed list from it and gives it another.

import { type Dispatch, type ReactNode, type SetStateAction } from "react";
import { type PluginView, type TabPlugin } from "../../plugins/client/tabs";
import { type ProjectMember } from "../../server/members";
import { type Scenario } from "../../server/parser";
import { type PaletteItem } from "../CommandPalette";
import { type ConfirmOptions, type PickOptions, type PromptOptions } from "../ModalPrompts";
import { type AppPage } from "../route";
import { useSpecsDerived } from "./derived";
import { useDescriptionEditor } from "./descriptionEditor";
import { useEditorState } from "./editorState";
import { useEditorEffects } from "./editorEffects";
import { useFeatureCommands } from "./featureCommands";
import { useFeatureFields } from "./featureFields";
import { useFeatureOps } from "./featureOps";
import { setDescEdit, useFeaturePageState } from "./featurePageState";
import { type Listing } from "./listing";
import { useOpenFeatureActions } from "./openActions";
import { setFeature, setSelected, setSelectedScenario, useOpenFeature } from "./openFeature";
import { useFeaturePageKeys } from "./pageKeys";
import { useSpecsPaletteActions } from "./paletteActions";
import { usePublish } from "./publish";
import { useSpecsRefs } from "./refs";
import { useScenarioOps } from "./scenarioOps";
import { useScenarioSave } from "./scenarioSave";
import { useSessionSelection } from "./sessionSelection";
import { useSpecsShortcuts } from "./specsShortcuts";
import { useTestLinks } from "./testLinks";
import { useTreeScenarios } from "./treeScenarios";

/**
 * What the Specs tab's hooks take from the shell: its dialogs, the listing's
 * loader, where the pane and the sidebar stand and how to move them, whether
 * the folder can be written, and the few settings and derived values they
 * read. Everything else they need is their own.
 */
export interface SpecsShell {
  action: (id: string, label: string, icon: ReactNode, run: () => void, extra?: Partial<PaletteItem>) => PaletteItem;
  activeTab: TabPlugin<unknown> | null;
  autosaveSeconds: number;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  customAttributesText: string | null;
  loadFeatures: () => Promise<Listing | null>;
  locked: boolean;
  members: ProjectMember[];
  paneScenario: Scenario | null;
  pick: (opts: PickOptions) => Promise<string | null>;
  pluginView: PluginView | null;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  quiet: boolean;
  quietBehindPalette: boolean;
  readOnly: boolean;
  savedEntry: Scenario | null;
  selectSidebarTab: (tab: string) => void;
  setAppPage: Dispatch<SetStateAction<AppPage | null>>;
  setPluginView: Dispatch<SetStateAction<PluginView | null>>;
  setQtestParentUrl: Dispatch<SetStateAction<string>>;
}

export function useSpecs(deps: SpecsShell) {
  const { selected, dirty, editing } = useOpenFeature();
  const { conflict } = useEditorState();
  const { renameDraft } = useFeaturePageState();
  const {
    action,
    activeTab,
    autosaveSeconds,
    confirm,
    customAttributesText,
    loadFeatures,
    locked,
    members,
    paneScenario,
    pick,
    pluginView,
    prompt,
    quiet,
    quietBehindPalette,
    readOnly,
    savedEntry,
    selectSidebarTab,
    setAppPage,
    setPluginView,
    setQtestParentUrl,
  } = deps;
  const {
    attributeDefs,
    knownAttributes,
    statusTotals,
  } = useSpecsDerived({
    customAttributesText,
  });
  const {
    autosaveInFlight,
    autosaved,
    bodyFieldRef,
    deletingScenario,
    descEditRef,
    descPaneRef,
    descSaveQueue,
    descSaved,
    editorRef,
    editorSession,
    featureEditorsRetiring,
    featureEditorsSealed,
    nameFieldRef,
    renameDraftRef,
    renamingRef,
    revealPending,
    saveOnOpen,
    scenarioRefs,
    scenarioSaveQueue,
    selectedRef,
    testEditOpened,
    testLookup,
    treePickAnchor,
    treeRef,
  } = useSpecsRefs();
  const {
    editingOpen,
  } = useEditorEffects({
    autosaveInFlight,
    autosaved,
    deletingScenario,
    editorSession,
    revealPending,
    scenarioRefs,
    testLookup,
    treeRef,
  });
  const {
    openFeature,
    refreshReadOnlyPane,
  } = useOpenFeatureActions({
    editorRef,
    loadFeatures,
    // Declared further down: called through, not passed.
    openDescriptionEditor: (file, text) => openDescriptionEditor(file, text),
    // Declared further down: called through, not passed.
    selectSidebarTab: (tab) => selectSidebarTab(tab),
    setAppPage,
    setPluginView,
    // Declared further down: called through, not passed.
    unsealFeatureEditors: () => unsealFeatureEditors(),
  });
  const {
    checkedLabel,
    describeSelection,
    selectionLabel,
    sessionBundle,
    sessionCount,
    sessionFiles,
  } = useSessionSelection({
    activeTab,
    locked,
    paneScenario,
    pluginView,
  });
  const {
    createFolder,
    createFolderIn,
    editFeatureDisplayName,
    editFolderDisplayName,
    fileStem,
    folderMenuKey,
    moveFeatureTo,
    moveFolder,
    moveFolderPrompt,
    moveFolderTo,
    moveTo,
    removeFolder,
    renameFile,
    renameFolder,
    renameSelected,
    reorderFeature,
    reorderFolder,
  } = useFeatureOps({
    confirm,
    descSaveQueue,
    editorRef,
    featureEditorsRetiring,
    loadFeatures,
    openFeature,
    pick,
    prompt,
    renameDraftRef,
    renamingRef,
    scenarioSaveQueue,
    selectedRef,
    // Declared further down: called through, not passed.
    unsealFeatureEditors: () => unsealFeatureEditors(),
  });
  const {
    confluencePublished,
    openQtestPublish,
    publish,
    qtestPublished,
    removeFeature,
  } = usePublish({
    confirm,
    descSaveQueue,
    editorRef,
    featureEditorsRetiring,
    loadFeatures,
    // Declared further down: called through, not passed.
    markSaved: () => markSaved(),
    openFeature,
    scenarioSaveQueue,
    selectedRef,
    setQtestParentUrl,
    // Declared further down: called through, not passed.
    unsealFeatureEditors: () => unsealFeatureEditors(),
  });
  const {
    draftVersion,
    markSaved,
    nextVersionFor,
    proposeScenario,
    publishScenario,
    saveScenario,
  } = useScenarioSave({
    autosaveInFlight,
    autosaveSeconds,
    autosaved,
    deletingScenario,
    editingOpen,
    editorSession,
    featureEditorsRetiring,
    featureEditorsSealed,
    nameFieldRef,
    publish,
    saveOnOpen,
    scenarioSaveQueue,
    selectedRef,
  });
  const {
    closeDescriptionEditor,
    descTick,
    openDescriptionEditor,
  } = useDescriptionEditor({
    autosaveSeconds,
    descEditRef,
    descSaveQueue,
    descSaved,
    featureEditorsRetiring,
    featureEditorsSealed,
    markSaved,
    selectedRef,
  });
  const {
    assignableMembers,
    changeLinkDraft,
    changeQtestDraft,
    saveAssigned,
    saveFeatureAttributes,
    saveFeatureFlags,
    saveFeatureQtest,
    saveFeatureTickets,
    savePullRequests,
    saveResourceLinks,
    saveScenarioFileList,
    setTests,
    uploadScenarioFiles,
  } = useFeatureFields({
    confirm,
    markSaved,
    members,
    selectedRef,
  });
  const {
    addTest,
    cancelTestLookup,
    commitTestEdit,
    removeTest,
    startTestEdit,
    testsTable,
  } = useTestLinks({
    setTests,
    testEditOpened,
    testLookup,
  });
  const {
    backToFeature,
    canAddAfter,
    closeEditor,
    confirmScenarioDelete,
    deleteScenario,
    moveScenarioTo,
    newScenarioAfterCurrent,
    newVersion,
    reorderScenario,
    toggleScenarioPolarityAt,
    unpublishScenario,
    unsealFeatureEditors,
  } = useScenarioOps({
    autosaveInFlight,
    autosaved,
    confirm,
    deletingScenario,
    descSaveQueue,
    descTick,
    draftVersion,
    editorRef,
    editorSession,
    featureEditorsRetiring,
    featureEditorsSealed,
    markSaved,
    nextVersionFor,
    prompt,
    saveOnOpen,
    saveScenario,
    scenarioSaveQueue,
    selectedRef,
  });
  const {
    clearTreePicks,
    cloneTreeScenario,
    deletePickedScenarios,
    deleteTreeScenario,
    dropTreeScenario,
    endScenarioDrag,
    moveScenarioToFeature,
    moveTreeScenario,
    openScenarioRow,
    pickTreeScenario,
    pickedTreeScenarios,
  } = useTreeScenarios({
    autosaveInFlight,
    closeEditor,
    confirm,
    confirmScenarioDelete,
    deleteScenario,
    featureEditorsSealed,
    loadFeatures,
    markSaved,
    moveScenarioTo,
    openFeature,
    paneScenario,
    pick,
    savedEntry,
    scenarioSaveQueue,
    selectedRef,
    treePickAnchor,
    treeRef,
  });
  const {
    moveScenarioSelection,
    newScenario,
    onFeaturePage,
    openSelectedScenario,
    scenarioLink,
    scenarioNav,
    stepScenario,
  } = useFeaturePageKeys({
    openScenarioRow,
    prompt,
    readOnly,
    saveOnOpen,
    scenarioRefs,
  });
  const {
    specsShortcuts,
  } = useSpecsShortcuts({
    moveScenarioSelection,
    onFeaturePage,
    openSelectedScenario,
    proposeScenario,
    publish,
    publishScenario,
    quiet,
    quietBehindPalette,
    reorderScenario,
    scenarioNav,
    stepScenario,
  });
  const {
    createFeature,
    createFeatureIn,
    dismissConflict,
    moveFeaturePrompt,
    openConfluenceFolder,
    resolveWith,
    toggleFolder,
    toggleOutline,
  } = useFeatureCommands({
    fileStem,
    loadFeatures,
    moveTo,
    openFeature,
    pick,
    prompt,
  });
  const {
    specsFeatureActions,
    specsFolderActions,
  } = useSpecsPaletteActions({
    action,
    editFolderDisplayName,
    moveFeaturePrompt,
    moveFolderPrompt,
    removeFeature,
    removeFolder,
    renameFolder,
    reorderFeature,
    reorderFolder,
  });
  /**
   * A data folder switch (the plugin's `data/leaving`): what the scenario
   * editor and the description editor hold lands in the folder it was typed
   * in. Each queue is awaited after its tick — a boolean in-flight flag
   * would make the tick a no-op while a PUT is already away, and that PUT
   * would then land in the folder that comes next (the server resolves the
   * data folder per request). The description's own cleanup tick would only
   * run once the selection empties, after the switch, so it lands here and
   * the editor is emptied so no later tick can.
   */
  /**
   * The pane is given to something else (the tab's `leave`): an open editor
   * pane leaves the way `<` does — its last save goes out before the
   * selection drops (specs/editor/spec-editor.feature.md "Spec editor pane")
   * — and no feature is open.
   */
  const leaveFeature = () => {
    editorRef.current.close();
    setSelected(null);
    setFeature(null);
    setSelectedScenario(null);
  };
  /**
   * The reload tick (the plugin's `reload/tick`): the open feature as the
   * folder now has it, without clobbering an in-progress edit or conflict
   * resolution.
   */
  const refreshOpenFeature = async (): Promise<void> => {
    const loads: Promise<unknown>[] = [];
    // The description editor holding an edit that hasn't landed yet keeps
    // its feature as is.
    const descPending =
      descEditRef.current !== null && descEditRef.current.text !== descSaved.current;
    // Nor while the header's feature name is being edited in place
    // (specs/ui/ui.feature.md "Main page"): re-opening the feature would
    // close the field mid-typing and drop the new name.
    if (selected && !dirty && !editing && !conflict && !descPending && renameDraft === null) {
      loads.push(openFeature(selected));
    }
    // The public specs site re-reads the open page too (specs/app/
    // public-specs-site.feature.md "A change pushed to the spec repo shows up
    // on the site"), and a scenario's page there is the editor pane — which
    // the rule above leaves alone so a refresh cannot clobber an edit. Nothing
    // is edited on that site, so the pane re-opens on the scenario as the
    // server now has it, once the feature changed.
    if (locked && selected && editing && editing.index !== null && !editing.isNew) {
      loads.push(refreshReadOnlyPane(selected, editing.scenario));
    }
    await Promise.all(loads);
  };
  const landSpecsEditors = async () => {
    await editorRef.current.close();
    await scenarioSaveQueue.current.idle();
    await descTick.current();
    await descSaveQueue.current.idle();
    setDescEdit(null);
  };
  return {
    addTest,
    assignableMembers,
    attributeDefs,
    backToFeature,
    bodyFieldRef,
    canAddAfter,
    cancelTestLookup,
    changeLinkDraft,
    changeQtestDraft,
    checkedLabel,
    clearTreePicks,
    cloneTreeScenario,
    closeDescriptionEditor,
    commitTestEdit,
    confluencePublished,
    createFeature,
    createFeatureIn,
    createFolder,
    createFolderIn,
    deletePickedScenarios,
    deleteScenario,
    deleteTreeScenario,
    descPaneRef,
    descSaved,
    describeSelection,
    dismissConflict,
    draftVersion,
    dropTreeScenario,
    editFeatureDisplayName,
    editFolderDisplayName,
    editorRef,
    endScenarioDrag,
    folderMenuKey,
    knownAttributes,
    landSpecsEditors,
    leaveFeature,
    markSaved,
    moveFeaturePrompt,
    moveFeatureTo,
    moveFolder,
    moveFolderPrompt,
    moveFolderTo,
    moveScenarioToFeature,
    moveTo,
    moveTreeScenario,
    nameFieldRef,
    newScenario,
    newScenarioAfterCurrent,
    newVersion,
    onFeaturePage,
    openConfluenceFolder,
    openDescriptionEditor,
    openFeature,
    openQtestPublish,
    openScenarioRow,
    pickTreeScenario,
    pickedTreeScenarios,
    proposeScenario,
    publish,
    publishScenario,
    qtestPublished,
    refreshOpenFeature,
    removeFeature,
    removeFolder,
    removeTest,
    renameDraftRef,
    renameFile,
    renameFolder,
    renameSelected,
    reorderScenario,
    resolveWith,
    saveAssigned,
    saveFeatureAttributes,
    saveFeatureFlags,
    saveFeatureQtest,
    saveFeatureTickets,
    savePullRequests,
    saveResourceLinks,
    saveScenarioFileList,
    scenarioLink,
    scenarioNav,
    scenarioRefs,
    selectionLabel,
    sessionBundle,
    sessionCount,
    sessionFiles,
    specsFeatureActions,
    specsFolderActions,
    specsShortcuts,
    startTestEdit,
    statusTotals,
    stepScenario,
    testsTable,
    toggleFolder,
    toggleOutline,
    toggleScenarioPolarityAt,
    treePickAnchor,
    treeRef,
    unpublishScenario,
    uploadScenarioFiles,
  };
}

/**
 * What the hooks hand back: the handlers and values the Specs tab's
 * components are given (./host.ts SpecsActions, the tree's props), and the
 * ones the shell still calls itself — the editor's ways out, opening a
 * feature, the session's selection, the keys and palette actions. The shell's
 * share shrinks as it goes through the tab contract instead.
 */
export type SpecsApi = ReturnType<typeof useSpecs>;

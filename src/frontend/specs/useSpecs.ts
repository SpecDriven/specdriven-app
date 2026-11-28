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
import { useEditorEffects } from "./editorEffects";
import { useFeatureCommands } from "./featureCommands";
import { useFeatureFields } from "./featureFields";
import { useFeatureOps } from "./featureOps";
import { type Listing } from "./listing";
import { useOpenFeatureActions } from "./openActions";
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
    descEditRef,
    descPaneRef,
    descSaveQueue,
    descSaved,
    descTick,
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
    refreshReadOnlyPane,
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
    scenarioSaveQueue,
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

// The feature page's own state — its menus and popovers, the name and the
// description being edited in place, and the description editor's height —
// kept apart from App.tsx like the open feature (./openFeature.ts), so the
// page can be a component of the Specs tab (specs/app/plugins.feature.md
// "Specs is a built-in plugin"). App.tsx still sets all of it, under the
// names its own state had.

import type { ResourceLinkKind } from "../../server/resourceLinks";
import type { LinkDraft } from "../externallinks";
import { DESC_HEIGHT_KEY, DESC_MIN, readEditorHeight } from "./editorHeight";
import { createStore } from "./store";

export interface FeaturePageState {
  /** The header's ⋯ menu, a card's ⋯ menu (by index), the assignee chips. */
  featureMenuOpen: boolean;
  cardMenu: number | null;
  assigneeMenuOpen: boolean;
  /** The publish-rollup menu (specs/editor/spec-editor.feature.md "Spec editor pane"). */
  publishMenuOpen: boolean;
  /** Whether an assignment change is in flight — the dropdown waits for it. */
  assignedSaving: boolean;
  /** Draft for the inline file-name editor; null while not editing. */
  renameDraft: string | null;
  renaming: boolean;
  /** The feature's tickets popover (specs/external-links/project-management-
      jira-linear-etc.feature.md "Several tickets on a feature"): open or not,
      why the server refused the last list, and whether one is on its way. */
  featureTicketsOpen: boolean;
  featureTicketsError: string | null;
  featureTicketsSaving: boolean;
  /** The feature's own qTest dialog (specs/external-links/qtest-test-cases.feature.md). */
  featureQtestDraft: LinkDraft | null;
  featureQtestError: string | null;
  featureQtestSaving: boolean;
  /** The feature's "Pull requests" popover
      (specs/external-links/related-pull-requests.feature.md). */
  featurePrsOpen: boolean;
  featureFlagsOpen: boolean;
  /** The feature's attributes popover (specs/app/custom-attributes.feature.md). */
  featureAttributesOpen: boolean;
  /** The feature's Aha! or Figma popover, whichever is open
      (specs/external-links/aha-and-figma-links.feature.md). */
  featureResourceOpen: ResourceLinkKind | null;
  // The feature description editor (specs/editor/feature-editor.feature.md):
  // the free markdown above the first scenario, edited in place and autosaved
  // at the scenario editor's interval like the home README. Keyed by file so
  // the editor belongs to the feature it was opened on — it shows only while
  // that feature is selected, and a save that lands after the user moved on
  // stamps nothing onto the feature opened since.
  descEdit: { file: string; text: string } | null;
  // The editor's height, dragged by the strip along its lower boundary. null
  // until a first drag or a stored height: then the CSS third-of-the-window
  // default stands, and follows the window.
  descHeight: number | null;
  resizingDesc: boolean;
}

const store = createStore<FeaturePageState>(() => ({
  featureMenuOpen: false,
  cardMenu: null,
  assigneeMenuOpen: false,
  publishMenuOpen: false,
  assignedSaving: false,
  renameDraft: null,
  renaming: false,
  featureTicketsOpen: false,
  featureTicketsError: null,
  featureTicketsSaving: false,
  featureQtestDraft: null,
  featureQtestError: null,
  featureQtestSaving: false,
  featurePrsOpen: false,
  featureFlagsOpen: false,
  featureAttributesOpen: false,
  featureResourceOpen: null,
  descEdit: null,
  descHeight: readEditorHeight(DESC_HEIGHT_KEY, DESC_MIN),
  resizingDesc: false,
}));

export const setFeatureMenuOpen = store.field("featureMenuOpen");
export const setCardMenu = store.field("cardMenu");
export const setAssigneeMenuOpen = store.field("assigneeMenuOpen");
export const setPublishMenuOpen = store.field("publishMenuOpen");
export const setAssignedSaving = store.field("assignedSaving");
export const setRenameDraft = store.field("renameDraft");
export const setRenaming = store.field("renaming");
export const setFeatureTicketsOpen = store.field("featureTicketsOpen");
export const setFeatureTicketsError = store.field("featureTicketsError");
export const setFeatureTicketsSaving = store.field("featureTicketsSaving");
export const setFeatureQtestDraft = store.field("featureQtestDraft");
export const setFeatureQtestError = store.field("featureQtestError");
export const setFeatureQtestSaving = store.field("featureQtestSaving");
export const setFeaturePrsOpen = store.field("featurePrsOpen");
export const setFeatureFlagsOpen = store.field("featureFlagsOpen");
export const setFeatureAttributesOpen = store.field("featureAttributesOpen");
export const setFeatureResourceOpen = store.field("featureResourceOpen");
export const setDescEdit = store.field("descEdit");
export const setDescHeight = store.field("descHeight");
export const setResizingDesc = store.field("resizingDesc");

/** A fresh App: nothing open, the description's height as this device stored it. */
export const resetFeaturePageState = store.reset;
export const featurePageState = store.get;
/** The feature page's state, re-rendering as it changes. */
export const useFeaturePageState = store.use;

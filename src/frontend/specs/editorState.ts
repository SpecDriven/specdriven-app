// The scenario editor pane's own state — what its menus, its Saved
// indicator, its link fields and its body's height hold, and a publish or a
// merge conflict under way — kept apart from App.tsx like the open feature
// (./openFeature.ts), so the editor can be a component of the Specs tab
// (specs/app/plugins.feature.md "Specs is a built-in plugin"). App.tsx still
// sets all of it, under the names its own state had.

import type { ScenarioTarget } from "../../server/parser";
import type { LinkDraft } from "../externallinks";
import { EMPTY_LINK_DRAFT } from "../externallinks";
import type { TestDraft } from "../testlinks";
import { BODY_HEIGHT_KEY, BODY_MIN, readEditorHeight } from "./editorHeight";
import { createStore } from "./store";

/** A publish the server refused because the file changed under it. */
export interface Conflict {
  ours: string;
  theirs: string;
  message: string;
  /** Set when the conflicted publish targeted a single scenario — with its
      document id, so the resolution still renames rather than doubles it. */
  scenario?: ScenarioTarget;
}

export interface EditorState {
  // The scenario pane's ⋯ menu and its status chip's menu
  // (specs/editor/spec-editor.feature.md "Spec editor pane"): actions as
  // menus, not a row of filled buttons.
  editorMenuOpen: boolean;
  statusMenuOpen: boolean;
  conflict: Conflict | null;
  conflictDraft: string;
  /** Which resolution is being published, if any — the buttons disable while it runs. */
  resolving: "ours" | "theirs" | "draft" | null;
  /** Autosave state behind the header's Saved indicator. */
  saving: boolean;
  savedAt: number | null;
  /** "all", a scenario key (`name@vN`), or null while no publish is running. */
  publishing: string | null;
  // The editor pane's Back to proposed is away (specs/editor/spec-editor.
  // feature.md "Unpublish a Spec"): its route commits and pushes first.
  unpublishing: boolean;
  /** Url being typed into the edit dialog's "Add test link" field. */
  testDraft: string;
  /** The test's name beside it: read from the code on GitHub, or typed. */
  testNameDraft: string;
  /** Index of the test link opened for in-place ✎ editing, if any. */
  testEdit: number | null;
  testEditDraft: TestDraft;
  /** What the last name lookup is doing or why it found nothing, under the field. */
  testNameHint: string | null;
  /** Why the last Save was blocked by the tests field, if it was. */
  testsError: string | null;
  /** The edit dialog's "Ticket link" fields as typed
      (specs/external-links/project-management-jira-linear-etc.feature.md). */
  linkDraft: LinkDraft;
  /** Why the last Save was blocked by the ticket-link fields, if it was. */
  linkError: string | null;
  /** The edit dialog's "qTest test case" fields as typed
      (specs/external-links/qtest-test-cases.feature.md), and why the last
      Save was blocked by them. */
  qtestDraft: LinkDraft;
  qtestError: string | null;
  // The scenario body's height (specs/editor/spec-editor.feature.md "Spec
  // body resize"), dragged by the strip under it: null until a first drag or
  // a stored height, while the CSS default stands.
  bodyHeight: number | null;
  resizingBody: boolean;
}

const store = createStore<EditorState>(() => ({
  editorMenuOpen: false,
  statusMenuOpen: false,
  conflict: null,
  conflictDraft: "",
  resolving: null,
  saving: false,
  savedAt: null,
  publishing: null,
  unpublishing: false,
  testDraft: "",
  testNameDraft: "",
  testEdit: null,
  testEditDraft: { url: "", name: "" },
  testNameHint: null,
  testsError: null,
  linkDraft: EMPTY_LINK_DRAFT,
  linkError: null,
  qtestDraft: EMPTY_LINK_DRAFT,
  qtestError: null,
  bodyHeight: readEditorHeight(BODY_HEIGHT_KEY, BODY_MIN),
  resizingBody: false,
}));

export const setEditorMenuOpen = store.field("editorMenuOpen");
export const setStatusMenuOpen = store.field("statusMenuOpen");
export const setConflict = store.field("conflict");
export const setConflictDraft = store.field("conflictDraft");
export const setResolving = store.field("resolving");
export const setSaving = store.field("saving");
export const setSavedAt = store.field("savedAt");
export const setPublishing = store.field("publishing");
export const setUnpublishing = store.field("unpublishing");
export const setTestDraft = store.field("testDraft");
export const setTestNameDraft = store.field("testNameDraft");
export const setTestEdit = store.field("testEdit");
export const setTestEditDraft = store.field("testEditDraft");
export const setTestNameHint = store.field("testNameHint");
export const setTestsError = store.field("testsError");
export const setLinkDraft = store.field("linkDraft");
export const setLinkError = store.field("linkError");
export const setQtestDraft = store.field("qtestDraft");
export const setQtestError = store.field("qtestError");
export const setBodyHeight = store.field("bodyHeight");
export const setResizingBody = store.field("resizingBody");

/** A fresh App: nothing open, the body's height as this device stored it. */
export const resetEditorState = store.reset;
export const editorState = store.get;
/** The editor pane's state, re-rendering as it changes. */
export const useEditorState = store.use;

// Which of the Specs tab's dialogs is open — the imports into a spec folder,
// the publishing of a feature or a folder, extracting specs from code and
// linking tests — kept apart from App.tsx like the open feature
// (./openFeature.ts). The tree, the feature page and the palette's commands
// open them; App.tsx still renders them.

import type { FolderFeature } from "../ConfluenceFolderPublishDialog";
import { createStore } from "./store";

export interface SpecsDialogs {
  /** Confluence (specs/external-links/confluence-wiki.feature.md): the publish dialog. */
  confluencePublishOpen: boolean;
  /** "Publish to Confluence…" on a folder ("Publish a folder's features to
      Confluence"): the folder, as the sidebar names it, and its features —
      null until the server says which pages they link. */
  confluenceFolder: { path: string; label: string; features: FolderFeature[] | null } | null;
  /** qTest (specs/external-links/qtest-test-cases.feature.md "Create qTest
      test cases from a feature"): the dialog. */
  qtestPublishOpen: boolean;
  /** "Publish to Wiki & qTest…" (specs/external-links/qtest-test-cases.feature.md
      "Publish the page and the test cases from one dialog"): the page first,
      then the test cases, from one dialog. */
  wikiQtestPublishOpen: boolean;
  /** Aha! (specs/external-links/aha-import.feature.md): the folder an open
      import lands in (null for the top level) — or null while the dialog is
      closed. */
  ahaImportOpen: { folder: string | null } | null;
  /** Import from OpenSpec (specs/external-links/openspec-import.feature.md):
      the folder an open import lands in (null for the top level), or null
      while the dialog is closed. */
  openSpecImportOpen: { folder: string | null } | null;
  /** Extract specs from a code project (specs/app/extract-specs-from-code
      .feature.md): the project the dialog starts on — the open code
      repository — or null to ask for one; null while the dialog is closed. */
  extractOpen: { codeDir: string | null } | null;
  /** Import from Jira/Wiki (specs/external-links/jira-wiki-import
      .feature.md): the folder an open import lands in (null for the top
      level) — or null while the dialog is closed. */
  importOpen: { folder: string | null; mode: "both" | "jira" | "wiki" } | null;
  /** Publish the folder's proposed specs. */
  publishOpen: boolean;
  /** "Link tests to specs" (specs/app/extract-specs-from-code.feature.md
      "Tests are linked later, on their own"). */
  linkTestsOpen: boolean;
}

const store = createStore<SpecsDialogs>(() => ({
  confluencePublishOpen: false,
  confluenceFolder: null,
  qtestPublishOpen: false,
  wikiQtestPublishOpen: false,
  ahaImportOpen: null,
  openSpecImportOpen: null,
  extractOpen: null,
  importOpen: null,
  publishOpen: false,
  linkTestsOpen: false,
}));

export const setConfluencePublishOpen = store.field("confluencePublishOpen");
export const setConfluenceFolder = store.field("confluenceFolder");
export const setQtestPublishOpen = store.field("qtestPublishOpen");
export const setWikiQtestPublishOpen = store.field("wikiQtestPublishOpen");
export const setAhaImportOpen = store.field("ahaImportOpen");
export const setOpenSpecImportOpen = store.field("openSpecImportOpen");
export const setExtractOpen = store.field("extractOpen");
export const setImportOpen = store.field("importOpen");
export const setPublishOpen = store.field("publishOpen");
export const setLinkTestsOpen = store.field("linkTestsOpen");

/** Every dialog closed — a fresh App, where its own state used to start. */
export const resetSpecsDialogs = store.reset;
export const specsDialogs = store.get;
/** Which dialogs are open, re-rendering as it changes. */
export const useSpecsDialogs = store.use;

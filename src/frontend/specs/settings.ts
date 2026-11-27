// The switches of Settings the Specs tab reads — what a scenario card shows,
// which links and chips a feature carries, which imports are offered — kept
// apart from App.tsx like the open feature (./openFeature.ts), so the tree,
// the feature page and the editor read them from the Specs tab
// (specs/app/plugins.feature.md "Specs is a built-in plugin"). App.tsx still
// sets them from `GET` and `PUT /api/state`, under the names its own state
// had; the Settings page keeps its drafts.

import type { ResourceLinkKind } from "../../server/resourceLinks";
import { createStore } from "./store";

export type ResourceLinkSwitches = Record<ResourceLinkKind, boolean>;
export const NO_RESOURCE_LINKS: ResourceLinkSwitches = { aha: false, figma: false };

/** The tool tickets live in until Settings names another. */
export const DEFAULT_PROJECT_MANAGEMENT_TOOL = "Jira";

export interface SpecsSettings {
  /** How many lines of a scenario its card shows. */
  previewLines: number;
  // Test links (specs/traceability.feature.md): the table of automated-test
  // links at the end of each scenario card is optional; default ON.
  showTestLinks: boolean;
  // External links (specs/external-links/project-management-jira-linear-etc.
  // feature.md): whether ticket links are written into the .feature.md files.
  publishExternalLinks: boolean;
  // Project management (specs/external-links/project-management-jira-linear-
  // etc.feature.md): whether tickets are tracked at all, and the tool they
  // live in. Off, nothing in the app shows or asks for a ticket; on, the
  // editors ask for the ticket's url alone — the tool is this one.
  projectManagement: boolean;
  projectManagementTool: string;
  /** Which of Aha! and Figma features and scenarios link to
      (specs/external-links/aha-and-figma-links.feature.md). */
  resourceLinksOn: ResourceLinkSwitches;
  /** Whether features and scenarios link qTest test cases
      (specs/external-links/qtest-test-cases.feature.md); default OFF. */
  qtestLinks: boolean;
  /** Whether "Import from Aha!" is switched on in Settings → Aha!, default OFF. */
  ahaImportOn: boolean;
  /** Whether Jira and Confluence are switched on at all — in Settings → Jira /
      Confluence, each default OFF (specs/external-links/jira-wiki-import
      .feature.md, confluence-wiki.feature.md). Jira off hides the Jira import;
      Confluence off hides "Publish to Confluence…" and the Confluence import. */
  jiraEnabledOn: boolean;
  confluenceEnabledOn: boolean;
  // Deleting published scenarios (specs/editor/spec-editor.feature.md "Delete
  // Published Spec"): opt-in — published scenarios stay immutable until the
  // Settings switch turns deletion on.
  deletePublished: boolean;
  // Feature assignment (src/server/members.ts): opt-in — the "Assigned"
  // dropdown shows only once the Settings switch turns assignments on.
  assignments: boolean;
  // Feature flags (specs/app/feature-flags.feature.md): opt-in — the flag
  // chips and editors show only once the Settings switch turns them on.
  featureFlags: boolean;
  // Scenario polarity (specs/ui/scenario-polarity.feature.md): opt-in — the
  // Positive / Negative pill shows only once the Settings switch turns it on.
  scenarioPolarity: boolean;
}

const store = createStore<SpecsSettings>(() => ({
  previewLines: 8,
  showTestLinks: true,
  publishExternalLinks: true,
  projectManagement: true,
  projectManagementTool: DEFAULT_PROJECT_MANAGEMENT_TOOL,
  resourceLinksOn: NO_RESOURCE_LINKS,
  qtestLinks: false,
  ahaImportOn: false,
  jiraEnabledOn: false,
  confluenceEnabledOn: false,
  deletePublished: false,
  assignments: false,
  featureFlags: false,
  scenarioPolarity: false,
}));

export const setPreviewLines = store.field("previewLines");
export const setShowTestLinks = store.field("showTestLinks");
export const setPublishExternalLinks = store.field("publishExternalLinks");
export const setProjectManagement = store.field("projectManagement");
export const setProjectManagementTool = store.field("projectManagementTool");
export const setResourceLinksOn = store.field("resourceLinksOn");
export const setQtestLinks = store.field("qtestLinks");
export const setAhaImportOn = store.field("ahaImportOn");
export const setJiraEnabledOn = store.field("jiraEnabledOn");
export const setConfluenceEnabledOn = store.field("confluenceEnabledOn");
export const setDeletePublished = store.field("deletePublished");
export const setAssignments = store.field("assignments");
export const setFeatureFlags = store.field("featureFlags");
export const setScenarioPolarity = store.field("scenarioPolarity");

/** The defaults — a fresh App, before its first read of /api/state. */
export const resetSpecsSettings = store.reset;
export const specsSettings = store.get;
/** The switches, re-rendering as they change. */
export const useSpecsSettings = store.use;

// What App.tsx hands the Specs tab (src/plugins/builtin/specs/client.tsx)
// while the tree is still built inside App and the handlers of the feature
// page and the editor still live there: the tree's element, and the
// handlers that act on App's state. App publishes a fresh host on every
// render, before its children render, so the tab's Sidebar, Pane and
// Overlay — rendered as App's children — always read this render's, and the
// tab's create and shortcut hooks read this render's handlers when they run.
//
// Not part of the plugin SDK: a seam for moving the Specs tab out of App.tsx
// a piece at a time (specs/app/plugins.feature.md "Specs is a built-in
// plugin"). Each later move takes a field off it.

import type { MouseEvent, ReactNode, RefObject } from "react";
import type { OpenViewOptions, TabShortcut } from "../../plugins/client/tabs";
import type { SpecsView } from "../../plugins/builtin/specs/route";
import type { AttributeDefinitions, KnownAttributes } from "../../server/customAttributes";
import type { AgentDescriptor } from "../../server/agentTypes";
import type { FeatureListing } from "../../server/features";
import type { ProjectMember } from "../../server/members";
import type {
  ExternalLink as TicketLink,
  Feature,
  FeatureFlag,
  PullRequestLink,
  ResourceLink,
  Scenario,
  ScenarioFile,
  ScenarioTarget,
  SpecAttribute,
} from "../../server/parser";
import type { ResourceLinkKind } from "../../server/resourceLinks";
import type { AgentModels } from "../AgentModels";
import type { AhaSite } from "../AhaToken";
import type { Crumb } from "../Breadcrumbs";
import type { ConfluencePublishResult } from "../ConfluencePublishDialog";
import type { ConfluenceWiki } from "../ConfluenceToken";
import type { JiraSite } from "../JiraToken";
import type { QtestPublishResult } from "../QtestPublishDialog";
import type { QtestSite } from "../QtestToken";
import type { LinkDraft } from "../externallinks";
import type { ScenarioRow, scenarioNeighbors } from "../tree";

/**
 * What the feature page, the scenario page and the editor still call in
 * App.tsx — the handlers that act on App's state, and what it derives for
 * them. They read their own state from the stores beside this file; a
 * handler leaves this list when it moves there too.
 */
export interface SpecsActions {
  /** `<` and ESC: back to the feature, on the scenario's card. */
  backToFeature(): void;
  /** The url "Copy link" shares for a scenario: versionless on the public site. */
  scenarioLink(fileName: string, scenario: Pick<Scenario, "name" | "version">): string;
  /** The scenarios before and after the open one, in the tree's order — across features too. */
  scenarioNav: ReturnType<typeof scenarioNeighbors>;
  /** Step to the scenario before (-1) or after (1) the open one. */
  stepScenario(step: -1 | 1): void | false;
  /** The clickable test-links table at the end of a scenario (specs/traceability.feature.md). */
  testsTable(tests: string[]): ReactNode;

  // The editor pane's.
  /** The open scenario as last saved, or null for a new one no save has placed. */
  savedEntry: Scenario | null;
  /** Its version as the draft has it. */
  draftVersion: number;
  /** A published scenario: its name and body are no longer edited. */
  editingPublished: boolean;
  /** Whether Delete is offered for it (a published one only where Settings allows). */
  editingDeletable: boolean;
  /** Whether "New scenario after this one" has a saved scenario to follow. */
  canAddAfter: boolean;
  /** The title field, so an autosave tick can see whether the name is still being typed. */
  nameFieldRef: RefObject<HTMLInputElement | null>;
  /** The body editor's box, measured while its height is dragged. */
  bodyFieldRef: RefObject<HTMLDivElement | null>;
  /** The data repo's attribute definitions, and the names and values in use. */
  attributeDefs: AttributeDefinitions;
  knownAttributes: KnownAttributes;
  newScenarioAfterCurrent(): Promise<void>;
  cloneTreeScenario(file: string, s: ScenarioRow): Promise<void>;
  newVersion(index: number): void;
  deleteScenario(): Promise<void>;
  proposeScenario(): Promise<void>;
  publishScenario(): Promise<void>;
  unpublishScenario(): Promise<void>;
  // The automated-tests field.
  addTest(): void;
  removeTest(index: number): void;
  startTestEdit(index: number): void;
  commitTestEdit(): void;
  cancelTestLookup(): void;
  // The ticket and qTest link fields as typed.
  changeLinkDraft(draft: LinkDraft): void;
  changeQtestDraft(draft: LinkDraft): void;
  // What a scenario (a target) or the feature (null) links to and carries.
  savePullRequests(target: ScenarioTarget | null, prs: PullRequestLink[]): Promise<void>;
  saveResourceLinks(target: ScenarioTarget | null, kind: ResourceLinkKind, links: ResourceLink[]): Promise<void>;
  uploadScenarioFiles(target: ScenarioTarget | null, listed: ScenarioFile[], chosen: File[], replacing?: string): Promise<void>;
  saveScenarioFileList(target: ScenarioTarget | null, files: ScenarioFile[]): Promise<void>;

  // The feature page's.
  /** The folder cannot be written: the read-only site, or a spec folder with nowhere to push. */
  locked: boolean;
  /** The shell's: the demo, the hosted app, code gen sessions offered at all. */
  demo: boolean;
  hosted: boolean;
  codeGen: boolean;
  /** Confluence is switched on, and this is neither the demo nor the hosted app. */
  confluenceEnabled: boolean;
  /** A code gen session is starting, and how many specs and scenarios one would take. */
  sessionRunning: boolean;
  sessionCount: number;
  startSession(): void;
  /** A click that stays in the app unless a modifier asks for a new tab. */
  spaClick(e: MouseEvent, go: () => void): void;
  /** The crumbs a module hangs on a feature (an Event Model's slice names its model). */
  pluginCrumbs(fileName: string): Crumb[];
  /** The name field's draft and the description's last saved text, as the latest render had them. */
  renameDraftRef: RefObject<string | null>;
  descSaved: RefObject<string | null>;
  /** The description editor's box, measured while its height is dragged. */
  descPaneRef: RefObject<HTMLDivElement | null>;
  /** The scenario cards, by index, for scrolling the highlighted one into view. */
  scenarioRefs: RefObject<(HTMLElement | null)[]>;
  renameSelected(): Promise<void>;
  renameFile(fileName: string): Promise<void>;
  moveFeaturePrompt(fileName?: string | null): Promise<void>;
  removeFeature(f: FeatureListing): Promise<void>;
  openDescriptionEditor(file: string, text: string): void;
  closeDescriptionEditor(): Promise<void>;
  newScenario(insertAt?: number): Promise<void>;
  reorderScenario(index: number, delta: -1 | 1): Promise<void>;
  toggleScenarioPolarityAt(index: number): Promise<void>;
  /** Publish the feature's proposed scenarios, or one of them. */
  publish(scenario?: ScenarioTarget, over?: Feature, file?: string | null): Promise<void>;
  openQtestPublish(f: Feature): Promise<void>;
  assignableMembers(): ProjectMember[];
  saveAssigned(name: string): Promise<void>;
  saveFeatureTickets(links: TicketLink[]): Promise<void>;
  saveFeatureQtest(): Promise<void>;
  saveFeatureFlags(flags: FeatureFlag[]): Promise<void>;
  saveFeatureAttributes(attributes: SpecAttribute[]): Promise<void>;
  // A scenario card dragged among the cards, or onto another feature in the tree.
  endScenarioDrag(): void;
  dropTreeScenario(
    file: string,
    dragged: { name: string; version: number },
    target: { name: string; version: number },
    after: boolean,
  ): Promise<void>;
  moveScenarioToFeature(
    file: string,
    s: { name: string; version: number },
    to: string,
    at?: { name: string; version: number; after: boolean },
  ): Promise<void>;

  // The dialogs' (./SpecsDialogs.tsx).
  /** A merge conflict: publish one side or the manual edit, or leave it. */
  resolveWith(which: "ours" | "theirs" | "draft", resolved: string): Promise<void>;
  dismissConflict(): void;
  /** The header's Saved indicator, after a save that landed. */
  markSaved(): void;
  /** What a publish to Confluence or qTest answered, written into the open feature. */
  confluencePublished(data: ConfluencePublishResult): void;
  qtestPublished(data: QtestPublishResult): void;
  /** The Observability page, on a service's log. */
  openObservability(component?: string): void;
  /** The sites this device holds a token for, and the last qTest parent module. */
  confluenceWikis: ConfluenceWiki[];
  qtestSites: QtestSite[];
  qtestParentUrl: string;
  ahaSites: AhaSite[];
  jiraSites: JiraSite[];
  /** The coding agents and their models, for an import an agent drafts. */
  agents: AgentDescriptor[];
  agentModels: AgentModels;
}

export interface SpecsHost {
  /** The tree: the Specs tab's sidebar panel. */
  sidebar: ReactNode;
  /** What the tab's page components and dialogs still call in App. */
  actions: SpecsActions | null;
  /** Open a feature, or a scenario's page when the view names one. */
  open(view: SpecsView, opts: OpenViewOptions): void;
  /** `c` from the tree: a new feature, in the folder selected. */
  createFeature(): void;
  /** `c` on an open feature: a new scenario. */
  createInView: { label: string; run: (() => void) | null } | null;
  /** The tab's own commands — the imports into a spec folder. */
  shortcuts: TabShortcut[];
}

const NO_HOST: SpecsHost = {
  sidebar: null,
  actions: null,
  open: () => {},
  createFeature: () => {},
  createInView: null,
  shortcuts: [],
};

let current: SpecsHost = NO_HOST;
let provided = false;

/**
 * App's render: what the Specs tab reads until the next render. The handlers
 * go first, before any early return of App's (its loading screen) — a link
 * opened at start needs `open` before the tree or the pane are built — and
 * the elements follow at the end of the render.
 */
export function provideSpecsHost(host: Partial<SpecsHost>): void {
  current = { ...current, ...host };
  provided = true;
}

/** The host App last provided, or null before App's first render. */
export function specsHost(): SpecsHost | null {
  return provided ? current : null;
}

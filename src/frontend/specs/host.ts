// What App.tsx hands the Specs tab (src/plugins/builtin/specs/client.tsx)
// while the tree, the feature page and the editor are still built inside App:
// the elements to render and the handlers that act on App's state. App
// publishes a fresh host on every render, before its children render, so the
// tab's Sidebar and Pane — rendered as App's children — always read this
// render's elements, and the tab's create and shortcut hooks read this
// render's handlers when they run.
//
// Not part of the plugin SDK: a seam for moving the Specs tab out of App.tsx
// a piece at a time (specs/app/plugins.feature.md "Specs is a built-in
// plugin"). Each later move takes a field off it.

import type { ReactNode, RefObject } from "react";
import type { OpenViewOptions, TabShortcut } from "../../plugins/client/tabs";
import type { SpecsView } from "../../plugins/builtin/specs/route";
import type { AttributeDefinitions, KnownAttributes } from "../../server/customAttributes";
import type {
  PullRequestLink,
  ResourceLink,
  Scenario,
  ScenarioFile,
  ScenarioTarget,
} from "../../server/parser";
import type { ResourceLinkKind } from "../../server/resourceLinks";
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
}

export interface SpecsHost {
  /** The tree: the Specs tab's sidebar panel. */
  sidebar: ReactNode;
  /** The open feature's page, its scenario's page or the editor. */
  pane: ReactNode;
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
  pane: null,
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

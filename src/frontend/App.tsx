import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { backdropDismiss } from "./backdropDismiss";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import {
  parseFeature,
  scenarioNumbers,
  serializeFeature,
  slugify,
  titleFromFileName,
  unclosedFence,
} from "../server/parser";
import type {
  ExternalLink as TicketLink,
  Feature,
  FeatureFlag,
  PullRequestLink,
  ResourceLink,
  Scenario,
  ScenarioFile,
  ScenarioPick,
  ScenarioStatus,
  ScenarioTarget,
  SpecAttribute,
} from "../server/parser";
import { RESOURCE_LINK_KINDS, RESOURCE_LINK_TOOLS, resourceChipLabel } from "../server/resourceLinks";
import type { ResourceLinkKind } from "../server/resourceLinks";
import type { FeatureListing } from "../server/features";
import type { ProjectMember } from "../server/members";
import type { GitHubRepo } from "../server/issues";
import type { SearchResultItem } from "../server/search";
import type { CurrentUser } from "../server/user";
import {
  codeGenTargetLabel,
  readCodeGenTarget,
  resolveCodeGenTarget,
  usableAgents,
  type CodeGenTarget,
} from "./codeGenTarget";
import { Logo } from "./Logo";
import { SidebarSection } from "./SidebarSection";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronLeft,
  ClipboardCheck,
  Import,
  ChevronRight,
  Ellipsis,
  Pencil,
  Timer,
  Plus,
  RefreshCw,
  RefreshCwOff,
  Search,
  ExternalLink,
  FileText,
  FolderInput,
  FolderTree,
  GitPullRequest,
  Flag,
  Home,
  Tag,
  Keyboard,
  Link,
  ListFilter,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Puzzle,
  Settings,
  Sun,
  Ticket,
  Trash2,
  UserRound,
  X,
  ArrowDown,
  ArrowUp,
  ArrowRightLeft,
  CopyPlus,
  Bot,
  KeyRound,
  Lightbulb,
  LogOut,
  PenTool,
  ShieldCheck,
  BookOpen,
  History,
  SendHorizontal,
  CloudUpload,
  Database,
  Images,
  Sparkles,
} from "lucide-react";
import { PublishRing, StatusCounts, StatusIcon } from "./StatusIcon";
import { NewFeatureIcon, NewFolderIcon, StartSessionIcon } from "./ActionIcons";
import { Tooltip } from "./Tooltip";
import { Menu, type MenuItem } from "./Menu";
import { VersionChip } from "./updateHint";
import { Popover } from "./Popover";
import { HeightResizer } from "./HeightResizer";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";
import { CommandPalette, type PaletteItem } from "./CommandPalette";
import { ErrorBoundary } from "./ErrorBoundary";
import { createPromiseQueue } from "./promiseQueue";
export { createPromiseQueue };

import { setShareRepo, shareUrl } from "./shareLink";
import { SaveIndicator, Toaster, toast } from "./Toasts";
import { missedFeatureNote, pullProblemOf, syncForLink } from "./linkSync";
import { currentSyncProblem, pushHint, setSyncProblem, syncProblemMessage, useSyncProblem } from "./syncProblem";
import { IS_MAC, ShortcutSheet, isTypingTarget, useShortcuts, type Shortcut } from "./shortcuts";
import { MarkdownEditor } from "./MarkdownEditor";
import { applyVimPref, setVimDemoMode, useVimMode } from "./vimPref";
import { applySpellCheckPref, useSpellCheck } from "./spellCheckPref";
import {
  applyExcalidrawPref,
  setExcalidrawDemoMode,
  useExcalidrawEnabled,
} from "./excalidrawPref";
import { markText } from "./highlight";
import { PageSkeleton } from "./Skeleton";
import { AppOutdated, watchDataTooNew } from "./AppOutdated";
import { useModalPrompts } from "./ModalPrompts";
import { PluginUpdatesDialog, dismissPluginUpdates, usePluginUpdatesOffer } from "./PluginUpdatesDialog";
import { cleanLine, cleanSegments } from "../server/text";
import { AppPageLayout, PageSection } from "./AppPage";
import { PluginsPage } from "./PluginsPage";
import { askToCloneCodeRepo, codeReposToOffer, ProjectSettingsPage } from "./ProjectSettingsPage";
import { ObservabilityPage } from "./ObservabilityPage";
import { DataPage } from "./DataPage";
import { ImagesPage } from "./ImagesPage";
import { WhatsNewPage, hasUnseenNotes, markNotesSeen } from "./WhatsNewPage";
import { UpdatesPage } from "./UpdatesPage";
import type { MarketplaceRef } from "../plugins/marketplace";
import type { PromptOptions } from "./ModalPrompts";
import { StartSessionDialog, aiTabState } from "./StartSessionDialog";
import { pomodoro, titlePrefix, usePomodoro } from "./pomodoro";
import { PomodoroBar, PomodoroToggle } from "./PomodoroBar";
import { applyPomodoroEnabled, applyPomodoroShown, usePomodoroEnabled } from "./pomodoroPref";
import { renderMarkdown } from "./markdown";
import { AgentPane } from "./AgentPane";
import {
  client,
  clientLoadErrors,
  isRemounting,
  matchPluginRoute,
  syncClientPlugins,
  tabs,
  watchPluginChanges,
  type PluginStatus,
} from "../plugins/client/loader";
import {
  tabReachable,
  useRegistry,
  useTabStores,
  type PluginView,
  type TabApp,
} from "../plugins/client/tabs";
import {
  sectionsAfter,
  sectionsBeforeAll,
  settingsSections,
  visibleSettingsSections,
  type SettingsSection,
} from "../plugins/client/settings";
import { entityFields } from "./entityFields";
import {
  AGENT_DEFAULT_WIDTH,
  AGENT_MIN_WIDTH,
  agentChat,
  agentPaneOffered,
  clampAgentWidth,
  defaultSessionName,
  useAgentChat,
} from "./agentChat";
import { ExternalLinkField } from "./ExternalLinkField";
import { QtestLinkField } from "./QtestLinkField";
import { PullRequestField, PullRequestList } from "./PullRequestField";
import { TicketLinkField } from "./TicketLinkField";
import { FeatureFlagChips, FeatureFlagsField } from "./FeatureFlagsField";
import { PolarityPill } from "./PolarityPill";
import { AttributeChips, AttributesField } from "./AttributesField";
import {
  NO_FILTER,
  attributeFilterGroups,
  attributeFilterLabel,
  featureMatches,
  isFiltering,
  sameAttributeFilter,
  scenarioMatches,
  type TreeFilter,
} from "./treeFilter";
import { CustomAttributesEditor } from "./CustomAttributesEditor";
import { definitionsFor, knownNames, parseAttributeDefinitions } from "../server/customAttributes";
import { ResourceLinkField, ResourceLinkList } from "./ResourceLinkField";
import { ScenarioFileList, ScenarioFilesField } from "./ScenarioFilesField";
import {
  EMPTY_LINK_DRAFT,
  externalLinkLabel,
  isBlankLinkDraft,
  linkDraftOf,
  resolveLinkDraft,
  resolveQtestDraft,
  ticketChipLabel,
} from "./externallinks";
import type { LinkDraft } from "./externallinks";
import {
  appPagePath,
  featurePath,
  isLinkEntry,
  latestScenarioPath,
  matchAppPage,
  pagePath,
  parseRoute,
  repoDisplayName,
  resolveScenario,
  scenarioPath,
  splitRepoPath,
  SPECS_FOLDER,
} from "./route";
import type { AppPage } from "./route";
import {
  addTestLink,
  canSetTestLink,
  removeTestLink,
  testDraftOf,
  testLinkHint,
  testLinkProblem,
  testLinkTarget,
  testLinkUrl,
  openTestInIdea,
  type TestDraft,
  resolvePendingTests,
  testLinkLabel,
  updateTestLink,
} from "./testlinks";
import {
  buildTree,
  featuresBeneath,
  findFolder,
  featureDrop,
  featureNamesMoved,
  folderDrop,
  folderDropsInto,
  folderLabel,
  folderNamesMoved,
  initialCaseDisplayName,
  folderMoveOptions,
  revealed,
  folderOptions,
  folderRenamed,
  scenarioDrop,
  scenarioMovesInto,
  scenarioNeighbors,
  scenarioPlace,
  scenarioRows,
  treeScenarioKey,
  scenarioSequence,
  withOpenScenarios,
} from "./tree";
import type { FolderNode, ScenarioRow } from "./tree";
import { useFocusTrap } from "./useFocusTrap";
import { authorshipLine } from "./authorship";
import {
  FOLDER_KIND_LABEL,
  FolderKindIcon,
  FolderSwitchDialog,
  parseRecentFolders,
  SpecFoldersDialog,
  type FolderEntry,
  type SwitchStep,
} from "./SpecFolders";
import { FILES_TAB } from "./files/plugin";
import { FILES_HOME, type FilesView } from "./files/route";
import { CloneFromGitHub, GITHUB_HOST, PasteToken, TokenSignInDialog } from "./GitHubToken";
import { SettingsFileDialog, type SettingsFile } from "./SettingsFileDialog";
import { accessShown, GitAccessChoice, type GitAccess } from "./GitAccessChoice";
import { ConfluenceTokens, fetchConfluenceTokens, type ConfluenceWiki } from "./ConfluenceToken";
import { JiraTokens, fetchJiraTokens, type JiraSite } from "./JiraToken";
import { ImportFromJiraWikiDialog } from "./ImportFromJiraWikiDialog";
import { AgentModelList, agentModelsOf, agentsWithoutSection, type AgentModels } from "./AgentModels";
import { ConfluencePublishDialog, type ConfluencePublishResult } from "./ConfluencePublishDialog";
import { ConfluenceFolderPublishDialog, type FolderFeature } from "./ConfluenceFolderPublishDialog";
import { QtestTokens, fetchQtestTokens, type QtestSite } from "./QtestToken";
import { QtestPublishDialog, type QtestPublishResult } from "./QtestPublishDialog";
import { WikiQtestPublishDialog } from "./WikiQtestPublishDialog";
import { AhaTokens, fetchAhaTokens, type AhaSite } from "./AhaToken";
import { AhaImportDialog } from "./AhaImportDialog";
import { importSummary, OpenSpecImportDialog } from "./OpenSpecImportDialog";
import { HostedStartNav, hostedCloneHint, type HostedAccount } from "./HostedStartNav";
import type { ScenarioRef } from "./route";
import { copyText } from "./clipboard";

interface Conflict {
  ours: string;
  theirs: string;
  message: string;
  /** Set when the conflicted publish targeted a single scenario — with its
      document id, so the resolution still renames rather than doubles it. */
  scenario?: ScenarioTarget;
}

/** Signed-in GitHub account as reported by /api/state (never the token). */
interface AuthInfo {
  signedIn: boolean;
  login?: string;
  name?: string | null;
  email?: string | null;
  /** The GitHub Enterprise host a pasted token belongs to; absent for github.com. */
  host?: string;
}

/** What the GitHub CLI reports (git-operations.md). */
interface GhInfo {
  available: boolean;
  signedIn: boolean;
  login: string | null;
  /** Whether gh's account is the one in use: the GitHub CLI is the Git access. */
  inUse?: boolean;
  /** The hosts gh is logged in to, GitHub Enterprise ones included. */
  hosts?: string[];
}

/** A device flow in progress: the code to enter and where to enter it. */
interface DeviceFlow {
  userCode: string;
  verificationUri: string;
  interval: number;
}

// Appearance (specs/ui/ui.feature.md "Settings"): system, light or dark. The
// choice lives on this device (localStorage), not in the settings file;
// index.html applies it before first paint, this keeps it in sync after.
type ThemePref = "system" | "light" | "dark";

function readThemePref(): ThemePref {
  try {
    const t = localStorage.getItem("sd-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function applyThemePref(pref: ThemePref): void {
  if (pref === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  try {
    if (pref === "system") localStorage.removeItem("sd-theme");
    else localStorage.setItem("sd-theme", pref);
  } catch {
    // Storage unavailable (private mode): the choice just won't stick.
  }
}

// Live sync (specs/datastore/automerge-store.feature.md): the url the Settings
// field is pre-filled with, so turning the switch on needs no typing. Sync
// itself stays opt-in — nothing is sent anywhere until the switch is on and
// saved.
const DEFAULT_SYNC_SERVER_URL = "wss://sync.automerge.org";

// Autosync (specs/ui/ui.feature.md "Settings"): the frequency the seconds field
// falls back to when the switch is turned back on. Autosync is on by default,
// so a stored 0 is the only way it is off.
const DEFAULT_AUTOSYNC_SECONDS = 60;

// Editor autosave (specs/editor/editor-autosave.feature.md): the open editor
// saves itself every n seconds. Always on — the setting is only how often — and
// never faster than the floor, which keeps a save off the keystrokes. Mirrors
// the server's defaults in src/server/state.ts.
const DEFAULT_AUTOSAVE_SECONDS = 6;
const MIN_AUTOSAVE_SECONDS = 3;

// Project management (specs/external-links/project-management-jira-linear-
// etc.feature.md): the tool tickets live in until Settings names another, and
// the tools the Settings dropdown offers by name — anything else is typed in
// beside it. Mirrors the server's default in src/server/state.ts.
const DEFAULT_PROJECT_MANAGEMENT_TOOL = "Jira";
const PROJECT_MANAGEMENT_TOOLS = ["Jira", "Linear", "GitHub", "GitLab", "Asana", "Azure DevOps"];

// Aha! and Figma links (specs/external-links/aha-and-figma-links.feature.md):
// each tool is offered only once its Settings switch is on — both start off.
type ResourceLinkSwitches = Record<ResourceLinkKind, boolean>;
const NO_RESOURCE_LINKS: ResourceLinkSwitches = { aha: false, figma: false };
/** The Settings key that switches each tool on. */
const RESOURCE_LINK_SETTING = { aha: "ahaLinks", figma: "figmaLinks" } as const;
const RESOURCE_LINK_ICON = { aha: Lightbulb, figma: PenTool } as const;

/** The switches as /api/state reports them; anything but `true` is off. */
export function resourceLinkSwitches(state: Record<string, unknown>): ResourceLinkSwitches {
  return {
    aha: state[RESOURCE_LINK_SETTING.aha] === true,
    figma: state[RESOURCE_LINK_SETTING.figma] === true,
  };
}

// Sidebar width (specs/ui/ui.feature.md "Sidebar resize"): dragged via the
// divider so a deep folder tree gets room. Device-local, like the theme.
const SIDEBAR_MIN = 180;
const SIDEBAR_DEFAULT = 256; // keep in sync with the 16rem fallback in index.css

function clampSidebarWidth(w: number): number {
  // The editor keeps at least 40% of the window. Only called while the user
  // drags or nudges, when the window has its real size — at startup the
  // window can be transiently tiny (restoring, embedded), so stored widths
  // are never clamped against it; the 70vw guard in index.css covers that
  // responsively instead.
  const max = Math.max(SIDEBAR_MIN, Math.round(window.innerWidth * 0.6));
  return Math.min(Math.max(Math.round(w), SIDEBAR_MIN), max);
}

function readSidebarWidth(): number {
  try {
    const w = Number(localStorage.getItem("sd-sidebar-width"));
    return Number.isFinite(w) && w >= SIDEBAR_MIN ? Math.round(w) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function storeSidebarWidth(w: number): void {
  try {
    localStorage.setItem("sd-sidebar-width", String(w));
  } catch {
    // Storage unavailable (private mode): the width just won't stick.
  }
}

// Description editor height (specs/editor/feature-editor.feature.md): the
// editor opens a third of the window tall and is dragged taller or shorter by
// the strip along its lower boundary. Device-local, like the sidebar width.
const DESC_MIN = 120;
const DESC_HEIGHT_KEY = "sd-desc-height";

export function clampDescHeight(h: number, windowHeight: number): number {
  // The scenario list below keeps at least a quarter of the window, so the
  // editor can never swallow the page it belongs to.
  const max = Math.max(DESC_MIN, Math.round(windowHeight * 0.75));
  return Math.min(Math.max(Math.round(h), DESC_MIN), max);
}

// Scenario body height (specs/editor/spec-editor.feature.md "Spec body
// resize"): the body editor opens at least 40% of the window tall and is
// dragged taller or shorter by the strip under it; the pane's column scrolls
// to whatever is below. Device-local, like the description's.
const BODY_MIN = 120;
const BODY_HEIGHT_KEY = "sd-body-height";

export function clampBodyHeight(h: number, windowHeight: number): number {
  // The pane scrolls, so the body may outgrow it — but never past what fits
  // the window, or the strip would end up off screen mid-drag.
  const max = Math.max(BODY_MIN, Math.round(windowHeight * 0.85));
  return Math.min(Math.max(Math.round(h), BODY_MIN), max);
}

function readEditorHeight(key: string, min: number): number | null {
  try {
    const h = Number(localStorage.getItem(key));
    // Nothing stored, or junk: the CSS default stands until a first drag.
    return Number.isFinite(h) && h >= min ? Math.round(h) : null;
  } catch {
    return null;
  }
}

/** A height, or null to clear it on a double-click: back to the CSS default. */
function storeEditorHeight(key: string, h: number | null): void {
  try {
    if (h === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(h));
  } catch {
    // Storage unavailable (private mode): the height just won't stick.
  }
}

/** A core tab, or a plugin's tab by its id (src/plugins/client/tabs.ts). */
// The sidebar's tabs: Specs, the feature tree, and one tab per mounted
// plugin — the special folders' page lists among them (src/plugins/builtin
// /pages). They all share the one column, so the choice is remembered like
// the sidebar width: a tab left open is meant to stay open, not to reset on
// every reload.
type SidebarTab = "specs" | (string & {});

function readSidebarTab(): SidebarTab {
  try {
    // Every stored name is kept: one that is not on offer any more falls
    // back to Specs where `shownTab` is derived.
    return localStorage.getItem("sd-sidebar-tab") ?? "specs";
  } catch {
    return "specs";
  }
}

function storeSidebarTab(tab: SidebarTab): void {
  try {
    localStorage.setItem("sd-sidebar-tab", tab);
  } catch {
    // Storage unavailable (private mode): the choice just won't stick.
  }
}

/**
 * index === null means a new scenario being added; every save — autosave
 * included — points it at the entry it wrote, so the next save rewrites that
 * entry instead of appending a second one. `scenario.id` — the document id
 * the server reads the scenario under, adopted from a new scenario's first
 * landed save — goes out with every save, so a retyped title or a re-derived
 * version renames that entry rather than filing a second one
 * (specs/editor/editor-autosave.feature.md "Autosave Never Adds the Same
 * Scenario Twice").
 */
export interface EditState {
  index: number | null;
  scenario: Scenario;
  /**
   * True while the editor pane is creating a scenario, which it stays even
   * after autosave (specs/editor/editor-autosave.feature.md) has put the
   * scenario in the feature and given `index` a value. The pane keeps its
   * new-scenario behavior for as long as it is open: retyping the name
   * re-derives the version, and the Draft checkbox stays unlocked.
   */
  isNew?: boolean;
  /**
   * Where a new scenario goes in the feature once a save places it (a new
   * version: right after the version it continues). Appended without.
   */
  insertAt?: number;
}

/**
 * The feature as the server sent it — its parsed form, which carries each
 * scenario's document id (the markdown never does) — with its name resolved
 * the way the page shows it: the `# <name>` heading, or the file stem when
 * the heading is missing (specs/ui/ui.feature.md "Main page"). Resolving it
 * here and not only at render time matters: every save serializes this object
 * back to the file, and a blank name would write a nameless `# ` heading over
 * the real one.
 */
function featureFromResponse(
  data: { content: string; parsed?: Feature },
  fileName: string,
): Feature {
  const parsed = data.parsed ?? parseFeature(data.content);
  return parsed.name ? parsed : { ...parsed, name: titleFromFileName(fileName) };
}

/**
 * How a save or publish names its scenario to the server: the heading
 * identity plus the document id the editor holds for it, which keeps the
 * scenario one scenario through a rename
 * (specs/editor/editor-autosave.feature.md "Autosave Never Adds the Same
 * Scenario Twice").
 */
function scenarioTarget(s: Scenario): ScenarioTarget {
  return { name: s.name, version: s.version, id: s.id };
}

/**
 * What autosave (specs/editor/editor-autosave.feature.md) compares to decide
 * whether the editor is holding anything new: everything a save would write,
 * under the version the dialog will save it as rather than the one on the
 * object.
 */
export function scenarioSignature(s: Scenario, version: number): string {
  // The name as a save writes it: a stray space is nothing new to save.
  return JSON.stringify([
    savedScenarioName(s),
    version,
    s.status,
    s.body,
    s.tests,
    s.link ?? null,
    s.qtest ?? null,
    s.flags ?? null,
    s.attributes ?? null,
    s.negative ?? null,
  ]);
}

/**
 * The name a save writes for the scenario (specs/ui/ui.feature.md
 * "User-entered text is cleaned up"): trimmed with inner runs of spaces
 * collapsed — except a published scenario's, which is immutable and only
 * saves for its test links, so its heading is kept verbatim (a changed one
 * would read as a rename the document must refuse).
 */
export function savedScenarioName(s: Pick<Scenario, "name" | "status">): string {
  return s.status === "published" ? s.name.trim() : cleanLine(s.name);
}

/**
 * Whether the scenario's name is still being typed — the dialog's title field
 * holds the caret (specs/editor/editor-autosave.feature.md "Autosave Waits
 * While the Name Is Being Typed"). A tick that fires mid-word would save the
 * half-typed name as a draft, so it stands down until focus moves on.
 */
export function namingInProgress(nameField: Element | null, active: Element | null): boolean {
  return nameField !== null && nameField === active;
}

/**
 * The feature with the editor's scenario written in — over the entry the
 * editor opened on (or the one a previous save placed), else at `insertAt`
 * (a new version goes right after its source), else appended — which is
 * where its card will be: scenarios keep their order
 * (specs/ui/ui.feature.md "number scenarios"). Every save places the
 * scenario this way, so the way back (specs/editor/spec-editor.feature.md
 * "Spec editor pane") can predict where to land.
 */
export function withScenario(
  feature: Feature,
  at: number | null,
  s: Scenario,
  insertAt?: number,
): Feature {
  if (at !== null) {
    return { ...feature, scenarios: feature.scenarios.map((sc, i) => (i === at ? s : sc)) };
  }
  const scenarios = [...feature.scenarios];
  scenarios.splice(Math.min(insertAt ?? scenarios.length, scenarios.length), 0, s);
  return { ...feature, scenarios };
}

/**
 * The feature with the scenario at `from` moved to `to` (specs/ui/
 * ui.feature.md "number scenarios": Move up, Move down), the rest keeping
 * their order. Out-of-range positions leave the feature as it is.
 */
export function withScenarioMoved(feature: Feature, from: number, to: number): Feature {
  const n = feature.scenarios.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return feature;
  const scenarios = [...feature.scenarios];
  const [moved] = scenarios.splice(from, 1);
  scenarios.splice(to, 0, moved!);
  return { ...feature, scenarios };
}

/**
 * The scenario with its polarity set (specs/ui/scenario-polarity.feature.md):
 * the `negative` key when negative, no key at all when positive, so the
 * markdown and the autosave signature never see an undefined marker.
 */
export function withPolarity(s: Scenario, negative: boolean): Scenario {
  const { negative: _previous, ...rest } = s;
  return negative ? { ...rest, negative: true } : rest;
}

/** The feature with the scenario at `i` marked negative or positive. */
export function withScenarioPolarity(feature: Feature, i: number, negative: boolean): Feature {
  const s = feature.scenarios[i];
  if (!s) return feature;
  return withScenario(feature, i, withPolarity(s, negative));
}

// Each scenario's number lives beside the file format it labels, so the
// Confluence page numbers its scenarios as the cards do.
export { scenarioNumbers };

/**
 * The version a scenario takes in `feature` when its version is derived
 * (specs/ui/ui.feature.md): one past the highest version already carrying that
 * name, or 1 when the name is new; `ignoreIndex` leaves its own entry out.
 */
export function nextVersionIn(
  feature: Feature | null,
  name: string,
  ignoreIndex?: number,
): number {
  const versions = (feature?.scenarios ?? [])
    .filter((s, i) => i !== ignoreIndex && cleanLine(s.name) === cleanLine(name))
    .map((s) => s.version);
  return versions.length ? Math.max(...versions) + 1 : 1;
}

/**
 * Where the editor's scenario sits on the server: the feature a save was
 * answered with, the scenario's index in it and its document id. A save
 * queued behind another places itself here rather than where the render
 * that queued it thought the scenario was.
 */
export type Placement = {
  feature: Feature;
  index: number | null;
  id?: string;
  /** Where a scenario not yet in the feature goes (withScenario); appended without. */
  insertAt?: number;
};

/**
 * The editor's scenario written into the feature at `placement`: over the
 * entry found there (or appended when there is none), adopting the document
 * id a save gave it. A `derived` version (a new scenario) is re-derived
 * against that feature with its own entry left out, or it would bump past
 * itself.
 */
export function placeScenario(
  draft: Scenario,
  { feature, index, id, insertAt }: Placement,
  derived: boolean,
): { s: Scenario; next: Feature } {
  const version =
    derived || index === null ? nextVersionIn(feature, draft.name, index ?? undefined) : draft.version;
  // The name goes out trimmed, as the server parses every heading
  // (parser.ts SCENARIO_RE), and with inner runs of spaces collapsed
  // (savedScenarioName): the scenario the save lands is then the one this
  // save names, and the editor finds it again (landedScenario).
  const s: Scenario = { ...draft, name: savedScenarioName(draft), version, id: draft.id ?? id };
  return { s, next: withScenario(feature, index, s, insertAt) };
}

/**
 * Whether a click on a scenario card landed on one of its controls — a
 * button, a checkbox, the ticket link, a test link — rather than on the card
 * itself. The title link counts as the card: clicking it highlights, and
 * double-clicking it edits, like anywhere else on the card.
 */
export function isCardControl(
  target: { closest?: (selector: string) => unknown } | EventTarget | null,
): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest(".scenario-title > a")) return false;
  return el.closest("button, input, a") != null;
}

/**
 * The card to highlight on the way back from the editor pane
 * (specs/editor/spec-editor.feature.md "Spec editor pane"): the scenario's
 * entry found by identity, since a save may have moved it; null for a
 * scenario the feature never received.
 */
export function cardOfScenario(
  scenarios: readonly Scenario[],
  s: { name: string; version: number },
): number | null {
  // Names compare cleaned, as a save writes them (savedScenarioName) and
  // as nextVersionIn counts them.
  const name = cleanLine(s.name);
  const i = scenarios.findIndex((sc) => cleanLine(sc.name) === name && sc.version === s.version);
  return i === -1 ? null : i;
}

/**
 * Where a landed save left the editor's scenario (issue #173): its entry by
 * identity, else the entry carrying its document id. Losing it would leave
 * the editor new, deriving the next version for its name on the next tick
 * and appending the scenario again — on every tick after that too. Only a
 * scenario whose id is gone from the feature as well is lost: the entry was
 * dropped underneath the editor, and the next save re-adds the work.
 */
export function landedScenario(
  scenarios: readonly Scenario[],
  s: { name: string; version: number },
  id: string | undefined,
): number | null {
  const card = cardOfScenario(scenarios, s);
  if (card !== null || id === undefined) return card;
  const i = scenarios.findIndex((sc) => sc.id === id);
  return i === -1 ? null : i;
}

/**
 * The editor state for a scenario about to be written: a draft under `name`
 * (cleaned, as a save writes it), version 1 until the first save derives the
 * real one, going into the feature at `insertAt` — appended without
 * (specs/ui/ui.feature.md "Add A Scenario Button").
 */
export function newScenarioDraft(name: string, insertAt?: number): EditState {
  return {
    index: null,
    isNew: true,
    ...(insertAt === undefined ? {} : { insertAt }),
    scenario: { name: cleanLine(name), version: 1, status: "draft", body: "", tests: [] },
  };
}

/**
 * Where the scenario added from an open pane goes (specs/editor/
 * spec-editor.feature.md "Spec editor pane"): right after the pane's
 * scenario, found where its save landed it — by identity, else by document
 * id — and at `fallback` when the feature no longer has it.
 */
export function insertAfterScenario(
  scenarios: readonly Scenario[],
  current: { name: string; version: number },
  id: string | undefined,
  fallback: number,
): number {
  const at = landedScenario(scenarios, current, id);
  return at === null ? fallback : at + 1;
}

/**
 * The scenario whose page is open (specs/ui/navigation.feature.md "URL scheme")
 * — what the address bar and the window title name. Read through the pane's
 * index into the feature, so a rename follows the scenario the moment its save
 * lands; a highlighted card is not a page, and a new scenario no save has
 * placed in the feature yet has no url of its own.
 */
export function pageScenario(
  editing: { index: number | null } | null,
  scenarios: readonly Scenario[] | undefined,
): Scenario | null {
  if (!editing || editing.index === null) return null;
  return scenarios?.[editing.index] ?? null;
}

/** What the command palette offers before typing: the last pages opened. */
interface RecentEntry {
  /** `plugin` is a plugin tab's view — a roadmap page, a task, an entry. */
  kind: "feature" | "scenario" | "plugin";
  /** A feature's file name; a plugin view's url. */
  fileName: string;
  name: string;
  scenario?: { name: string; version: number };
  /** The plugin tab the view belongs to. */
  tab?: string;
}

/** The url of a special folder's page, for a list written before pages
    were plugins (src/plugins/builtin/pages/route.ts pageLink). */
function legacyPageUrl(fileName: string): string {
  return `/${fileName.replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/")}`;
}

const RECENT_KEY = "sd-recent";

function readRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as RecentEntry[]) : [];
    if (!Array.isArray(list)) return [];
    // A list written before the special folders were plugins calls their
    // pages "page" — or "roadmap", before the tasks folder existed; each is
    // the view at its url on the folder's tab.
    return list.slice(0, 8).map((e) => {
      const kind = e.kind as string;
      if (kind !== "page" && kind !== "roadmap") return e;
      return {
        kind: "plugin" as const,
        fileName: legacyPageUrl(e.fileName),
        name: e.name,
        tab: e.fileName.split("/")[0],
      };
    });
  } catch {
    return [];
  }
}

function writeRecent(list: RecentEntry[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: the list just does not survive a reload.
  }
}

/**
 * Small screens — phones, and tablets held narrower than this — get one pane:
 * the sidebar becomes a drawer over the page, opened from a top bar. Keep in
 * sync with the `--compact` breakpoint in index.css.
 */
export const COMPACT_QUERY = "(max-width: 47.99rem)";


// Code gen sessions (specs/agents/claude.feature.md): which agent "Start
// session" runs in — a new session in Claude Code Desktop, or the app's own
// coding agent pane (specs/agents/agent-pane.feature.md) with one of the
// agents the plugins supply. The helpers live in src/frontend/codeGenTarget.ts.
export type { CodeGenTarget };
export { codeGenTargetLabel, readCodeGenTarget, resolveCodeGenTarget };

/** The session dialog's one non-agent option: copy the prompt, run nothing. */
export const CLIPBOARD_TARGET = "clipboard";

// The default session name lives with the pane's helpers now; re-exported
// here since the session dialog and its tests know it by this door.
export { defaultSessionName };

/** Tracks a media query live, so rotating a tablet flips the layout. */
function useMediaQuery(query: string): boolean {
  const read = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** The sidebar collapsed to a rail ("["), remembered on this device. */
const COLLAPSED_KEY = "sd-sidebar-collapsed";

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function storeSidebarCollapsed(collapsed: boolean) {
  try {
    if (collapsed) localStorage.setItem(COLLAPSED_KEY, "1");
    else localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    // Storage unavailable: the choice just does not survive a reload.
  }
}

/** The editor column hidden so the coding agent pane can take the window
    ("\"), remembered on this device like the sidebar's own collapse. */
const EDITOR_HIDDEN_KEY = "sd-editor-hidden";

export function readEditorHidden(): boolean {
  try {
    return localStorage.getItem(EDITOR_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeEditorHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(EDITOR_HIDDEN_KEY, "1");
    else localStorage.removeItem(EDITOR_HIDDEN_KEY);
  } catch {
    // Storage unavailable: the choice just does not survive a reload.
  }
}

/** Two-letter initials for an assignee chip. */
function initialsOf(name: string): string {
  return (
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .map((w) => w[0]!)
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

interface OpenOptions {
  /** Push a history entry for the opened feature (deliberate navigation). */
  push?: boolean;
  /**
   * Deep-link target (specs/ui/navigation.feature.md): select this scenario, or
   * clear the selection when null. Undefined keeps the same-file selection
   * preservation used by sync/cron refreshes.
   */
  scenario?: ScenarioRef | null;
  /**
   * Open the scenario's own page — the editor pane — on top of selecting its
   * card (specs/ui/navigation.feature.md "open a scenario link"). Deep links
   * do; in-app navigation that merely lands on a card does not.
   */
  pane?: boolean;
  /**
   * Why the pull behind the link that asked for this feature failed, if it
   * did — a miss then says the feature may not have arrived, not that the
   * link is stale (src/frontend/linkSync.ts).
   */
  pullProblem?: string | null;
  /**
   * The words a search hit matched on (specs/search.feature.md): the pane
   * opened for the hit marks them in the scenario's body.
   */
  terms?: string[];
  /**
   * Open with the feature description editor on (specs/editor/feature-editor
   * .feature.md "Edit feature descrition"): a just-created feature is empty,
   * and describing it is the first thing to do.
   */
  editDescription?: boolean;
}

/** What /api/features returns: the flat feature list, the folder list, and
    the project's settings (src/server/members.ts) — the members a feature
    can be assigned to, and the code repo a session runs in (null: the data
    repo). */
interface Listing {
  features: FeatureListing[];
  folders: string[];
  /** Folder path → what its display-name.txt says (specs/ui/folders.feature.md "describe a folder"). */
  folderDescriptions: Record<string, string>;
  /** Folder path → its subfolders in order, from its folder-order.txt ("order folders"); `specs` for the top level. */
  folderOrders: Record<string, string[]>;
  /** Folder path → its features' file names in order, from its feature-order.txt ("order features"). */
  featureOrders: Record<string, string[]>;
  members: ProjectMember[];
  codeRepo: string | null;
  /** Every code repo the project names, the default first (specs/app/project-settings.feature.md). */
  codeRepos: string[];
  /** Whether the repo writes authorship into its feature files
      (specs/app/specs-authorship.feature.md, `authors-in-markdown`). */
  authorsInMarkdown: boolean;
  /** The GitHub repo the code repo pushes to — whose issues the Issues tab shows. */
  issuesRepo: GitHubRepo | null;
  /** The data repo's custom-attributes.txt (specs/app/custom-attributes.feature.md); empty when it has none. */
  customAttributes: string;
  /** Why saved changes are not reaching the remote (git-operations.md); null while they are. */
  syncProblem: string | null;
}

/**
 * What's new (specs/app/release-notes.feature.md): the release notes page,
 * on every copy's user menu, the read-only site's included. `unseen` marks
 * an installed version whose notes the user has not opened yet.
 */
export function whatsNewMenuItem(unseen: boolean, open: () => void): MenuItem {
  return {
    id: "whats-new",
    label: (
      <span className="whats-new-label">
        What's new
        {unseen && <span className="unseen-dot" role="img" aria-label="new release notes" />}
      </span>
    ),
    icon: <Sparkles size={13} />,
    onSelect: open,
  };
}

/** The user menu's link to the running build's source
    (specs/app/open-source-license.feature.md): the app is open source
    (Apache-2.0), and every copy — the public demo included — offers it. None until the state
    has named the url. */
export function sourceCodeMenuItems(
  url: string | null,
  open: (url: string) => void = (u) => window.open(u, "_blank", "noreferrer"),
): MenuItem[] {
  if (!url) return [];
  return [
    {
      id: "source-code",
      label: "Source code",
      description: "Apache-2.0",
      icon: <ExternalLink size={13} />,
      title: url,
      onSelect: () => open(url),
    },
  ];
}

/** How many times a feature-list load tries before it reports an error, and
    the step it backs off by (1×, 2×, …). Short enough that a real outage
    still surfaces quickly, long enough to outlast a demo-mode reseed
    swapping the data directory (src/server/demo.ts reseedDemo). */
export const LOAD_RETRIES = 3;
export const LOAD_RETRY_MS = 300;
/** How long the page waits between tries to reach a server that is not answering. */
export const BOOT_RETRY_MS = 3000;
/** How long the boot read waits for an answer before it calls the server stuck. */
export const BOOT_TIMEOUT_MS = 20_000;
/** When, after boot, the desktop app re-reads the state for the daily update check's answer: soon, and twice more for a slow releases page. */
const UPDATE_FOLLOW_UP_MS = [750, 4000, 20000];

/**
 * Fetch the feature listing, retrying the failures that a later try can
 * still turn into an answer.
 *
 * A failed load leaves the sidebar empty, and the cron refresh that would
 * otherwise cover for it is off whenever reloadFrequencySeconds is 0 — demo
 * mode always, and any folder with sync turned off. That makes the boot load
 * the only one, so a single blip would read "No feature files yet" for the
 * rest of the session. Retried here instead: a reseed swapping the data
 * directory mid-flight, or a fetch that threw before it reached the server.
 * A 409 (no data repo yet) is a settled answer rather than a blip, so it
 * stops early and reports.
 */
export async function fetchListing(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ listing: Listing } | { error: string; attempts: number }> {
  let lastError = "Could not load features";
  let attempts = 0;
  for (let attempt = 0; attempt < LOAD_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(LOAD_RETRY_MS * attempt);
    attempts += 1;
    let res: Response;
    let data: { features?: FeatureListing[]; error?: string; [k: string]: unknown };
    try {
      res = await fetchImpl("/api/features");
      data = (await res.json()) as typeof data;
    } catch (e) {
      // Network-level failure: nothing was read, so this is always worth
      // another go.
      lastError = (e as Error).message;
      continue;
    }
    if (res.ok) {
      return {
        listing: {
          features: (data.features as FeatureListing[]) ?? [],
          folders: (data.folders as string[]) ?? [],
          folderDescriptions:
            data.folderDescriptions && typeof data.folderDescriptions === "object"
              ? (data.folderDescriptions as Record<string, string>)
              : {},
          folderOrders:
            data.folderOrders && typeof data.folderOrders === "object"
              ? (data.folderOrders as Record<string, string[]>)
              : {},
          featureOrders:
            data.featureOrders && typeof data.featureOrders === "object"
              ? (data.featureOrders as Record<string, string[]>)
              : {},
          members: Array.isArray(data.members) ? (data.members as ProjectMember[]) : [],
          codeRepo: typeof data.codeRepo === "string" ? data.codeRepo : null,
          codeRepos: Array.isArray(data.codeRepos)
            ? (data.codeRepos as unknown[]).filter((d): d is string => typeof d === "string")
            : [],
          authorsInMarkdown: data.authorsInMarkdown === true,
          issuesRepo:
            data.issuesRepo &&
            typeof data.issuesRepo === "object" &&
            typeof (data.issuesRepo as GitHubRepo).owner === "string"
              ? (data.issuesRepo as GitHubRepo)
              : null,
          customAttributes: typeof data.customAttributes === "string" ? data.customAttributes : "",
          syncProblem: typeof data.syncProblem === "string" && data.syncProblem ? data.syncProblem : null,
        },
      };
    }
    lastError = data.error ?? "Could not load features";
    // "No data repo configured" is the app's steady state before a folder is
    // picked — retrying cannot change it.
    if (res.status === 409) break;
  }
  return { error: lastError, attempts };
}

/** Why the boot-time `/api/state` read failed (specs/ui/app-start.feature.md). */
export interface BootError {
  message: string;
  /**
   * No answer came back: every try was refused (no server is listening), or
   * the server took the request and never answered.
   */
  unreachable: boolean;
}

/**
 * Read `/api/state?boot=1`, the page's first request, retrying the fetches
 * that threw. In the browser the API lives in a separate `bun run dev`
 * process; when that process is gone the fetch is refused, and an
 * unhandled refusal left the boot effect holding the loading skeleton for
 * good. A failure is returned instead, so the page can say the server
 * cannot be reached and try again. A server that takes the request and
 * never answers is reported the same way after BOOT_TIMEOUT_MS. The desktop
 * app serves the API in process, so this only bites the web app.
 */
export async function fetchBootState(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs: number = BOOT_TIMEOUT_MS,
): Promise<{ state: Record<string, any> } | { error: BootError }> {
  let lastError = "Could not reach the server";
  const stuck: BootError = {
    message: `The server did not answer within ${timeoutMs / 1000} s`,
    unreachable: true,
  };
  for (let attempt = 0; attempt < LOAD_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(LOAD_RETRY_MS * attempt);
    const signal = timeoutSignal(timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl("/api/state?boot=1", { signal });
    } catch (e) {
      // Waiting longer would only repeat the wait; refusals are worth another go.
      if (signal?.aborted) return { error: stuck };
      lastError = (e as Error).message;
      continue;
    }
    // An answer, even an error, is settled: the server is there to say it.
    let data: Record<string, any> | null = null;
    try {
      data = (await res.json()) as Record<string, any>;
    } catch {
      if (signal?.aborted) return { error: stuck };
      // A body that is not JSON — reported below by status.
    }
    if (res.ok && data) return { state: data };
    const message =
      typeof data?.error === "string" ? data.error : `The server answered ${res.status}`;
    return { error: { message, unreachable: false } };
  }
  return { error: { message: lastError, unreachable: true } };
}

/** An abort signal that fires after `ms`, where the runtime has AbortSignal.timeout. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/** Whether a url names a view: an app page, a plugin's view or a feature. */
function routesSomewhere(pathname: string): boolean {
  return Boolean(matchAppPage(pathname) || matchPluginRoute(pathname) || parseRoute(pathname).feature);
}

/** Decode a path segment; a malformed escape is kept as-is rather than thrown. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * "Copy link" as an icon button (specs/ui/navigation.feature.md "share a
 * link"): a link icon that flips to a check mark while `copied`.
 */
function CopyLinkButton({
  copied,
  onCopy,
  disabled,
  size = 16,
  keys,
  label = "Copy link",
}: {
  copied: boolean;
  onCopy: () => void;
  disabled?: boolean;
  size?: number;
  /** The shortcut, where mod+shift+c copies this same url. */
  keys?: string;
  label?: string;
}) {
  return (
    <Tooltip label={copied ? "Copied" : "Copy link"} keys={keys}>
      <button type="button" className="ibtn" aria-label={label} disabled={disabled} onClick={onCopy}>
        {copied ? <Check size={size} aria-hidden="true" /> : <Link size={size} aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}

/** The shortcuts the read-only site keeps (beside each tab's `go-…`): moving around, never writing. */
const READ_ONLY_SHORTCUTS = new Set([
  "search",
  "sheet",
  "editor-pane",
  "go-home",
  "theme",
  "sidebar",
  "escape",
  "next",
  "prev",
  "open",
  "editor-prev",
  "editor-next",
  "copy-link",
  "divider",
]);
/** The command palette's actions on the read-only site. */
const READ_ONLY_PALETTE = new RegExp(`^action:(${[...READ_ONLY_SHORTCUTS].join("|")}|go-[\\w-]+|theme-\\w+)$`);

export function App() {
  const [dataRepo, setDataRepo] = useState<string | null>(null);
  // Recent folder list (specs/ui/ui.feature.md "Recent folder list",
  // specs/app/spec-folders.feature.md "Manage specification folders"): every
  // folder used before, spec folders and code repositories together, each
  // with its kind, the open one first, then most recent first — what the ▾
  // beside the folder name drops down (up to 10) and the folder dialog lists.
  const [recentFolders, setRecentFolders] = useState<FolderEntry[]>([]);
  // Where each GitHub url among them is cloned on this computer — what the
  // Spec folders dialog shows under the url.
  const [recentRepoDirs, setRecentRepoDirs] = useState<Record<string, string>>({});
  /**
   * The same two, for a link that names its spec folder
   * (`specdriven://<folder>/...`): openFromLocation runs from closures older
   * than either state — the boot effect's, the popstate listener's — so it
   * reads them here.
   */
  const reposRef = useRef<{ open: string | null; recent: string[] }>({ open: null, recent: [] });
  // Code repository mode (specs/app/code-repo-mode.feature.md): a code
  // repository open in place of a specifications folder — its absolute path,
  // or null — the ones opened before, and whether one may be opened here.
  // The ref is for callbacks that outlive a render (the loaders, goHome).
  const [codeRepoDir, setCodeRepoDir] = useState<string | null>(null);
  const codeRepoRef = useRef<string | null>(null);
  const [canOpenCodeRepo, setCanOpenCodeRepo] = useState(false);
  /** The open folder's absolute path, as the server resolved it. */
  const [dataDir, setDataDir] = useState<string | null>(null);
  /** The user's home folder, for paths the session popover writes as ~/…;
      null in the demo and on a shared server. */
  const [homeDir, setHomeDir] = useState<string | null>(null);
  /**
   * Take the open folder and the recent list from an /api/state answer. The
   * open folder is also the one "Copy link" names (src/frontend/shareLink.ts).
   */
  const applyRepos = (state: {
    dataRepo?: string | null;
    recentDataRepos?: unknown;
    recentDataRepoDirs?: unknown;
    dataDir?: unknown;
    homeDir?: unknown;
    codeRepoMode?: unknown;
    codeRepoDir?: unknown;
    recentFolders?: unknown;
    canOpenCodeRepo?: unknown;
  }) => {
    // An answer that says (every /api/state one) sets the mode; a code
    // repository open means no specifications folder is.
    if (state.codeRepoMode !== undefined) {
      const code = state.codeRepoMode === true && typeof state.codeRepoDir === "string" ? state.codeRepoDir : null;
      codeRepoRef.current = code;
      setCodeRepoDir(code);
    }
    if (Array.isArray(state.recentFolders)) setRecentFolders(parseRecentFolders(state.recentFolders));
    if (typeof state.canOpenCodeRepo === "boolean") setCanOpenCodeRepo(state.canOpenCodeRepo);
    const open = codeRepoRef.current ? null : (state.dataRepo ?? null);
    const recent = Array.isArray(state.recentDataRepos) ? (state.recentDataRepos as string[]) : [];
    const dirs = state.recentDataRepoDirs;
    reposRef.current = { open, recent };
    setShareRepo(open);
    setDataRepo(open);
    setRecentRepoDirs(dirs && typeof dirs === "object" ? (dirs as Record<string, string>) : {});
    // An answer that does not say (the forget-a-folder reply) keeps it.
    if (state.dataDir !== undefined) setDataDir(typeof state.dataDir === "string" ? state.dataDir : null);
    if (state.homeDir !== undefined) setHomeDir(typeof state.homeDir === "string" ? state.homeDir : null);
  };
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const [needsRepo, setNeedsRepo] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [settingRepo, setSettingRepo] = useState(false);
  // First-run screen (specs/ui/app-start.feature.md): open a folder on this
  // computer, or clone a GitHub repository with a personal access token.
  // Or open a code repository directly (specs/app/code-repo-mode.feature.md).
  const [startChoice, setStartChoice] = useState<"folder" | "clone" | "code">("folder");
  // Switch spec folder (specs/app/spec-folders.feature.md): while a switch
  // runs, a modal covers the app with the folder being opened and the step
  // it is on; null between switches.
  const [switching, setSwitching] = useState<{ folder: string; step: SwitchStep } | null>(null);
  // Manage specification folders (specs/app/spec-folders.feature.md): the
  // dialog listing the folders the app knows, from the recent folders menu.
  const [foldersOpen, setFoldersOpen] = useState(false);
  // Whether the runtime offers a native folder chooser
  // (specs/ui/app-start.feature.md).
  const [canChooseFolder, setCanChooseFolder] = useState(false);
  // Demo mode: the data directory is a fixed ephemeral copy — everything that
  // changes or syncs it (✎, recents ▾, Sync, git/GitHub settings) hides.
  const [demo, setDemo] = useState(false);
  // Read-only mode (src/server/readOnlyMode.ts): the public spec site. The
  // server refuses every write; the client hides what would make one — the
  // folder switch and Sync, every create, edit, move and delete, settings,
  // agents — and opens editors as previews.
  const [readOnly, setReadOnly] = useState(false);
  // Check for Updates… belongs to the desktop app (src/frontend/main.tsx marks
  // it): the web server cannot replace itself, so its version is not a way in.
  const canCheckForUpdates = typeof document !== "undefined" && Boolean(document.documentElement.dataset.desktop);
  // Hosted mode (src/server/hostedMode.ts): the app runs behind the hosted
  // gateway, whose account page holds the GitHub token and agent keys.
  const [hosted, setHosted] = useState(false);
  // The signed-in hosted account (src/gateway): its email and whether it is
  // an admin (src/gateway/admin.ts), which puts Admin beside Settings in the
  // user menu. Null outside the hosted app, or until the gateway answers.
  const [hostedAccount, setHostedAccount] = useState<HostedAccount | null>(null);
  const hostedAdmin = hostedAccount?.admin ?? false;
  // The running app's version, shown beside the user name.
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // A newer release the server's daily check, or a manual one, found
  // (src/frontend/updateHint.tsx): the version chip and the menu mark it.
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const applyUpdateAvailable = (state: Record<string, unknown>) => {
    setUpdateAvailable(typeof state.updateAvailable === "string" ? state.updateAvailable : null);
  };
  // Where that version's source lives — the user menu links to it.
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const repoInputRef = useRef<HTMLInputElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [features, setFeatures] = useState<FeatureListing[]>([]);
  // Project members (src/server/members.ts): the data repo's
  // project-settings.json, as the feature's "Assigned" dropdown offers them.
  const [members, setMembers] = useState<ProjectMember[]>([]);
  // Code repo (src/server/members.ts `code-repo`): where a code gen session
  // runs, from the same file; null means the data repo.
  const [codeRepo, setCodeRepo] = useState<string | null>(null);
  // Every code repo the project names, the default first — the folders the
  // agent pane offers.
  const [codeRepos, setCodeRepos] = useState<string[]>([]);
  // Authorship in the feature files (specs/app/specs-authorship.feature.md):
  // the data repo's `authors-in-markdown`, from the same file; null until a
  // listing has been read, so Settings offers the switch only for a folder.
  const [authorsInMarkdown, setAuthorsInMarkdown] = useState<boolean | null>(null);
  // GitHub issues (specs/app/github-issues.feature.md): the repository the
  // code repo pushes to, when it is a GitHub one — the Issues tab shows for
  // it. Null (no code repo, or not on GitHub) means no tab.
  const [issuesRepo, setIssuesRepo] = useState<GitHubRepo | null>(null);
  // Custom attributes (specs/app/custom-attributes.feature.md): the data
  // repo's definitions as written, from the listing; null until one has been
  // read, so Settings offers the editor only for a folder.
  const [customAttributesText, setCustomAttributesText] = useState<string | null>(null);
  const attributeDefs = useMemo(
    () => parseAttributeDefinitions(customAttributesText ?? ""),
    [customAttributesText],
  );
  /**
   * Project-wide status rollup for the Specs section head: how many scenarios
   * are draft / proposed / published across every feature. Always the full
   * totals — independent of any active filter.
   */
  const statusTotals = useMemo(() => {
    const t = { draft: 0, proposed: 0, published: 0 };
    for (const f of features) for (const s of f.scenarios) t[s.status]++;
    return t;
  }, [features]);
  /** Whether an assignment change is in flight — the dropdown waits for it. */
  const [assignedSaving, setAssignedSaving] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  /** Folder path → description, for the folders that have a display-name.txt. */
  const [folderDescriptions, setFolderDescriptions] = useState<Record<string, string>>({});
  /**
   * Folder path → its subfolders in order (specs/ui/folders.feature.md
   * "order folders"), for the folders that have a folder-order.txt; the top
   * level's under `specs`. A move writes the new order here first, so the
   * tree shows it while the save is out.
   */
  const [folderOrders, setFolderOrders] = useState<Record<string, string[]>>({});
  /**
   * Folder path → its features' file names in order (specs/ui/
   * folders.feature.md "order features"), for the folders that have a
   * feature-order.txt. Written first on a move, like `folderOrders`.
   */
  const [featureOrders, setFeatureOrders] = useState<Record<string, string[]>>({});
  /** Folder paths whose subtree is collapsed in the sidebar. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /**
   * Feature files whose scenario outline is expanded in the sidebar
   * (specs/ui/navigation.feature.md "Scenario navigation"). Folders default to
   * open because a repo has few of them; scenario outlines are many, so they
   * default to closed and this tracks the ones opened — the mirror image of
   * `collapsed`. Kept for the session, like the folder state.
   */
  const [outlined, setOutlined] = useState<Set<string>>(new Set());
  /** Sidebar width in px (specs/ui/ui.feature.md "Sidebar resize"). */
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  /** True while the sidebar divider is being dragged. */
  const [resizingSidebar, setResizingSidebar] = useState(false);
  /** Folder highlighted by a click; "+ New folder" creates inside it. */
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  /** File name of the feature being dragged, if any. */
  const [dragging, setDragging] = useState<string | null>(null);
  // Code gen sessions (specs/agents/claude.feature.md): specs checked in the
  // sidebar, and scenarios checked on their cards, go into a named session
  // that runs the coding agent. Per file the selection is the whole spec
  // ("all") or a set of scenario keys.
  const [specSelection, setSpecSelection] = useState<Map<string, "all" | Set<string>>>(new Map());
  // Scenarios picked in the sidebar tree (specs/ui/navigation.feature.md
  // "delete several scenarios at once"): ⌘/Ctrl-click toggles a row,
  // Shift-click picks the range from the anchor. Keyed by treeScenarioKey.
  const [treePicks, setTreePicks] = useState<Set<string>>(() => new Set());
  const treePickAnchor = useRef<string | null>(null);
  const [sessionRunning, setSessionRunning] = useState(false);
  /** The Start session dialog (src/frontend/StartSessionDialog.tsx), open or not. */
  const [startDialog, setStartDialog] = useState(false);
  // The Pomodoro (src/frontend/pomodoro.ts): a feature of the app, not a kind
  // of session — its store keeps the clock, and App reads it for the window
  // title and the bar. The preferences are read once on boot; there is no
  // timer to pick up, since it lives only as long as the app is open.
  const pom = usePomodoro();
  useEffect(() => {
    pomodoro.load();
  }, []);
  /** The Pomodoro settings dialog, opened from the bar's ⋯ or the palette. */
  const [pomodoroSettings, setPomodoroSettings] = useState(false);
  /** Outcome line under the Start session button (started/finished). */
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  /** A failed session's message, shown in an error box until dismissed. */
  const [sessionError, setSessionError] = useState<string | null>(null);
  /** Sidebar entry whose "⋯" menu is open (file name), if any. */
  const [treeMenu, setTreeMenu] = useState<string | null>(null);
  /** True while the File submenu of the open tree menu is expanded. */
  /** Folder path the drag is hovering over ("" = top level). */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /**
   * The sibling feature row a dragged feature would land beside (specs/ui/
   * folders.feature.md "order features"), and on which edge. A feature
   * dragged over a row in another folder drops into that folder instead.
   */
  const [featureDropAt, setFeatureDropAt] = useState<{ fileName: string; after: boolean } | null>(null);
  /**
   * A scenario being dragged — a row of the sidebar outline or a card of the
   * feature page (specs/ui/navigation.feature.md "reorder scenarios by
   * dragging them in the tree", "drag a scenario to another feature") — and
   * the row or card edge it would land on, in its own feature or another.
   * Apart from `dragging`, so the folders' drop zones never take it for a
   * feature.
   */
  const [scenarioDrag, setScenarioDrag] = useState<{
    file: string;
    name: string;
    version: number;
    status: ScenarioStatus;
  } | null>(null);
  const [scenarioDropAt, setScenarioDropAt] = useState<{
    file: string;
    name: string;
    version: number;
    after: boolean;
  } | null>(null);
  /** The feature row a scenario dragged out of another feature is over. */
  const [scenarioDropInto, setScenarioDropInto] = useState<string | null>(null);
  /**
   * A folder being dragged among its siblings (specs/ui/folders.feature.md
   * "order folders"), and the sibling row edge it would land on. Apart from
   * `dragging` too: a folder never drops into a folder, only beside one.
   */
  const [folderDrag, setFolderDrag] = useState<{ parent: string; path: string } | null>(null);
  const [folderDropAt, setFolderDropAt] = useState<{ path: string; after: boolean } | null>(null);
  // Full-text search (specs/search.feature.md) lives in the command palette
  // (⌘K, src/frontend/CommandPalette.tsx): open, with the text it starts on.
  const [palette, setPalette] = useState<{ query: string } | null>(null);
  /** The pages opened most recently — the palette's empty state. */
  const [recent, setRecent] = useState<RecentEntry[]>(readRecent);
  /** The header's ⋯ menu, a card's ⋯ menu (by index), the assignee chips. */
  const [featureMenuOpen, setFeatureMenuOpen] = useState(false);
  // The scenario pane's ⋯ menu, its status chip's menu, and the feature
  // page's publish-rollup menu (specs/editor/spec-editor.feature.md "Spec
  // editor pane"): actions as menus, not a row of filled buttons.
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [publishMenuOpen, setPublishMenuOpen] = useState(false);
  const [cardMenu, setCardMenu] = useState<number | null>(null);
  const [assigneeMenuOpen, setAssigneeMenuOpen] = useState(false);
  /** Sidebar collapsed to a rail ("["), remembered on this device. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  /** The editor column hidden ("\"), so the coding agent pane can have the
      window. Only ever acted on while that pane is a column beside it — see
      `editorOff` below, which is what the layout actually follows. */
  const [editorHidden, setEditorHidden] = useState(readEditorHidden);
  /** One pane (a phone, a narrow tablet): the sidebar is a drawer over the
      page, closed by default and closed again by navigating anywhere. */
  const compact = useMediaQuery(COMPACT_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTrapRef = useFocusTrap(compact && drawerOpen);
  /** The sidebar's filter, and its menu. */
  const [filter, setFilter] = useState<TreeFilter>(NO_FILTER);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  /** A feature is being fetched — the skeleton shows until it lands. */
  const [featureLoading, setFeatureLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [feature, setFeature] = useState<Feature | null>(null);
  // What the data repo's attributes use, for the chips' checks and the
  // editor's suggestions (specs/app/custom-attributes.feature.md): every
  // listed feature, and the open one as it stands — its drafts and an edit
  // the listing has not caught up with included.
  const knownAttributes = useMemo(
    () =>
      knownNames([
        ...features.flatMap((f) => [f.attributes, ...f.scenarios.map((s) => s.attributes)]),
        feature?.attributes,
        ...(feature?.scenarios.map((s) => s.attributes) ?? []),
      ]),
    [features, feature],
  );
  /** Draft for the inline file-name editor; null while not editing. */
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  // The header field saves on blur, and a blur can arrive from a stale
  // render (the field closing on ESC, or while a save is out) — these refs
  // carry the current draft and whether a rename is in flight.
  const renameDraftRef = useRef(renameDraft);
  renameDraftRef.current = renameDraft;
  const renamingRef = useRef(false);
  const [selectedScenario, setSelectedScenario] = useState<number | null>(null);
  const scenarioRefs = useRef<(HTMLElement | null)[]>([]);
  /** The sidebar's folder tree, for scrolling its highlighted row into view. */
  const treeRef = useRef<HTMLDivElement | null>(null);
  /**
   * True from a selection change until the tree has scrolled its highlighted
   * row into view (specs/ui/navigation.feature.md "the tree follows the open
   * feature") — the row may only render a commit or two later, once the
   * folders above it open and the listing is in.
   */
  const revealPending = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  /**
   * A scenario deep link asks for that scenario's page (specs/navigation.spec
   * .md "open a scenario link"). The pane opens from an effect rather than
   * straight from the navigation: any pane the link replaced closes first, so
   * the new one starts a fresh editor session — its own autosave baseline,
   * with the outgoing one's last save unable to reach back into it.
   */
  const [paneRequest, setPaneRequest] = useState<{
    scenario: Scenario;
    /** Search terms to mark in the pane (specs/search.feature.md), when a hit opened it. */
    terms: string[] | null;
  } | null>(null);
  /**
   * The words marked in the open scenario editor (specs/search.feature.md):
   * the terms of the search hit that opened it, gone when the pane closes.
   */
  const [searchTerms, setSearchTerms] = useState<string[] | null>(null);
  // Editor autosave (specs/editor/editor-autosave.feature.md): the signature of
  // what the open dialog last had saved, and whether a tick is still saving.
  // Refs, because a tick reads them between renders and must not cause one.
  // Scenario PUTs share a queue with the description editor's reason: a folder
  // switch must wait for a tick already on its way. A boolean in-flight flag
  // would make that wait a no-op, and the server resolves the data folder per
  // request, so the late PUT would write this scenario into the folder that
  // comes next.
  const autosaved = useRef<string | null>(null);
  /** A scenario just added with `+` (specs/ui/ui.feature.md "Add A Scenario
      Button") is saved the moment its pane opens, empty body and all. */
  const saveOnOpen = useRef(false);
  /** The tick still saving, resolving to where it left the scenario — null when none is away. */
  const autosaveInFlight = useRef<Promise<Placement> | null>(null);
  const scenarioSaveQueue = useRef(createPromiseQueue());
  /**
   * The feature's path is about to change (move, rename-file) or go away
   * (delete). `retiring` blocks new autosave ticks while a flush lands;
   * `sealed` refuses every further write to the retired path — the same
   * pair a page editor uses (PagesPane flush/seal).
   */
  const featureEditorsRetiring = useRef(false);
  const featureEditorsSealed = useRef(false);
  /** The editor pane's title field, so a tick can see whether the name is
      still being typed (specs/editor/editor-autosave.feature.md). Null once the
      scenario is published, when the name is no longer editable. */
  const nameFieldRef = useRef<HTMLInputElement | null>(null);
  /** The ways out of the editor pane, for the handlers that leave it from
      outside the render that defines them — ESC, and every navigation away
      from the feature (specs/editor/spec-editor.feature.md "Spec editor
      pane"). Kept in a ref so they always run the current ones. `close`
      returns the last save when one went out, for a caller that must order
      itself after it. `flush` / `seal` land and then refuse writes when the
      file is about to be renamed, moved or deleted. */
  const editorRef = useRef<{
    close: () => Promise<{ ok: boolean; placed: Placement }> | null;
    back: () => void;
    flush: () => Promise<void>;
    seal: () => void;
  }>({
    close: () => null,
    back: () => {},
    flush: async () => {},
    seal: () => {},
  });
  /** True from the moment Delete is pressed until the removal is away, so no
      tick saves the scenario back while the confirmation is on screen — and
      so nothing re-sorts the feature under the entry being deleted. */
  const deletingScenario = useRef(false);
  /** Bumped every time the dialog opens or closes, so a save that lands after
      the user has moved on cannot stamp its result onto another scenario. */
  const editorSession = useRef(0);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [conflictDraft, setConflictDraft] = useState("");
  /** Which resolution is being published, if any — the buttons disable while it runs. */
  const [resolving, setResolving] = useState<"ours" | "theirs" | "draft" | null>(null);
  /** Autosave state behind the header's Saved indicator. */
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** The `?` keyboard cheat sheet. */
  const [sheetOpen, setSheetOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  /** "all", a scenario key (`name@vN`), or null while no publish is running. */
  const [publishing, setPublishing] = useState<string | null>(null);
  // The editor pane's Back to proposed is away (specs/editor/spec-editor.
  // feature.md "Unpublish a Spec"): its route commits and pushes first.
  const [unpublishing, setUnpublishing] = useState(false);
  const [reloadSeconds, setReloadSeconds] = useState(60);
  const [previewLines, setPreviewLines] = useState(8);
  /**
   * How often the open editor saves itself
   * (specs/editor/editor-autosave.feature.md).
   */
  const [autosaveSeconds, setAutosaveSeconds] = useState(DEFAULT_AUTOSAVE_SECONDS);
  // The data repo's README.md (app-startup.md "App Starts with
  // existing specs folder selected"): the home view is an editor on it, saved
  // on the same interval as the scenario editor. `readme` is what the editor
  // holds (null until loaded); the refs are what the last landed save or load
  // put on disk, and whether a save is still on its way — a tick reads them
  // between renders.
  const [readme, setReadme] = useState<string | null>(null);
  const readmeText = useRef<string | null>(null);
  readmeText.current = readme;
  const readmeSaved = useRef<string | null>(null);
  const readmeSaveQueue = useRef(createPromiseQueue());
  /** Bumped per README load, so a save landing after a repo switch stamps nothing. */
  const readmeSession = useRef(0);
  // Test links (specs/traceability.feature.md): the table of automated-test
  // links at the end of each scenario card is optional; default ON.
  const [showTestLinks, setShowTestLinks] = useState(true);
  // Open test links in IntelliJ IDEA (specs/traceability.feature.md "Open
  // test in idea"): a click on one runs `idea --line` on the file in the
  // code repo instead of opening GitHub; default OFF.
  const [openTestsInIdea, setOpenTestsInIdea] = useState(false);
  /** Whether `idea` is on the server's PATH, so the setting can work. */
  const [canOpenInIdea, setCanOpenInIdea] = useState(false);
  // Open worktrees in Ghostty (specs/agents/agent-pane.feature.md "A
  // worktree session opens in a Ghostty shell"): a click on a worktree
  // session's branch in the agent pane opens a shell there; default OFF.
  const [ghosttyOn, setGhosttyOn] = useState(false);
  /** Whether Ghostty is installed where the server runs. */
  const [canOpenGhostty, setCanOpenGhostty] = useState(false);
  // External links (specs/external-links/project-management-jira-linear-etc.
  // feature.md): whether ticket links are written into the .feature.md files.
  const [publishExternalLinks, setPublishExternalLinks] = useState(true);
  // Project management (specs/external-links/project-management-jira-linear-
  // etc.feature.md): whether tickets are tracked at all, and the tool they
  // live in. Off, nothing in the app shows or asks for a ticket; on, the
  // editors ask for the ticket's url alone — the tool is this one.
  const [projectManagement, setProjectManagement] = useState(true);
  const [projectManagementTool, setProjectManagementTool] = useState(
    DEFAULT_PROJECT_MANAGEMENT_TOOL,
  );
  /** Which of Aha! and Figma features and scenarios link to
      (specs/external-links/aha-and-figma-links.feature.md). */
  const [resourceLinksOn, setResourceLinksOn] = useState<ResourceLinkSwitches>(NO_RESOURCE_LINKS);
  /** Whether features and scenarios link qTest test cases
      (specs/external-links/qtest-test-cases.feature.md); default OFF. */
  const [qtestLinks, setQtestLinks] = useState(false);
  /** Confluence (specs/external-links/confluence-wiki.feature.md): the wikis
      this device holds a token for, the last parent page published under,
      and whether the publish dialog is open. */
  const [confluenceWikis, setConfluenceWikis] = useState<ConfluenceWiki[]>([]);
  const [confluencePublishOpen, setConfluencePublishOpen] = useState(false);
  /** "Publish to Confluence…" on a folder ("Publish a folder's features to
      Confluence"): the folder, as the sidebar names it, and its features —
      null until the server says which pages they link. */
  const [confluenceFolder, setConfluenceFolder] = useState<{
    path: string;
    label: string;
    features: FolderFeature[] | null;
  } | null>(null);
  /** qTest (specs/external-links/qtest-test-cases.feature.md "Create qTest
      test cases from a feature"): the sites this device holds a token for,
      the last parent module created under, and whether the dialog is open. */
  const [qtestSites, setQtestSites] = useState<QtestSite[]>([]);
  const [qtestParentUrl, setQtestParentUrl] = useState("");
  const [qtestPublishOpen, setQtestPublishOpen] = useState(false);
  /** "Publish to Wiki & qTest…" (specs/external-links/qtest-test-cases.feature.md
      "Publish the page and the test cases from one dialog"): the page first,
      then the test cases, from one dialog. */
  const [wikiQtestPublishOpen, setWikiQtestPublishOpen] = useState(false);
  /** Aha! (specs/external-links/aha-import.feature.md): the sites this
      device holds an API key for, and the folder an open import lands in
      (null for the top level) — or null while the dialog is closed. */
  const [ahaSites, setAhaSites] = useState<AhaSite[]>([]);
  const [ahaImportOpen, setAhaImportOpen] = useState<{ folder: string | null } | null>(null);
  /** Whether "Import from Aha!" is offered at all — switched on in Settings
      → Aha!, default OFF. Never in the demo or the hosted app, which keep
      no API key. */
  const [ahaImportOn, setAhaImportOn] = useState(false);
  const ahaImport = ahaImportOn && !demo && !hosted;
  /** Import from OpenSpec (specs/external-links/openspec-import.feature.md):
      the folder an open import lands in (null for the top level), or null
      while the dialog is closed. Needs no key, so no Settings switch; never
      in the demo or the hosted app, which have no code repo on disk. */
  const [openSpecImportOpen, setOpenSpecImportOpen] = useState<{ folder: string | null } | null>(null);
  const openSpecImport = !demo && !hosted;
  /** Import from Jira/Wiki (specs/external-links/jira-wiki-import
      .feature.md): the Jira sites this device holds a token for, and the
      folder an open import lands in (null for the top level) — or null
      while the dialog is closed. Never in the demo or the hosted app. */
  const [jiraSites, setJiraSites] = useState<JiraSite[]>([]);
  const [importOpen, setImportOpen] = useState<{ folder: string | null; mode: "both" | "jira" | "wiki" } | null>(null);
  /** Whether Jira and Confluence are switched on at all — in Settings → Jira /
      Confluence, each default OFF (specs/external-links/jira-wiki-import
      .feature.md, confluence-wiki.feature.md). Jira off hides the Jira import;
      Confluence off hides "Publish to Confluence…" and the Confluence import.
      Never in the demo or the hosted app, which keep no tokens. */
  const [jiraEnabledOn, setJiraEnabledOn] = useState(false);
  const [confluenceEnabledOn, setConfluenceEnabledOn] = useState(false);
  const jiraEnabled = jiraEnabledOn && !demo && !hosted;
  const confluenceEnabled = confluenceEnabledOn && !demo && !hosted;
  /** Code gen sessions offered at all (specs/agents/claude.feature.md). */
  const [codeGen, setCodeGen] = useState(true);
  /** Whether Claude.app is installed, so a session can open in Claude Code
      Desktop — the session dialog offers "Run in" only then. */
  const [canOpenClaudeDesktop, setCanOpenClaudeDesktop] = useState(false);
  /** The last "Run in" choice, remembered in settings; null means not chosen yet. */
  const [codeGenTarget, setCodeGenTarget] = useState<CodeGenTarget | null>(null);
  // The coding agent pane's own state (src/frontend/agentChat.ts): open,
  // width, sessions. Restored once on boot — the pane, its width and the
  // last session come back the way they were left.
  const pane = useAgentChat();
  /** The coding agents the plugins supply (specs/agents/agent-plugins
      .feature.md), by rank, each saying whether its CLI is on PATH. The
      store holds them, so every /api/state reader updates them in one place. */
  const agents = pane.agents;
  const canOpenAgentPane = agentPaneOffered(pane);
  // The coding agent pane shows only while code gen is on at all.
  const paneShown = pane.open && codeGen;
  /** The editor can be hidden only while the agent pane is a column beside
      it — never in compact, where that pane covers the page instead, so
      hiding the editor could leave a window with nothing in it. */
  const canHideEditor = paneShown && !compact;
  /** What the layout follows. Closing the pane or crossing into compact
      brings the editor back without clearing the stored choice, so
      reopening the pane restores it. */
  const editorOff = canHideEditor && editorHidden;
  const [resizingAgent, setResizingAgent] = useState(false);
  useEffect(() => {
    void agentChat.restore();
  }, []);
  // Deleting published scenarios (specs/editor/spec-editor.feature.md "Delete
  // Published Spec"): opt-in — published scenarios stay immutable until the
  // Settings switch turns deletion on.
  const [deletePublished, setDeletePublished] = useState(false);
  // Feature assignment (src/server/members.ts): opt-in — the "Assigned"
  // dropdown shows only once the Settings switch turns assignments on.
  const [assignments, setAssignments] = useState(false);
  // Feature flags (specs/app/feature-flags.feature.md): opt-in — the flag
  // chips and editors show only once the Settings switch turns them on.
  const [featureFlags, setFeatureFlags] = useState(false);
  // Scenario polarity (specs/ui/scenario-polarity.feature.md): opt-in — the
  // Positive / Negative pill shows only once the Settings switch turns it on.
  const [scenarioPolarity, setScenarioPolarity] = useState(false);
  // The GitHub account (specs/app/user-info-settings.feature.md "GitHub
  // account behind a switch"): not ready, so the Settings sign-in block and
  // the user menu's sign-in entries show only once the switch is on.
  const [githubAccount, setGithubAccount] = useState(false);
  // The plugins (specs/app/plugins.feature.md) as `GET /api/state` lists
  // them: the profile's entries in tab order, then the built-ins it leaves
  // off — what Settings → Plugins renders, each with its switch. Every
  // module — the special folders, Event Models, Tests, Issues — is one of
  // them; App names none.
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  // The profile's explicit plugin folders (specs/app/plugins.feature.md "A
  // plugin loads from a local folder"), listed under the plugins.
  const [pluginSources, setPluginSources] = useState<string[]>([]);
  const [pluginMarketplaces, setPluginMarketplaces] = useState<MarketplaceRef[]>([]);
  // A browser half that failed to load, by plugin id — shown beside the row.
  const pluginLoadErrors = useSyncExternalStore(clientLoadErrors.subscribe, clientLoadErrors.snapshot);
  // The plugins' tabs (specs/app/plugins.feature.md), in their order, and
  // which plugin view has the pane — null when none. App knows only the tab
  // id and an opaque view; the tab parses, renders and titles it.
  const registeredTabs = useRegistry(tabs);
  // With a code repository open (specs/app/code-repo-mode.feature.md) the
  // Files tab is the only one; otherwise it is never shown.
  const pluginTabs = useMemo(
    () => registeredTabs.filter((tab) => (tab.id === FILES_TAB) === (codeRepoDir !== null)),
    [registeredTabs, codeRepoDir],
  );
  // The Settings sections the plugins register (src/plugins/client/
  // settings.ts), and the state payload they read; each sits where its
  // order puts it among the core sections.
  const pluginSettingsSections = visibleSettingsSections(useRegistry(settingsSections), { demo, hosted });
  const [settingsPayload, setSettingsPayload] = useState<Record<string, unknown>>({});
  // The models each agent offers (its Settings section), from the data
  // repo's .specdriven/<agent>-models.json files — what every model dropdown lists.
  const agentModels = useMemo(() => agentModelsOf(settingsPayload), [settingsPayload]);
  const saveAgentModels = (next: AgentModels) => setSettingsPayload((p) => ({ ...p, agentModels: next }));
  const [pluginView, setPluginView] = useState<PluginView | null>(null);
  const pluginViewRef = useRef<PluginView | null>(null);
  pluginViewRef.current = pluginView;
  const activeTab = pluginView ? (pluginTabs.find((t) => t.id === pluginView.tab) ?? null) : null;
  /** Ticks with the active tab's store, so titles read through it stay current. */
  const tabsTick = useTabStores(pluginTabs);
  // Google Calendar (specs/app/tasks.feature.md "Add task to Google
  // Calendar"): the Settings switch behind every task's calendar chip, as
  // the Settings dialog's row shows it; the tasks plugin reads it too.
  const [googleCalendarOn, setGoogleCalendarOn] = useState(false);
  /** Which sidebar tab is open — Specs or a plugin's; remembered. */
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(readSidebarTab);
  /** The tab on screen: a plugin's tab only while it is still mounted. */
  const shownTab: SidebarTab = pluginTabs.some((tab) => tab.id === sidebarTab)
    ? sidebarTab
    : codeRepoDir !== null
      ? FILES_TAB
      : "specs";
  // Live sync (specs/datastore/automerge-store.feature.md): optional websocket
  // sync server; empty means off — git stays the only transport.
  const [syncServerUrl, setSyncServerUrl] = useState<string | null>(null);
  /**
   * The app's own page holding the editor pane — Settings or Plugins
   * (specs/user-info-settings.feature.md "open Settings", "open Plugins") —
   * or null. Like a plugin's view it owns the pane and its url.
   */
  const [appPage, setAppPage] = useState<AppPage | null>(null);
  // The read-only site opens none of the app's own pages but What's new: a
  // /settings or /data link lands on what the url would show beneath it.
  const appPageShown = readOnly && appPage !== "whats-new" ? null : appPage;
  /** Whether opening the page pushed a history entry that closing can pop. */
  const appPagePushed = useRef(false);
  const [settingsDraft, setSettingsDraft] = useState(String(DEFAULT_AUTOSYNC_SECONDS));
  /** The autosync switch: off saves a frequency of 0, which stops the reload. */
  const [settingsAutosyncOnDraft, setSettingsAutosyncOnDraft] = useState(true);
  const [settingsLinesDraft, setSettingsLinesDraft] = useState("8");
  const [settingsAutosaveDraft, setSettingsAutosaveDraft] = useState(
    String(DEFAULT_AUTOSAVE_SECONDS),
  );
  const [settingsTestLinksDraft, setSettingsTestLinksDraft] = useState(true);
  const [settingsOpenInIdeaDraft, setSettingsOpenInIdeaDraft] = useState(false);
  const [settingsGhosttyDraft, setSettingsGhosttyDraft] = useState(false);
  const [settingsProjectManagementDraft, setSettingsProjectManagementDraft] = useState(true);
  /** The tool name being typed/picked in Settings; saved when it is usable. */
  const [settingsToolDraft, setSettingsToolDraft] = useState(DEFAULT_PROJECT_MANAGEMENT_TOOL);
  const [settingsPublishLinksDraft, setSettingsPublishLinksDraft] = useState(true);
  const [settingsResourceLinksDraft, setSettingsResourceLinksDraft] =
    useState<ResourceLinkSwitches>(NO_RESOURCE_LINKS);
  const [settingsQtestLinksDraft, setSettingsQtestLinksDraft] = useState(false);
  const [settingsAhaImportDraft, setSettingsAhaImportDraft] = useState(false);
  const [settingsJiraEnabledDraft, setSettingsJiraEnabledDraft] = useState(false);
  const [settingsConfluenceEnabledDraft, setSettingsConfluenceEnabledDraft] = useState(false);
  const [settingsCodeGenDraft, setSettingsCodeGenDraft] = useState(true);
  const [settingsDeletePublishedDraft, setSettingsDeletePublishedDraft] = useState(false);
  const [settingsAssignmentsDraft, setSettingsAssignmentsDraft] = useState(false);
  const [settingsFeatureFlagsDraft, setSettingsFeatureFlagsDraft] = useState(false);
  const [settingsScenarioPolarityDraft, setSettingsScenarioPolarityDraft] = useState(false);
  const [settingsGithubAccountDraft, setSettingsGithubAccountDraft] = useState(false);
  const [settingsGoogleCalendarDraft, setSettingsGoogleCalendarDraft] = useState(false);
  const [settingsSyncDraft, setSettingsSyncDraft] = useState(DEFAULT_SYNC_SERVER_URL);
  /** The Settings switch: off saves an empty url, which turns live sync off. */
  const [settingsSyncOnDraft, setSettingsSyncOnDraft] = useState(false);
  /** Url being typed into the edit dialog's "Add test link" field. */
  const [testDraft, setTestDraft] = useState("");
  /** The test's name beside it: read from the code on GitHub, or typed. */
  const [testNameDraft, setTestNameDraft] = useState("");
  /** Index of the test link opened for in-place ✎ editing, if any. */
  const [testEdit, setTestEdit] = useState<number | null>(null);
  const [testEditDraft, setTestEditDraft] = useState<TestDraft>({ url: "", name: "" });
  /** What the last name lookup is doing or why it found nothing, under the field. */
  const [testNameHint, setTestNameHint] = useState<string | null>(null);
  /** Serial of the latest name lookup: an older one landing late is ignored. */
  const testLookup = useRef(0);
  /** The url and name an ✎ row opened with, to tell a changed url from a re-open. */
  const testEditOpened = useRef<TestDraft>({ url: "", name: "" });
  /** Why the last Save was blocked by the tests field, if it was. */
  const [testsError, setTestsError] = useState<string | null>(null);
  /** The edit dialog's "Ticket link" fields as typed
      (specs/external-links/project-management-jira-linear-etc.feature.md). */
  const [linkDraft, setLinkDraft] = useState<LinkDraft>(EMPTY_LINK_DRAFT);
  /** Why the last Save was blocked by the ticket-link fields, if it was. */
  const [linkError, setLinkError] = useState<string | null>(null);
  /** The feature's tickets popover (specs/external-links/project-management-
      jira-linear-etc.feature.md "Several tickets on a feature"): open or not,
      why the server refused the last list, and whether one is on its way. */
  const [featureTicketsOpen, setFeatureTicketsOpen] = useState(false);
  const [featureTicketsError, setFeatureTicketsError] = useState<string | null>(null);
  const [featureTicketsSaving, setFeatureTicketsSaving] = useState(false);
  /** The edit dialog's "qTest test case" fields as typed
      (specs/external-links/qtest-test-cases.feature.md), and why the last
      Save was blocked by them; then the feature's own qTest dialog. */
  const [qtestDraft, setQtestDraft] = useState<LinkDraft>(EMPTY_LINK_DRAFT);
  const [qtestError, setQtestError] = useState<string | null>(null);
  const [featureQtestDraft, setFeatureQtestDraft] = useState<LinkDraft | null>(null);
  const [featureQtestError, setFeatureQtestError] = useState<string | null>(null);
  const [featureQtestSaving, setFeatureQtestSaving] = useState(false);
  /** The feature's "Pull requests" popover
      (specs/external-links/related-pull-requests.feature.md). */
  const [featurePrsOpen, setFeaturePrsOpen] = useState(false);
  const [featureFlagsOpen, setFeatureFlagsOpen] = useState(false);
  /** The feature's attributes popover (specs/app/custom-attributes.feature.md). */
  const [featureAttributesOpen, setFeatureAttributesOpen] = useState(false);
  /** The feature's Aha! or Figma popover, whichever is open
      (specs/external-links/aha-and-figma-links.feature.md). */
  const [featureResourceOpen, setFeatureResourceOpen] = useState<ResourceLinkKind | null>(null);
  // The feature description editor (specs/editor/feature-editor.feature.md):
  // the free markdown above the first scenario, edited in place and autosaved
  // at the scenario editor's interval like the home README. Keyed by file so
  // the editor belongs to the feature it was opened on — it shows only while
  // that feature is selected, and a save that lands after the user moved on
  // stamps nothing onto the feature opened since. `descSaved` is the text
  // last landed on the server; refs, because a tick reads them between
  // renders and must not cause one.
  const [descEdit, setDescEdit] = useState<{ file: string; text: string } | null>(null);
  const descEditRef = useRef(descEdit);
  descEditRef.current = descEdit;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const descSaved = useRef<string | null>(null);
  /**
   * Description PUTs go through one queue, so a flush (leaving the feature, or
   * switching data folder) waits for a tick already on its way and then writes
   * what the editor still holds — the same reason the page editor and the
   * model canvas have queues of their own. A boolean in-flight flag would make
   * that flush a no-op instead, dropping whatever was typed since the tick
   * started.
   */
  const descSaveQueue = useRef(createPromiseQueue());
  // The editor's height, dragged by the strip along its lower boundary. null
  // until a first drag or a stored height: then the CSS third-of-the-window
  // default stands, and follows the window.
  const [descHeight, setDescHeight] = useState<number | null>(() =>
    readEditorHeight(DESC_HEIGHT_KEY, DESC_MIN),
  );
  const [resizingDesc, setResizingDesc] = useState(false);
  const descPaneRef = useRef<HTMLDivElement | null>(null);
  // The scenario body's height, the same way (specs/editor/spec-editor.
  // feature.md "Spec body resize"): null until a first drag or a stored
  // height, while the CSS default stands.
  const [bodyHeight, setBodyHeight] = useState<number | null>(() =>
    readEditorHeight(BODY_HEIGHT_KEY, BODY_MIN),
  );
  const [resizingBody, setResizingBody] = useState(false);
  const bodyFieldRef = useRef<HTMLDivElement | null>(null);
  // Git access (specs/app/user-info-settings.feature.md "Git access"): the
  // GitHub CLI (the default wherever gh is installed), a personal access
  // token, or the GitHub account sign-in — the server picks the engine.
  const [gitAccess, setGitAccess] = useState<string | null>(null);
  const [cliGitAvailable, setCliGitAvailable] = useState(false);
  const [gh, setGh] = useState<GhInfo | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // GitHub sign-in (git-operations.md): the browser flow — GitHub
  // opens in a tab and redirects back to the server while we poll — with the
  // device flow (enter the shown code at github.com/login/device) as the
  // fallback, and the only path on the desktop app's app:// pages.
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlow | null>(null);
  const [webConnecting, setWebConnecting] = useState(false);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(readThemePref);
  // Vim mode (specs/ui/ui.feature.md "Settings"): device-local like the theme;
  // every open Markdown editor follows the switch (src/frontend/vimPref.ts).
  const vimMode = useVimMode();
  // Excalidraw support (specs/editor/excalidraw-support.feature.md): device-
  // local too; every Markdown editor's toolbar follows the switch.
  const excalidrawOn = useExcalidrawEnabled();
  // Spell check (specs/editor/common-editor.feature.md "Spell check"): on by
  // default, device-local; every prose field follows (src/frontend/spellCheckPref.ts).
  const spellCheckOn = useSpellCheck();
  // The Pomodoro (specs/app/pomodoro.feature.md): off until asked for, and
  // device-local like the rest (src/frontend/pomodoroPref.ts). Off means the
  // bar, the `p` key and the palette's entries are all gone.
  const pomodoroOn = usePomodoroEnabled();
  /** Path whose "Copy link" action just ran — its label shows "Copied". */
  const [copied, setCopied] = useState<string | null>(null);
  // Current user (specs/user-info-settings.feature.md): shown in the sidebar's
  // lower left corner; the chip opens a menu with User info and Settings.
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [userInfoOpen, setUserInfoOpen] = useState(false);
  // "View settings file…" in User info (specs/app/user-info-settings
  // .feature.md "view the settings file"): ~/.specdriven/settings.json,
  // read-only and readable. `settingsFile` is null while it loads.
  const [settingsFileOpen, setSettingsFileOpen] = useState(false);
  const [settingsFile, setSettingsFile] = useState<SettingsFile | null>(null);
  const [settingsFileError, setSettingsFileError] = useState<string | null>(null);
  // The user menu's token sign-in (specs/user-info-settings.feature.md).
  const [tokenSignInOpen, setTokenSignInOpen] = useState(false);
  // In-app prompt/confirm dialogs (specs/ui/ui.feature.md "Dialogs") — the
  // desktop runtime has no window.prompt (specs/app/desktop-app.feature.md
  // "Dialogs").
  const { modal, modalOpen, prompt, promptWithChoice, confirm, pick } = useModalPrompts();
  // Plugin updates at start (specs/app/plugins.feature.md "Plugins with an
  // update are offered in a dialog at start"): asked once the server's
  // start has pulled the marketplaces; the server answers [] wherever it
  // offers none — the demo, the hosted app, a run already asked.
  const [pluginUpdates, clearPluginUpdates] = usePluginUpdatesOffer(true);

  /** Returns the listing it loaded, so callers can act on it before state settles. */
  const loadFeatures = useCallback(async (): Promise<Listing | null> => {
    // A code repository has no specifications to list.
    if (codeRepoRef.current) return null;
    const result = await fetchListing();
    if ("error" in result) {
      setLoadError(result.error);
      return null;
    }
    const { listing } = result;
    setFeatures(listing.features);
    setFolders(listing.folders);
    setFolderDescriptions(listing.folderDescriptions);
    setFolderOrders(listing.folderOrders);
    setFeatureOrders(listing.featureOrders);
    setMembers(listing.members);
    setCodeRepo(listing.codeRepo);
    setCodeRepos(listing.codeRepos ?? []);
    setAuthorsInMarkdown(listing.authorsInMarkdown);
    setIssuesRepo(listing.issuesRepo);
    setCustomAttributesText(listing.customAttributes);
    setSyncProblem(listing.syncProblem);
    setLoadError(null);
    return listing;
  }, []);

  /** Read the data repo's README into the home editor, dropping any unsaved edit. */
  const loadReadme = useCallback(async (): Promise<void> => {
    // A code repository's README opens in the Files tab instead.
    if (codeRepoRef.current) return;
    const res = await fetch("/api/readme");
    if (!res.ok) return;
    const data = (await res.json()) as { content: string };
    readmeSession.current += 1;
    readmeSaved.current = data.content;
    setReadme(data.content);
  }, []);

  // Why the page's first read failed (specs/ui/app-start.feature.md "the
  // server cannot be reached at start"): shown in place of the app, and
  // retried until the server answers.
  const [bootError, setBootError] = useState<BootError | null>(null);
  const booting = useRef(false);
  // Data saved by a newer app (specs/app/data-format.feature.md): the
  // version it asks for, while the server refuses to work on the folder.
  const [outdated, setOutdated] = useState<{ minAppVersion: string | null } | null>(null);
  const [checkingOutdated, setCheckingOutdated] = useState(false);
  useEffect(() => watchDataTooNew((minAppVersion) => setOutdated({ minAppVersion })), []);

  const boot = useCallback(async () => {
    // The retry timer and the Retry button can both land here.
    if (booting.current) return;
    booting.current = true;
    try {
      // boot=1 marks the page-load fetch: in demo mode the server reseeds the
      // pristine dataset on it, so a refresh reopens on the default data.
      const result = await fetchBootState();
      if ("error" in result) {
        setBootError(result.error);
        return;
      }
      const { state } = result;
      try {
        applyRepos(state);
        // No folder of either kind: the first-run screen (needsFolder is
        // false while a code repository is open in place of the specs).
        setNeedsRepo(state.needsFolder ?? state.needsDataRepo);
        if (typeof state.reloadFrequencySeconds === "number") {
          setReloadSeconds(state.reloadFrequencySeconds);
        }
        if (typeof state.scenarioPreviewLines === "number") {
          setPreviewLines(state.scenarioPreviewLines);
        }
        if (typeof state.autosaveIntervalSeconds === "number") {
          setAutosaveSeconds(state.autosaveIntervalSeconds);
        }
        if (typeof state.showTestLinks === "boolean") {
          setShowTestLinks(state.showTestLinks);
        }
        setOpenTestsInIdea(state.openTestsInIdea === true);
        setCanOpenInIdea(Boolean(state.canOpenInIdea));
        setGhosttyOn(state.ghostty === true);
        setCanOpenGhostty(Boolean(state.canOpenGhostty));
        if (typeof state.publishExternalLinks === "boolean") {
          setPublishExternalLinks(state.publishExternalLinks);
        }
        if (typeof state.projectManagement === "boolean") {
          setProjectManagement(state.projectManagement);
        }
        if (typeof state.projectManagementTool === "string") {
          setProjectManagementTool(state.projectManagementTool);
        }
        setResourceLinksOn(resourceLinkSwitches(state));
        setAhaImportOn(state.ahaImport === true);
        setJiraEnabledOn(state.jiraEnabled === true);
        setConfluenceEnabledOn(state.confluenceEnabled === true);
        setQtestLinks(state.qtestLinks === true);
        setQtestParentUrl(typeof state.qtestParentUrl === "string" ? state.qtestParentUrl : "");
        if (typeof state.codeGen === "boolean") {
          setCodeGen(state.codeGen);
        }
        setCanOpenClaudeDesktop(Boolean(state.canOpenClaudeDesktop));
        setCodeGenTarget(readCodeGenTarget(state.codeGenTarget, agentChat.applyState(state)));
        if (typeof state.deletePublished === "boolean") {
          setDeletePublished(state.deletePublished);
        }
        if (typeof state.assignments === "boolean") {
          setAssignments(state.assignments);
        }
        if (typeof state.featureFlags === "boolean") {
          setFeatureFlags(state.featureFlags);
        }
        if (typeof state.scenarioPolarity === "boolean") {
          setScenarioPolarity(state.scenarioPolarity);
        }
        if (typeof state.githubAccount === "boolean") {
          setGithubAccount(state.githubAccount);
        }
        setPlugins(Array.isArray(state.plugins) ? state.plugins : []);
        setPluginSources(Array.isArray(state.pluginSources) ? state.pluginSources : []);
        setPluginMarketplaces(Array.isArray(state.pluginMarketplaces) ? state.pluginMarketplaces : []);
        if (typeof state.googleCalendar === "boolean") {
          setGoogleCalendarOn(state.googleCalendar);
        }
        setSyncServerUrl(typeof state.syncServerUrl === "string" ? state.syncServerUrl : null);
        setCanChooseFolder(Boolean(state.canChooseFolder));
        setDemo(Boolean(state.demo));
        setReadOnly(Boolean(state.readOnly));
        setHosted(Boolean(state.hosted));
        // The demo pins Vim mode off (src/frontend/vimPref.ts): any editor open
        // when this lands drops its Vim tab, and the Settings row hides.
        setVimDemoMode(Boolean(state.demo));
        // Excalidraw goes the other way (src/frontend/excalidrawPref.ts): the
        // demo defaults it on so a visitor finds the diagram button without
        // first finding Settings. Turning it off there still sticks.
        setExcalidrawDemoMode(Boolean(state.demo));
        setAppVersion(typeof state.version === "string" ? state.version : null);
        applyUpdateAvailable(state);
        setSourceUrl(typeof state.sourceUrl === "string" ? state.sourceUrl : null);
        setGitAccess(typeof state.gitAccess === "string" ? state.gitAccess : null);
        setCliGitAvailable(Boolean(state.cliGitAvailable));
        setGh(state.gh ?? null);
        setAuth(state.auth ?? null);
        if (state.user) setUser(state.user);
        const tooNew = state.dataFormat?.ok === false;
        setOutdated(tooNew ? { minAppVersion: state.dataFormat.minAppVersion ?? null } : null);
        if (!state.needsDataRepo && !tooNew) {
          // The README rides along: a start on the bare url opens on it
          // (app-startup.md).
          await Promise.all([
            loadFeatures(),
            loadReadme(),
            // So do the plugins — the special folders' pages, the Tests tab and
            // its plans — before the deep link below, which may name one of
            // their views. The demo's modules read but never write
            // (src/server/demo.ts).
            syncClientPlugins(state.plugins, { demo: Boolean(state.demo), settings: state }),
          ]);
          setSettingsPayload(state);
          // Deep link (specs/ui/navigation.feature.md): the entry url picks the
          // view.
          await openFromLocation();
        } else if (state.codeRepoMode === true) {
          // A code repository (specs/app/code-repo-mode.feature.md): the
          // Files tab — mounted for it by the loader — and whatever installed
          // plugin still applies; the entry url opens a file or home.
          await syncClientPlugins(state.plugins, { demo: Boolean(state.demo), settings: state });
          setSettingsPayload(state);
          await openFromLocation();
        }
      } catch (e) {
        // The server answered: a plugin or deep link that failed to open is
        // logged rather than left holding the loading skeleton.
        console.error("[boot]", e);
      }
      setBootError(null);
    } finally {
      booting.current = false;
      setLoading(false);
    }
  }, [loadFeatures, loadReadme]);

  useEffect(() => {
    void boot();
  }, [boot]);

  // The account's role is the gateway's, not the worker's: ask it. A worker
  // that does not answer leaves `hosted` unknown, so a failed start asks too:
  // only the hosted gateway answers with an account.
  const askGateway = hosted || bootError !== null;
  useEffect(() => {
    if (!askGateway) return;
    let live = true;
    fetch("/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((me: { email?: unknown; role?: unknown } | null) => {
        if (!live || typeof me?.email !== "string") return;
        setHostedAccount({ email: me.email, admin: me.role === "admin" });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [askGateway]);

  const signOutHosted = () => {
    void fetch("/auth/logout", { method: "POST" }).finally(() => window.location.assign("/login"));
  };

  // Each failed try sets a fresh error, which schedules the next one.
  useEffect(() => {
    if (!bootError) return;
    const id = setTimeout(() => void boot(), BOOT_RETRY_MS);
    return () => clearTimeout(id);
  }, [bootError, boot]);

  // Show what a reload brought (crud-feature.md) — the feature list, the open
  // feature, the README and every plugin's view — without clobbering an
  // in-progress edit or conflict resolution. The cron mirror below and the
  // Sync button both run it, so a page open in the Roadmap (or any plugin
  // tab) refreshes on Sync too, not only on the next tick (issue #288).
  const refreshView = async (): Promise<void> => {
    const loads: Promise<unknown>[] = [loadFeatures()];
    // The description editor holding an edit that hasn't landed yet keeps
    // its feature as is, like the README below.
    const descPending =
      descEditRef.current !== null && descEditRef.current.text !== descSaved.current;
    // Nor while the header's feature name is being edited in place
    // (specs/ui/ui.feature.md "Main page"): re-opening the feature would
    // close the field mid-typing and drop the new name.
    if (selected && !dirty && !editing && !conflict && !descPending && renameDraft === null) {
      loads.push(openFeature(selected));
    }
    // A pulled README shows up too — unless the home editor holds an edit
    // that hasn't landed yet.
    if (!selected && !pluginViewRef.current && readmeText.current === readmeSaved.current) {
      loads.push(loadReadme());
    }
    // The plugins follow the same rule — each refreshes its own store (the
    // special folders their page lists), and what is open on screen only
    // while its editor holds nothing unsaved.
    client.emit("reload/tick", pluginViewRef.current);
    await Promise.all(loads);
  };
  const refreshViewRef = useRef(refreshView);
  refreshViewRef.current = refreshView;

  // Mirror the server's cron reload: refresh on the same cadence so pulled
  // changes show up.
  // Not for a code repository, which nothing syncs: its tree refreshes when
  // the window comes back into focus instead.
  useEffect(() => {
    if (loading || needsRepo || outdated || reloadSeconds <= 0 || codeRepoDir !== null) return;
    const id = setInterval(() => void refreshViewRef.current(), reloadSeconds * 1000);
    return () => clearInterval(id);
  }, [loading, needsRepo, outdated, reloadSeconds, codeRepoDir]);

  // Keyboard: every shortcut — the scenario cards' ↑/↓/Enter, ESC's many
  // meanings, "/" for search and the rest — is declared in one registry
  // further down (`shortcuts`) and dispatched by one listener.

  // The dialog's "Add test link" field starts empty each time it opens, with
  // no row left open for ✎ editing (specs/traceability.feature.md).
  const editingOpen = editing !== null;
  /** The scenario whose page is open — what the url and the title name. */
  const paneScenario = pageScenario(editing, feature?.scenarios);
  /** Whether the url already stands for an open scenario page. */
  const panePushed = useRef(false);
  useEffect(() => {
    setTestDraft("");
    setTestNameDraft("");
    setTestEdit(null);
    setTestNameHint(null);
    testLookup.current++;
    // The ticket-link fields open showing the scenario's link, if any.
    setLinkDraft(linkDraftOf(editing?.scenario.link));
    setQtestDraft(linkDraftOf(editing?.scenario.qtest));
  }, [editingOpen]);

  // The tree reads the open feature's scenarios from its live state, every
  // other feature's from the listing — which only refreshes on start and on
  // the reload cron. So whatever the open feature now holds goes into its
  // listing entry too, or a scenario deleted (or renamed, or added) there
  // would come back the moment another feature is opened.
  useEffect(() => {
    if (!selected || !feature) return;
    setFeatures((prev) => withOpenScenarios(prev, selected, feature));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature]);

  // Autosave measures against what the dialog opened with, so a scenario that
  // is opened and read but not edited is never re-saved
  // (specs/editor/editor-autosave.feature.md).
  useEffect(() => {
    editorSession.current += 1;
    autosaved.current = editing
      ? scenarioSignature(editing.scenario, editing.scenario.version)
      : null;
    autosaveInFlight.current = null;
    // The delete that closed the dialog may still be in flight, but with no
    // dialog open there is no tick for the flag to hold back.
    deletingScenario.current = false;
  }, [editingOpen]);

  // A scenario deep link honored above left its scenario here: open its page
  // now that the feature it belongs to is on screen
  // (specs/ui/navigation.feature.md "open a scenario link"). By identity, like
  // every other card lookup — the link resolved against the same feature, so it
  // is still there.
  useEffect(() => {
    if (!paneRequest) return;
    setPaneRequest(null);
    if (!feature) return;
    const idx = cardOfScenario(feature.scenarios, paneRequest.scenario);
    if (idx !== null) {
      setEditing({ index: idx, scenario: { ...feature.scenarios[idx]! } });
      setSearchTerms(paneRequest.terms);
    }
  }, [paneRequest, feature]);

  // The tree follows the open feature (specs/ui/navigation.feature.md "the
  // tree follows the open feature"): whatever opened it — a search hit, a
  // link, a card, the palette — the folders above it open, a scenario pane
  // expands its feature's outline, and the highlighted row is scrolled into
  // view. The scroll itself waits for the next commit (the effect below),
  // since the row it wants may not be rendered yet.
  const paneKey = paneScenario ? `${paneScenario.name}@v${paneScenario.version}` : null;
  useEffect(() => {
    if (!selected) return;
    revealPending.current = true;
    setCollapsed((prev) => revealed(prev, selected));
    if (paneKey !== null)
      setOutlined((prev) => {
        if (prev.has(selected)) return prev;
        return new Set(prev).add(selected);
      });
  }, [selected, paneKey]);

  // After every commit: the pending reveal scrolls the tree's highlighted
  // row — the open scenario's while a pane is open, else the feature's —
  // into view, and is done once it found it. A listing still loading, a
  // folder still opening or an outline still expanding leaves it pending for
  // the next commit; a pane must wait for its own row, since the feature's is
  // there a commit earlier and the scenario's may sit below the fold.
  useEffect(() => {
    if (!revealPending.current) return;
    const tree = treeRef.current;
    if (!tree) return;
    const row = tree.querySelector<HTMLElement>(
      paneKey !== null ? "a.tree-scenario.active" : "a.tree-feature.active",
    );
    if (!row) return;
    revealPending.current = false;
    row.scrollIntoView({ block: "nearest" });
  });

  // The marks belong to the pane the hit opened: closing it takes them along,
  // so the scenario reopened from its card shows plain text. Not while a pane
  // request is pending — opening a hit closes the previous pane first, and
  // the request above is what carries the new terms in.
  useEffect(() => {
    if (editing === null && paneRequest === null) setSearchTerms(null);
  }, [editing === null, paneRequest]);

  // A "Save was blocked" message stops applying the moment the tests widgets
  // change — typing, adding, or opening/closing an ✎ row.
  useEffect(() => {
    setTestsError(null);
  }, [editingOpen, testDraft, testNameDraft, testEditDraft, testEdit]);

  useEffect(() => {
    setLinkError(null);
  }, [editingOpen, linkDraft]);

  useEffect(() => {
    setQtestError(null);
  }, [editingOpen, qtestDraft]);

  const featureLinkOpen = featureTicketsOpen;
  const featureQtestOpen = featureQtestDraft !== null;
  // ESC (specs/ui/ui.feature.md "Dialogs", specs/editor/spec-editor.feature.md
  // "Spec editor pane", specs/ui/folders.feature.md): one key, closing whatever
  // is on top — see `closeTopmost` in the shortcut registry below. The menus
  // (src/frontend/Menu.tsx) take their own ESC and outside clicks.

  // specs/ui/ui.feature.md "Dialogs": Tab stays inside the foreground dialog.
  // The editor pane is part of the page, not a dialog — Tab reaches the sidebar
  // from it (specs/editor/spec-editor.feature.md "Spec editor pane").
  const userInfoTrapRef = useFocusTrap(userInfoOpen);
  const settingsFileTrapRef = useFocusTrap(settingsFileOpen);
  const tokenSignInTrapRef = useFocusTrap(tokenSignInOpen);
  const confluenceTrapRef = useFocusTrap(confluencePublishOpen);
  const confluenceFolderTrapRef = useFocusTrap(confluenceFolder !== null);
  const qtestTrapRef = useFocusTrap(qtestPublishOpen);
  const wikiQtestTrapRef = useFocusTrap(wikiQtestPublishOpen);
  const ahaTrapRef = useFocusTrap(ahaImportOpen !== null);
  const openSpecTrapRef = useFocusTrap(openSpecImportOpen !== null);
  const importTrapRef = useFocusTrap(importOpen !== null);
  const foldersTrapRef = useFocusTrap(foldersOpen);
  const switchTrapRef = useFocusTrap(switching !== null);
  const conflictTrapRef = useFocusTrap(conflict !== null);
  const sessionErrorTrapRef = useFocusTrap(sessionError !== null);

  // Also re-run when the editor pane gives the feature page back: the cards
  // mount afresh, so the highlighted one is scrolled to even if the highlight
  // itself did not move (specs/editor/spec-editor.feature.md "Spec editor
  // pane").
  useEffect(() => {
    if (selectedScenario !== null)
      scenarioRefs.current[selectedScenario]?.scrollIntoView({ block: "nearest" });
  }, [selectedScenario, editingOpen]);

  // Canonical url (specs/ui/navigation.feature.md "Resolution rules"): the
  // address bar shows the page that is open — the scenario page's own url while
  // it is open, the feature's otherwise. A plugin's view — an open roadmap page
  // or task among them (specs/app/tasks.feature.md "Support deep link just like
  // Features") — owns its own url. Opening a scenario page pushes, like a
  // feature switch does in openFeature, so Back leaves it the way `<` does.
  // Everything else rewrites in place: a rename moving an open page's url must
  // not leave the retired url behind for Back to land on.
  useEffect(() => {
    if (loading || needsRepo) return;
    // A plugin's view owns its url (openPluginView pushes it), and so does
    // an app page; with no feature selected this effect would otherwise
    // rewrite it to `/`.
    if (pluginView || appPage) return;
    const url = pagePath(selected, paneScenario);
    const opening = paneScenario !== null && !panePushed.current;
    panePushed.current = paneScenario !== null;
    if (location.pathname === url) return;
    // A page opened by a deep link is already standing on a scenario url:
    // canonicalizing it (a versionless link resolving to `/v<N>`) rewrites in
    // place, or Back would land on the link again and re-open the page.
    const fromLink = parseRoute(location.pathname).scenario !== undefined;
    if (opening && !fromLink) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }, [loading, needsRepo, selected, paneScenario, pluginView, appPage]);

  // A code repository's pane is the Files tab's (specs/app/code-repo-mode
  // .feature.md): leaving an app page, or a view that went away, lands on
  // its home rather than on a README editor the repository has no data for.
  useEffect(() => {
    if (loading || needsRepo || codeRepoDir === null || pluginView || appPage) return;
    openPluginView(FILES_TAB, FILES_HOME);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, needsRepo, codeRepoDir, pluginView, appPage, pluginTabs]);

  // Window title follows what is open (specs/ui/navigation.feature.md) — chat
  // and email link previews show it.
  const clock = titlePrefix(pom.timer, pom.now);
  useEffect(() => {
    const s = paneScenario ?? undefined;
    const name = feature && selected ? feature.name || titleFromFileName(selected) : "";
    // A plugin's view — an open roadmap page or task, say — names the window
    // the way a feature does, so a shared link previews as that page
    // (specs/app/tasks.feature.md).
    const base = appPage
      ? `SpecDriven — ${appPage === "settings" ? "Settings" : appPage === "project-settings" ? "Project settings" : appPage === "plugins" ? "Plugins" : appPage === "data" ? "Data" : appPage === "images" ? "Images" : appPage === "whats-new" ? "What's new" : appPage === "updates" ? "Updates" : "Observability"}`
      : pluginView && activeTab
      ? `SpecDriven — ${activeTab.route.title(pluginView.view)}`
      : !selected || !feature
        ? "SpecDriven"
        : s
          ? `SpecDriven — ${name} · ${s.name} v${s.version}`
          : `SpecDriven — ${name}`;
    // A running pomodoro puts its clock first, so the tab shows the time
    // left while the person works elsewhere. This effect is the title's
    // only writer.
    document.title = clock ? `${clock} · ${base}` : base;
  }, [selected, feature, paneScenario, pluginView, appPage, activeTab, tabsTick, clock]);

  // PUT a picked data folder. A path that names no folder is refused by the
  // server (specs/app/spec-folders.feature.md): ask before making it, then
  // ask again with the user's go-ahead. `asking` brackets the question, so a
  // switch can step its modal aside while the confirm is up.
  const putDataRepo = async (
    repo: string,
    asking?: (open: boolean) => void,
  ): Promise<{ res: Response; state: any } | null> => {
    const put = async (create: boolean) => {
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(create ? { dataRepo: repo, createDataRepo: true } : { dataRepo: repo }),
      });
      return { res, state: await res.json() };
    };
    const first = await put(false);
    if (first.res.ok || !first.state.missing) return first;
    asking?.(true);
    const ok = await confirm({
      title: "Create folder?",
      body: `There is no folder at ${first.state.path ?? repo}. Create it as a new, empty spec folder?`,
      confirmLabel: "Create folder",
      danger: false,
    });
    asking?.(false);
    return ok ? put(true) : null;
  };

  const saveRepo = async (repo: string) => {
    // Capture the entry url now: once needsRepo flips, the canonical-url
    // effect would rewrite a deep link before we get to honor it
    // (specs/ui/navigation.feature.md "deep link before a data repo is
    // configured").
    const entryPath = location.pathname;
    const entryLink = isLinkEntry(location.search);
    setSettingRepo(true);
    setRepoError(null);
    try {
      const put = await putDataRepo(repo);
      if (!put) return;
      const { res, state } = put;
      if (res.ok) {
        applyRepos(state);
        setNeedsRepo(false);
        // A folder a newer app wrote opens on the update screen instead.
        if (state.dataFormat?.ok === false) {
          setOutdated({ minAppVersion: state.dataFormat.minAppVersion ?? null });
          return;
        }
        // A freshly picked folder opens on its README, like a start does
        // (app-startup.md "A newly picked data folder opens on
        // its README") — unless there is a deep link to honor. The plugins —
        // the special folders' pages among them — ride along, as they do on a
        // start with a folder already configured (specs/app/roadmap.feature.md).
        // Each folder keeps its own plugins (specs/app/plugins.feature.md),
        // so Settings → Plugins lists this one's.
        setPlugins(Array.isArray(state.plugins) ? state.plugins : []);
        await Promise.all([
          loadFeatures(),
          loadReadme(),
          syncClientPlugins(state.plugins, { demo: Boolean(state.demo), settings: state }),
        ]);
        setSettingsPayload(state);
        await openFromLocation(entryPath, entryLink);
      } else {
        setRepoError(state.error ?? "Could not use this repo");
      }
    } finally {
      setSettingRepo(false);
    }
  };

  // Native OS folder chooser (specs/ui/app-start.feature.md): the server (or
  // the desktop shell) owns the dialog; null means canceled or unavailable.
  const chooseFolderNative = async (
    purpose: "data-repo" | "code-repo" = "data-repo",
  ): Promise<string | null> => {
    const res = await fetch("/api/choose-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purpose }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.path ?? null;
  };

  // First-run form (specs/ui/app-start.feature.md): the picker fills the path
  // field; the user still confirms with the submit button.
  const browseIntoRepoInput = async (purpose: "data-repo" | "code-repo" = "data-repo") => {
    const picked = await chooseFolderNative(purpose);
    if (picked && repoInputRef.current) repoInputRef.current.value = picked;
  };

  // Open another data folder — Manage folders → "Open another folder…"
  // (specs/ui/app-start.feature.md "changing the data repo"): pre-filled prompt; on success the view resets
  // to home, since the current selection belonged to the old repo.
  const changeRepo = async () => {
    const input = await prompt({
      title: "Data directory",
      hint: "Path or GitHub url of the spec data repo.",
      initial: dataRepo ?? "",
      confirmLabel: "Use this directory",
      browse: canChooseFolder ? () => chooseFolderNative() : undefined,
    });
    await switchRepo(input?.trim() ?? "");
  };

  /**
   * Land what every editor holds in the folder it was typed in, before the
   * open folder changes — a spec folder's or a code repository's.
   */
  const landEditors = async () => {
    // A README edit belongs to the repo it was typed in: land it there before
    // the switch, and empty the editor so no tick writes it into the new one.
    // Await the queue after the tick — a boolean in-flight flag would make
    // the tick a no-op while a PUT is already away, and that PUT would then
    // land in the folder that comes next (the server re-reads dataRepo per
    // request). The same for an open scenario editor.
    await readmeTick.current();
    await readmeSaveQueue.current.idle();
    readmeText.current = null;
    setReadme(null);
    await editorRef.current.close();
    await scenarioSaveQueue.current.idle();
    // So does whatever a plugin's view holds — an open roadmap page, an
    // Event Model's canvas, a code repository's file, say:
    // its last save goes out there, and the plugin seals the view on its way
    // out. The unmount below lands in a later React commit that nothing here
    // awaits, so the seal — not the ordering — is what keeps its parting save
    // from writing into the new folder.
    await client.serial("data/leaving");
    // A feature description belongs to the folder it was typed in too. Its
    // own cleanup tick would only run once the selection empties below —
    // after the switch — and the server resolves the data folder per request,
    // so that late PUT would write these words into the folder that comes
    // next. Land it here, awaited, and empty the editor so no later tick can.
    await descTick.current();
    await descSaveQueue.current.idle();
    setDescEdit(null);
  };

  // Switch to another data dir — typed into the prompt above or picked from
  // the recent folder list (specs/ui/ui.feature.md "Recent folder list"), or
  // named by a link (`specdriven://<folder>/...`), which then opens `entryPath`
  // in it rather than its README.
  const switchRepo = async (next: string, entryPath?: string) => {
    if (!next || next === reposRef.current.open) return;
    setSettingRepo(true);
    // The switch is modal (specs/app/spec-folders.feature.md "Switch spec
    // folder"): the dialog names the folder and the step, and everything
    // else waits until it comes down in the finally below.
    setSwitching({ folder: next, step: "saving" });
    await landEditors();
    try {
      setSwitching({ folder: next, step: "opening" });
      const put = await putDataRepo(next, (asking) =>
        setSwitching(asking ? null : { folder: next, step: "opening" }),
      );
      // Declined to create a missing folder: the current one stays open.
      if (!put) {
        await loadReadme();
        return;
      }
      const { res, state } = put;
      if (res.ok) {
        setSwitching({ folder: next, step: "loading" });
        applyRepos(state);
        setSelected(null);
        setFeature(null);
        setSelectedScenario(null);
        // The old folder's plugin views — its pages among them — are not
        // this folder's; the plugins reload their stores below, on the
        // data/changed event.
        setPluginView(null);
        setAppPage(null);
        // Nor its entity fields: the next editor to open reads the new
        // folder's code repo.
        entityFields.reset();
        // A page url from the old folder would only miss in the new one, and
        // nothing else resets it — the selection was already empty while a
        // page was open, so the canonical-url effect has no change to react
        // to.
        if (location.pathname !== "/") history.replaceState(null, "", "/");
        // The new folder's own plugins (specs/app/plugins.feature.md "Each
        // data folder keeps its own plugins"), on Settings → Plugins too.
        setPlugins(Array.isArray(state.plugins) ? state.plugins : []);
        // Home is the new folder's README (app-startup.md).
        await Promise.all([
          loadFeatures(),
          loadReadme(),
          syncClientPlugins(state.plugins, { demo: Boolean(state.demo), settings: state }).then(() => {
            setSettingsPayload(state);
            return client.serial("data/changed");
          }),
        ]);
        if (entryPath && entryPath !== "/") {
          history.replaceState(null, "", entryPath);
          // Already read off the link: a folder named like its first segment
          // must not take it a second time.
          // The server pulled the folder before it answered; a pull that
          // failed rides along, for the note a missing page leaves.
          await openFromLocationRef.current(entryPath, false, pullProblemOf(state));
        }
      } else {
        toast.error(state.error ?? "Could not use this directory");
        // The README was emptied for the switch; the folder stays, so it
        // comes back.
        await loadReadme();
      }
    } finally {
      setSwitching(null);
      setSettingRepo(false);
    }
  };

  /**
   * Open a code repository directly (specs/app/code-repo-mode.feature.md
   * "Open a code repository"): from the first-run screen, the folder dialog
   * or the palette. What the editors hold lands first; then the Files tab
   * takes the place of the specs, and the app opens on the repository's
   * home. False when the server refused — the reason is shown.
   */
  const openCodeRepo = async (dir: string): Promise<boolean> => {
    const next = dir.trim();
    if (!next) return false;
    if (next === codeRepoRef.current) {
      goHome();
      return true;
    }
    const first = needsRepo;
    setSettingRepo(true);
    setRepoError(null);
    if (!first) setSwitching({ folder: next, step: "saving" });
    try {
      if (!first) {
        await landEditors();
        setSwitching({ folder: next, step: "opening" });
      }
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openCodeRepo: next }),
      });
      const state = await res.json();
      if (!res.ok) {
        const error = state.error ?? "Could not open this folder";
        if (first) setRepoError(error);
        else {
          toast.error(error);
          // The README was emptied to leave; the folder stays, so it comes back.
          await loadReadme();
        }
        return false;
      }
      if (!first) setSwitching({ folder: next, step: "loading" });
      applyRepos(state);
      setNeedsRepo(false);
      setSelected(null);
      setFeature(null);
      setSelectedScenario(null);
      setPluginView(null);
      setAppPage(null);
      setFeatures([]);
      setLoadError(null);
      entityFields.reset();
      if (location.pathname !== "/") history.replaceState(null, "", "/");
      setPlugins(Array.isArray(state.plugins) ? state.plugins : []);
      await syncClientPlugins(state.plugins, { demo: Boolean(state.demo), settings: state });
      setSettingsPayload(state);
      await client.serial("data/changed");
      await openFromLocationRef.current("/", false);
      return true;
    } finally {
      setSwitching(null);
      setSettingRepo(false);
    }
  };

  /** Ask for a code repository's folder (typed, or with Browse…), then open it. */
  const openCodeRepoPrompt = async () => {
    const input = await prompt({
      title: "Open a code repository",
      hint: "The folder of a code repository on this computer. The app shows its files and runs the coding agent there; git stays yours.",
      initial: codeRepoDir ?? "",
      placeholder: "/path/to/your/code",
      confirmLabel: "Open",
      browse: canChooseFolder ? () => chooseFolderNative("code-repo") : undefined,
    });
    if (input?.trim()) await openCodeRepo(input.trim());
  };

  /** Take a code repository off the folder dialog's list — the folder stays on disk. */
  const forgetCodeRepo = async (repo: string) => {
    setSettingRepo(true);
    try {
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forgetCodeRepo: repo }),
      });
      const state = await res.json();
      if (res.ok) setRecentFolders(parseRecentFolders(state.recentFolders));
      else toast.error(state.error ?? "Could not remove this folder");
    } finally {
      setSettingRepo(false);
    }
  };

  // Manage specification folders (specs/app/spec-folders.feature.md): take a
  // folder off the list. The server keeps the open folder on it, so the
  // dialog never offers to remove that one.
  const forgetRepo = async (repo: string) => {
    setSettingRepo(true);
    try {
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forgetDataRepo: repo }),
      });
      const state = await res.json();
      if (res.ok) applyRepos({
          dataRepo: reposRef.current.open,
          recentDataRepos: state.recentDataRepos,
          recentDataRepoDirs: state.recentDataRepoDirs,
          recentFolders: state.recentFolders,
        });
      else toast.error(state.error ?? "Could not remove this folder");
    } finally {
      setSettingRepo(false);
    }
  };

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
      if (file !== selected) selectSidebarTab("specs");
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
   * Home — the data folder's README editor (app-startup.md
   * "The data folder name links to the README"). Drops the feature selection
   * and pushes `/`, so Back returns to the feature that was open. The README
   * editor's own unmount tick saves anything typed there, and an open
   * scenario editor leaves the way `<` does — its last save goes out before
   * the selection drops (specs/editor/spec-editor.feature.md "Spec editor
   * pane").
   */
  const goHome = () => {
    // A code repository's home is the Files tab's (its README.md, if any).
    if (codeRepoRef.current && openPluginView(FILES_TAB, FILES_HOME, { push: true })) return;
    editorRef.current.close();
    setPluginView(null);
    setAppPage(null);
    setSelectedFolder(null);
    setSelected(null);
    setFeature(null);
    setSelectedScenario(null);
    if (location.pathname !== "/") history.pushState(null, "", "/");
  };

  /**
   * Open a view of a plugin's tab (specs/app/plugins.feature.md) — the Tests
   * tab, say. The pane is the module's alone, so the feature and the page
   * leave — saving what their editors hold, the way goHome does — and the
   * sidebar turns to that tab. The view owns its url from here on; the tab
   * says what the url is. A view that names no one thing — `/models` — opens
   * the one the tab resolves it to; false when there is nothing to open.
   */
  const openPluginView = (tab: string, view: unknown, opts: { push?: boolean } = {}): boolean => {
    const owner = tabs.get(tab);
    if (!owner) return false;
    const resolved = owner.route.resolve ? owner.route.resolve(view) : view;
    if (resolved === null) return false;
    view = resolved;
    editorRef.current.close();
    setSelected(null);
    setFeature(null);
    setSelectedScenario(null);
    setSelectedFolder(null);
    selectSidebarTab(tab);
    setAppPage(null);
    setPluginView({ tab, view });
    // A url that is not the view's own (`/models` opening the first model)
    // canonicalises in place, so a reload reopens the same view.
    const path = owner.route.path(view);
    if (location.pathname !== path) {
      if (opts.push) history.pushState(null, "", path);
      else history.replaceState(null, "", path);
    }
    return true;
  };
  /** A tab's navigate callback, bound to its id. */
  const navigateIn = (tab: string) => (view: unknown, opts?: { push?: boolean }) =>
    openPluginView(tab, view, opts);

  /**
   * Open Settings or Plugins in the editor pane (specs/user-info-settings.
   * feature.md "open Settings", "open Plugins") — a page, not a dialog, so
   * it has the pane's room. What was open leaves the way it does for a
   * plugin's view, saving what its editor holds, and the page takes its own
   * url. Going from one app page to the other rewrites the url in place, so
   * closing either returns to what was open before both.
   */
  const openAppPage = (page: AppPage, opts: { push?: boolean } = { push: true }) => {
    editorRef.current.close();
    setPluginView(null);
    setSelected(null);
    setFeature(null);
    setSelectedScenario(null);
    setSelectedFolder(null);
    setDrawerOpen(false);
    setSettingsError(null);
    const path = appPagePath(page);
    if (location.pathname !== path) {
      if (opts.push && !appPage) {
        history.pushState(null, "", path);
        appPagePushed.current = true;
      } else {
        history.replaceState(null, "", path);
      }
    }
    setAppPage(page);
  };
  const openSettings = () => openAppPage("settings");
  /** Project settings (src/frontend/ProjectSettingsPage.tsx): the data repo's project-settings.json. */
  const openProjectSettings = () => openAppPage("project-settings");
  // Bumped to make an open Project settings page read the file afresh — a
  // clone started from outside it shows on its row.
  const [projectSettingsKey, setProjectSettingsKey] = useState(0);

  // A code repo that is not on this computer is offered for cloning when its
  // data folder opens (specs/app/project-settings.feature.md): once per
  // folder per run, one prompt per missing repo, the default first, with
  // the url the server suggests filled in. A clone that starts opens
  // Project settings, whose row shows it running until the folder is there.
  const cloneOffered = useRef(new Set<string>());
  const offerClonesRef = useRef<() => Promise<void>>(async () => {});
  offerClonesRef.current = async () => {
    const res = await fetch("/api/project-settings").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json().catch(() => null)) as Parameters<typeof codeReposToOffer>[0] | null;
    if (!data?.codeRepos) return;
    let show = false;
    for (const repo of codeReposToOffer(data)) {
      const result = await askToCloneCodeRepo(prompt, repo, {
        intro: `The project's ${repo.isDefault ? "default " : ""}code repository is not on this computer.`,
      });
      if (!result) continue;
      if ("data" in result) show = true;
      else if (
        await confirm({ title: "Could not clone", body: result.error, confirmLabel: "Open Project settings", danger: false })
      ) {
        show = true;
      }
    }
    if (!show) return;
    setProjectSettingsKey((k) => k + 1);
    openAppPage("project-settings");
  };
  useEffect(() => {
    if (!dataDir || loading || needsRepo || outdated || demo || readOnly || hosted || modalOpen) return;
    if (cloneOffered.current.has(dataDir)) return;
    cloneOffered.current.add(dataDir);
    void offerClonesRef.current();
  }, [dataDir, loading, needsRepo, outdated, demo, readOnly, hosted, modalOpen]);
  /** Settings, scrolled to one section (`settings-<id>`) once the page has drawn it. */
  const openSettingsAt = (sectionId: string) => {
    openAppPage("settings");
    let tries = 0;
    const scroll = () => {
      const el = document.getElementById(sectionId);
      if (el) el.scrollIntoView({ block: "start" });
      else if (++tries < 40) setTimeout(scroll, 25);
    };
    setTimeout(scroll, 0);
  };
  // A push that fails is shown (git-operations.md "a push that fails is
  // shown, and tried again"): the server's ticks commit an edit and then
  // cannot push it, which nothing on the page used to say — the edits piled
  // up on this computer while every editor promised the next sync would
  // push them. The toast appears once per reason, not once per tick, stays
  // until dismissed, and leaves on its own when a push goes through; the
  // Sync button keeps saying so for as long as it is true.
  const syncProblem = useSyncProblem();
  const syncProblemToast = useRef<number | null>(null);
  const announceSyncProblem = (reason: string) => {
    if (syncProblemToast.current !== null) toast.dismiss(syncProblemToast.current);
    // A credential problem is fixed in Settings; the hosted app's token
    // lives on the account page instead, which the message itself names.
    const settingsFixIt = !hosted && /authentication required|sign in with GitHub/i.test(reason);
    syncProblemToast.current = toast.error(
      syncProblemMessage(reason),
      settingsFixIt ? { action: { label: "Open Settings", run: () => openSettingsAt("settings-git") } } : undefined,
    );
  };
  const announceSyncProblemRef = useRef(announceSyncProblem);
  announceSyncProblemRef.current = announceSyncProblem;
  useEffect(() => {
    if (syncProblem !== null) {
      announceSyncProblemRef.current(syncProblem);
      return;
    }
    if (syncProblemToast.current === null) return;
    toast.dismiss(syncProblemToast.current);
    syncProblemToast.current = null;
    toast.success("Saved changes pushed");
  }, [syncProblem]);
  const openPlugins = () => openAppPage("plugins");
  /** A marketplace plugin the Plugins page opens scrolled to, when the agent pane sent the user there. */
  const [pluginsWanted, setPluginsWanted] = useState<string | null>(null);
  /** The component the Observability page opens narrowed to, when a dialog sent the user there. */
  const [observabilityComponent, setObservabilityComponent] = useState("");
  const openObservability = (component = "") => {
    setObservabilityComponent(component);
    openAppPage("observability");
  };
  /** Data (src/frontend/DataPage.tsx): the Automerge store, browsed read-only. */
  const openData = () => openAppPage("data");
  /** Images (src/frontend/ImagesPage.tsx): the stored images, the unreferenced ones to delete. */
  const openImages = () => openAppPage("images");
  /** What's new (src/frontend/WhatsNewPage.tsx): the release notes, newest first. */
  const openWhatsNew = () => openAppPage("whats-new");
  /** The running version's notes not opened yet in this browser. */
  const [notesUnseen, setNotesUnseen] = useState(false);
  useEffect(() => {
    setNotesUnseen(hasUnseenNotes(appVersion));
  }, [appVersion]);
  // However the page opens — the menu, a link, Back — its notes count as seen.
  useEffect(() => {
    if (appPage !== "whats-new" || !appVersion) return;
    markNotesSeen(appVersion);
    setNotesUnseen(false);
  }, [appPage, appVersion]);
  /** Updates (src/frontend/UpdatesPage.tsx): Check for Updates…, and the desktop app updating itself. */
  const openUpdates = () => openAppPage("updates");
  // The version chip opens it where the app can replace itself: the desktop
  // app, not the demo or a hosted copy, which never change.
  const canUpdate = canCheckForUpdates && !demo && !hosted;
  // The server starts its daily check on the boot-time state fetch and
  // answers without waiting for it, so the desktop app reads the state again
  // a moment later: the dot shows within a second of boot, not at the next
  // routine refresh — and twice more, for a releases page slow to answer.
  // Only where a check runs at all.
  useEffect(() => {
    if (loading || !canCheckForUpdates || demo || hosted) return;
    let cancelled = false;
    const timers = UPDATE_FOLLOW_UP_MS.map((ms) =>
      setTimeout(() => {
        void fetch("/api/state")
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => !cancelled && data && applyUpdateAvailable(data))
          .catch(() => {});
      }, ms),
    );
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [loading, canCheckForUpdates, demo, hosted]);
  /** ✕ or ESC: back to what was open, or home after a deep link. */
  const closeAppPage = () => {
    if (appPagePushed.current) {
      appPagePushed.current = false;
      history.back();
    } else {
      goHome();
    }
  };

  // A plugin switched off takes its open view with it: the pane leaves and
  // the app goes home (specs/app/plugins.feature.md "Turning a plugin off
  // unwinds everything it registered").
  useEffect(() => {
    // A tab being remounted — its plugin was rebuilt — is back in a moment.
    if (pluginView && !pluginTabs.some((t) => t.id === pluginView.tab) && !isRemounting(pluginView.tab)) {
      goHome();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginTabs]);

  /**
   * Re-read the plugins from the server — a plugin from a folder was
   * rebuilt, or a folder came or went (specs/app/plugins.feature.md "A
   * plugin loads from a local folder"): the browser half remounts from its
   * new url, without a reload.
   */
  const refreshPlugins = useCallback(async () => {
    const res = await fetch("/api/state");
    if (!res.ok) return;
    const data = await res.json();
    applyUpdateAvailable(data);
    setPlugins(Array.isArray(data.plugins) ? data.plugins : []);
    setPluginSources(Array.isArray(data.pluginSources) ? data.pluginSources : []);
    setPluginMarketplaces(Array.isArray(data.pluginMarketplaces) ? data.pluginMarketplaces : []);
    // An agent plugin installed, updated or rebuilt arrives here, not through
    // a Settings change: without this the pane button stayed hidden until a
    // reload.
    agentChat.applyState(data);
    await syncClientPlugins(data.plugins, { demo: Boolean(data.demo), settings: data });
    setSettingsPayload(data);
    client.emit("settings/changed", data);
  }, []);
  useEffect(() => {
    if (loading || demo) return;
    // A change is also an agent's sign-in moving on: its models and the
    // pane header's account chip are asked for again.
    return watchPluginChanges(() => {
      void refreshPlugins();
      void agentChat.reloadChoices();
    });
  }, [loading, demo, refreshPlugins]);

  /**
   * Derive the view from a url (initial load, popstate, after repo setup).
   * `link` says the path came from outside the window (src/electron/main.ts
   * flags it, route.ts LINK_PARAM): only then may it name a spec folder.
   */
  const openFromLocation = async (
    pathname = location.pathname,
    link = isLinkEntry(location.search),
    // Why the pull behind a link brought nothing in — the folder switch a
    // link asked for hands its own here; a link into the open folder finds
    // out below.
    pullProblem: string | null = null,
  ): Promise<void> => {
    // A link from outside names its spec folder first
    // (`specdriven://specs-insurance/tasks/ship`): the window's url drops it
    // — the folder on screen is the app's state, not the url's — and a
    // folder other than the open one is switched to, which then opens the
    // rest of the path there. The window's own url — a reload, Back — never
    // names a folder, so a folder called "features" or "tasks" can't take
    // its first segment there.
    if (link) {
      // Drop the flag too, so Back to this entry is not a link again.
      history.replaceState(history.state, "", pathname);
      const { open, recent } = reposRef.current;
      const linked = splitRepoPath(pathname, open ? [open, ...recent] : recent, routesSomewhere);
      if (linked.repo) {
        pathname = linked.path;
        history.replaceState(history.state, "", pathname);
        if (linked.repo !== open) {
          await switchRepo(linked.repo, pathname);
          return;
        }
      } else if (!routesSomewhere(pathname)) {
        // Not a path the app knows, but one once its first segment is gone: a
        // link to a folder this machine has never opened.
        const [first, ...rest] = pathname.split("/").filter(Boolean);
        if (first && rest.length > 0 && routesSomewhere(`/${rest.join("/")}`)) {
          toast.error(
            `This link is for the spec folder “${decodeSegment(first)}”, which isn't in your folder list. Open that folder, then follow the link again.`,
          );
          pathname = "/";
          history.replaceState(history.state, "", pathname);
        }
      }
      // A link opens on synced data (specs/ui/navigation.feature.md "a link
      // opens on synced data"): the open folder is pulled before the link is
      // resolved, so what a teammate just made is there to open — the next
      // reload tick would be too late. (A switch above pulled on the server.)
      // A code repository is never pulled (code-repo-mode.feature.md).
      if (pathname !== "/" && !codeRepoRef.current) {
        pullProblem = await syncForLink();
        // What the pull brought shows the way a tick's does — the tree, and
        // each plugin's store, which a link to one of its pages reads.
        await refreshViewRef.current();
      }
    }
    const route = parseRoute(pathname);
    // The app's own pages first, so no plugin can claim their urls.
    const page = matchAppPage(pathname);
    if (page) {
      openAppPage(page, { push: false });
      return;
    }
    // Back out of an app page: the entry it pushed is gone.
    appPagePushed.current = false;
    setAppPage(null);
    // A plugin's url first (specs/app/plugins.feature.md "Plugin urls serve
    // the app shell"): the mounted tabs each know their own. With the plugin
    // off nothing matches, and the url reads as home below.
    const pluginHit = matchPluginRoute(pathname);
    if (pluginHit) {
      // A tab with nothing to open — an empty models folder — goes home.
      if (!openPluginView(pluginHit.tab.id, pluginHit.view)) goHome();
    } else if (route.feature) {
      // A scenario url is a link to that scenario's page — the card's "Copy
      // link" makes one — so it opens the pane, not just the card
      // (specs/ui/navigation.feature.md "open a scenario link").
      await openFeature(route.feature, { scenario: route.scenario ?? null, pane: true, pullProblem });
    } else {
      // Back to home while the editor pane is open: it leaves the way `<`
      // does (specs/editor/spec-editor.feature.md "Spec editor pane").
      editorRef.current.close();
      setPluginView(null);
      setSelected(null);
      setFeature(null);
      setSelectedScenario(null);
    }
  };

  // Back/forward (specs/ui/navigation.feature.md "browser history and reload"):
  // re-derive the view from the url. The ref keeps the handler current
  // without re-registering listeners on every state change.
  const openFromLocationRef = useRef(openFromLocation);
  openFromLocationRef.current = openFromLocation;
  useEffect(() => {
    const onPop = () => void openFromLocationRef.current();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // With a folder selected, the new feature is created inside it — the same
  // insertion point "+ New folder" uses; `folder/name` nests further below
  // it (specs/ui/folders.feature.md).
  const createFeature = () => createFeatureIn(selectedFolder);
  /** `parent` is a repo-relative folder path, or null for the top level. */
  const createFeatureIn = async (parent: string | null) => {
    const input = await prompt({
      title: parent ? `New feature in "${parent}"` : "New feature",
      hint: parent ? undefined : "Use folder/name to create inside a folder.",
      placeholder: parent ? "Basic Quote" : "billing/Basic Quote",
      confirmLabel: "Create feature",
    });
    if (!input) return;
    const name = cleanSegments(input);
    const res = await fetch("/api/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: parent ? `${parent}/${name}` : name }),
    });
    const data = await res.json();
    if (res.ok) {
      // Reveal the new feature: a selected folder may be collapsed, since
      // clicking one both selects it and toggles its subtree.
      if (parent) setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parent);
        return next;
      });
      await loadFeatures();
      // A new feature opens on its description editor (specs/editor/feature-
      // editor.feature.md "Edit feature descrition").
      await openFeature(data.fileName, { push: true, editDescription: true });
    } else {
      toast.error(data.error ?? "Could not create the feature");
    }
  };

  /** A scenario's identity within its file: the `<name>@v<version>` heading
      syntax, used as both a publish-progress and a selection key. Declared
      before the selection helpers that call it during render. */
  const scenarioKey = (s: { name: string; version: number }) => `${s.name}@v${s.version}`;

  // The spec's own checkbox: none or some scenarios → the whole spec;
  // the whole spec → cleared.
  const toggleSpecSelected = (fileName: string) =>
    setSpecSelection((prev) => {
      const next = new Map(prev);
      if (next.get(fileName) === "all") next.delete(fileName);
      else next.set(fileName, "all");
      return next;
    });

  // A scenario's checkbox on its card: unchecking one of a whole-spec
  // selection keeps the rest; checking the last missing one promotes back to
  // the whole spec. `all` is every scenario the file has, so "the whole
  // spec" and "all of its scenarios" stay the same selection.
  const toggleScenarioSelected = (
    fileName: string,
    all: { name: string; version: number }[],
    key: string,
  ) =>
    setSpecSelection((prev) => {
      const next = new Map(prev);
      const entry = next.get(fileName);
      const picked = new Set(entry === "all" ? all.map(scenarioKey) : (entry ?? []));
      if (picked.has(key)) picked.delete(key);
      else picked.add(key);
      if (picked.size === 0) next.delete(fileName);
      else if (all.every((s) => picked.has(scenarioKey(s)))) next.set(fileName, "all");
      else next.set(fileName, picked);
      return next;
    });

  /** True when this scenario is in the session selection. */
  const scenarioSelected = (fileName: string, s: { name: string; version: number }) => {
    const entry = specSelection.get(fileName);
    return entry === "all" || (entry instanceof Set && entry.has(scenarioKey(s)));
  };

  // What the current selection sends to a session. Selections can outlive
  // the list (a checked spec deleted elsewhere, a scenario replaced by a new
  // version) — only specs and scenarios still listed go in.
  const sessionFiles = (): { fileName: string; scenarios?: ScenarioPick[] }[] => {
    const files: { fileName: string; scenarios?: ScenarioPick[] }[] = [];
    for (const f of features) {
      const entry = specSelection.get(f.fileName);
      if (entry === undefined) continue;
      if (entry === "all") {
        files.push({ fileName: f.fileName });
        continue;
      }
      const picked = f.scenarios.filter((s) => entry.has(scenarioKey(s)));
      if (picked.length > 0) {
        files.push({
          fileName: f.fileName,
          scenarios: picked.map(({ name, version }) => ({ name, version })),
        });
      }
    }
    return files;
  };

  /**
   * What the open plugin view bundles into a session beyond the picked specs
   * (src/plugins/client/tabs.ts `session`) — the Event Model on the Models
   * plugin's canvas, whose JSON goes into the prompt after the specs — sent
   * as `attachments` under the plugin's id. What a tab bundles alone is a
   * session too (src/server/api.ts resolveSessionRequest).
   */
  const sessionBundle = (): {
    attachments: Record<string, string[]>;
    labels: string[];
    count: number;
  } => {
    const bundle = pluginView && activeTab ? activeTab.session?.(pluginView.view) : null;
    return bundle && activeTab
      ? { attachments: { [activeTab.id]: bundle.refs }, labels: bundle.labels, count: bundle.refs.length }
      : { attachments: {}, labels: [], count: 0 };
  };

  /** "2 whole specs and 3 scenarios from 1 spec" — the button and the name
      dialog both say what a session would run over. */
  const describeSelection = (
    files: { scenarios?: ScenarioPick[] }[],
    bundled: string[] = sessionBundle().labels,
  ): string => {
    const whole = files.filter((f) => !f.scenarios).length;
    const partial = files.length - whole;
    const scenarios = files.reduce((n, f) => n + (f.scenarios?.length ?? 0), 0);
    const parts: string[] = [];
    if (whole > 0) parts.push(`${whole} whole spec${whole === 1 ? "" : "s"}`);
    if (partial > 0) {
      parts.push(
        `${scenarios} scenario${scenarios === 1 ? "" : "s"} from ` +
          `${partial} spec${partial === 1 ? "" : "s"}`,
      );
    }
    parts.push(...bundled);
    return parts.join(" and ");
  };

  const selectionLabel = describeSelection(sessionFiles());
  const sessionCount = specSelection.size + sessionBundle().count;

  /** The target the next session dialog opens on. */
  const sessionTarget = resolveCodeGenTarget(codeGenTarget, canOpenClaudeDesktop, agents);

  // Code gen session (specs/agents/claude.feature.md): with specs or single
  // scenarios selected, "Start session" asks for a name — prefilled with a
  // timestamp name, so confirming straight away works — and, with more than
  // one agent installed, where to run. The server builds a prompt from the
  // selection and opens it in Claude Code Desktop or in the coding agent
  // pane. A failure lands in the error box.
  // "Copy prompt to clipboard": the server builds the very prompt a session
  // would run and hands it back; nothing is launched, so the selection stays
  // put only when the copy fails.
  const copySessionPrompt = async (
    name: string,
    files: { fileName: string; scenarios?: ScenarioPick[] }[],
    attachments: Record<string, string[]>,
  ) => {
    setSessionRunning(true);
    setSessionNotice(`Building the prompt for "${name}"…`);
    try {
      const res = await fetch("/api/agent/session/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, files, attachments }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSessionNotice(null);
        setSessionError(data.error ?? "Could not build the prompt");
        return;
      }
      if (!(await copyText(data.prompt as string))) {
        setSessionNotice(null);
        setSessionError("Could not copy the prompt to the clipboard.");
        return;
      }
      setSessionNotice(`Prompt for "${name}" copied to the clipboard.`);
      setSpecSelection(new Map());
    } catch (e) {
      setSessionNotice(null);
      setSessionError((e as Error).message);
    } finally {
      setSessionRunning(false);
    }
  };

  // The AI session's dialog, built from the selection at the time: the
  // Start session dialog renders it on its AI tab, and runAiSession acts on
  // what was picked. Kept apart from the running so the dialog can hold a
  // second tab.
  const aiSessionDialog = (): {
    files: ReturnType<typeof sessionFiles>;
    bundle: ReturnType<typeof sessionBundle>;
    only: CodeGenTarget;
    dialog: PromptOptions;
  } => {
    const files = sessionFiles();
    const bundle = sessionBundle();
    // With a code repo named in project-settings.json the session runs
    // there, and the dialog says so — the folder is the session's whole
    // context, so it must not come as a surprise.
    const where = codeRepo ? ` in ${codeRepo}` : "";
    // Every agent the session can run in here; a choice only when there is
    // more than one.
    const repoWord = codeRepo ? "the code repo" : "the data repo";
    const agentChoices = [
      ...(canOpenClaudeDesktop
        ? [
            {
              value: "desktop",
              label: codeGenTargetLabel("desktop", agents),
              hint: `Opens a new session in the Claude app, on ${repoWord}`,
            },
          ]
        : []),
      // The agents the plugins supply (specs/agents/agent-plugins
      // .feature.md): the same pane, driven by each — offered when its CLI
      // is on PATH, in rank order, each described in its own words.
      ...usableAgents(agents).map((a) => ({
        value: a.id,
        label: codeGenTargetLabel(a.id, agents),
        hint: `Chats with ${a.label} in a pane here, on ${repoWord} — ${a.description.charAt(0).toLowerCase()}${a.description.slice(1)}`,
      })),
    ];
    // The clipboard is always on offer, and first: it needs no agent
    // installed, and the prompt it copies is the same text a session would
    // run — to paste into an agent the app doesn't drive.
    const choices = [
      {
        value: CLIPBOARD_TARGET,
        label: "Copy prompt to clipboard",
        hint: `Copies the prompt for ${repoWord} — paste it into any agent`,
        confirmLabel: "Copy prompt",
      },
      ...agentChoices,
    ];
    // With no agent installed the clipboard is all there is, so the dialog
    // asks for a name without a choice and says what it will do.
    const only = (agentChoices[0]?.value ?? CLIPBOARD_TARGET) as CodeGenTarget;
    const dialog = {
      title: "Name the session",
      // With a choice of agents each option says what it runs, so the hint
      // names none of them; with only one, it names that one's agent.
      hint:
        agentChoices.length === 0
          ? `Builds a prompt over ${describeSelection(files)}${where} to copy — no coding agent found to run it here.`
          : `Runs ${agentChoices.length > 1 ? "the chosen agent" : only === "desktop" ? "Claude" : (agents.find((a) => a.id === only)?.label ?? only)} over ${describeSelection(files)}${where}, or copies the prompt.`,
      initial: defaultSessionName(),
      placeholder: "e.g. implement billing quotes",
      confirmLabel: "Start AI Session",
    };
    // With no agent installed the dialog asks for a name without a choice
    // and says what it will do; the hint only makes sense over a selection.
    const opts: PromptOptions =
      agentChoices.length > 0
        ? { ...dialog, choicesLabel: "Run in", choices, initialChoice: sessionTarget }
        : { ...dialog, confirmLabel: "Copy prompt" };
    if (files.length === 0 && bundle.count === 0) delete opts.hint;
    return { files, bundle, only, dialog: opts };
  };

  /** The AI tab was confirmed: copy the prompt, or run the session where it was told to. */
  const runAiSession = async (sessionName: string, choice: string | null) => {
    const { files, bundle, only } = aiSessionDialog();
    if ((files.length === 0 && bundle.count === 0) || sessionRunning) return;
    const { attachments } = bundle;
    if (choice === null || choice === CLIPBOARD_TARGET) {
      await copySessionPrompt(sessionName, files, attachments);
      return;
    }
    const target = readCodeGenTarget(choice, agents) ?? only;
    // Remembered, so the next dialog opens on the same choice.
    if (target !== codeGenTarget) void patchSettings({ codeGenTarget: target });
    setSessionRunning(true);
    setSessionNotice(
      target === "desktop"
        ? `Opening "${sessionName}" in Claude Code Desktop…`
        : `Opening "${sessionName}" in the coding agent pane…`,
    );
    try {
      const res = await fetch("/api/agent/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: sessionName, files, attachments, target }),
      });
      const data = await res.json();
      if (res.ok && target === "desktop") {
        // The session goes on in the Claude app from here; "opened", since
        // whether the prompt is sent or only prefilled is the app's call.
        setSessionNotice(`Session "${sessionName}" opened in Claude Code Desktop.`);
        setSpecSelection(new Map());
      } else if (res.ok) {
        // The chat is up with the prompt as its first turn; show it.
        setSessionNotice(`Session "${sessionName}" opened in the coding agent pane.`);
        setSpecSelection(new Map());
        await agentChat.openSession(data.id as string);
        agentChat.openPane();
      } else {
        setSessionNotice(null);
        setSessionError(data.error ?? "Code gen session failed");
      }
    } catch (e) {
      setSessionNotice(null);
      setSessionError((e as Error).message);
    } finally {
      setSessionRunning(false);
    }
  };

  /** Open the Start session dialog — every entry point lands here. */
  const startSession = () => setStartDialog(true);

  /**
   * Start a pomodoro: one click, no dialog and no name. Called straight from
   * the click or the key, which is also what unlocks the sound.
   */
  const startPomodoro = () => {
    pomodoro.start();
    toast.success("Pomodoro started");
  };

  // Folders (specs/ui/folders.feature.md): plain directories in the data repo.
  // With a folder selected, the new folder is created inside it.
  const createFolder = () => createFolderIn(selectedFolder);
  /** `parent` is a repo-relative folder path, or null for the top level. */
  const createFolderIn = async (parent: string | null) => {
    const input = await prompt({
      title: parent ? `New folder in "${parent}"` : "New folder",
      hint: parent ? undefined : "Use / for nesting.",
      confirmLabel: "Create folder",
    });
    if (!input) return;
    const path = cleanSegments(input);
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: parent ? `${parent}/${path}` : path }),
    });
    const data = await res.json();
    if (res.ok) {
      // Reveal and select the new folder, so a follow-up "+ New folder"
      // nests inside it and a drag has a visible target.
      if (parent) setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parent);
        return next;
      });
      setSelectedFolder(data.path);
      // The new folder starts with its name in initial case as its display
      // name; a failed save leaves it showing its plain name.
      const display = initialCaseDisplayName(String(data.path).split("/").pop() ?? "");
      if (display) {
        await fetch(`/api/folders/${encodeURIComponent(data.path)}/description`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description: display }),
        }).catch(() => undefined);
      }
      await loadFeatures();
    } else {
      toast.error(data.error ?? "Could not create the folder");
    }
  };

  // Delete from a folder's ⋯ menu (specs/ui/folders.feature.md "delete a
  // folder" / "delete a folder with features in it"): an empty folder goes
  // at once, with Undo; one with features asks again, naming how many, and
  // then goes with them — a `git rm -r` on the server, committed and pushed.
  const removeFolder = async (path: string) => {
    const node = findFolder(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), path);
    const count = node ? featuresBeneath(node) : 0;
    const ok = await confirm({
      title: "Delete folder",
      body:
        count === 0
          ? `Delete the empty folder "${path}"?`
          : `Delete "${path}" and the ${count} feature${count === 1 ? "" : "s"} in it? They are removed from the repository, committed and pushed.`,
      confirmLabel: count === 0 ? "Delete folder" : `Delete folder and ${count} feature${count === 1 ? "" : "s"}`,
    });
    if (!ok) return;
    // An editor open on a feature beneath the folder has nothing left to save
    // into — the same seal as deleting that feature from its own menu.
    const retiring = selected !== null && selected.startsWith(`${path}/`);
    if (retiring) {
      featureEditorsRetiring.current = true;
      await scenarioSaveQueue.current.idle();
      await descSaveQueue.current.idle();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(path)}${count > 0 ? "?force=true" : ""}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (res.ok) {
        if (retiring) {
          setEditing(null);
          setSelected(null);
          setFeature(null);
          setSelectedScenario(null);
        }
        // A selection under the deleted folder points nowhere — drop it.
        setSelectedFolder((f) => (f === path || f?.startsWith(`${path}/`) ? null : f));
        await loadFeatures();
        if (count === 0) {
          toast.success(`Deleted folder "${path}".`, {
            action: { label: "Undo", run: () => void restoreFolder(path) },
          });
        } else {
          toast.success(`Deleted folder "${path}" and ${count} feature${count === 1 ? "" : "s"} — ${data.message}.`);
        }
      } else {
        toast.error(data.error ?? "Could not delete the folder");
      }
    } finally {
      if (retiring) unsealFeatureEditors();
    }
  };

  // Rename from a folder's ⋯ menu (specs/ui/folders.feature.md "rename a
  // folder"): the last segment changes, the server git-mvs the directory, and
  // everything keyed by a path beneath it — the open feature, the selected
  // folder, the collapsed set — follows to the new path.
  const renameFolder = async (path: string) => {
    const current = path.split("/").pop()!;
    const name = await prompt({
      title: "Rename folder",
      hint: "The folder keeps its place in the tree; names are slugified like file names.",
      initial: current,
      confirmLabel: "Rename",
    });
    if (!name || cleanLine(name) === current) return;
    // The editors over a feature in the folder flush, then seal, before the
    // git mv — the same pair renameFile uses, so no save names the old path.
    const retiring = selected !== null && selected.startsWith(`${path}/`);
    if (retiring) {
      await editorRef.current.flush();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(path)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleanLine(name) }),
      });
      const data = (await res.json()) as { path?: string; message?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Rename failed");
        return;
      }
      const to = data.path!;
      if (to === path) return;
      await followFolder(path, to, retiring);
      toast.success(`Renamed folder to ${to.split("/").pop()} — ${data.message}.`);
    } finally {
      if (retiring) unsealFeatureEditors();
    }
  };

  // After a folder rename or move, everything keyed by a path beneath it —
  // the selected folder, the collapsed set, the open feature — follows to
  // the new path.
  const followFolder = async (path: string, to: string, retiring: boolean) => {
    setSelectedFolder((f) => (f === null ? f : folderRenamed(f, path, to)));
    setCollapsed((prev) => new Set([...prev].map((p) => folderRenamed(p, path, to))));
    setOutlined((prev) => new Set([...prev].map((p) => folderRenamed(p, path, to))));
    await loadFeatures();
    if (selected !== null && retiring) await openFeature(folderRenamed(selected, path, to));
  };

  // Move to folder… from a folder's ⋯ menu or the palette
  // (specs/ui/folders.feature.md "move a folder"): pick a new parent — the
  // top level included — and the server git-mvs the directory there, keeping
  // its name. The open feature follows the way it does on a rename; Undo
  // moves the folder back to where it came from.
  const moveFolder = async (path: string, parent: string) => {
    const from = path.slice(0, path.lastIndexOf("/"));
    const retiring = selected !== null && selected.startsWith(`${path}/`);
    if (retiring) {
      await editorRef.current.flush();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(path)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent }),
      });
      const data = (await res.json()) as { path?: string; message?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Move failed");
        return;
      }
      const to = data.path!;
      if (to === path) return;
      await followFolder(path, to, retiring);
      const where = parent === "" || parent === SPECS_FOLDER ? "the top level" : parent.split("/").pop();
      toast.success(`Moved folder to ${where} — ${data.message}.`, {
        action: { label: "Undo", run: () => void moveFolder(to, from) },
      });
    } catch (e) {
      toast.error(e instanceof TypeError ? "Could not move the folder — is the server running?" : (e as Error).message);
    } finally {
      if (retiring) unsealFeatureEditors();
    }
  };
  const moveFolderPrompt = async (path: string) => {
    setTreeMenu(null);
    const options = folderMoveOptions(
      buildTree(folders, features, folderDescriptions, folderOrders, featureOrders),
      path,
    );
    const to = await pick({
      title: `Move folder “${path.split("/").pop()}”`,
      hint: "To the top level or another folder — a git mv, committed and pushed.",
      placeholder: "Find a folder…",
      options,
      empty: options.length === 0 ? "There is no other folder to move it to." : "No folder matches.",
    });
    if (to === null) return;
    await moveFolder(path, to);
  };

  // Display name from a folder's ⋯ menu (specs/ui/folders.feature.md "edit a
  // folder's display name"): the label the sidebar shows in place of the
  // folder name, kept in the folder's display-name.txt. The folder — and every
  // path beneath it — stays put; a blank name clears the label.
  const editFolderDisplayName = async (path: string) => {
    const current = folderDescriptions[path] ?? "";
    const name = await prompt({
      title: "Edit display name",
      hint: "Shown in the tree in place of the folder name. Leave blank to show the folder name.",
      initial: current,
      placeholder: path.split("/").pop(),
      confirmLabel: "Save",
      allowEmpty: true,
    });
    if (name === null || cleanLine(name) === current) return;
    const res = await fetch(`/api/folders/${encodeURIComponent(path)}/description`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: cleanLine(name) }),
    });
    const data = (await res.json()) as { description?: string | null; message?: string; error?: string };
    if (!res.ok) {
      toast.error(data.error ?? "Could not save the display name");
      return;
    }
    await loadFeatures();
    toast.success(
      data.description
        ? `Folder display name set to "${data.description}" — ${data.message}.`
        : `Cleared the folder's display name — ${data.message}.`,
    );
  };

  /**
   * Move the subfolder at `from` among `parent`'s subfolders to `to`
   * (specs/ui/folders.feature.md "order folders") — one place for Move up /
   * Move down, anywhere for a drop on a sibling's row — and save the order:
   * the parent's folder-order.txt, committed and pushed. The tree shows the
   * new order while the save is out, and falls back if it fails.
   */
  const moveFolderTo = async (parent: string, from: number, to: number) => {
    const siblings = findFolder(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), parent)?.folders;
    if (!siblings) return;
    const names = folderNamesMoved(siblings, from, to);
    if (!names) return;
    const before = folderOrders;
    setFolderOrders({ ...before, [parent]: names });
    setTreeMenu(null);
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(parent)}/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folders: names }),
      });
      const data = (await res.json()) as { folders?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not move the folder");
      await loadFeatures();
    } catch (e) {
      setFolderOrders(before);
      toast.error(
        e instanceof TypeError ? "Could not move the folder — is the server running?" : (e as Error).message,
      );
    }
  };

  /** Move a folder one place up or down among its siblings, from its menu or the palette. */
  const reorderFolder = (path: string, delta: -1 | 1) => {
    const parent = path.split("/").slice(0, -1).join("/");
    const siblings = findFolder(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), parent)?.folders;
    if (!siblings) return;
    const i = siblings.findIndex((f) => f.path === path);
    if (i < 0) return;
    void moveFolderTo(parent, i, i + delta);
  };

  /**
   * Move the feature at `from` among `parent`'s features to `to` (specs/ui/
   * folders.feature.md "order features") — one place for Move up / Move
   * down, anywhere for a drop on a sibling's row — and save the order: the
   * folder's feature-order.txt, committed and pushed. The tree shows the new
   * order while the save is out, and falls back if it fails.
   */
  const moveFeatureTo = async (parent: string, from: number, to: number) => {
    const siblings = findFolder(
      buildTree(folders, features, folderDescriptions, folderOrders, featureOrders),
      parent,
    )?.features;
    if (!siblings) return;
    const names = featureNamesMoved(siblings, from, to);
    if (!names) return;
    const before = featureOrders;
    setFeatureOrders({ ...before, [parent]: names });
    setTreeMenu(null);
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(parent)}/feature-order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: names }),
      });
      const data = (await res.json()) as { features?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not move the feature");
      await loadFeatures();
    } catch (e) {
      setFeatureOrders(before);
      toast.error(
        e instanceof TypeError ? "Could not move the feature — is the server running?" : (e as Error).message,
      );
    }
  };

  /** Move a feature one place up or down among its siblings, from the palette. */
  const reorderFeature = (fileName: string, delta: -1 | 1) => {
    const parent = fileName.slice(0, fileName.lastIndexOf("/"));
    const siblings = findFolder(
      buildTree(folders, features, folderDescriptions, folderOrders, featureOrders),
      parent,
    )?.features;
    if (!siblings) return;
    const i = siblings.findIndex((f) => f.fileName === fileName);
    if (i < 0) return;
    void moveFeatureTo(parent, i, i + delta);
  };

  /** Undo of a folder delete: only empty folders go, so re-creating restores it. */
  const restoreFolder = async (path: string) => {
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (res.ok) await loadFeatures();
    else toast.error(`Could not restore "${path}".`);
  };

  // Drag-move (specs/ui/folders.feature.md): the server does a `git mv` into
  // the target folder, committed and pushed. A selected feature stays
  // selected under its new path — the canonical-url effect follows along.
  // What the scenario / description editors hold lands on the current path
  // first, then they seal, so the openFeature close after git-mv cannot PUT
  // the retired path and recreate the old file.
  const moveTo = async (fileName: string, folder: string) => {
    setDragging(null);
    setDropTarget(null);
    const from = fileName.includes("/") ? fileName.slice(0, fileName.lastIndexOf("/")) : "";
    // A drop on the folder it is already in moves nothing ("already there"):
    // no need to close the editors over it.
    const retiring = selected === fileName && folder !== from;
    if (retiring) {
      await editorRef.current.flush();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(fileName)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder }),
      });
      const data = await res.json();
      if (res.ok) {
        await loadFeatures();
        if (data.fileName !== fileName) {
          if (selected === fileName) await openFeature(data.fileName);
          // Undo moves it straight back to where it came from.
          toast.success(`Moved to ${folder || "the top level"} — ${data.message}.`, {
            action: { label: "Undo", run: () => void moveTo(data.fileName, from) },
          });
        }
      } else {
        toast.error(data.error ?? "Move failed");
      }
    } finally {
      // Moved, refused, unchanged or never answered: the seal is over either
      // way, or the next scenario opened here would silently never save.
      if (retiring) unsealFeatureEditors();
    }
  };

  // specs/ui/ui.feature.md "Main page": the Edit link next to the feature name
  // lets the user edit the feature name — the file's `# <name>` heading. The
  // server rewrites the heading, commits and pushes; the file name (and so the
  // feature's url) stays the same.
  const renameSelected = async () => {
    const draft = renameDraftRef.current;
    if (!selected || draft === null || renamingRef.current) return;
    const target = cleanLine(draft);
    const currentName = feature ? feature.name || titleFromFileName(selected) : "";
    if (!target || target === currentName) {
      setRenameDraft(null);
      return;
    }
    renamingRef.current = true;
    setRenaming(true);
    try {
      if (await renameFeature(selected, target)) setRenameDraft(null);
    } finally {
      renamingRef.current = false;
      setRenaming(false);
    }
  };

  /** Rewrite `fileName`'s `# <name>` heading to `name` — committed and pushed
      by the server; the file (and its url) stays put. True once saved. */
  const renameFeature = async (fileName: string, name: string) => {
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(fileName)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Rename failed");
        return false;
      }
      await loadFeatures();
      // Still the open feature? A blur-save can be out while the user
      // already opened another one — that one stays.
      if (selectedRef.current === fileName) await openFeature(fileName);
      toast.success(`Renamed to "${data.name}" — ${data.message}.`);
      return true;
    } catch {
      toast.error("Rename failed — is the server running?");
      return false;
    }
  };

  // Edit display name from a feature's ⋯ menu in the sidebar
  // (specs/ui/ui.feature.md "Feature entry menu"): the feature name — the
  // file's `# <name>` heading the tree shows — as the page's Edit link does.
  // The file name and url stay the same.
  const editFeatureDisplayName = async (f: FeatureListing) => {
    const current = f.name || titleFromFileName(f.fileName);
    const name = await prompt({
      title: "Edit display name",
      hint: "The feature name shown in the tree and on its page. The file name stays the same.",
      initial: current,
      confirmLabel: "Save",
    });
    if (name === null || !cleanLine(name) || cleanLine(name) === current) return;
    await renameFeature(f.fileName, cleanLine(name));
  };

  /** The file name shown in the menu: only the part left of the dot —
      the `.feature.md` extension is hidden (specs/ui/ui.feature.md "Feature
      entry menu"). */
  const fileStem = (fileName: string) => fileName.split("/").pop()!.split(".")[0]!;
  /** A folder's entry in `treeMenu` — a NUL keeps it apart from file names. */
  const folderMenuKey = (path: string) => `folder\u0000${path}`;

  // File → Rename (specs/ui/ui.feature.md "Feature entry menu"): renames the
  // underlying file. The extension stays; a selected feature follows its
  // new file name (and so a new url — old links go stale).
  const renameFile = async (fileName: string) => {
    const stem = await prompt({
      title: "Rename file",
      hint: "The .feature.md extension is kept.",
      initial: fileStem(fileName),
      confirmLabel: "Rename",
    });
    if (!stem || cleanLine(stem) === fileStem(fileName)) return;
    // The server slugs the stem, so the name can still come back unchanged;
    // the finally below lifts the seal then too.
    const retiring = selected === fileName;
    if (retiring) {
      await editorRef.current.flush();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(fileName)}/rename-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stem: cleanLine(stem) }),
      });
      const data = await res.json();
      if (res.ok) {
        await loadFeatures();
        if (data.fileName !== fileName) {
          if (selected === fileName) await openFeature(data.fileName);
          toast.success(`Renamed file to ${fileStem(data.fileName)} — ${data.message}.`);
        }
      } else {
        toast.error(data.error ?? "Rename failed");
      }
    } finally {
      if (retiring) unsealFeatureEditors();
    }
  };

  // A feature's page is published (specs/external-links/confluence-wiki.feature.md
  // "Publish a feature to Confluence"): the feature now links it, shown as
  // saved, and the toast offers "Open page". Shared by the Confluence
  // dialog and the Wiki & qTest one.
  const confluencePublished = (data: ConfluencePublishResult) => {
    if (!selected) return;
    setFeature(featureFromResponse(data, selected));
    setDirty(false);
    markSaved();
    const open = { label: "Open page", run: () => window.open(data.url, "_blank", "noreferrer") };
    toast.success(`${data.created ? "Published" : "Updated"} “${data.title}” in Confluence`, { action: open });
    if (data.warning) toast.error(data.warning);
  };

  // A feature's test cases are written (specs/external-links/qtest-test-cases.feature.md
  // "Create qTest test cases from a feature"): the feature and its scenarios
  // link them, the parent module is remembered for next time, and the toast
  // says how many were created and offers "Open module". Shared by the qTest
  // dialog and the Wiki & qTest one; each decides whether to stay open.
  const qtestPublished = (data: QtestPublishResult) => {
    if (!selected) return;
    setFeature(featureFromResponse(data, selected));
    setDirty(false);
    markSaved();
    setQtestParentUrl(data.parentUrl);
    const open = { label: "Open module", run: () => window.open(data.module.url, "_blank", "noreferrer") };
    const what = [
      data.created > 0 ? `created ${data.created}` : "",
      data.updated > 0 ? `updated ${data.updated}` : "",
      // Test cases of scenarios no longer in the feature (or out of scope), removed from the module.
      (data.deleted ?? 0) > 0 ? `deleted ${data.deleted}` : "",
      // The requirements of the feature's Jira issues they cover, those found and linked.
      (() => {
        const pids = (data.requirements ?? []).filter((r) => r.linked + r.alreadyLinked > 0).map((r) => r.pid);
        return pids.length > 0 ? `linked to ${pids.join(", ")}` : "";
      })(),
    ]
      .filter(Boolean)
      .join(", ");
    // A run refused at its first test case wrote nothing to report.
    if (what || !data.failure) toast.success(`qTest: ${what || "nothing to write"} for “${data.title}”`, { action: open });
    if (data.warning) toast.error(data.warning);
  };

  // "Publish qTest Test Cases…" (specs/external-links/qtest-test-cases.feature.md
  // "A feature with no Confluence page asks first"): each test case links its
  // scenario on the feature's Confluence page, so without one it would only
  // name the spec file — asked before the dialog opens.
  const openQtestPublish = async (f: Feature) => {
    if (!f.confluence) {
      const ok = await confirm({
        title: "No Confluence page",
        body: `“${f.name}” has not been published to Confluence, so its test cases cannot link their scenarios there — they will name the spec file instead. Create the qTest test cases anyway?`,
        confirmLabel: "Create anyway",
        danger: false,
      });
      if (!ok) return;
    }
    setQtestPublishOpen(true);
  };

  // Delete (specs/ui/ui.feature.md "Feature entry menu"): removes the feature
  // file after a confirmation — a `git rm`, committed and pushed on the server.
  const removeFeature = async (f: FeatureListing) => {
    const ok = await confirm({
      title: "Delete feature",
      body: `Delete "${f.name}" (${f.fileName})?`,
      confirmLabel: "Delete feature",
    });
    if (!ok) return;
    // Seal without a parting save: writing the file back would undo the
    // delete, the way an open page seals before its DELETE. Saves already
    // away finish first, or they would recreate the file after git rm.
    const retiring = selected === f.fileName;
    if (retiring) {
      featureEditorsRetiring.current = true;
      await scenarioSaveQueue.current.idle();
      await descSaveQueue.current.idle();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(f.fileName)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (res.ok) {
        if (selected === f.fileName) {
          // An editor open on the deleted feature has nothing left to save into.
          setEditing(null);
          setSelected(null);
          setFeature(null);
          setSelectedScenario(null);
        }
        await loadFeatures();
        toast.success(`Deleted "${f.name}" — ${data.message}.`);
      } else {
        toast.error(data.error ?? "Delete failed");
      }
    } finally {
      if (retiring) unsealFeatureEditors();
    }
  };

  // Publish buttons (specs/ui/ui.feature.md "Main page"): same style and
  // behavior as Sync — disabled with a progress label while running, no
  // "Published" status line at the bottom of the page. Without a target every
  // scenario is published (the upper-left "Publish All"); with one, only that
  // scenario (crud-feature.md "publish each scenario individually").
  // `over` carries content the state hasn't caught up with yet: the dialog's
  // Publish saves its scenario into the feature and publishes in one motion.
  // The target carries the scenario's document id, so one going out under a
  // new name or version is published as itself, not as a second scenario.
  const publish = async (scenario?: ScenarioTarget, over?: Feature, file = selected) => {
    const content = over ?? feature;
    if (!file || !content) return;
    setPublishing(scenario ? scenarioKey(scenario) : "all");
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(content), scenario }),
      });
      const data = await res.json();
      // The dialog's Publish can wait behind an autosave tick, long enough
      // for the user to open another feature. Its answer then belongs to a
      // feature no longer on screen: reopening it would pull the user back,
      // and its conflict dialog would resolve against the wrong page.
      const stillHere = selectedRef.current === file;
      if (res.status === 409 && data.status === "conflict") {
        if (stillHere) {
          setConflict({ ours: data.ours, theirs: data.theirs, message: data.message, scenario });
          setConflictDraft(data.ours);
          toast.info("Merge conflict — choose a resolution below.");
        } else {
          toast.error(`Merge conflict publishing to ${file} — open it and publish again to resolve.`);
        }
      } else if (res.ok) {
        if (stillHere) await openFeature(file);
        else await loadFeatures();
      } else {
        toast.error(data.error ?? "Publish failed");
      }
    } catch {
      toast.error("Publish failed — is the server running?");
    } finally {
      setPublishing(null);
    }
  };

  // Sync button (specs/ui/ui.feature.md "Main page"): immediate data reload —
  // the server runs one reload tick (pull + push saved), then the view
  // refreshes the way the cron mirror does — open pages and plugin tabs
  // included, an in-progress edit or conflict not clobbered. Progress shows
  // only on the button — no status line at the bottom of the page.
  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/reload", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Sync failed");
        return;
      }
      await refreshViewRef.current();
      // Asked for by hand, a sync that still cannot push says so again —
      // the first toast may be long dismissed.
      const stillFailing = currentSyncProblem();
      if (stillFailing !== null) announceSyncProblemRef.current(stillFailing);
    } catch {
      toast.error("Sync failed — is the server running?");
    } finally {
      setSyncing(false);
    }
  };

  const resolveWith = async (which: "ours" | "theirs" | "draft", resolved: string) => {
    if (!selected || resolving) return;
    setResolving(which);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: resolved,
          resolveConflict: true,
          // Keep an individual publish scoped to its scenario — and, by its
          // document id, renaming rather than doubling — through the
          // conflict resolution.
          scenario: conflict?.scenario,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // openFeature closes the dialog by clearing the conflict.
        await openFeature(selected);
      } else {
        toast.error(data.error ?? "Publish failed");
      }
    } catch {
      toast.error("Publish failed — is the server running?");
    } finally {
      setResolving(null);
    }
  };

  /** Close the conflict dialog without resolving. The unfinished merge stays
      in the repo, so Publish brings the same choices back. */
  const dismissConflict = () => {
    setConflict(null);
    toast.info("Merge conflict left unresolved — Publish again to pick a resolution.");
  };

  /** Handle a link in-app on a plain click; cmd/ctrl/shift-clicks keep their
      native behavior (new tab etc — specs/ui/navigation.feature.md "share a
      link"). */
  const spaClick = (e: MouseEvent, go: () => void) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go();
  };

  // "Copy link" (specs/ui/navigation.feature.md "share a link"): absolute url
  // on the clipboard; the pressed control's label flips to "Copied" for 2 sec.
  // The desktop app's own origin (app://specdriven) means nothing outside its
  // window, so there the shared url is the registered specdriven:// scheme,
  // which names the open spec folder (src/frontend/shareLink.ts).
  const copyLink = async (path: string) => {
    const url = shareUrl(path);
    if (!(await copyText(url))) {
      toast.error("Could not copy the link to the clipboard.");
      return;
    }
    setCopied(path);
    window.setTimeout(() => setCopied((p) => (p === path ? null : p)), 2000);
  };
  // The scenario url "Copy link" shares. The public specs site hands links to
  // people outside the team, so there it is the versionless url, which still
  // opens after the scenario gets a new version (specs/app/public-specs-site
  // .feature.md "copies a deep link"); everywhere else, the versioned one.
  const scenarioLink = (fileName: string, s: Pick<Scenario, "name" | "version">) =>
    readOnly ? latestScenarioPath(fileName, s) : scenarioPath(fileName, s);

  // crud-feature.md ("Scenario is automatically saved locally and
  // pushed to GitHub"): a landed save updates the header's Saved indicator.
  const markSaved = () => {
    setSaving(false);
    setSavedAt(Date.now());
  };

  /**
   * The version a scenario gets is derived, never typed
   * (specs/ui/ui.feature.md): one past the highest version already carrying
   * that name, or 1 when the name is new. Editing an existing entry keeps the
   * version it was given.
   */
  const nextVersionFor = (name: string, ignoreIndex?: number) =>
    nextVersionIn(feature, name, ignoreIndex);

  /** The version the open dialog will save under; shown read-only in the dialog.
      A new scenario autosave has already placed in the feature keeps deriving
      its version, with its own entry left out — or it would bump past itself
      on every tick. */
  const draftVersion = !editing
    ? 1
    : editing.isNew || editing.index === null
      ? nextVersionFor(editing.scenario.name, editing.index ?? undefined)
      : editing.scenario.version;

  /**
   * Write the editor's scenario into the feature and save the feature locally
   * (marked [proposed], so no data is lost); the server's reload cron commits
   * and pushes it. `close` false is the autosave path
   * (specs/editor/editor-autosave.feature.md): the pane stays open and follows
   * its scenario into the saved feature. Resolves to whether the save landed
   * and where it left the scenario; null when there is nothing to save.
   */
  const saveScenario = (
    tests: string[],
    close: boolean,
    // Propose (specs/editor/spec-editor.feature.md) is the explicit action
    // that advances the editor's draft; every other save keeps the status.
    status?: Scenario["status"],
  ): Promise<{ ok: boolean; placed: Placement }> | null => {
    if (featureEditorsSealed.current) return null;
    if (!editing || !feature || !selected) return null;
    const draft = { ...editing.scenario, status: status ?? editing.scenario.status, tests };
    const derived = editing.isNew === true;
    // Where this scenario sits in the feature: the entry the editor opened
    // on, or the one a previous save placed — never appended twice. While a
    // tick is still away that is wherever the tick lands it, not what this
    // render knows: its index and (for a new scenario) its missing document
    // id predate that save, so placing by them would append the scenario a
    // second time, or write over the neighbour a rename re-sorted into its
    // old slot.
    const ahead = autosaveInFlight.current;
    const known: Placement = { feature, index: editing.index, id: draft.id, insertAt: editing.insertAt };
    const place = (at: Placement) => placeScenario(draft, at, derived);
    if (!ahead) setFeature(place(known).next);
    if (close) setEditing(null);
    const session = editorSession.current;
    const file = selected;
    setSaving(true);
    // Through the queue so a folder switch can wait for this PUT, and so
    // a save meeting a tick already away goes out after it, from where it
    // landed.
    return scenarioSaveQueue.current.run(async () => {
      const base = ahead ? await ahead : known;
      const { s, next } = place(base);
      if (ahead && selectedRef.current === file) setFeature(next);
      const res = await fetch(`/api/features/${encodeURIComponent(file)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // The scenario goes out with its document id, so a retyped title or a
        // re-derived version renames the saved entry instead of leaving a draft
        // behind under its old name.
        body: JSON.stringify({
          content: serializeFeature(next),
          save: true,
          scenario: scenarioTarget(s),
        }),
      });
      const data = await res.json();
      // The user may have moved on while the save was away — navigating from
      // the sidebar leaves the editor pane with this last save
      // (specs/editor/spec-editor.feature.md "Spec editor pane") — and then
      // its result belongs to nothing on screen.
      const stillHere = selectedRef.current === file;
      if (res.ok) {
        const saved = featureFromResponse(data, file);
        if (stillHere) {
          setFeature(saved);
          setDirty(false);
        } else {
          // Its feature is no longer open, so the tree reads it from the
          // listing: the save lands there instead.
          setFeatures((prev) => withOpenScenarios(prev, file, saved));
        }
        // The feature comes back in canonical order, so a renamed scenario has
        // moved: a still-open editor has to find its scenario again, and an
        // explicit save that closed the editor lands on its card — by its
        // identity, else by its document id (landedScenario). Not finding it
        // (the entry was dropped underneath us) leaves the editor new, so
        // the next save re-adds the work rather than overwriting a neighbour.
        // The entry's document id comes back with it: a new scenario adopts it
        // here, and every later save names the entry by it.
        const moved = landedScenario(saved.scenarios, s, s.id);
        const id = moved === null ? undefined : saved.scenarios[moved]!.id;
        if (!close && session === editorSession.current) {
          setEditing((prev) =>
            prev === null
              ? null
              : {
                  ...prev,
                  index: moved,
                  scenario: id === undefined ? prev.scenario : { ...prev.scenario, id },
                },
          );
        }
        if (close && stillHere) setSelectedScenario(moved);
        // A published scenario's editor can only have changed its links — test
        // links (specs/traceability.feature.md) and its ticket link — so there
        // is nothing left to publish.
        if (stillHere) markSaved();
        else setSaving(false);
        return { ok: true, placed: { feature: saved, index: moved, id } };
      }
      setSaving(false);
      if (stillHere) {
        setDirty(true);
        toast.error(data.error ?? "Save failed");
      }
      // Nothing landed: the scenario is still where this save found it.
      return { ok: false, placed: base };
    });
  };
  const commitScenario = async (
    tests: string[],
    close: boolean,
    status?: Scenario["status"],
  ): Promise<boolean> => (await saveScenario(tests, close, status))?.ok ?? false;

  /**
   * A url still sitting in the add field or an open ✎ row rides along with
   * Propose and Publish — it must never be silently dropped — and one that
   * can't join the list blocks the save instead
   * (specs/traceability.feature.md). The ticket-link fields gate the save the
   * same way: a half-filled link is not written half-done, it blocks with a
   * message
   * (specs/external-links/project-management-jira-linear-etc.feature.md). Null
   * means blocked, with the reason already on screen.
   */
  const pendingTests = (): string[] | null => {
    if (!editing) return null;
    const link = resolveLinkDraft(linkDraft);
    if (link.error) {
      setLinkError(link.error);
      return null;
    }
    // The qTest test case fields gate it the same way
    // (specs/external-links/qtest-test-cases.feature.md).
    const qtest = resolveQtestDraft(qtestDraft);
    if (qtest.error) {
      setQtestError(qtest.error);
      return null;
    }
    const pending = resolvePendingTests(
      editing.scenario.tests,
      testEdit === null ? null : { index: testEdit, ...testEditDraft },
      { url: testDraft, name: testNameDraft },
    );
    if (pending.error) {
      setTestsError(pending.error);
      return null;
    }
    return pending.tests;
  };

  /**
   * Propose (specs/editor/spec-editor.feature.md): the explicit action that
   * moves the dialog's scenario into the `.feature.md` as [proposed]. Saves
   * and closes.
   */
  const proposeScenario = async () => {
    if (!editing) return;
    const tests = pendingTests();
    if (tests === null) return;
    const name = savedScenarioName(editing.scenario);
    const version = draftVersion;
    if (await commitScenario(tests, true, "proposed")) {
      toast.success(`Proposed "${name}" v${version} — publish it from its card, or press Publish All.`);
    }
  };

  /**
   * Publish straight from the dialog (specs/editor/spec-editor.feature.md):
   * the dialog's scenario goes into the feature and that one scenario is
   * published — marked [published], committed and pushed, exactly like a
   * card's Publish. The target carries the draft's document id, so a title
   * retyped since autosave filed it publishes that draft — renamed — rather
   * than a second scenario beside it. A merge conflict opens the usual
   * resolution dialog.
   *
   * Same placement as `saveScenario`: while a tick is still away, this render's
   * index and (for a new scenario) its missing document id predate that save.
   * Placing from them would append a second scenario — or write over the
   * neighbour a rename re-sorted into the old slot — and then publish that.
   * Through the queue so the publish PUT goes out after the tick, from where
   * it landed, and so a folder switch can wait for it.
   */
  const publishScenario = async () => {
    // A move, rename-file or delete has sealed this feature's path: a PUT
    // would mint the retired file again (tests/featurePathRetire.test.tsx).
    if (featureEditorsSealed.current) return;
    if (!editing || !feature || !selected) return;
    const tests = pendingTests();
    if (tests === null) return;
    const draft = { ...editing.scenario, tests };
    const derived = editing.isNew === true;
    const ahead = autosaveInFlight.current;
    const known: Placement = { feature, index: editing.index, id: draft.id, insertAt: editing.insertAt };
    const place = (at: Placement) => placeScenario(draft, at, derived);
    const shown = place(known);
    if (!ahead) {
      setFeature(shown.next);
      setSelectedScenario(cardOfScenario(shown.next.scenarios, shown.s));
    }
    setEditing(null);
    // Busy from the click, not from when the queue reaches the PUT: the wait
    // behind a tick would otherwise show nothing and leave Publish enabled.
    setPublishing(scenarioKey(shown.s));
    const file = selected;
    await scenarioSaveQueue.current.run(async () => {
      const base = ahead ? await ahead : known;
      // Sealed while it waited: the path is retired, so nothing goes out.
      if (featureEditorsSealed.current) {
        setPublishing(null);
        return;
      }
      const { s, next } = place(base);
      if (ahead && selectedRef.current === file) {
        setFeature(next);
        setSelectedScenario(cardOfScenario(next.scenarios, s));
      }
      await publish(scenarioTarget(s), next, file);
    });
  };

  /**
   * One autosave tick (specs/editor/editor-autosave.feature.md "Autosave
   * Triggered at Defined Interval"): save what the editor holds, unless it
   * holds nothing new. A url still being typed into the test-link fields stays
   * out — those join the scenario when the user adds them, or when the pane
   * closes.
   */
  const autosaveScenario = async () => {
    if (featureEditorsSealed.current || featureEditorsRetiring.current) return;
    if (!editing || !feature || !selected) return;
    if (autosaveInFlight.current) return; // the previous tick is still saving
    if (deletingScenario.current) return; // a delete is being confirmed or sent
    // The name is still being typed: saving now would put a half-typed name
    // on the draft (specs/editor/editor-autosave.feature.md "Autosave Waits
    // While the Name Is Being Typed"). The tick after focus moves on saves it.
    if (namingInProgress(nameFieldRef.current, document.activeElement)) return;
    // A scenario with no name has nothing to be saved under; the Save button
    // is disabled for the same reason.
    if (!editing.scenario.name.trim()) return;
    // A code fence is still being typed: the body ends inside it, so every
    // scenario heading after it would read as fenced content and the server
    // refuses the save rather than drop those scenarios
    // (specs/editor/editor-autosave.feature.md "Autosave Waits While a Code
    // Fence Is Open"). The tick after the fence closes saves it.
    if (unclosedFence(editing.scenario.body) !== null) return;
    const signature = scenarioSignature(editing.scenario, draftVersion);
    if (signature === autosaved.current) return;
    const session = editorSession.current;
    const before: Placement = {
      feature,
      index: editing.index,
      id: editing.scenario.id,
      insertAt: editing.insertAt,
    };
    const run = saveScenario(editing.scenario.tests, false);
    if (!run) return;
    // A save that meets this tick still away (the pane's parting save,
    // Propose) waits for it and places itself where it landed.
    const placed = run.then(
      (r) => r.placed,
      () => before,
    );
    autosaveInFlight.current = placed;
    try {
      // Only a landed save may mark the content saved — a failed one is
      // retried by the next tick, and reported on the banner meanwhile. A
      // save that lands after the dialog closed belongs to nothing.
      const { ok } = await run;
      if (ok && session === editorSession.current) autosaved.current = signature;
    } finally {
      if (autosaveInFlight.current === placed) autosaveInFlight.current = null;
    }
  };

  // The tick runs off a plain interval, so it fires on the defined cadence
  // however long the user keeps typing — a timer restarted per keystroke
  // would never come round while an edit is in flow.
  const autosaveTick = useRef(autosaveScenario);
  useEffect(() => {
    autosaveTick.current = autosaveScenario;
  });
  // A scenario added with `+` is in the feature from the moment its pane
  // opens, even if nothing is ever typed into its body: nothing counts as
  // saved yet, and one tick goes out right away. Should that tick stand down
  // (the name field holding the caret, say), the next one — or leaving the
  // pane — still saves it.
  useEffect(() => {
    if (!saveOnOpen.current || !editing) return;
    saveOnOpen.current = false;
    autosaved.current = null;
    void autosaveTick.current();
  }, [editing]);
  useEffect(() => {
    if (!editingOpen) return;
    const id = setInterval(() => void autosaveTick.current(), autosaveSeconds * 1000);
    return () => clearInterval(id);
  }, [editingOpen, autosaveSeconds]);

  /**
   * One autosave tick of the home README editor (app-startup.md
   * "App Starts with existing specs folder selected"): write what it holds,
   * unless that is already on disk. Same rules as the scenario editor — ticks
   * never overlap, only a landed save counts, a failed one is reported and
   * retried by the next tick.
   */
  const autosaveReadme = async () => {
    const content = readmeText.current;
    if (content === null || content === readmeSaved.current) return;
    const session = readmeSession.current;
    await readmeSaveQueue.current.run(async () => {
      // A tick queued ahead of this one may already have landed these words.
      const toWrite = readmeText.current;
      if (toWrite === null || toWrite === readmeSaved.current) return;
      // `from` is the text this buffer grew out of, so the server folds in a
      // disk edit the dirty editor has not shown. Without a base there is
      // nothing to fold against — a plain write.
      const from = readmeSaved.current;
      setSaving(true);
      try {
        const res = await fetch("/api/readme", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(from === null ? { content: toWrite } : { content: toWrite, from }),
        });
        const data = (await res.json().catch(() => ({}))) as { content?: string; error?: string };
        if (res.ok) {
          if (session === readmeSession.current) {
            // A folded disk edit can make the file differ from what went
            // out. Show it if the buffer has not moved on, so the next tick
            // does not treat the fold as a new edit of its own. If it has,
            // the buffer still grew out of what went out — keep that as the
            // base, and the next tick folds the disk edit in again rather
            // than writing over it.
            const written = typeof data.content === "string" ? data.content : toWrite;
            if (readmeText.current === toWrite) {
              readmeSaved.current = written;
              if (written !== toWrite) setReadme(written);
            } else {
              readmeSaved.current = toWrite;
            }
            markSaved();
          }
        } else {
          toast.error(`README.md not saved: ${data.error ?? res.statusText} — will retry.`);
        }
      } catch (e) {
        toast.error(`README.md not saved: ${(e as Error).message} — will retry.`);
      } finally {
        setSaving(false);
      }
    });
  };
  const readmeTick = useRef(autosaveReadme);
  useEffect(() => {
    readmeTick.current = autosaveReadme;
  });
  // Ticks run while the home view shows the README editor. Leaving it (a
  // feature opens) saves what was typed since the last tick, so nothing
  // written on the home view is lost to the navigation.
  const readmeOpen =
    !loading && !needsRepo && selected === null && pluginView === null && readme !== null;
  useEffect(() => {
    if (!readmeOpen) return;
    const id = setInterval(() => void readmeTick.current(), autosaveSeconds * 1000);
    return () => {
      clearInterval(id);
      void readmeTick.current();
    };
  }, [readmeOpen, autosaveSeconds]);

  /** Switch the sidebar to the Specs tab or a plugin's; the choice sticks. */
  const selectSidebarTab = (tab: SidebarTab) => {
    setSidebarTab(tab);
    storeSidebarTab(tab);
  };

  /**
   * Feature description editor (specs/editor/feature-editor.feature.md "Edit
   * feature descrition"). Opening seeds it with the description on the
   * feature, which counts as saved; nothing is written until it changes.
   */
  const openDescriptionEditor = (file: string, text: string) => {
    descSaved.current = text;
    setDescEdit({ file, text });
  };

  /**
   * One autosave tick of the description editor: save the feature with the
   * description it holds, unless that is what the server already has. Same
   * rules as the README editor — ticks never overlap, only a landed save
   * counts, a failed one is reported and retried by the next tick. The save
   * goes through the ordinary feature save, so the scenarios ride along
   * unchanged and the reload cron commits and pushes it.
   */
  const autosaveDescription = async () => {
    if (featureEditorsSealed.current) return;
    // `selected` and `feature` come from the closure, not from refs, and that
    // is what makes leaving a feature safe: React runs an effect's cleanup
    // before the effect bodies of the same commit, and the assignment that
    // refreshes `descTick` below has no dep array — so the cleanup tick still
    // holds the render in which this feature was the selected one. Reading
    // refs here would see the file the user moved *to* and drop the edit.
    const edit = descEditRef.current;
    if (!edit || !feature || edit.file !== selected) return;
    if (edit.text === descSaved.current) return;
    const next: Feature = { ...feature, description: edit.text.trim() };
    const content = serializeFeature(next);
    await descSaveQueue.current.run(async () => {
      // A tick queued ahead of this one may already have landed these words.
      if (edit.text === descSaved.current) return;
      setSaving(true);
      try {
        const res = await fetch(`/api/features/${encodeURIComponent(edit.file)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, save: true }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          content?: string;
          parsed?: Feature;
          error?: string;
        };
        if (res.ok && typeof data.content === "string") {
          // The editor may have closed, or moved to another feature, while the
          // save was away: then its result belongs to nothing on screen.
          if (descEditRef.current?.file === edit.file) descSaved.current = edit.text;
          if (selectedRef.current === edit.file) {
            setFeature(
              featureFromResponse({ content: data.content, parsed: data.parsed }, edit.file),
            );
            markSaved();
          }
        } else {
          toast.error(`Description not saved: ${data.error ?? res.statusText} — will retry.`);
        }
      } catch (e) {
        toast.error(`Description not saved: ${(e as Error).message} — will retry.`);
      } finally {
        setSaving(false);
      }
    });
  };
  const descTick = useRef(autosaveDescription);
  useEffect(() => {
    descTick.current = autosaveDescription;
  });
  // Ticks run while the selected feature's description editor is on. Leaving
  // it — Done, or navigating to another feature or home — saves what was typed
  // since the last tick, then drops an editor left behind by navigation.
  const descOpen = descEdit !== null && descEdit.file === selected;
  useEffect(() => {
    if (!descOpen) return;
    const id = setInterval(() => {
      if (featureEditorsRetiring.current || featureEditorsSealed.current) return;
      void descTick.current();
    }, autosaveSeconds * 1000);
    return () => {
      clearInterval(id);
      if (!featureEditorsSealed.current) void descTick.current();
      if (descEditRef.current && descEditRef.current.file !== selectedRef.current) setDescEdit(null);
    };
  }, [descOpen, autosaveSeconds]);

  /** Done: land what the editor holds and show the description rendered. */
  const closeDescriptionEditor = async () => {
    await descTick.current();
    setDescEdit(null);
  };

  // Avatar initials: from the git name when set, else the OS user name
  // (specs/user-info-settings.feature.md).
  const initials = (user?.name || user?.username || "?")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // The Settings page's fields start from what is saved each time it opens
  // — after the render that opened it, so a deep link to /settings reads
  // the state the boot just loaded. A layout effect, so the fields never
  // paint with their defaults first.
  const settingsShown = appPage === "settings";
  const confluenceFolderOpen = confluenceFolder !== null;
  // The Confluence wikis this device holds a token for: read when Settings
  // or a publish dialog opens, so a token added in one shows in the other.
  useEffect(() => {
    if (
      hosted ||
      (!settingsShown && !confluencePublishOpen && !confluenceFolderOpen && !wikiQtestPublishOpen && importOpen === null)
    )
      return;
    let live = true;
    void fetchConfluenceTokens().then((wikis) => {
      if (live) setConfluenceWikis(wikis);
    });
    return () => {
      live = false;
    };
  }, [hosted, settingsShown, confluencePublishOpen, confluenceFolderOpen, wikiQtestPublishOpen, importOpen]);
  // The Jira sites this device holds a token for, read the same way.
  useEffect(() => {
    if (hosted || (!settingsShown && importOpen === null)) return;
    let live = true;
    void fetchJiraTokens().then((sites) => {
      if (live) setJiraSites(sites);
    });
    return () => {
      live = false;
    };
  }, [hosted, settingsShown, importOpen]);
  // The qTest sites this device holds a token for, read the same way.
  useEffect(() => {
    if (hosted || (!settingsShown && !qtestPublishOpen && !wikiQtestPublishOpen)) return;
    let live = true;
    void fetchQtestTokens().then((sites) => {
      if (live) setQtestSites(sites);
    });
    return () => {
      live = false;
    };
  }, [hosted, settingsShown, qtestPublishOpen, wikiQtestPublishOpen]);
  // The Aha! sites this device holds an API key for, read the same way.
  useEffect(() => {
    if (hosted || (!settingsShown && ahaImportOpen === null)) return;
    let live = true;
    void fetchAhaTokens().then((sites) => {
      if (live) setAhaSites(sites);
    });
    return () => {
      live = false;
    };
  }, [hosted, settingsShown, ahaImportOpen]);
  useLayoutEffect(() => {
    if (!settingsShown) return;
    // A stored 0 means autosync is off; the field keeps a usable frequency so
    // switching it back on needs no typing.
    setSettingsAutosyncOnDraft(reloadSeconds > 0);
    setSettingsDraft(String(reloadSeconds > 0 ? reloadSeconds : DEFAULT_AUTOSYNC_SECONDS));
    setSettingsLinesDraft(String(previewLines));
    setSettingsAutosaveDraft(String(autosaveSeconds));
    setSettingsTestLinksDraft(showTestLinks);
    setSettingsOpenInIdeaDraft(openTestsInIdea);
    setSettingsGhosttyDraft(ghosttyOn);
    setSettingsProjectManagementDraft(projectManagement);
    setSettingsToolDraft(projectManagementTool);
    setSettingsPublishLinksDraft(publishExternalLinks);
    setSettingsResourceLinksDraft(resourceLinksOn);
    setSettingsQtestLinksDraft(qtestLinks);
    setSettingsAhaImportDraft(ahaImportOn);
    setSettingsJiraEnabledDraft(jiraEnabledOn);
    setSettingsConfluenceEnabledDraft(confluenceEnabledOn);
    setSettingsCodeGenDraft(codeGen);
    setSettingsDeletePublishedDraft(deletePublished);
    setSettingsAssignmentsDraft(assignments);
    setSettingsFeatureFlagsDraft(featureFlags);
    setSettingsScenarioPolarityDraft(scenarioPolarity);
    setSettingsGithubAccountDraft(githubAccount);
    setSettingsGoogleCalendarDraft(googleCalendarOn);
    setSettingsSyncDraft(syncServerUrl ?? DEFAULT_SYNC_SERVER_URL);
    setSettingsSyncOnDraft(syncServerUrl !== null);
    setSettingsError(null);
    setAuthStatus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsShown]);

  // Browser sign-in (git-operations.md "connect to GitHub via the
  // browser"): the server hands back GitHub's authorize url, the browser
  // opens it in a new tab, and GitHub redirects back to the server. In the
  // desktop shell the window-open handler sends the url to the default
  // browser. Not offered on app:// pages — there is no http callback there.
  const canConnectViaBrowser = /^https?:$/.test(window.location.protocol);
  const connectGitHub = async () => {
    setAuthStatus(null);
    const res = await fetch("/api/auth/github/web/start", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      window.open(data.authorizeUrl, "_blank", "noopener");
      setWebConnecting(true);
    } else {
      setAuthStatus(data.error ?? "Could not start GitHub sign-in");
    }
  };

  // GitHub sign-in (git-operations.md): start the device flow,
  // show the code, and poll until GitHub reports a decision. The poll
  // lives in an effect so closing the dialog stops it.
  const startSignIn = async () => {
    setAuthStatus(null);
    setWebConnecting(false);
    const res = await fetch("/api/auth/github/start", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      setDeviceFlow({
        userCode: data.userCode,
        verificationUri: data.verificationUri,
        interval: data.interval || 5,
      });
    } else {
      setAuthStatus(data.error ?? "Could not start GitHub sign-in");
    }
  };

  const refreshUser = async () => {
    const state = await (await fetch("/api/state")).json();
    if (state.user) setUser(state.user);
    setGh(state.gh ?? null);
    applyUpdateAvailable(state);
  };

  // Signing out also stops the app using the GitHub CLI's account
  // (specs/user-info-settings.feature.md); Settings can turn it back on.
  const signOutGitHub = async () => {
    await fetch("/api/auth/github", { method: "DELETE" });
    setAuth({ signedIn: false });
    await refreshUser();
  };

  // "View settings file…": User info gives way to the wider read-only view,
  // which reads the file afresh each time it opens.
  const openSettingsFile = async () => {
    setUserInfoOpen(false);
    setSettingsFile(null);
    setSettingsFileError(null);
    setSettingsFileOpen(true);
    try {
      const res = await fetch("/api/settings-file");
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setSettingsFile(body as SettingsFile);
    } catch (err) {
      setSettingsFileError(err instanceof Error ? err.message : String(err));
    }
  };

  // A token pasted in Settings or the user menu's dialog is the sign-in now.
  const signedInWithToken = (signedIn: AuthInfo) => {
    setAuth(signedIn);
    setAuthStatus(null);
    void refreshUser();
  };

  useEffect(() => {
    if (!settingsShown) {
      setDeviceFlow(null);
      setWebConnecting(false);
      setAuthStatus(null);
    }
  }, [settingsShown]);

  // While the browser tab is with GitHub, poll for the callback's outcome.
  useEffect(() => {
    if (!webConnecting) return;
    let stopped = false;
    const id = setInterval(async () => {
      const res = await fetch("/api/auth/github/web/poll", { method: "POST" });
      const data = await res.json();
      if (stopped) return;
      if (!res.ok) {
        setWebConnecting(false);
        setAuthStatus(data.error ?? "GitHub sign-in failed");
        return;
      }
      if (data.status === "authorized") {
        setWebConnecting(false);
        setAuth({ signedIn: true, ...data.user });
        void refreshUser();
      } else if (data.status === "denied") {
        setWebConnecting(false);
        setAuthStatus(data.error ?? "Sign-in was denied on GitHub.");
      } else if (data.status === "expired") {
        setWebConnecting(false);
        setAuthStatus("The sign-in expired — try again.");
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [webConnecting]);

  useEffect(() => {
    if (!deviceFlow) return;
    let stopped = false;
    const id = setInterval(async () => {
      const res = await fetch("/api/auth/github/poll", { method: "POST" });
      const data = await res.json();
      if (stopped) return;
      if (!res.ok) {
        setDeviceFlow(null);
        setAuthStatus(data.error ?? "GitHub sign-in failed");
        return;
      }
      if (data.status === "authorized") {
        setDeviceFlow(null);
        setAuth({ signedIn: true, ...data.user });
        void refreshUser();
      } else if (data.status === "denied") {
        setDeviceFlow(null);
        setAuthStatus("Sign-in was denied on GitHub.");
      } else if (data.status === "expired") {
        setDeviceFlow(null);
        setAuthStatus("The sign-in code expired — try again.");
      }
    }, deviceFlow.interval * 1000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [deviceFlow]);

  // Settings save themselves the moment a control changes (macOS style —
  // there is no Save button; specs/ui/ui.feature.md "Settings"). Each change
  // PUTs only its own field; the response carries the full normalized state, so
  // local state follows whatever the server accepted.
  const patchSettings = async (patch: Record<string, unknown>): Promise<boolean> => {
    setSettingsError(null);
    const res = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) {
      setSettingsError(data.error ?? "Could not save settings");
      return false;
    }
    setReloadSeconds(data.reloadFrequencySeconds);
    setPreviewLines(data.scenarioPreviewLines);
    setAutosaveSeconds(data.autosaveIntervalSeconds);
    setShowTestLinks(data.showTestLinks !== false);
    setOpenTestsInIdea(data.openTestsInIdea === true);
    setCanOpenInIdea(Boolean(data.canOpenInIdea));
    setGhosttyOn(data.ghostty === true);
    setCanOpenGhostty(Boolean(data.canOpenGhostty));
    setPublishExternalLinks(data.publishExternalLinks !== false);
    setProjectManagement(data.projectManagement !== false);
    if (typeof data.projectManagementTool === "string") {
      setProjectManagementTool(data.projectManagementTool);
    }
    setResourceLinksOn(resourceLinkSwitches(data));
    setAhaImportOn(data.ahaImport === true);
    setJiraEnabledOn(data.jiraEnabled === true);
    setConfluenceEnabledOn(data.confluenceEnabled === true);
    setQtestLinks(data.qtestLinks === true);
    setQtestParentUrl(typeof data.qtestParentUrl === "string" ? data.qtestParentUrl : "");
    // Switched off, a selection left over from before must not linger as a
    // session waiting to be started.
    if (data.codeGen === false) setSpecSelection(new Map());
    setCodeGen(data.codeGen !== false);
    setCanOpenClaudeDesktop(Boolean(data.canOpenClaudeDesktop));
    setCodeGenTarget(readCodeGenTarget(data.codeGenTarget, agentChat.applyState(data)));
    setDeletePublished(data.deletePublished === true);
    setAssignments(data.assignments === true);
    setFeatureFlags(data.featureFlags === true);
    setScenarioPolarity(data.scenarioPolarity === true);
    setGithubAccount(data.githubAccount === true);
    // The profile's plugins mount and unmount to match, in its order — a
    // tab appears, goes or moves before this returns (src/plugins/client/
    // loader.ts).
    setPlugins(Array.isArray(data.plugins) ? data.plugins : []);
    setPluginSources(Array.isArray(data.pluginSources) ? data.pluginSources : []);
    setPluginMarketplaces(Array.isArray(data.pluginMarketplaces) ? data.pluginMarketplaces : []);
    // An agent plugin installed, updated or rebuilt arrives here, not through
    // a Settings change: without this the pane button stayed hidden until a
    // reload.
    agentChat.applyState(data);
    await syncClientPlugins(data.plugins, { demo: Boolean(data.demo), settings: data });
    setSettingsPayload(data);
    // The mounted ones follow the other switches they read — the tasks'
    // calendar chip follows Google Calendar's, say.
    client.emit("settings/changed", data);
    setGoogleCalendarOn(data.googleCalendar === true);
    setSyncServerUrl(typeof data.syncServerUrl === "string" ? data.syncServerUrl : null);
    setGitAccess(typeof data.gitAccess === "string" ? data.gitAccess : null);
    setCliGitAvailable(Boolean(data.cliGitAvailable));
    setGh(data.gh ?? null);
    // The Git access decides which account authors commits, so the user
    // corner can be showing the wrong one now.
    if (patch.gitAccess !== undefined || patch.githubAccount !== undefined) await refreshUser();
    return true;
  };

  /** A number field's usable value: floored, at least min, else the fallback. */
  const clampDraft = (draft: string, min: number, fallback: number) => {
    const n = Math.floor(Number(draft));
    return Number.isFinite(n) && n >= min ? n : fallback;
  };

  // The number fields clamp and save when the field is left (blur or Enter),
  // never mid-typing — otherwise "15" would save as "1" on the way.
  const commitAutosyncSeconds = async () => {
    const n = clampDraft(settingsDraft, 1, DEFAULT_AUTOSYNC_SECONDS);
    setSettingsDraft(String(n));
    if (settingsAutosyncOnDraft) await patchSettings({ reloadFrequencySeconds: n });
  };

  // The switch decides whether autosync runs; a frequency of 0 stops it. The
  // field keeps its frequency while off, so switching back on needs no typing.
  const toggleAutosync = async (on: boolean) => {
    setSettingsAutosyncOnDraft(on);
    const n = clampDraft(settingsDraft, 1, DEFAULT_AUTOSYNC_SECONDS);
    setSettingsDraft(String(n));
    if (!(await patchSettings({ reloadFrequencySeconds: on ? n : 0 }))) {
      setSettingsAutosyncOnDraft(!on);
    }
  };

  const commitAutosaveSeconds = async () => {
    const n = clampDraft(settingsAutosaveDraft, MIN_AUTOSAVE_SECONDS, DEFAULT_AUTOSAVE_SECONDS);
    setSettingsAutosaveDraft(String(n));
    await patchSettings({ autosaveIntervalSeconds: n });
  };

  const commitPreviewLines = async () => {
    const n = clampDraft(settingsLinesDraft, 1, previewLines);
    setSettingsLinesDraft(String(n));
    await patchSettings({ scenarioPreviewLines: n });
  };

  // The switch decides on/off; the url only travels while it is on. An empty
  // url is the stored form of "off"
  // (specs/datastore/automerge-store.feature.md).
  const toggleLiveSync = async (on: boolean) => {
    setSettingsSyncOnDraft(on);
    if (!on) {
      if (!(await patchSettings({ syncServerUrl: "" }))) setSettingsSyncOnDraft(true);
      return;
    }
    const url = settingsSyncDraft.trim();
    if (/^wss?:\/\//.test(url)) await patchSettings({ syncServerUrl: url });
  };

  const commitSyncUrl = async () => {
    if (!settingsSyncOnDraft) return;
    const url = settingsSyncDraft.trim();
    if (!/^wss?:\/\//.test(url)) {
      setSettingsError("Enter a ws:// or wss:// sync server url, or switch live sync off.");
      return;
    }
    await patchSettings({ syncServerUrl: url });
  };

  const toggleTestLinks = async (on: boolean) => {
    setSettingsTestLinksDraft(on);
    if (!(await patchSettings({ showTestLinks: on }))) setSettingsTestLinksDraft(!on);
  };

  const toggleOpenInIdea = async (on: boolean) => {
    setSettingsOpenInIdeaDraft(on);
    if (!(await patchSettings({ openTestsInIdea: on }))) setSettingsOpenInIdeaDraft(!on);
  };

  const toggleGhostty = async (on: boolean) => {
    setSettingsGhosttyDraft(on);
    if (!(await patchSettings({ ghostty: on }))) setSettingsGhosttyDraft(!on);
  };

  // With the setting on, a click on any test link — the card's table, the
  // editor pane's list, an inline [test:…] reference in a preview — goes to
  // IDEA instead of the browser. One listener for all of them, on the
  // document, since the preview's links are rendered without a handler.
  // When the IDE can't take it (no `idea` on PATH, no code repo, file not
  // there) the reason is toasted and the link opens on GitHub after all.
  useEffect(() => {
    if (!openTestsInIdea) return;
    const onClick = (e: globalThis.MouseEvent) => {
      const a = testLinkTarget(e);
      if (!a) return;
      e.preventDefault();
      const url = a.href;
      void openTestInIdea(url).then((error) => {
        if (!error) return;
        toast.error(error);
        window.open(url, "_blank", "noreferrer");
      });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [openTestsInIdea]);

  // Project management (specs/external-links/project-management-jira-linear-
  // etc.feature.md): the switch decides whether the app tracks tickets at
  // all. Off, the ticket chips and fields go — the links already recorded
  // stay in the documents, and come back when it is switched on again.
  const toggleProjectManagement = async (on: boolean) => {
    setSettingsProjectManagementDraft(on);
    if (!(await patchSettings({ projectManagement: on }))) {
      setSettingsProjectManagementDraft(!on);
    }
  };

  // The tool the tickets live in: picked from the list, or typed when it is
  // one the list doesn't offer. A blank name is not saved — the field is
  // being typed into; the stored tool stands until it holds a usable name.
  const changeTool = async (name: string) => {
    setSettingsToolDraft(name);
    if (!name.trim()) return;
    await patchSettings({ projectManagementTool: cleanLine(name) });
  };

  // Publish external links (specs/external-links/project-management-jira-
  // linear-etc.feature.md): the server rewrites every feature file to the
  // new form at once; the open feature is re-read so the page follows — an
  // editor pane open on it (Settings is reachable beside the pane) leaves
  // with its last save, like any other re-open.
  const toggleExternalLinks = async (on: boolean) => {
    setSettingsPublishLinksDraft(on);
    if (!(await patchSettings({ publishExternalLinks: on }))) {
      setSettingsPublishLinksDraft(!on);
    } else if (selected) {
      await openFeature(selected);
    }
  };

  // Aha! and Figma links (specs/external-links/aha-and-figma-links
  // .feature.md): off takes the tool's chip, field and lists away; the links
  // already recorded stay in the documents and come back when it is on again.
  // qTest test case links (specs/external-links/qtest-test-cases.feature.md):
  // off takes the chip and field away; the links already recorded stay.
  const toggleQtestLinks = async (on: boolean) => {
    setSettingsQtestLinksDraft(on);
    if (!(await patchSettings({ qtestLinks: on }))) setSettingsQtestLinksDraft(!on);
  };

  // Import from Aha! (specs/external-links/aha-import.feature.md "Import from
  // Aha! is switched on in Settings"): off takes the folder menu item, the
  // header button and the palette command away; the API keys stay.
  const toggleAhaImport = async (on: boolean) => {
    setSettingsAhaImportDraft(on);
    if (!(await patchSettings({ ahaImport: on }))) setSettingsAhaImportDraft(!on);
  };

  // Jira (specs/external-links/jira-wiki-import.feature.md "Jira and Confluence
  // imports are switched on in Settings"): off takes the Jira import menu item
  // away; the tokens stay.
  const toggleJiraEnabled = async (on: boolean) => {
    setSettingsJiraEnabledDraft(on);
    if (!(await patchSettings({ jiraEnabled: on }))) setSettingsJiraEnabledDraft(!on);
  };

  // Confluence (specs/external-links/confluence-wiki.feature.md): off takes
  // "Publish to Confluence…", the Confluence import and the agent's wiki MCP
  // server away; the tokens stay.
  const toggleConfluenceEnabled = async (on: boolean) => {
    setSettingsConfluenceEnabledDraft(on);
    if (!(await patchSettings({ confluenceEnabled: on }))) setSettingsConfluenceEnabledDraft(!on);
  };

  const toggleResourceLinks = async (kind: ResourceLinkKind, on: boolean) => {
    setSettingsResourceLinksDraft((prev) => ({ ...prev, [kind]: on }));
    if (!(await patchSettings({ [RESOURCE_LINK_SETTING[kind]]: on }))) {
      setSettingsResourceLinksDraft((prev) => ({ ...prev, [kind]: !on }));
    }
  };

  const toggleCodeGen = async (on: boolean) => {
    setSettingsCodeGenDraft(on);
    if (!(await patchSettings({ codeGen: on }))) setSettingsCodeGenDraft(!on);
  };

  const toggleDeletePublished = async (on: boolean) => {
    setSettingsDeletePublishedDraft(on);
    if (!(await patchSettings({ deletePublished: on }))) setSettingsDeletePublishedDraft(!on);
  };

  // Authorship in the markdown (specs/app/specs-authorship.feature.md): a
  // setting of the data repo, not of this device — written into its
  // project-settings.json, and every feature file rewritten on the spot.
  const toggleAuthorsInMarkdown = async (on: boolean) => {
    setSettingsError(null);
    const before = authorsInMarkdown;
    setAuthorsInMarkdown(on);
    const res = await fetch("/api/project-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorsInMarkdown: on }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      authorsInMarkdown?: boolean;
      error?: string;
    };
    if (!res.ok) {
      setSettingsError(data.error ?? "Could not save the data folder's settings");
      setAuthorsInMarkdown(before);
      return;
    }
    setAuthorsInMarkdown(data.authorsInMarkdown === true);
  };

  const toggleAssignments = async (on: boolean) => {
    setSettingsAssignmentsDraft(on);
    if (!(await patchSettings({ assignments: on }))) setSettingsAssignmentsDraft(!on);
  };

  const toggleFeatureFlags = async (on: boolean) => {
    setSettingsFeatureFlagsDraft(on);
    if (!(await patchSettings({ featureFlags: on }))) setSettingsFeatureFlagsDraft(!on);
  };

  const toggleScenarioPolarity = async (on: boolean) => {
    setSettingsScenarioPolarityDraft(on);
    if (!(await patchSettings({ scenarioPolarity: on }))) setSettingsScenarioPolarityDraft(!on);
  };

  const toggleGithubAccount = async (on: boolean) => {
    setSettingsGithubAccountDraft(on);
    if (!(await patchSettings({ githubAccount: on }))) setSettingsGithubAccountDraft(!on);
  };

  // The profile (specs/app/plugins.feature.md "Turning a plugin off unwinds
  // everything it registered", "The profile lists enabled plugins in tab
  // order"): Settings → Plugins edits the ordered list of enabled plugins
  // and sends it whole. The server mounts and unmounts to match — a special
  // folder is created when its plugin goes on — and the browser follows in
  // patchSettings: a tab appears, goes or moves, and an open view of a
  // plugin now off leaves the pane. The data in the repo is left alone.
  const enabledPluginIds = () => plugins.filter((p) => p.enabled).map((p) => p.id);
  const setProfile = async (enabled: string[]) => {
    const previous = plugins;
    // Optimistic, like every switch: the rows re-order at once, and snap
    // back if the server refuses.
    setPlugins((rows) => {
      const byId = new Map(rows.map((r) => [r.id, r]));
      const on = enabled.map((id) => ({ ...(byId.get(id) ?? { id }), enabled: true }));
      const off = rows.filter((r) => !enabled.includes(r.id)).map((r) => ({ ...r, enabled: false }));
      return [...on, ...off];
    });
    if (!(await patchSettings({ plugins: { enabled } }))) setPlugins(previous);
  };
  const setPluginEnabled = (id: string, on: boolean) => {
    const rest = enabledPluginIds().filter((x) => x !== id);
    return setProfile(on ? [...rest, id] : rest);
  };
  /** Move an enabled plugin one place up (-1) or down (+1) in tab order. */
  const movePlugin = (id: string, delta: -1 | 1) => {
    const enabled = enabledPluginIds();
    const i = enabled.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= enabled.length) return Promise.resolve();
    const next = [...enabled];
    next.splice(i, 1);
    next.splice(j, 0, id);
    return setProfile(next);
  };

  // Google Calendar (specs/app/tasks.feature.md "Add task to Google
  // Calendar"): switched on, every task's header carries the calendar chip;
  // off, the chip goes and nothing else changes — the estimates already on
  // tasks stay in their files.
  const toggleGoogleCalendar = async (on: boolean) => {
    setSettingsGoogleCalendarDraft(on);
    if (!(await patchSettings({ googleCalendar: on }))) {
      setSettingsGoogleCalendarDraft(!on);
      return;
    }
    setGoogleCalendarOn(on);
  };

  /** The Git access the radios show; the account sign-in only while its switch is on. */
  const settingsAccessShown = accessShown(gitAccess, Boolean(gh?.available), settingsGithubAccountDraft);
  const pickGitAccess = async (access: GitAccess) => {
    const prev = gitAccess;
    setGitAccess(access);
    if (!(await patchSettings({ gitAccess: access }))) setGitAccess(prev);
  };

  // The dialog's "Automated tests" list editor (specs/traceability.feature.md);
  // the rules for what may go in a row live in ./testlinks.
  const setTests = (tests: string[]) => {
    if (!editing) return;
    setEditing({ ...editing, scenario: { ...editing.scenario, tests } });
  };

  // The dialog's "Ticket link" fields (specs/external-links/project-
  // management-jira-linear-etc.feature.md): typed into a draft; the moment
  // the fields make a whole link — or are all cleared — the scenario follows,
  // so autosave and closing carry the link like any other edit. A half-filled
  // draft stays in the fields until an explicit save, which it blocks.
  const changeLinkDraft = (draft: LinkDraft) => {
    setLinkDraft(draft);
    if (!editing) return;
    const resolved = resolveLinkDraft(draft);
    if (resolved.error) return;
    const { link: _previous, ...rest } = editing.scenario;
    setEditing({ ...editing, scenario: resolved.link ? { ...rest, link: resolved.link } : rest });
  };

  // The dialog's "qTest test case" fields
  // (specs/external-links/qtest-test-cases.feature.md), following the
  // scenario the same way as the ticket link's.
  const changeQtestDraft = (draft: LinkDraft) => {
    setQtestDraft(draft);
    if (!editing) return;
    const resolved = resolveQtestDraft(draft);
    if (resolved.error) return;
    const { qtest: _previous, ...rest } = editing.scenario;
    setEditing({ ...editing, scenario: resolved.link ? { ...rest, qtest: resolved.link } : rest });
  };

  /**
   * Save the feature's own ticket link (specs/external-links/project-
   * management-jira-linear-etc.feature.md "Add link to feature"): the feature
   * is saved like any scenario edit — locally, marked [proposed] where
   * applicable, pushed by the reload cron — with the link set or cleared.
   */
  /**
   * The feature's own flags (specs/app/feature-flags.feature.md), saved on
   * the spot from the header's popover — written into the `.feature.md` like
   * the ticket link.
   */
  const saveFeatureFlags = async (flags: FeatureFlag[]) => {
    if (!feature || !selected) return;
    const { flags: _previous, ...rest } = feature;
    const next: Feature = flags.length > 0 ? { ...rest, flags } : rest;
    setFeature(next);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeature(featureFromResponse(data, selected));
        setDirty(false);
        markSaved();
      } else {
        setFeature(feature);
        toast.error(data.error ?? "Could not save the feature flags");
      }
    } catch {
      setFeature(feature);
      toast.error("Could not save the feature flags — is the server running?");
    }
  };

  /**
   * The feature's own custom attributes (specs/app/custom-attributes.feature.md),
   * saved on the spot from the header's popover like the flags.
   */
  const saveFeatureAttributes = async (attributes: SpecAttribute[]) => {
    if (!feature || !selected) return;
    const { attributes: _previous, ...rest } = feature;
    const next: Feature = attributes.length > 0 ? { ...rest, attributes } : rest;
    setFeature(next);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeature(featureFromResponse(data, selected));
        setDirty(false);
        markSaved();
      } else {
        setFeature(feature);
        toast.error(data.error ?? "Could not save the attributes");
      }
    } catch {
      setFeature(feature);
      toast.error("Could not save the attributes — is the server running?");
    }
  };

  /**
   * Set the feature's tickets (specs/external-links/project-management-jira-
   * linear-etc.feature.md "Several tickets on a feature"): the whole list to
   * the tickets route, which saves it from the server's own view of the
   * feature — the markdown changes with it when links are published, so it
   * is a save, not a document-only write like the pull requests'.
   */
  const saveFeatureTickets = async (links: TicketLink[]) => {
    if (!feature || !selected) return;
    const before = feature.links ?? [];
    const added = links.find((l) => !before.includes(l));
    const removed = before.find((l) => !links.includes(l));
    setFeatureTicketsSaving(true);
    setFeatureTicketsError(null);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}/tickets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeature(featureFromResponse(data, selected));
        setDirty(false);
        toast.success(
          added
            ? `Linked ${externalLinkLabel(added)} — ${data.message}.`
            : removed
              ? `Removed ${externalLinkLabel(removed)} — ${data.message}.`
              : `Tickets saved — ${data.message}.`,
        );
        markSaved();
      } else {
        setFeatureTicketsError(data.error ?? "Could not save the tickets");
      }
    } catch {
      setFeatureTicketsError("Could not save the tickets — is the server running?");
    } finally {
      setFeatureTicketsSaving(false);
    }
  };

  /**
   * Save the feature's own qTest test case link
   * (specs/external-links/qtest-test-cases.feature.md), the way
   * saveFeatureLink saves its ticket.
   */
  const saveFeatureQtest = async () => {
    if (!feature || !selected || featureQtestDraft === null) return;
    const resolved = resolveQtestDraft(featureQtestDraft);
    if (resolved.error) {
      setFeatureQtestError(resolved.error);
      return;
    }
    const { qtest: _previous, ...rest } = feature;
    const next: Feature = resolved.link ? { ...rest, qtest: resolved.link } : rest;
    setFeatureQtestSaving(true);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeature(featureFromResponse(data, selected));
        setDirty(false);
        setFeatureQtestDraft(null);
        toast.success(
          resolved.link
            ? `Linked ${externalLinkLabel(resolved.link)} — ${data.message}.`
            : `Test case link removed — ${data.message}.`,
        );
        markSaved();
      } else {
        setFeatureQtestError(data.error ?? "Could not save the test case link");
      }
    } catch {
      setFeatureQtestError("Could not save the test case link — is the server running?");
    } finally {
      setFeatureQtestSaving(false);
    }
  };

  /**
   * Save the pull requests linked to the feature (`target` null) or to one
   * scenario (specs/external-links/related-pull-requests.feature.md): a
   * document-only write through its own route — the links never ride in
   * the markdown a save sends — answered with the editor's view, which the
   * page and an open editor pane follow. Nothing to autosave: every add and
   * remove is saved on the spot.
   */
  const savePullRequests = async (target: ScenarioTarget | null, prs: PullRequestLink[]) => {
    if (!selected) return;
    const file = selected;
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}/pull-requests`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: target, prs }),
      });
      const data = await res.json();
      if (selectedRef.current !== file) return;
      if (res.ok) {
        setFeature(featureFromResponse(data, file));
        if (target) {
          setEditing((prev) =>
            prev === null || prev.scenario.id !== target.id
              ? prev
              : { ...prev, scenario: { ...prev.scenario, prs } },
          );
        }
        markSaved();
      } else {
        toast.error(data.error ?? "Could not save the pull requests");
      }
    } catch {
      toast.error("Could not save the pull requests — is the server running?");
    }
  };

  /**
   * Save the Aha! or Figma links of the feature (`target` null) or of one
   * scenario (specs/external-links/aha-and-figma-links.feature.md): a
   * document-only write through its own route, like the pull requests'.
   */
  const saveResourceLinks = async (
    target: ScenarioTarget | null,
    kind: ResourceLinkKind,
    links: ResourceLink[],
  ) => {
    if (!selected) return;
    const file = selected;
    const { name } = RESOURCE_LINK_TOOLS[kind];
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}/links/${kind}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: target, links }),
      });
      const data = await res.json();
      if (selectedRef.current !== file) return;
      if (res.ok) {
        setFeature(featureFromResponse(data, file));
        if (target) {
          setEditing((prev) =>
            prev === null || prev.scenario.id !== target.id
              ? prev
              : { ...prev, scenario: { ...prev.scenario, [kind]: links } },
          );
        }
        markSaved();
      } else {
        toast.error(data.error ?? `Could not save the ${name} links`);
      }
    } catch {
      toast.error(`Could not save the ${name} links — is the server running?`);
    }
  };

  /**
   * Follow a files route's answer (specs/editor/store-associated-files
   * .feature.md): the page and an open editor pane take the scenario's new
   * list. True when it was saved.
   */
  const followScenarioFiles = async (
    res: Response,
    file: string,
    target: ScenarioTarget,
    failure: string,
  ): Promise<boolean> => {
    const data = await res.json();
    if (selectedRef.current !== file) return res.ok;
    if (!res.ok) {
      toast.error(data.error ?? failure);
      return false;
    }
    const next = featureFromResponse(data, file);
    setFeature(next);
    const saved = next.scenarios.find((s) =>
      target.id !== undefined ? s.id === target.id : s.name === target.name && s.version === target.version,
    );
    setEditing((prev) =>
      prev === null || prev.scenario.id !== target.id
        ? prev
        : { ...prev, scenario: { ...prev.scenario, files: saved?.files ?? [] } },
    );
    markSaved();
    return true;
  };

  /**
   * Upload files chosen for a scenario, one request each: the bytes are
   * stored in the data repo and the scenario lists them by name. A chosen
   * file named like one already listed replaces its contents — after a
   * confirm, unless the Replace button is what chose it (`replacing`).
   */
  const uploadScenarioFiles = async (
    target: ScenarioTarget | null,
    listed: ScenarioFile[],
    chosen: File[],
    replacing?: string,
  ) => {
    if (!selected || !target) return;
    const file = selected;
    if (replacing === undefined) {
      const clashes = chosen.filter((c) => listed.some((f) => f.name === c.name)).map((c) => c.name);
      if (clashes.length > 0) {
        const ok = await confirm({
          title: clashes.length === 1 ? `Replace "${clashes[0]}"?` : `Replace ${clashes.length} files?`,
          body: `This scenario already has ${clashes.map((n) => `"${n}"`).join(", ")}. The upload replaces the contents.`,
          confirmLabel: "Replace",
        });
        if (!ok) return;
      }
    }
    for (const one of chosen) {
      const form = new FormData();
      form.append("file", one);
      form.append("scenario", JSON.stringify(target));
      if (replacing !== undefined) form.append("name", replacing);
      try {
        const res = await fetch(`/api/features/${encodeURIComponent(file)}/scenario-files`, {
          method: "POST",
          body: form,
        });
        const ok = await followScenarioFiles(res, file, target, `Could not upload ${one.name}`);
        if (!ok) return;
      } catch {
        toast.error(`Could not upload ${one.name} — is the server running?`);
        return;
      }
    }
  };

  /** Save a scenario's file list after a rename or a removal. */
  const saveScenarioFileList = async (target: ScenarioTarget | null, files: ScenarioFile[]) => {
    if (!selected || !target) return;
    const file = selected;
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}/scenario-files`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: target, files }),
      });
      await followScenarioFiles(res, file, target, "Could not save the files");
    } catch {
      toast.error("Could not save the files — is the server running?");
    }
  };

  /**
   * The project members the "Assigned" dropdown offers: the data repo's
   * project-settings.json (src/server/members.ts), plus whoever the feature
   * is assigned to when that name is no longer on the list — a member who
   * left the project must still show, or opening the feature would silently
   * look unassigned.
   */
  const assignableMembers = (): ProjectMember[] => {
    const assigned = feature?.assigned;
    if (!assigned || members.some((m) => m.name === assigned)) return members;
    return [...members, { name: assigned }];
  };

  /**
   * Assign the feature to a project member, or to nobody (the empty choice).
   * Saved like the feature's ticket link: locally, right away, pushed by the
   * reload cron — the name lands in the file's `**Assigned:**` line.
   */
  const saveAssigned = async (name: string) => {
    if (!feature || !selected) return;
    const assigned = name.trim();
    if ((feature.assigned ?? "") === assigned) return;
    const { assigned: _previous, ...rest } = feature;
    const next: Feature = assigned ? { ...rest, assigned } : rest;
    setAssignedSaving(true);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeature(featureFromResponse(data, selected));
        setDirty(false);
        toast.success(
          assigned ? `Assigned to ${assigned} — ${data.message}.` : `Assignment cleared — ${data.message}.`,
          { action: { label: "Undo", run: () => void saveAssigned(_previous ?? "") } },
        );
        markSaved();
      } else {
        toast.error(data.error ?? "Could not save the assignment");
      }
    } catch {
      toast.error("Could not save the assignment — is the server running?");
    } finally {
      setAssignedSaving(false);
    }
  };

  /**
   * Fill a Name field from the code on GitHub (specs/external-links/
   * test-traceability.feature.md "the test name is read from the code on
   * GitHub"): the latest lookup wins, and every way of finding nothing —
   * a private repository, a language the server doesn't read, no test near
   * the line — becomes a hint under the field while the link stays.
   */
  const lookupTestName = (url: string, apply: (name: string) => void) => {
    const id = ++testLookup.current;
    setTestNameHint("Reading the test name from GitHub…");
    void (async () => {
      let name: string | null = null;
      let reason = "Could not read the test name — is the server running?";
      try {
        const res = await fetch(`/api/test-name?url=${encodeURIComponent(url)}`);
        const data = (await res.json()) as { name?: string | null; reason?: string; error?: string };
        name = data.name ?? null;
        reason = data.reason ?? data.error ?? reason;
      } catch {
        // keep the generic reason
      }
      if (id !== testLookup.current) return;
      if (name) {
        apply(name);
        setTestNameHint(null);
      } else {
        setTestNameHint(reason);
      }
    })();
  };

  // A url with a #L anchor typed into the add field is looked up a moment
  // after typing stops; a name already typed by hand is left alone.
  useEffect(() => {
    if (!editing) return;
    const url = testDraft.trim();
    if (!url || testLinkProblem(editing.scenario.tests, null, { url, name: "" }) !== null) {
      // Nothing to look up: a hint from an earlier url no longer applies,
      // and a GitHub url still missing its #L anchor says so right away.
      testLookup.current++;
      setTestNameHint(testLinkHint(url));
      return;
    }
    const timer = setTimeout(
      () => lookupTestName(url, (name) => setTestNameDraft((current) => (current.trim() ? current : name))),
      400,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testDraft]);

  // The same for an ✎ row whose url was changed: the name it opened with
  // belongs to the old url, so it is replaced; one typed since is kept.
  useEffect(() => {
    if (!editing || testEdit === null) return;
    const url = testEditDraft.url.trim();
    if (url === testEditOpened.current.url) return;
    if (testLinkProblem(editing.scenario.tests, testEdit, { url, name: "" }) !== null) {
      testLookup.current++;
      setTestNameHint(testLinkHint(url));
      return;
    }
    const timer = setTimeout(
      () =>
        lookupTestName(url, (name) =>
          setTestEditDraft((current) => {
            const typed = current.name.trim() && current.name !== testEditOpened.current.name;
            return typed ? current : { ...current, name };
          }),
        ),
      400,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testEditDraft.url, testEdit]);

  /** Forget a lookup still in flight, so it cannot land in the next row's fields. */
  const cancelTestLookup = () => {
    testLookup.current++;
    setTestNameHint(null);
  };

  const addTest = () => {
    const draft = { url: testDraft, name: testNameDraft };
    if (!editing || !canSetTestLink(editing.scenario.tests, null, draft)) return;
    setTests(addTestLink(editing.scenario.tests, draft));
    setTestDraft("");
    setTestNameDraft("");
    cancelTestLookup();
  };

  /** Open a row for in-place editing, seeded with the url and name it holds. */
  const startTestEdit = (index: number) => {
    if (!editing) return;
    const draft = testDraftOf(editing.scenario.tests[index] ?? "");
    testEditOpened.current = draft;
    setTestEdit(index);
    setTestEditDraft(draft);
    cancelTestLookup();
  };

  const commitTestEdit = () => {
    if (!editing || testEdit === null) return;
    if (!canSetTestLink(editing.scenario.tests, testEdit, testEditDraft)) return;
    setTests(updateTestLink(editing.scenario.tests, testEdit, testEditDraft));
    setTestEdit(null);
    cancelTestLookup();
  };

  const removeTest = (index: number) => {
    if (!editing) return;
    setTests(removeTestLink(editing.scenario.tests, index));
    // The rows below shift up one, so an open ✎ row would now point elsewhere.
    setTestEdit(null);
  };

  /** The clickable test-links table at the end of a scenario
      (specs/traceability.feature.md). */
  const testsTable = (tests: string[]) =>
    tests.length > 0 && (
      <table className="scenario-tests">
        <thead>
          <tr>
            <th>Automated tests</th>
          </tr>
        </thead>
        <tbody>
          {tests.map((t) => (
            <tr key={t}>
              <td>
                <a
                  href={testLinkUrl(t)}
                  target="_blank"
                  rel="noreferrer"
                  title={testLinkUrl(t)}
                  data-test-link=""
                >
                  {testLinkLabel(t)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  /**
   * The confirmation a scenario delete asks for. A published scenario gets
   * the Danger Zone wording and a Confirm button
   * (specs/editor/spec-editor.feature.md "Delete Published Spec") — it is
   * published, immutable content, deletable only because Settings says so.
   */
  const confirmScenarioDelete = ({ name, version, status }: ScenarioRow) =>
    confirm(
      status === "published"
        ? {
            title: "Danger Zone!",
            body: `Confirm that you want to delete a Published spec — "${name}" v${version}.`,
            confirmLabel: "Confirm",
          }
        : {
            title: "Delete scenario",
            body:
              status === "draft"
                ? `Delete the draft "${name}" v${version}?`
                : `Delete "${name}" v${version}?`,
            confirmLabel: "Delete scenario",
          },
    );

  /**
   * Delete the dialog's scenario (specs/ui/ui.feature.md "Scenario editor"),
   * after a confirmation. Three removals, by what the scenario is: a
   * [proposed] one is saved out of the feature like any other edit; a draft —
   * which the `.feature.md` never held, so leaving it out of a save would
   * remove nothing — is deleted from the Automerge document through its own
   * route; and a [published] one (offered only while Settings allows it —
   * specs/editor/spec-editor.feature.md "Delete Published Spec") goes through
   * its own route too, which commits and pushes the removal right away.
   */
  const deleteScenario = async () => {
    if (!editing || editing.index === null || !feature || !selected) return;
    const idx = editing.index;
    // The entry as last saved, not the dialog's unsaved edits: that is what
    // the delete removes, and its name and version identify it to the server.
    const saved = feature.scenarios[idx];
    if (!saved) return;
    const { name, version } = saved;
    // From here on autosave stands down: a tick landing while the
    // confirmation is up could re-sort the feature under `idx`.
    deletingScenario.current = true;
    const ok = await confirmScenarioDelete(saved);
    if (!ok) {
      deletingScenario.current = false;
      return;
    }
    setEditing(null);
    await removeScenario(idx, saved, `Deleted scenario "${name}" v${version}.`);
  };

  /**
   * Back to proposed (specs/editor/spec-editor.feature.md "Unpublish a Spec"):
   * the published status chip's one action, offered only while Settings allows
   * deleting or moving published specs — the route checks the same switch,
   * and commits and pushes the demotion. The pane stays on the scenario, now
   * [proposed] and editable again; Publish takes it back.
   */
  const unpublishScenario = async () => {
    if (!editing || editing.index === null || !feature || !selected) return;
    const saved = feature.scenarios[editing.index];
    if (!saved || saved.status !== "published") return;
    const { name, version } = saved;
    const file = selected;
    const session = editorSession.current;
    setUnpublishing(true);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}/unpublish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: { name, version } }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Unpublish failed");
        return;
      }
      // Like a delete's answer: the feature's editor view, which goes to the
      // listing instead when another feature was opened meanwhile.
      const left = featureFromResponse(data, file);
      if (selectedRef.current === file) {
        setFeature(left);
        setDirty(false);
      } else {
        setFeatures((prev) => withOpenScenarios(prev, file, left));
      }
      if (session === editorSession.current) {
        setEditing((e) =>
          e && e.scenario.name === name && e.scenario.version === version
            ? { ...e, scenario: { ...e.scenario, status: "proposed" } }
            : e,
        );
      }
      toast.success(`Moved "${name}" v${version} back to proposed.`);
      markSaved();
    } catch {
      toast.error("Unpublish failed");
    } finally {
      setUnpublishing(false);
    }
  };

  /**
   * Take a scenario back out of the open feature, by what it is: a [proposed]
   * one is saved out of the feature like any other edit; a draft — which the
   * `.feature.md` never held — is deleted from the Automerge document through
   * its own route; a [published] one through the delete-published route,
   * which commits and pushes right away. The first two are local, picked up
   * by the reload cron. `saved` is the entry as last saved, at `idx` in the
   * feature.
   */
  const removeScenario = async (idx: number, saved: Scenario, done: string) => {
    if (!feature || !selected) return;
    const next: Feature = {
      ...feature,
      scenarios: feature.scenarios.filter((_, i) => i !== idx),
    };
    setFeature(next);
    // The keyboard highlight can't stay on the removed card; later cards
    // shift up one index.
    setSelectedScenario((prev) =>
      prev === null || prev === idx ? null : prev > idx ? prev - 1 : prev,
    );
    const file = selected;
    const url = `/api/features/${encodeURIComponent(file)}`;
    // Drafts and published scenarios go through their own routes — a draft
    // because the file never held it, a published one because both
    // immutability gates refuse a save without it
    // (specs/editor/spec-editor.feature.md "Delete Published Spec").
    const res =
      saved.status === "draft" || saved.status === "published"
        ? await fetch(`${url}/${saved.status === "draft" ? "delete-draft" : "delete-published"}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scenario: { name: saved.name, version: saved.version } }),
          })
        : await fetch(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: serializeFeature(next), save: true }),
          });
    const data = await res.json();
    // Another feature may have been opened while the delete was away — a
    // published one commits and pushes first — and then the answer is not
    // the feature on screen: it goes to the listing the tree reads it from.
    const stillHere = selectedRef.current === file;
    if (res.ok) {
      // Both routes answer with the editor's view of the feature — the file
      // content with the remaining drafts folded back in.
      const left = featureFromResponse(data, file);
      if (stillHere) {
        setFeature(left);
        setDirty(false);
      } else {
        setFeatures((prev) => withOpenScenarios(prev, file, left));
      }
      toast.success(done);
      markSaved();
    } else {
      if (stillHere) setDirty(true);
      toast.error(data.error ?? "Delete failed");
    }
  };

  /**
   * Leave the editor pane (specs/editor/spec-editor.feature.md "Spec editor
   * pane"): `<`, ESC and every navigation away from the feature leave the
   * scenario in its autosaved state — leaving discards nothing and reverts
   * nothing; Delete is the way to take a draft back out. One last save
   * catches what was typed since the previous tick — the test-link fields
   * included — so the state left behind is the pane's latest. Started before the editor state clears so it saves
   * under this editor session; while a tick is still in flight the parting
   * save follows it, placed where it lands. Returns the save when one went out.
   */
  const closeEditor = (): Promise<{ ok: boolean; placed: Placement }> | null => {
    let saving: Promise<{ ok: boolean; placed: Placement }> | null = null;
    if (
      !featureEditorsSealed.current &&
      editing &&
      editing.scenario.name.trim() && // no name, nothing to be saved under
      !deletingScenario.current
    ) {
      // A url still sitting in the add field or in an open ✎ row joins the
      // scenario on the way out, as if Add (or the row's Save) had been
      // pressed — it is never silently dropped (specs/traceability.feature.md).
      // A published scenario has no explicit save left to fold it in, so
      // leaving is the last chance. One that can't join the list has nowhere
      // to be reported once the pane is gone, so it is left behind rather
      // than holding the pane open.
      const tests = resolvePendingTests(
        editing.scenario.tests,
        testEdit === null ? null : { index: testEdit, ...testEditDraft },
        { url: testDraft, name: testNameDraft },
      ).tests;
      if (scenarioSignature({ ...editing.scenario, tests }, draftVersion) !== autosaved.current) {
        saving = saveScenario(tests, false);
      }
    }
    setEditing(null);
    return saving;
  };

  /**
   * Whether the open pane can be followed by a new scenario: its scenario
   * has a place in the feature, or at least a name to be saved under. A
   * brand-new unnamed scenario has neither, so nothing could come after it.
   */
  const canAddAfter =
    editing !== null && (editing.index !== null || editing.scenario.name.trim() !== "");

  /**
   * New scenario after the open one (specs/editor/spec-editor.feature.md
   * "Spec editor pane"): the pane's `+` and `c`. The pane saves on the way
   * out, as ESC and the arrows do, and the new draft opens right after where
   * that save landed the scenario — so S3's successor is S4, whatever a
   * rename re-sorted meanwhile.
   */
  const newScenarioAfterCurrent = async () => {
    if (!editing || !feature || !selected || !canAddAfter || publishing !== null) return;
    const file = selected;
    const current = { name: editing.scenario.name, version: draftVersion };
    const id = editing.scenario.id;
    const fallback =
      editing.index !== null ? editing.index + 1 : (editing.insertAt ?? feature.scenarios.length);
    const name = await prompt({
      title: "New scenario",
      placeholder: "Scenario name",
      confirmLabel: "Create",
    });
    if (!name || !cleanLine(name)) return;
    // The prompt was modal, but autosave may have ticked meanwhile: close
    // the pane as it stands now, and wait for every save ahead of the new
    // scenario to land before placing it.
    const ahead = autosaveInFlight.current;
    const saving = editorRef.current.close();
    const placed = saving === null ? null : ((await saving)?.placed ?? null);
    await ahead;
    await scenarioSaveQueue.current.idle();
    if (selectedRef.current !== file || featureEditorsSealed.current) return;
    const scenarios = placed?.feature.scenarios ?? feature.scenarios;
    saveOnOpen.current = true;
    setEditing(newScenarioDraft(name, insertAfterScenario(scenarios, current, id, fallback)));
  };

  /**
   * `<` and ESC (specs/editor/spec-editor.feature.md "Spec editor pane"):
   * back to the feature, landing on the scenario's card — highlighted and
   * scrolled into view. The card is found by identity in the feature as the
   * last save is writing it (the same placement commitScenario makes), or as
   * it stands when nothing needed saving; a new scenario that was never
   * saved has no card, so nothing is highlighted.
   */
  const backToFeature = () => {
    if (!editing || !feature) {
      closeEditor();
      return;
    }
    const s = { ...editing.scenario, version: draftVersion };
    const at = editing.index;
    const saved = closeEditor() !== null;
    // A new scenario lands where the pane was told to put it (a new
    // version, "New scenario below", the pane's `+`), not at the end.
    const landed = saved ? withScenario(feature, at, s, editing.insertAt) : feature;
    setSelectedScenario(cardOfScenario(landed.scenarios, s));
  };

  // Before a move, rename-file or delete: what the scenario and description
  // editors hold lands on the current path, then `seal` refuses every later
  // write to it — the order switchRepo uses, through the same queues.
  const flushFeatureEditors = async () => {
    if (featureEditorsSealed.current) return;
    featureEditorsRetiring.current = true;
    await closeEditor();
    await scenarioSaveQueue.current.idle();
    await descTick.current();
    await descSaveQueue.current.idle();
  };
  const sealFeatureEditors = () => {
    featureEditorsSealed.current = true;
    featureEditorsRetiring.current = true;
    editorSession.current += 1;
    setEditing(null);
    setDescEdit(null);
  };
  const unsealFeatureEditors = () => {
    featureEditorsSealed.current = false;
    featureEditorsRetiring.current = false;
  };
  // ESC and the navigation paths run whichever close/back is current, from
  // listeners and callbacks bound in earlier renders.
  useEffect(() => {
    editorRef.current = {
      close: closeEditor,
      back: backToFeature,
      flush: flushFeatureEditors,
      seal: sealFeatureEditors,
    };
  });

  /**
   * Move the scenario at `i` one place up or down (specs/ui/ui.feature.md
   * "number scenarios") and save the feature in its new order — a save like
   * any other, through the queue so it goes out after a tick already away.
   * The highlight follows the scenario. Not while the editor pane is open:
   * its index into the feature would go stale under it.
   */
  const reorderScenario = (i: number, delta: -1 | 1) => moveScenarioTo(i, i + delta);

  /**
   * Move the open feature's scenario at `i` to `to` — one place for Move up
   * / Move down, anywhere for a drop in the sidebar outline — and save it.
   */
  const moveScenarioTo = async (i: number, to: number) => {
    if (!feature || !selected || editing !== null || featureEditorsSealed.current) return;
    if (to < 0 || to >= feature.scenarios.length || to === i) return;
    const before = feature;
    const next = withScenarioMoved(feature, i, to);
    const file = selected;
    setFeature(next);
    setSelectedScenario(to);
    setCardMenu(null);
    await scenarioSaveQueue.current.run(async () => {
      try {
        const res = await fetch(`/api/features/${encodeURIComponent(file)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: serializeFeature(next), save: true }),
        });
        const data = await res.json();
        if (selectedRef.current !== file) return;
        if (res.ok) {
          setFeature(featureFromResponse(data, file));
          setDirty(false);
          markSaved();
        } else {
          setFeature(before);
          setSelectedScenario(i);
          toast.error(data.error ?? "Could not move the scenario");
        }
      } catch {
        if (selectedRef.current !== file) return;
        setFeature(before);
        setSelectedScenario(i);
        toast.error("Could not move the scenario — is the server running?");
      }
    });
  };

  /**
   * Flip the polarity of the scenario at `i` from its card
   * (specs/ui/scenario-polarity.feature.md): bookkeeping around the spec,
   * so a published scenario takes it too. Saved like a move — the whole
   * feature, optimistically, rolled back if the save fails.
   */
  const toggleScenarioPolarityAt = async (i: number) => {
    if (!feature || !selected || editing !== null || featureEditorsSealed.current) return;
    const current = feature.scenarios[i];
    if (!current) return;
    const before = feature;
    const next = withScenarioPolarity(feature, i, !current.negative);
    const file = selected;
    setFeature(next);
    await scenarioSaveQueue.current.run(async () => {
      try {
        const res = await fetch(`/api/features/${encodeURIComponent(file)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: serializeFeature(next), save: true }),
        });
        const data = await res.json();
        if (selectedRef.current !== file) return;
        if (res.ok) {
          setFeature(featureFromResponse(data, file));
          setDirty(false);
          markSaved();
        } else {
          setFeature(before);
          toast.error(data.error ?? "Could not change the scenario's polarity");
        }
      } catch {
        if (selectedRef.current !== file) return;
        setFeature(before);
        toast.error("Could not change the scenario's polarity — is the server running?");
      }
    });
  };

  /** Draft the next version of a published scenario as a new, editable scenario. */
  const newVersion = (i: number) => {
    if (!feature) return;
    const src = feature.scenarios[i]!;
    setEditing({
      index: null,
      // isNew marks it as new, so the version is derived on save.
      isNew: true,
      // Right after the version it continues, where the reader looks for it.
      insertAt: i + 1,
      // Draft like any other new scenario, so autosave can't propose the next
      // version of a published scenario on the user's behalf — and without
      // the source's document id: this is a new scenario, not that one renamed.
      // Its files stay the source's (specs/editor/store-associated-files
      // .feature.md): the new version starts with none.
      scenario: {
        ...src,
        id: undefined,
        files: undefined,
        version: nextVersionFor(src.name),
        status: "draft",
      },
    });
  };

  const toggleFolder = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /**
   * Open or close a feature's scenario outline
   * (specs/ui/navigation.feature.md).
   */
  const toggleOutline = (file: string) =>
    setOutlined((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });

  /**
   * Open a search hit exactly like its deep link (specs/search.feature.md): a
   * scenario hit opens that scenario's page — or, with ⌘⏎ in the palette,
   * its feature page with the card highlighted.
   */
  const openResult = (r: SearchResultItem, onFeaturePage = false) => {
    setSelectedFolder(null);
    void openFeature(r.fileName, {
      push: true,
      scenario: r.scenario
        ? { slug: slugify(r.scenario.name), version: r.scenario.version }
        : null,
      pane: r.scenario !== undefined && !onFeaturePage,
      terms: r.terms,
    });
  };

  const resultHref = (r: SearchResultItem) =>
    r.scenario ? scenarioPath(r.fileName, r.scenario) : featurePath(r.fileName);

  /**
   * A scenario in the sidebar tree (specs/ui/navigation.feature.md "Scenario
   * navigation"): opens that scenario's page, from the feature page or
   * straight from another scenario's pane — the whole point, switching
   * scenarios without going back to the feature view. The same path a deep
   * link takes, so an open pane autosaves on the way out
   * (specs/editor/spec-editor.feature.md "Spec editor pane").
   */
  const openScenarioRow = (file: string, s: ScenarioRow) => {
    setSelectedFolder(null);
    void openFeature(file, {
      push: true,
      scenario: { slug: slugify(s.name), version: s.version },
      pane: true,
    });
  };

  /**
   * Delete from a scenario's menu in the sidebar tree
   * (specs/ui/navigation.feature.md "Scenario navigation"): the
   * same removal the editor pane's Delete makes, by what the scenario is,
   * for any feature in the tree — not only the open one. A pane open on that
   * very scenario takes the pane's own Delete. A pane open on another
   * scenario of the same feature is left first, autosaving like any
   * navigation away, since the removal re-indexes the feature under it.
   */
  const deleteTreeScenario = async (file: string, s: ScenarioRow) => {
    const same = (x: { name: string; version: number }) =>
      x.name === s.name && x.version === s.version;
    if (file === selected && savedEntry !== null && same(savedEntry)) {
      await deleteScenario();
      return;
    }
    if (!(await confirmScenarioDelete(s))) return;
    if (file === selected && editing) {
      const ahead = autosaveInFlight.current;
      await closeEditor();
      await ahead;
    }
    const url = `/api/features/${encodeURIComponent(file)}`;
    let res: Response;
    if (s.status === "draft" || s.status === "published") {
      res = await fetch(`${url}/${s.status === "draft" ? "delete-draft" : "delete-published"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: { name: s.name, version: s.version } }),
      });
    } else {
      // A [proposed] scenario is saved out of the feature, from the server's
      // copy: the feature may not be the open one.
      const got = await fetch(url);
      if (!got.ok) {
        toast.error("Delete failed");
        return;
      }
      const current = featureFromResponse(await got.json(), file);
      const next: Feature = { ...current, scenarios: current.scenarios.filter((x) => !same(x)) };
      res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
    }
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? "Delete failed");
      return;
    }
    // Every route answers with the editor's view of the feature.
    if (selectedRef.current === file) {
      setFeature(featureFromResponse(data, file));
      setSelectedScenario(null);
      markSaved();
    }
    await loadFeatures();
    toast.success(`Deleted scenario "${s.name}" v${s.version}.`);
  };

  /**
   * The rows picked in the sidebar tree (specs/ui/navigation.feature.md
   * "delete several scenarios at once"), in tree order, each with its
   * feature. Picks can outlive their rows — a scenario deleted or renamed
   * elsewhere — so only rows still listed come back.
   */
  const pickedTreeScenarios = (): { file: string; row: ScenarioRow }[] => {
    if (treePicks.size === 0) return [];
    const out: { file: string; row: ScenarioRow }[] = [];
    for (const f of features) {
      for (const row of scenarioRows(f, selected, feature)) {
        if (treePicks.has(treeScenarioKey(f.fileName, row))) out.push({ file: f.fileName, row });
      }
    }
    return out;
  };

  /** The open scenario's tree key, when its page is open. */
  const openTreeKey = (): string | null =>
    selected && paneScenario ? treeScenarioKey(selected, paneScenario) : null;

  /**
   * ⌘/Ctrl-click (toggle) or Shift-click (range) on a scenario row of the
   * tree. The first pick takes the open scenario along, as a desktop list's
   * first ⌘-click keeps the row already highlighted; a range runs from the
   * anchor — the last row toggled, else the open one — over the rows as the
   * tree shows them, across features too. `add` keeps the picks a range
   * would otherwise replace (⌘⇧-click).
   */
  const pickTreeScenario = (key: string, mode: "toggle" | "range", add = false) => {
    const open = openTreeKey();
    if (mode === "toggle") {
      setTreePicks((prev) => {
        const next = new Set(prev);
        if (next.size === 0 && open !== null && open !== key) next.add(open);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      treePickAnchor.current = key;
      return;
    }
    const keys = [...(treeRef.current?.querySelectorAll<HTMLElement>("[data-scenario]") ?? [])].map(
      (el) => el.dataset.scenario!,
    );
    let from = keys.indexOf(treePickAnchor.current ?? open ?? key);
    const to = keys.indexOf(key);
    if (to === -1) return;
    if (from === -1) from = to;
    if (treePickAnchor.current === null) treePickAnchor.current = keys[from]!;
    const span = keys.slice(Math.min(from, to), Math.max(from, to) + 1);
    setTreePicks((prev) => new Set([...(add ? prev : []), ...span]));
  };

  const clearTreePicks = () => {
    setTreePicks((prev) => (prev.size === 0 ? prev : new Set()));
    treePickAnchor.current = null;
  };

  /**
   * Delete every scenario picked in the tree (specs/ui/navigation.feature.md
   * "delete several scenarios at once") after one confirmation — each the
   * way its own Delete removes it, one request per feature. Published ones
   * go only while Settings allows it; with the switch off they stay, and the
   * confirmation says so. One pick is just that row's own Delete.
   */
  const deletePickedScenarios = async () => {
    // A ⋯ menu left open on a row about to go would stay open with no row
    // to close it from, holding every shortcut — Esc included — quiet.
    setTreeMenu(null);
    const picked = pickedTreeScenarios();
    if (picked.length === 0) {
      clearTreePicks();
      return;
    }
    if (picked.length === 1) {
      clearTreePicks();
      await deleteTreeScenario(picked[0]!.file, picked[0]!.row);
      return;
    }
    const going = picked.filter((p) => p.row.status !== "published" || deletePublished);
    const kept = picked.length - going.length;
    if (going.length === 0) {
      toast.error("Published scenarios can't be deleted — deleting them is switched off in Settings.");
      return;
    }
    const published = going.filter((p) => p.row.status === "published").length;
    const files = new Map<string, ScenarioRow[]>();
    for (const p of going) files.set(p.file, [...(files.get(p.file) ?? []), p.row]);
    const n = going.length;
    const what = `${n} scenario${n === 1 ? "" : "s"}`;
    const from = files.size > 1 ? ` from ${files.size} features` : "";
    const body = [
      published > 0
        ? `Confirm that you want to delete ${what}${from} — ${published} of them published.`
        : `Delete ${what}${from}?`,
      kept > 0
        ? `${kept} published scenario${kept === 1 ? " stays" : "s stay"} — deleting published specs is switched off in Settings.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    const ok = await confirm(
      published > 0
        ? { title: "Danger Zone!", body, confirmLabel: "Confirm" }
        : { title: `Delete ${what}`, body, confirmLabel: `Delete ${what}` },
    );
    if (!ok) return;
    // An editor pane open on one of these features is left first, autosaving
    // like any navigation away: the removal re-indexes the feature under it.
    if (selected !== null && files.has(selected) && editing) {
      const ahead = autosaveInFlight.current;
      await closeEditor();
      await ahead;
    }
    await scenarioSaveQueue.current.idle();
    let deleted = 0;
    for (const [file, rows] of files) {
      let res: Response;
      try {
        res = await fetch(`/api/features/${encodeURIComponent(file)}/delete-scenarios`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenarios: rows.map(({ name, version }) => ({ name, version })) }),
        });
      } catch {
        toast.error("Delete failed — is the server running?");
        break;
      }
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Delete failed");
        continue;
      }
      deleted += rows.length;
      if (selectedRef.current === file) {
        setFeature(featureFromResponse(data, file));
        setSelectedScenario(null);
        markSaved();
      }
    }
    clearTreePicks();
    await loadFeatures();
    if (deleted > 0) toast.success(`Deleted ${deleted} scenario${deleted === 1 ? "" : "s"}.`);
  };

  /**
   * Move to… from a scenario's menu in the sidebar tree
   * (specs/ui/navigation.feature.md "move a scenario to another feature"):
   * pick another feature, and the server adds the scenario there and takes it
   * out of this one — whatever it is, as its Delete would. An editor pane open
   * on either feature is left first, autosaving like any navigation away: its
   * next save would otherwise write the feature back without the move. A pane
   * that was on the moved scenario follows it to its new feature.
   */
  const moveTreeScenario = async (file: string, s: ScenarioRow) => {
    const options = features
      .filter((f) => f.fileName !== file)
      .map((f) => ({
        value: f.fileName,
        label: f.name || titleFromFileName(f.fileName),
        hint: f.fileName.replace(/^specs\//, ""),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const to = await pick({
      title: `Move “${s.name}” v${s.version}`,
      hint:
        s.status === "published"
          ? "To another feature — published, so the move is committed and pushed right away."
          : "To another feature.",
      placeholder: "Find a feature…",
      options,
      empty: options.length === 0 ? "There is no other feature to move it to." : "No feature matches.",
    });
    if (to === null) return;
    await moveScenarioToFeature(file, s, to);
  };

  /**
   * Move a scenario out of `file` into the feature `to` — from Move to…, or
   * dropped there (specs/ui/navigation.feature.md "drag a scenario to another
   * feature"): last in it, or next to the scenario `at` names. The toast's
   * Undo moves it back to where it was.
   */
  const moveScenarioToFeature = async (
    file: string,
    s: { name: string; version: number },
    to: string,
    at?: { name: string; version: number; after: boolean },
  ) => {
    const following =
      file === selected &&
      paneScenario !== null &&
      paneScenario.name === s.name &&
      paneScenario.version === s.version;
    // Its place before the move, for Undo: the open feature knows its drafts
    // too, the listing only what the file holds.
    const listed = features.find((f) => f.fileName === file);
    const back = scenarioPlace(
      file === selected && feature ? feature.scenarios : (listed?.scenarios ?? []),
      s,
    );
    if ((file === selected || to === selected) && editing) {
      const ahead = autosaveInFlight.current;
      await closeEditor();
      await ahead;
    }
    await scenarioSaveQueue.current.idle();
    let res: Response;
    try {
      res = await fetch(`/api/features/${encodeURIComponent(file)}/move-scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: { name: s.name, version: s.version }, to, at }),
      });
    } catch {
      toast.error("Move failed — is the server running?");
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? "Move failed");
      return;
    }
    if (following) {
      await openFeature(to, {
        push: true,
        scenario: { slug: slugify(s.name), version: s.version },
        pane: true,
      });
    } else if (selectedRef.current === file) {
      setFeature(featureFromResponse(data, file));
      setSelectedScenario(null);
      markSaved();
    } else if (selectedRef.current === to) {
      await openFeature(to);
    }
    await loadFeatures();
    const target = features.find((f) => f.fileName === to);
    // Undo runs whenever it is clicked, so through the latest render's move:
    // this one's selection and editor pane may be long gone by then.
    toast.success(`Moved "${s.name}" v${s.version} to ${target?.name || titleFromFileName(to)}.`, {
      action: { label: "Undo", run: () => void latestMoveScenario.current(to, s, file, back ?? undefined) },
    });
  };
  const latestMoveScenario = useRef(moveScenarioToFeature);
  latestMoveScenario.current = moveScenarioToFeature;

  /**
   * Clone from a scenario's menu — its card's on the feature page or its
   * row's in the sidebar tree (specs/ui/navigation.feature.md "clone a
   * scenario"): the server puts a draft copy right after it, and the copy
   * opens in the editor pane, ready to be renamed and changed. An editor
   * pane open on the feature is left first, autosaving like any navigation
   * away, so its save goes out before the copy is made rather than after.
   */
  const cloneTreeScenario = async (file: string, s: ScenarioRow) => {
    if (file === selected && editing) {
      const ahead = autosaveInFlight.current;
      await closeEditor();
      await ahead;
    }
    await scenarioSaveQueue.current.idle();
    let res: Response;
    try {
      res = await fetch(`/api/features/${encodeURIComponent(file)}/clone-scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: { name: s.name, version: s.version } }),
      });
    } catch {
      toast.error("Clone failed — is the server running?");
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? "Clone failed");
      return;
    }
    const copy = data.clone as { name: string; version: number };
    await openFeature(file, {
      push: true,
      scenario: { slug: slugify(copy.name), version: copy.version },
      pane: true,
    });
    await loadFeatures();
    toast.success(`Cloned "${s.name}" v${s.version} as "${copy.name}".`);
  };

  /**
   * A scenario dropped on another row of its feature's outline
   * (specs/ui/navigation.feature.md "reorder scenarios by dragging them in
   * the tree"): it lands before or after that row and the feature is saved
   * in its new order, as Move up / Move down save it. The open feature with
   * no editor pane moves in place. Any other feature moves in the server's
   * copy, the way the tree's Delete edits it; an editor pane open on that
   * feature is left first, autosaving like any navigation away, and opens
   * again on the scenario it showed — its index would go stale under it.
   */
  const dropTreeScenario = async (
    file: string,
    dragged: { name: string; version: number },
    target: { name: string; version: number },
    after: boolean,
  ) => {
    if (file === selected && feature && editing === null) {
      const move = scenarioDrop(feature.scenarios, dragged, target, after);
      if (move) await moveScenarioTo(move.from, move.to);
      return;
    }
    if (file === selected && featureEditorsSealed.current) return;
    const reopen = file === selected ? paneScenario : null;
    if (file === selected && editing) {
      const ahead = autosaveInFlight.current;
      await closeEditor();
      await ahead;
    }
    await scenarioSaveQueue.current.idle();
    const url = `/api/features/${encodeURIComponent(file)}`;
    const reopenPane = () =>
      reopen && selectedRef.current === file
        ? openFeature(file, {
            scenario: { slug: slugify(reopen.name), version: reopen.version },
            pane: true,
          })
        : undefined;
    try {
      const got = await fetch(url);
      if (!got.ok) throw new Error("Could not move the scenario");
      const current = featureFromResponse(await got.json(), file);
      const move = scenarioDrop(current.scenarios, dragged, target, after);
      if (!move) {
        await reopenPane();
        return;
      }
      const next = withScenarioMoved(current, move.from, move.to);
      // The outline shows the new order while the save is out.
      setFeatures((prev) => withOpenScenarios(prev, file, next));
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not move the scenario");
      if (reopen) await reopenPane();
      else if (selectedRef.current === file) {
        setFeature(featureFromResponse(data, file));
        markSaved();
      }
    } catch (e) {
      toast.error(
        e instanceof TypeError
          ? "Could not move the scenario — is the server running?"
          : (e as Error).message,
      );
      await reopenPane();
    }
    await loadFeatures();
  };

  /** A scenario drag is over: dropped, or let go anywhere else. */
  const endScenarioDrag = () => {
    setScenarioDrag(null);
    setScenarioDropAt(null);
    setScenarioDropInto(null);
  };

  /**
   * One sidebar entry per feature; the entry is the drag source. `parent` is
   * the folder it sits in, whose features it moves up and down among
   * (specs/ui/folders.feature.md "order features").
   */
  const featureItem = (f: FeatureListing, depth: number, parent: FolderNode) => {
    const index = parent.features.findIndex((x) => x.fileName === f.fileName);
    // Drag to reorder ("order features"): a feature dragged over a sibling's
    // row lands before or after it; over a row in another folder it still
    // drops into that folder, the folder's own drag-move.
    const siblingDrag =
      dragging !== null && dragging !== f.fileName && parent.features.some((x) => x.fileName === dragging);
    const featureDropEdge =
      siblingDrag && featureDropAt?.fileName === f.fileName
        ? featureDropAt.after
          ? " drop-after"
          : " drop-before"
        : "";
    // A scenario dragged out of another feature — a row of its outline or a
    // card of its page — drops in here, last (specs/ui/navigation.feature.md
    // "drag a scenario to another feature").
    const scenarioInto =
      scenarioDrag !== null && scenarioMovesInto(scenarioDrag, f.fileName, deletePublished);
    const entry = specSelection.get(f.fileName);
    // The feature's scenarios, listed under it when the outline is expanded
    // (specs/ui/navigation.feature.md "Scenario navigation"). The open feature
    // reads from its live state, so a save shows here before the listing's
    // next refresh.
    const rows = scenarioRows(f, selected, feature);
    const expanded = rows.length > 0 && outlined.has(f.fileName);
    return (
      <div key={f.fileName}>
        <div
          className={`tree-row${matchesFilter(f) ? "" : " dim"}${featureDropEdge}${
            dragging === f.fileName ? " dragging" : ""
          }${scenarioInto && scenarioDropInto === f.fileName ? " drop-target" : ""}`}
          onDragOver={(e) => {
            if (scenarioInto) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              setScenarioDropAt(null);
              if (scenarioDropInto !== f.fileName) setScenarioDropInto(f.fileName);
              return;
            }
            if (!siblingDrag) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(null);
            const box = e.currentTarget.getBoundingClientRect();
            const after = e.clientY > box.top + box.height / 2;
            if (featureDropAt?.fileName !== f.fileName || featureDropAt.after !== after) {
              setFeatureDropAt({ fileName: f.fileName, after });
            }
          }}
          onDragLeave={(e) => {
            if (scenarioDropInto === f.fileName && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setScenarioDropInto(null);
            }
          }}
          onDrop={(e) => {
            if (scenarioInto) {
              e.preventDefault();
              e.stopPropagation();
              const dragged = scenarioDrag!;
              endScenarioDrag();
              void moveScenarioToFeature(dragged.file, dragged, f.fileName);
              return;
            }
            if (!siblingDrag) return;
            e.preventDefault();
            e.stopPropagation();
            const box = e.currentTarget.getBoundingClientRect();
            const dragged = dragging!;
            setDragging(null);
            setDropTarget(null);
            setFeatureDropAt(null);
            const move = featureDrop(parent.features, dragged, f.fileName, e.clientY > box.top + box.height / 2);
            if (move) void moveFeatureTo(parent.path, move.from, move.to);
          }}
        >
          {/* Code gen selection (specs/agents/claude.feature.md): checking a
              spec here takes the whole thing; a dash means some of its
              scenarios are picked, which is done on the scenario cards.
              Gone entirely when the Settings switch is off. */}
          {codeGen && (
            <input
              type="checkbox"
              className="tree-check"
              style={{ marginLeft: `${0.4 + depth * 0.9}rem` }}
              checked={entry === "all"}
              ref={(el) => {
                if (el) el.indeterminate = entry !== undefined && entry !== "all";
              }}
              onChange={() => toggleSpecSelected(f.fileName)}
              aria-label={`Select ${f.name} for an AI session`}
              title={
                entry !== undefined && entry !== "all"
                  ? "Some scenarios of this spec are selected"
                  : `Select all of ${f.name} for an AI session`
              }
            />
          )}
          {/* The outline twisty (specs/ui/navigation.feature.md "Scenario
              navigation"): expands the feature's scenarios under it. Not a
              treeitem of its own — the feature link keeps that role, so the
              tree's ↑/↓ walk is unchanged. A feature with no scenarios keeps
              the same-width spacer so every label stays on one line. */}
          {rows.length > 0 ? (
            <button
              type="button"
              className="scenario-toggle"
              style={{ marginLeft: codeGen ? undefined : `${depth * 0.9}rem` }}
              aria-expanded={expanded}
              aria-label={`Scenarios of ${f.name}`}
              onClick={() => toggleOutline(f.fileName)}
            >
              {expanded ? (
                <ChevronDown size={12} aria-hidden="true" />
              ) : (
                <ChevronRight size={12} aria-hidden="true" />
              )}
            </button>
          ) : (
            <span
              className="scenario-toggle spacer"
              style={{ marginLeft: codeGen ? undefined : `${depth * 0.9}rem` }}
              aria-hidden="true"
            />
          )}
          {/* A real link (specs/ui/navigation.feature.md "share a link"): plain
          clicks navigate in-app, right-click → Copy Link works. The label is
          the feature name, not the file name (specs/ui/ui.feature.md "Main
          page"). */}
      <a
        href={featurePath(f.fileName)}
        className={`tree-feature${f.fileName === selected ? " active" : ""}`}
        role="treeitem"
        aria-level={depth + 1}
        aria-current={f.fileName === selected ? "page" : undefined}
        data-file={f.fileName}
        /* The checkbox and the twisty carry the depth indent before it. */
        style={{ paddingLeft: "0.2rem" }}
        draggable={!readOnly}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", f.fileName);
          e.dataTransfer.effectAllowed = "move";
          setDragging(f.fileName);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDropTarget(null);
          setFeatureDropAt(null);
        }}
        onClick={(e) =>
          spaClick(e, () => {
            // Opening a feature is a deliberate move away from the folder.
            setSelectedFolder(null);
            void openFeature(f.fileName, { push: true });
          })
        }
      >
        {f.name}
      </a>
      {/* The feature's rollup (specs/ui/ui.feature.md "Design system"): how
          many of its scenarios are published, as a small ring. */}
      <PublishRing
        published={f.scenarios.filter((s) => s.status === "published").length}
        total={f.scenarios.length}
      />
      {/* Drop down menu (specs/ui/ui.feature.md "Feature entry menu"): File →
          Rename edits the underlying file name; Delete removes the file. */}
      <span className="tree-row-menu">
        <Tooltip label="More actions">
          <button
            type="button"
            className="tree-menu-btn"
            aria-label={`Menu for ${f.fileName}`}
            aria-haspopup="menu"
            aria-expanded={treeMenu === f.fileName}
            onClick={() => setTreeMenu((m) => (m === f.fileName ? null : f.fileName))}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </button>
        </Tooltip>
        <Menu
          open={treeMenu === f.fileName}
          onClose={() => setTreeMenu(null)}
          label={`Menu for ${f.fileName}`}
          className="tree-menu"
          containerSelector=".tree-row-menu"
          items={[
            // Plain "Rename" on the menu itself (ui.feature.md "Feature entry
            // menu"): the name belongs to the row, and a long one would widen
            // the menu past the sidebar's left edge.
            {
              id: "rename",
              label: "Rename",
              icon: <Pencil size={13} />,
              onSelect: () => void renameFile(f.fileName),
            },
            {
              id: "display-name",
              label: "Edit display name",
              icon: <Tag size={13} />,
              onSelect: () => void editFeatureDisplayName(f),
            },
            // Move up / Move down (specs/ui/folders.feature.md "order
            // features"): the order among its siblings is the user's, kept
            // in the folder's feature-order.txt.
            {
              id: "move-up",
              label: "Move up",
              icon: <ArrowUp size={13} />,
              disabled: index <= 0,
              onSelect: () => void moveFeatureTo(parent.path, index, index - 1),
            },
            {
              id: "move-down",
              label: "Move down",
              icon: <ArrowDown size={13} />,
              disabled: index < 0 || index === parent.features.length - 1,
              onSelect: () => void moveFeatureTo(parent.path, index, index + 1),
            },
            {
              id: "move",
              label: "Move to folder…",
              icon: <FolderInput size={13} />,
              onSelect: () => void moveFeaturePrompt(f.fileName),
            },
            // Copy link (specs/ui/navigation.feature.md "share a link"): the
            // feature's url, as the page's ⋯ offers it.
            {
              id: "copy",
              label: "Copy link",
              icon: <Link size={13} />,
              onSelect: () => void copyLink(featurePath(f.fileName)),
            },
            {
              id: "delete",
              label: "Delete",
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: () => void removeFeature(f),
            },
          ]}
        />
      </span>
        </div>
        {/* The expanded outline (specs/ui/navigation.feature.md "Scenario
            navigation"): each scenario is a real link to its own page, so
            right-click → Copy Link and cmd-click work like every other
            sidebar entry. A plain click opens that scenario's editor pane —
            the point of the scenario, switching without going back to the
            feature view. */}
        {expanded && (
          <div role="group">
            {rows.map((s) => {
              const here =
                f.fileName === selected &&
                paneScenario !== null &&
                paneScenario.name === s.name &&
                paneScenario.version === s.version;
              // Its menu (specs/ui/navigation.feature.md "Scenario
              // navigation"): Clone always; Move to… and Delete on the
              // same terms as the editor pane's Delete — a published scenario
              // only while Settings allows it.
              const menuKey = treeScenarioKey(f.fileName, s);
              const deletable = s.status !== "published" || deletePublished;
              // Picked for a bulk action ("delete several scenarios at
              // once"); with more than this one picked, its Delete deletes
              // them all.
              const picked = treePicks.has(menuKey);
              const pickedCount = picked ? treePicksCount : 0;
              // Drag to reorder (specs/ui/navigation.feature.md "reorder
              // scenarios by dragging them in the tree"): landing before or
              // after the row it is over — in this feature, or moved here
              // out of another one ("drag a scenario to another feature").
              const same = (x: { name: string; version: number } | null) =>
                x !== null && x.name === s.name && x.version === s.version;
              const draggingHere = scenarioDrag !== null && scenarioDrag.file === f.fileName;
              const droppable = draggingHere || scenarioInto;
              const dropEdge =
                droppable &&
                scenarioDropAt?.file === f.fileName &&
                same(scenarioDropAt) &&
                !(draggingHere && same(scenarioDrag))
                  ? scenarioDropAt.after
                    ? " drop-after"
                    : " drop-before"
                  : "";
              return (
                <div
                  key={`${s.name}-v${s.version}`}
                  className={`tree-scenario-row${dropEdge}${draggingHere && same(scenarioDrag) ? " dragging" : ""}${
                    picked ? " picked" : ""
                  }`}
                  onDragOver={(e) => {
                    if (!droppable) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "move";
                    setScenarioDropInto(null);
                    const box = e.currentTarget.getBoundingClientRect();
                    const after = e.clientY > box.top + box.height / 2;
                    if (
                      scenarioDropAt?.file !== f.fileName ||
                      !same(scenarioDropAt) ||
                      scenarioDropAt.after !== after
                    ) {
                      setScenarioDropAt({ file: f.fileName, name: s.name, version: s.version, after });
                    }
                  }}
                  onDrop={(e) => {
                    if (!droppable) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const box = e.currentTarget.getBoundingClientRect();
                    const dragged = scenarioDrag!;
                    const at = {
                      name: s.name,
                      version: s.version,
                      after: e.clientY > box.top + box.height / 2,
                    };
                    endScenarioDrag();
                    if (draggingHere) void dropTreeScenario(f.fileName, dragged, at, at.after);
                    else void moveScenarioToFeature(dragged.file, dragged, f.fileName, at);
                  }}
                >
                  <a
                    href={scenarioPath(f.fileName, s)}
                    className={`tree-scenario${here ? " active" : ""}`}
                    role="treeitem"
                    aria-level={depth + 2}
                    /* Shift+F10 on the row opens its ⋯ (onTreeKeyDown). */
                    data-scenario={menuKey}
                    aria-current={here ? "page" : undefined}
                    aria-selected={readOnly ? undefined : picked}
                    /* Line up just past the feature's twisty: the codegen
                       checkbox, when on, already carries the depth indent for
                       the whole row, so it is not added twice. */
                    style={{ paddingLeft: `${(codeGen ? 1.5 : 0.6) + depth * 0.9}rem` }}
                    title={`${s.name} v${s.version}`}
                    draggable={!readOnly}
                    onDragStart={(e) => {
                      e.stopPropagation();
                      e.dataTransfer.setData("text/plain", scenarioPath(f.fileName, s));
                      e.dataTransfer.effectAllowed = "move";
                      setScenarioDrag({ file: f.fileName, name: s.name, version: s.version, status: s.status });
                    }}
                    onDragEnd={endScenarioDrag}
                    /* Shift-click would select the page's text from here to
                       the last click before the click picks the range. */
                    onMouseDown={(e) => {
                      if (!readOnly && e.shiftKey) e.preventDefault();
                    }}
                    onClick={(e) => {
                      // ⌘/Ctrl-click toggles the row, Shift-click picks the
                      // range ("delete several scenarios at once") — in place
                      // of the browser's new tab or window for this link;
                      // right-click → Open in new tab still works.
                      if (!readOnly && !e.altKey && (e.metaKey || e.ctrlKey || e.shiftKey)) {
                        e.preventDefault();
                        if (e.shiftKey) pickTreeScenario(menuKey, "range", e.metaKey || e.ctrlKey);
                        else pickTreeScenario(menuKey, "toggle");
                        return;
                      }
                      spaClick(e, () => {
                        clearTreePicks();
                        treePickAnchor.current = menuKey;
                        openScenarioRow(f.fileName, s);
                      });
                    }}
                  >
                    {scenarioNumbers(rows)[rows.indexOf(s)] !== null && (
                      <span className="scenario-number">S{scenarioNumbers(rows)[rows.indexOf(s)]}</span>
                    )}
                    <StatusIcon status={s.status} size={12} />
                    <span className="tree-scenario-name">{s.name}</span>
                    <span className="version">v{s.version}</span>
                  </a>
                  <span className="tree-row-menu">
                    <Tooltip label="More actions">
                      <button
                        type="button"
                        className="tree-menu-btn"
                        aria-label={`Menu for ${s.name} v${s.version}`}
                        aria-haspopup="menu"
                        aria-expanded={treeMenu === menuKey}
                        onClick={() => setTreeMenu((m) => (m === menuKey ? null : menuKey))}
                      >
                        <Ellipsis size={14} aria-hidden="true" />
                      </button>
                    </Tooltip>
                    <Menu
                      open={treeMenu === menuKey}
                      onClose={() => setTreeMenu(null)}
                      label={`Menu for ${s.name} v${s.version}`}
                      className="tree-menu"
                      containerSelector=".tree-row-menu"
                      items={[
                        ...(deletable
                          ? [
                              {
                                id: "move",
                                label: "Move to…",
                                icon: <ArrowRightLeft size={13} />,
                                onSelect: () => void moveTreeScenario(f.fileName, s),
                              },
                            ]
                          : []),
                        // Copy link (specs/ui/navigation.feature.md "share a
                        // link"): the versioned permalink the card copies.
                        {
                          id: "copy",
                          label: "Copy link",
                          icon: <Link size={13} />,
                          onSelect: () => void copyLink(scenarioPath(f.fileName, s)),
                        },
                        {
                          id: "clone",
                          label: "Clone",
                          icon: <CopyPlus size={13} />,
                          onSelect: () => void cloneTreeScenario(f.fileName, s),
                        },
                        ...(pickedCount > 1
                          ? [
                              {
                                id: "delete",
                                label: `Delete ${pickedCount} scenarios`,
                                icon: <Trash2 size={13} />,
                                danger: true,
                                onSelect: () => void deletePickedScenarios(),
                              },
                            ]
                          : deletable
                            ? [
                                {
                                  id: "delete",
                                  label: "Delete",
                                  icon: <Trash2 size={13} />,
                                  danger: true,
                                  onSelect: () => void deleteTreeScenario(f.fileName, s),
                                },
                              ]
                            : []),
                      ]}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  /**
   * Folders then features, indented per depth (specs/ui/folders.feature.md).
   * A folder's whole subtree is its drop zone — dropping on a feature drops
   * into the folder that holds it; nested folders win via stopPropagation.
   */
  // "Publish to Confluence…" on a folder: the dialog opens on the folder's
  // features in the sidebar's order, its subfolders' after its own, then
  // learns from the server which pages they link and where they were last
  // published under.
  const openConfluenceFolder = async (node: FolderNode) => {
    const inOrder: FeatureListing[] = [];
    const walk = (n: FolderNode) => {
      inOrder.push(...n.features);
      n.folders.forEach(walk);
    };
    walk(node);
    const path = node.path;
    setConfluenceFolder({ path, label: folderLabel(node), features: null });
    let known = new Map<string, FolderFeature>();
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(path)}/confluence`);
      if (res.ok) {
        const data = (await res.json()) as { features: FolderFeature[] };
        known = new Map(data.features.map((f) => [f.file, f]));
      }
    } catch {
      // Without the server's answer every feature reads as a new page; the
      // publish itself still finds the pages they link.
    }
    const features = inOrder.map((f) => known.get(f.fileName) ?? { file: f.fileName, name: f.name });
    setConfluenceFolder((open) => (open?.path === path ? { ...open, features } : open));
  };

  const renderTree = (node: FolderNode, depth: number) => (
    <>
      {node.folders.map((child, i) => {
        // Drag to reorder (specs/ui/folders.feature.md "order folders"):
        // among this folder's siblings only, landing before or after the
        // row it is over. A folder dragged elsewhere drops nowhere.
        const siblingDrag = folderDrag !== null && folderDrag.parent === node.path;
        const folderDropEdge =
          siblingDrag && folderDropAt?.path === child.path && folderDrag!.path !== child.path
            ? folderDropAt!.after
              ? " drop-after"
              : " drop-before"
            : "";
        const endFolderDrag = () => {
          setFolderDrag(null);
          setFolderDropAt(null);
          setDropTarget(null);
        };
        return (
        <div
          key={child.path}
          onDragOver={(e) => {
            // A folder dragged over another folder's subtree ("move a
            // folder") drops into it — sibling rows took the drag already,
            // to reorder. The nearest folder decides: over the folder it is
            // in, or itself, it drops nowhere, never falling through to the
            // tree background.
            if (folderDrag !== null) {
              e.stopPropagation();
              if (!folderDropsInto(folderDrag, child.path)) {
                setDropTarget(null);
                return;
              }
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(child.path);
              return;
            }
            if (dragging === null) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(child.path);
          }}
          onDragLeave={() => setDropTarget((t) => (t === child.path ? null : t))}
          onDrop={(e) => {
            if (folderDrag !== null) {
              e.stopPropagation();
              if (!folderDropsInto(folderDrag, child.path)) return;
              e.preventDefault();
              const dragged = folderDrag.path;
              endFolderDrag();
              void moveFolder(dragged, child.path);
              return;
            }
            if (dragging === null) return;
            e.preventDefault();
            e.stopPropagation();
            void moveTo(dragging, child.path);
          }}
        >
          <div
            className={`folder-row${(dragging !== null || folderDrag !== null) && dropTarget === child.path ? " drop-target" : ""}${
              child.path === selectedFolder ? " selected" : ""
            }${folderDropEdge}${siblingDrag && folderDrag!.path === child.path ? " dragging" : ""}`}
            style={{ paddingLeft: `${depth * 0.9}rem` }}
            onDragOver={(e) => {
              if (!siblingDrag) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(null);
              const box = e.currentTarget.getBoundingClientRect();
              const after = e.clientY > box.top + box.height / 2;
              if (folderDropAt?.path !== child.path || folderDropAt.after !== after) {
                setFolderDropAt({ path: child.path, after });
              }
            }}
            onDrop={(e) => {
              if (!siblingDrag) return;
              e.preventDefault();
              e.stopPropagation();
              const box = e.currentTarget.getBoundingClientRect();
              const dragged = folderDrag!.path;
              endFolderDrag();
              const move = folderDrop(node.folders, dragged, child.path, e.clientY > box.top + box.height / 2);
              if (move) void moveFolderTo(node.path, move.from, move.to);
            }}
          >
            {/* Clicking selects the folder (specs/ui/folders.feature.md — "+
                New folder" then creates inside it) and toggles its subtree.
                The button is the drag handle too ("order folders"). */}
            <button
              type="button"
              className="folder-toggle"
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={!collapsed.has(child.path)}
              data-folder={child.path}
              title={child.description ? child.path : undefined}
              draggable={!readOnly}
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.setData("text/plain", child.path);
                e.dataTransfer.effectAllowed = "move";
                setFolderDrag({ parent: node.path, path: child.path });
              }}
              onDragEnd={endFolderDrag}
              onClick={() => {
                setSelectedFolder(child.path);
                toggleFolder(child.path);
              }}
            >
              <span className="twist">
                {collapsed.has(child.path) ? (
                  <ChevronRight size={12} aria-hidden="true" />
                ) : (
                  <ChevronDown size={12} aria-hidden="true" />
                )}
              </span>{" "}
              {/* The display-name.txt's line when the folder has one
                  (specs/ui/folders.feature.md "describe a folder"); the
                  folder's own name is then a hover away. */}
              {folderLabel(child)}
            </button>
            {/* The folder's own ⋯ (specs/ui/folders.feature.md "Folder
                menu"): create inside it, rename it, delete it — the same
                quiet button a feature row carries, keyboard included. */}
            <span className="tree-row-menu">
              <Tooltip label="More actions">
                <button
                  type="button"
                  className="tree-menu-btn"
                  aria-label={`Menu for folder ${child.path}`}
                  aria-haspopup="menu"
                  aria-expanded={treeMenu === folderMenuKey(child.path)}
                  onClick={() =>
                    setTreeMenu((m) => (m === folderMenuKey(child.path) ? null : folderMenuKey(child.path)))
                  }
                >
                  <Ellipsis size={14} aria-hidden="true" />
                </button>
              </Tooltip>
              <Menu
                open={treeMenu === folderMenuKey(child.path)}
                onClose={() => setTreeMenu(null)}
                label={`Menu for folder ${child.path}`}
                className="tree-menu"
                containerSelector=".tree-row-menu"
                items={[
                  {
                    id: "new-feature",
                    label: "New feature here",
                    icon: <NewFeatureIcon size={13} />,
                    onSelect: () => void createFeatureIn(child.path),
                  },
                  // Import from Aha! (specs/external-links/aha-import
                  // .feature.md): the feature lands in this folder. Only
                  // while switched on in Settings; never in the demo or the
                  // hosted app, which keep no API key.
                  ...(!ahaImport
                    ? []
                    : [
                        {
                          id: "import-aha",
                          label: "Import from Aha! here…",
                          icon: <Import size={13} />,
                          onSelect: () => setAhaImportOpen({ folder: child.path }),
                        },
                      ]),
                  // Import from OpenSpec (specs/external-links/openspec-
                  // import.feature.md): the code repo's capabilities land
                  // in this folder.
                  ...(!openSpecImport
                    ? []
                    : [
                        {
                          id: "import-openspec",
                          label: "Import from OpenSpec here…",
                          icon: <Import size={13} />,
                          onSelect: () => setOpenSpecImportOpen({ folder: child.path }),
                        },
                      ]),
                  // Import from Jira/Wiki (specs/external-links/jira-wiki
                  // -import.feature.md "Jira and Confluence imports are
                  // switched on in Settings"): which item shows depends on
                  // which integrations are on — both the combined importer,
                  // one that side only, neither no item. Never in the demo or
                  // the hosted app, which keep no token and no agent.
                  ...(jiraEnabled && confluenceEnabled
                    ? [
                        {
                          id: "import-jira-wiki",
                          label: "Import from Jira/Wiki here…",
                          icon: <Import size={13} />,
                          onSelect: () => setImportOpen({ folder: child.path, mode: "both" as const }),
                        },
                      ]
                    : jiraEnabled
                      ? [
                          {
                            id: "import-jira",
                            label: "Import from Jira here…",
                            icon: <Import size={13} />,
                            onSelect: () => setImportOpen({ folder: child.path, mode: "jira" as const }),
                          },
                        ]
                      : confluenceEnabled
                        ? [
                            {
                              id: "import-confluence",
                              label: "Import from Confluence here…",
                              icon: <Import size={13} />,
                              onSelect: () => setImportOpen({ folder: child.path, mode: "wiki" as const }),
                            },
                          ]
                        : []),
                  {
                    id: "new-folder",
                    label: "New folder here",
                    icon: <NewFolderIcon size={13} />,
                    onSelect: () => void createFolderIn(child.path),
                  },
                  {
                    id: "rename",
                    label: "Rename",
                    icon: <Pencil size={13} />,
                    onSelect: () => void renameFolder(child.path),
                  },
                  {
                    id: "display-name",
                    label: "Edit display name",
                    icon: <Tag size={13} />,
                    onSelect: () => void editFolderDisplayName(child.path),
                  },
                  // Move up / Move down (specs/ui/folders.feature.md "order
                  // folders"): the order among its siblings is the user's,
                  // kept in the parent's folder-order.txt.
                  {
                    id: "move-up",
                    label: "Move up",
                    icon: <ArrowUp size={13} />,
                    disabled: i === 0,
                    onSelect: () => void moveFolderTo(node.path, i, i - 1),
                  },
                  {
                    id: "move-down",
                    label: "Move down",
                    icon: <ArrowDown size={13} />,
                    disabled: i === node.folders.length - 1,
                    onSelect: () => void moveFolderTo(node.path, i, i + 1),
                  },
                  {
                    id: "move",
                    label: "Move to folder…",
                    icon: <FolderInput size={13} />,
                    onSelect: () => void moveFolderPrompt(child.path),
                  },
                  // Publish to Confluence (specs/external-links/confluence
                  // -wiki.feature.md "Publish a folder's features to
                  // Confluence"): each feature under the folder its own page
                  // under one parent. Only while Confluence is switched on in
                  // Settings; never in the demo or the hosted app.
                  ...(confluenceEnabled
                    ? [
                        {
                          id: "confluence",
                          label: "Publish to Confluence…",
                          icon: <BookOpen size={13} />,
                          onSelect: () => void openConfluenceFolder(child),
                        },
                      ]
                    : []),
                  {
                    id: "delete",
                    label: "Delete",
                    icon: <Trash2 size={13} />,
                    danger: true,
                    onSelect: () => void removeFolder(child.path),
                  },
                ]}
              />
            </span>
          </div>
          {!collapsed.has(child.path) && <div role="group">{renderTree(child, depth + 1)}</div>}
        </div>
        );
      })}
      {node.features.map((f) => featureItem(f, depth, node))}
    </>
  );

  // One keyboard model (specs/ui/ui.feature.md "Design system"): every
  // shortcut is declared once here, dispatched by one listener
  // (src/frontend/shortcuts.tsx) and listed by the `?` cheat sheet from the
  // same list. Single keys stay quiet while a dialog or menu is open and
  // while typing in a field; ESC works everywhere.
  const dialogOpen =
    userInfoOpen ||
    settingsFileOpen ||
    importOpen !== null ||
    openSpecImportOpen !== null ||
    tokenSignInOpen ||
    foldersOpen ||
    switching !== null ||
    modalOpen ||
    startDialog ||
    pomodoroSettings ||
    conflict !== null ||
    featureLinkOpen ||
    featureQtestOpen ||
    featurePrsOpen ||
    featureFlagsOpen ||
    featureAttributesOpen ||
    sessionError !== null ||
    sheetOpen ||
    palette !== null;
  const menuOpen =
    treeMenu !== null ||
    recentMenuOpen ||
    userMenuOpen ||
    featureMenuOpen ||
    editorMenuOpen ||
    statusMenuOpen ||
    publishMenuOpen ||
    cardMenu !== null ||
    assigneeMenuOpen ||
    filterMenuOpen;
  const quiet = dialogOpen || menuOpen;
  /**
   * `quiet` with the palette itself discounted. A shortcut's `when` keeps its
   * key from firing behind a dialog — the palette included — but the palette
   * *lists* those same shortcuts as commands (shortcutAction), and a command
   * that hides the moment the palette opens can never be picked. Visibility
   * asks this instead, so "New feature" and "New notebook entry" are
   * offered there (specs/app/engineering-notebook.feature.md "Search and the
   * command palette").
   */
  const quietBehindPalette = quiet && palette === null;
  const onFeaturePage = selected !== null && feature !== null && editing === null;
  // On a small screen "[" and the sidebar buttons work the drawer instead of
  // the rail; the rail preference is left alone for the next big window.
  const toggleSidebar = () => {
    if (compact) {
      setDrawerOpen((o) => !o);
      return;
    }
    setSidebarCollapsed((c) => {
      storeSidebarCollapsed(!c);
      return !c;
    });
  };
  const toggleEditor = () => {
    setEditorHidden((h) => {
      storeEditorHidden(!h);
      return !h;
    });
  };
  // The drawer closes behind any navigation — a feature, a plugin's view (a
  // page, say), the scenario editor — and when the window grows back into
  // two panes.
  const pluginViewKey = pluginView && activeTab ? activeTab.route.key(pluginView.view) : null;
  useEffect(() => {
    setDrawerOpen(false);
  }, [compact, selected, pluginViewKey, editing !== null]);
  // specs/editor/spec-editor.feature.md "Adding Scanarios": a small dialog
  // asks for the scenario's name first; the editor pane opens with it. A
  // new scenario starts as a draft: autosave
  // (specs/editor/editor-autosave.feature.md) writes the editor out every few
  // seconds, and a draft stays in the document. Proposing it — into the
  // .feature.md — takes the editor's Propose button, an explicit act.
  const newScenario = async (insertAt?: number) => {
    const name = await prompt({
      title: "New scenario",
      placeholder: "Scenario name",
      confirmLabel: "Create",
    });
    if (!name || !cleanLine(name)) return;
    // At `insertAt` — "New scenario below" on a card — or at the end.
    saveOnOpen.current = true;
    setEditing(newScenarioDraft(name, insertAt));
  };
  // specs/ui/ui.feature.md "Select scenarios via up and down keys": the
  // highlight walks the cards; Enter opens the highlighted one in the editor
  // pane.
  const moveScenarioSelection = (e: KeyboardEvent, delta: 1 | -1) => {
    if (!feature) return;
    const count = feature.scenarios.length;
    // Steal focus from a clicked button (e.g. the feature just opened in the
    // sidebar) so a following Enter edits the highlighted scenario instead
    // of re-activating that button.
    if (e.target instanceof HTMLElement) e.target.blur();
    setSelectedScenario((i) =>
      delta > 0
        ? i === null
          ? 0
          : Math.min(i + 1, count - 1)
        : i === null
          ? count - 1
          : Math.max(i - 1, 0),
    );
  };
  const openSelectedScenario = (e: KeyboardEvent): void | false => {
    if (!feature || selectedScenario === null) return false;
    const t = e.target;
    if (e.key === "Enter") {
      // A focused button or link keeps its native Enter activation — except
      // the highlighted card's own title link, which a click left focused:
      // Enter there edits the scenario rather than re-selecting it.
      const titleLink = scenarioRefs.current[selectedScenario]?.querySelector(
        ".scenario-title > a",
      );
      if (t instanceof HTMLButtonElement) return false;
      if (t instanceof HTMLAnchorElement && t !== titleLink) return false;
    }
    const s = feature.scenarios[selectedScenario];
    if (s) setEditing({ index: selectedScenario, scenario: { ...s } });
  };
  // ESC closes whatever is on top (specs/ui/ui.feature.md "Dialogs"): a dialog;
  // then the editor pane — its way back, leaving the scenario autosaved
  // (specs/editor/spec-editor.feature.md "Spec editor pane") — unless the
  // key came from the sidebar, which stays reachable beside the pane; then
  // an app page — Settings, Plugins — the same way; then a selected folder
  // (specs/ui/folders.feature.md). A field keeps its own ESC.
  const closeTopmost = (e: KeyboardEvent): void | false => {
    if (sessionError !== null) return setSessionError(null);
    if (startDialog) return setStartDialog(false);
    if (pomodoroSettings) return setPomodoroSettings(false);
    if (conflict) {
      if (resolving) return false;
      dismissConflict();
      return;
    }
    if (settingsFileOpen) return setSettingsFileOpen(false);
    if (userInfoOpen) return setUserInfoOpen(false);
    if (tokenSignInOpen) return setTokenSignInOpen(false);
    if (confluencePublishOpen) return setConfluencePublishOpen(false);
    if (confluenceFolder) return setConfluenceFolder(null);
    if (qtestPublishOpen) return setQtestPublishOpen(false);
    if (wikiQtestPublishOpen) return setWikiQtestPublishOpen(false);
    if (ahaImportOpen !== null) return setAhaImportOpen(null);
    if (openSpecImportOpen !== null) return setOpenSpecImportOpen(null);
    if (importOpen !== null) return setImportOpen(null);
    if (featureLinkOpen) return setFeatureTicketsOpen(false);
    if (featureQtestOpen) return setFeatureQtestDraft(null);
    if (featurePrsOpen) return setFeaturePrsOpen(false);
    if (featureFlagsOpen) return setFeatureFlagsOpen(false);
    if (featureAttributesOpen) return setFeatureAttributesOpen(false);
    if (featureResourceOpen) return setFeatureResourceOpen(null);
    if (modalOpen || sheetOpen || menuOpen) return false;
    if (compact && drawerOpen) return setDrawerOpen(false);
    if (compact && pane.open) return agentChat.closePane();
    if (treePicks.size > 0) return clearTreePicks();
    const fromSidebar = e.target instanceof Element && e.target.closest("aside") !== null;
    if (editing && !fromSidebar) {
      editorRef.current.back();
      return;
    }
    if (appPage && !fromSidebar) {
      // A field on the page saves on blur; leave it first so it does.
      if (e.target instanceof HTMLElement) e.target.blur();
      closeAppPage();
      return;
    }
    if (isTypingTarget(e.target)) return false;
    if (selectedFolder !== null) return setSelectedFolder(null);
    return false;
  };
  // The scenario editor's `<` / `>` and their keys: step to the scenario
  // before or after the open one, through every scenario in the tree in the
  // order the sidebar lists them — across features too. The same way the
  // tree's own rows switch scenarios (openScenarioRow), so the open pane
  // autosaves on the way out. Located by the scenario as last saved, not by
  // a name still being typed; a new scenario not yet saved has no place in
  // the walk, so both ways are off until it does.
  const editedEntry =
    editing !== null && editing.index !== null ? (feature?.scenarios[editing.index] ?? null) : null;
  const scenarioNav =
    selected && editedEntry
      ? scenarioNeighbors(
          scenarioSequence(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), selected, feature),
          selected,
          editedEntry,
        )
      : { prev: null, next: null };
  const stepScenario = (step: -1 | 1): void | false => {
    const to = step < 0 ? scenarioNav.prev : scenarioNav.next;
    if (!to) return false;
    openScenarioRow(to.file, to.scenario);
  };
  // The shown plugin tab's own "new" (specs/app/plugins.feature.md): what `c`
  // creates while that tab is the sidebar — a task, a case, an issue.
  const tabCreate = readOnly || shownTab === "specs"
    ? undefined
    : pluginTabs.find((tab) => tab.id === shownTab)?.create;
  const allShortcuts: Shortcut[] = [
    // mod+k and `/` open the palette; the browser's own Find (mod+f) is
    // left alone, since the in-sidebar field it used to focus is gone.
    {
      id: "search",
      keys: ["mod+k", "/"],
      label: "Search specs and commands",
      group: "Navigate",
      when: () => !quiet,
      run: () => setPalette({ query: "" }),
    },
    {
      id: "sheet",
      keys: "?",
      label: "Keyboard shortcuts",
      group: "Navigate",
      when: () => !quiet,
      palette: () => !quietBehindPalette,
      run: () => setSheetOpen(true),
    },
    // The right pane on "]", as the left one is on "["
    // (specs/agents/agent-pane.feature.md).
    {
      id: "agent-pane",
      keys: "]",
      label: pane.open ? "Close the coding agent pane" : "Open the coding agent pane",
      group: "Navigate",
      when: () => !quiet && codeGen && canOpenAgentPane,
      palette: () => !quietBehindPalette && codeGen && canOpenAgentPane,
      run: () => agentChat.togglePane(),
    },
    // The editor pane on "\", the key between "[" and "]" that hide the two
    // side panes (specs/ui/ui.feature.md "Hide the editor pane"). Offered
    // only while the coding agent pane is a column beside it.
    {
      id: "editor-pane",
      keys: "\\",
      label: editorOff ? "Show the editor pane" : "Hide the editor pane",
      group: "Navigate",
      when: () => !quiet && canHideEditor,
      palette: () => !quietBehindPalette && canHideEditor,
      run: () => toggleEditor(),
    },
    {
      id: "go-home",
      keys: "g h",
      label: "Go to Home (README)",
      group: "Navigate",
      when: () => !quiet,
      palette: () => !quietBehindPalette,
      run: () => {
        goHome();
        void loadReadme();
      },
    },
    // The Specs tab (specs/app/roadmap.feature.md "The roadmap is a sidebar
    // tab"): `g s` turns the sidebar to the tree, leaving a plugin's view
    // for home, so the tree has a chord like every plugin's tab.
    {
      id: "go-specs",
      keys: "g s",
      label: "Go to the specs",
      group: "Navigate",
      // A code repository has no specs tab (specs/app/code-repo-mode.feature.md).
      when: () => !quiet && codeRepoDir === null,
      palette: () => !quietBehindPalette && codeRepoDir === null,
      run: () => {
        selectSidebarTab("specs");
        // A plugin's view or an app page (Settings, Images) leaves for the
        // README; a feature page stays, it is the tree's own.
        if (pluginView || appPage) {
          goHome();
          void loadReadme();
        }
      },
    },
    // Each plugin's tab has its own `g` chord (specs/app/plugins.feature.md) —
    // `g r`, `g t` and `g n` open the special folders on their first page. A
    // tab with nothing to open (an empty folder) has no chord.
    ...pluginTabs
      .filter((tab) => tab.shortcut)
      .map(
        (tab): Shortcut => ({
          id: `go-${tab.id}`,
          keys: tab.shortcut!,
          label: `Go to the ${tab.title.toLowerCase()}`,
          group: "Navigate",
          when: () => !quiet && tabReachable(tab),
          palette: () => !quietBehindPalette && tabReachable(tab),
          run: () => void openPluginView(tab.id, tab.route.home, { push: true }),
        }),
      ),
    {
      id: "settings",
      keys: "mod+,",
      label: "Settings",
      group: "Navigate",
      when: () => !quiet,
      palette: () => !quietBehindPalette,
      run: () => openSettings(),
    },
    {
      id: "plugins",
      keys: "g p",
      label: "Plugins",
      group: "Navigate",
      when: () => !quiet,
      palette: () => !quietBehindPalette,
      run: () => openPlugins(),
    },
    {
      // Observability (src/frontend/ObservabilityPage.tsx): the app's own
      // logs. The hosted demo has none to show a visitor.
      id: "observability",
      keys: "g o",
      label: "Observability",
      group: "Navigate",
      when: () => !quiet && !demo,
      palette: () => !quietBehindPalette && !demo,
      run: () => openObservability(),
    },
    {
      // Data (src/frontend/DataPage.tsx): the Automerge store as tables,
      // documents and history. Read-only, so the demo may show it too.
      id: "data",
      keys: "g d",
      label: "Data",
      group: "Navigate",
      when: () => !quiet,
      palette: () => !quietBehindPalette,
      run: () => openData(),
    },
    {
      // Images (src/frontend/ImagesPage.tsx): every stored image with where
      // it is used, and the unreferenced ones to delete.
      id: "images",
      keys: "g m",
      label: "Images",
      group: "Navigate",
      when: () => !quiet,
      palette: () => !quietBehindPalette,
      run: () => openImages(),
    },
    {
      id: "theme",
      keys: "mod+shift+l",
      label: "Cycle the theme",
      group: "Navigate",
      inFields: true,
      when: () => !quiet,
      run: () => {
        const order: ThemePref[] = ["system", "light", "dark"];
        const next = order[(order.indexOf(theme) + 1) % order.length]!;
        setTheme(next);
        applyThemePref(next);
        toast.info(`Theme: ${next}`);
      },
    },
    {
      id: "sidebar",
      keys: "[",
      label: compact
        ? drawerOpen
          ? "Close the menu"
          : "Open the menu"
        : sidebarCollapsed
          ? "Expand the sidebar"
          : "Collapse the sidebar",
      group: "Navigate",
      when: () => !quiet,
      run: () => toggleSidebar(),
    },
    {
      id: "escape",
      keys: "escape",
      label: "Close, go back, or clear the selection",
      group: "Navigate",
      inFields: true,
      run: closeTopmost,
    },
    {
      id: "create",
      keys: "c",
      // Inside the scenario pane the new scenario follows the open one
      // (specs/editor/spec-editor.feature.md "Spec editor pane"); single
      // letters never fire while typing, so `c` in the body is just a c.
      label: editing
        ? "New scenario after this one"
        : onFeaturePage
          ? "New scenario"
          : tabCreate
            ? tabCreate.label
            : "New feature",
      group: "Create",
      when: () => !quiet && (editing === null || canAddAfter),
      palette: () => !quietBehindPalette && (editing === null || canAddAfter),
      run: () => {
        if (editing) void newScenarioAfterCurrent();
        else if (onFeaturePage) void newScenario();
        // The shown tab's own "new": a task from the Tasks tab, a case from
        // Tests — never a feature from there.
        else if (tabCreate) tabCreate.run(tabApp, navigateIn(shownTab));
        else void createFeature();
      },
    },
    {
      id: "import-aha",
      keys: [],
      label: selectedFolder ? `Import from Aha! into "${selectedFolder}"…` : "Import from Aha!…",
      group: "Create",
      when: () => !quiet && ahaImport && editing === null,
      palette: () => !quietBehindPalette && ahaImport && editing === null,
      run: () => setAhaImportOpen({ folder: selectedFolder }),
    },
    {
      id: "import-openspec",
      keys: [],
      label: selectedFolder ? `Import from OpenSpec into "${selectedFolder}"…` : "Import from OpenSpec…",
      group: "Create",
      when: () => !quiet && openSpecImport && editing === null,
      palette: () => !quietBehindPalette && openSpecImport && editing === null,
      run: () => setOpenSpecImportOpen({ folder: selectedFolder }),
    },
    {
      id: "pomodoro",
      keys: "p",
      label: "Start a pomodoro",
      group: "Create",
      when: () => pomodoroOn && !quiet && editing === null && pom.timer === null,
      palette: () => pomodoroOn && !quietBehindPalette && editing === null && pom.timer === null,
      run: () => startPomodoro(),
    },
    {
      id: "next",
      keys: ["j", "arrowdown"],
      label: "Next scenario",
      group: "Scenarios",
      when: () => !quiet && onFeaturePage && feature !== null && feature.scenarios.length > 0,
      run: (e) => moveScenarioSelection(e, 1),
    },
    {
      id: "prev",
      keys: ["k", "arrowup"],
      label: "Previous scenario",
      group: "Scenarios",
      when: () => !quiet && onFeaturePage && feature !== null && feature.scenarios.length > 0,
      run: (e) => moveScenarioSelection(e, -1),
    },
    {
      id: "move-up",
      keys: "alt+arrowup",
      label: "Move the selected scenario up",
      group: "Scenarios",
      when: () => !quiet && onFeaturePage && editing === null && selectedScenario !== null,
      run: () => void reorderScenario(selectedScenario!, -1),
    },
    {
      id: "move-down",
      keys: "alt+arrowdown",
      label: "Move the selected scenario down",
      group: "Scenarios",
      when: () => !quiet && onFeaturePage && editing === null && selectedScenario !== null,
      run: () => void reorderScenario(selectedScenario!, 1),
    },
    {
      id: "open",
      keys: ["enter", "e", "o"],
      label: "Open the selected scenario",
      group: "Scenarios",
      when: () => !quiet && onFeaturePage && selectedScenario !== null,
      run: openSelectedScenario,
    },
    {
      id: "editor-prev",
      keys: ["<", "k"],
      label: "Previous scenario (in the scenario editor)",
      group: "Scenarios",
      when: () => !quiet && editing !== null && scenarioNav.prev !== null,
      run: () => stepScenario(-1),
    },
    {
      id: "editor-next",
      keys: [">", "j"],
      label: "Next scenario (in the scenario editor)",
      group: "Scenarios",
      when: () => !quiet && editing !== null && scenarioNav.next !== null,
      run: () => stepScenario(1),
    },
    {
      id: "publish",
      keys: "mod+enter",
      label: editing
        ? editing.scenario.status === "draft"
          ? "Propose the scenario"
          : "Publish the scenario"
        : "Publish all",
      group: "Publish",
      inFields: true,
      when: () => !quiet && (editing !== null || onFeaturePage),
      palette: () => !quietBehindPalette && (editing !== null || onFeaturePage),
      run: () => {
        if (publishing !== null) return false;
        if (editing) {
          if (editing.scenario.status === "published" || !editing.scenario.name.trim())
            return false;
          if (editing.scenario.status === "draft") void proposeScenario();
          else void publishScenario();
          return;
        }
        void publish();
      },
    },
    {
      id: "copy-link",
      keys: "mod+shift+c",
      label: "Copy link to this page",
      group: "Share",
      inFields: true,
      when: () => !quiet && (selected !== null || pluginView !== null),
      palette: () => !quietBehindPalette && (selected !== null || pluginView !== null),
      run: () => {
        if (selected && editing) void copyLink(scenarioLink(selected, editing.scenario));
        else if (selected) void copyLink(featurePath(selected));
        // A plugin's view — an open roadmap page or task, say — has its own url.
        else if (pluginView && activeTab) void copyLink(activeTab.route.path(pluginView.view));
      },
    },
    // Handled by the fields themselves (src/frontend/MarkdownEditor.tsx and
    // the sidebar divider); listed so the cheat sheet is complete.
    {
      id: "md-bold",
      keys: "mod+b",
      label: "Bold (in a text editor)",
      group: "Editor",
      displayOnly: true,
      run: () => false,
    },
    {
      id: "md-italic",
      keys: "mod+i",
      label: "Italic (in a text editor)",
      group: "Editor",
      displayOnly: true,
      run: () => false,
    },
    {
      id: "md-link",
      keys: "mod+k",
      label: "Insert a link (in a text editor)",
      group: "Editor",
      displayOnly: true,
      run: () => false,
    },
    {
      id: "divider",
      keys: ["arrowleft", "arrowright"],
      label: "Resize the sidebar (divider focused)",
      group: "Navigate",
      displayOnly: true,
      run: () => false,
    },
  ];
  // The read-only site keeps the ways around and nothing that writes.
  const shortcuts = readOnly
    ? allShortcuts.filter((x) => READ_ONLY_SHORTCUTS.has(x.id) || x.id.startsWith("go-"))
    : allShortcuts;
  useShortcuts(shortcuts);

  // The command palette's contents (src/frontend/CommandPalette.tsx): the
  // actions by name — the keyboard registry's, plus the ones without a key —
  // and, for a query, the full-text search's hits (specs/search.feature.md).
  // The sidebar tab on screen picks what is searched: the Specs tab the spec
  // files, a page tab that folder's pages (specs/app/roadmap.feature.md,
  // specs/app/tasks.feature.md).
  const shortcutAction = (id: string, icon: ReactNode): PaletteItem | null => {
    const s = shortcuts.find((x) => x.id === id);
    if (!s || (s.palette ? !s.palette() : s.when && !s.when())) return null;
    return {
      id: `action:${id}`,
      group: "Actions",
      label: s.label,
      text: s.label,
      icon,
      keys: Array.isArray(s.keys) ? s.keys[0] : s.keys,
      run: () => void s.run(new KeyboardEvent("keydown", { key: "Enter" })),
    };
  };
  // Move to folder… (specs/ui/folders.feature.md "move a feature from its
  // menu"): the keyboard's way to what a drag does — pick a folder from the
  // list, the top level included, and the same git mv runs.
  const moveFeaturePrompt = async (fileName: string | null = selected) => {
    if (!fileName) return;
    const from = fileName.slice(0, fileName.lastIndexOf("/"));
    const options = folderOptions(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), from);
    const to = await pick({
      title: `Move “${fileStem(fileName)}”`,
      hint: "To another folder — a git mv, committed and pushed.",
      placeholder: "Find a folder…",
      options,
      empty: options.length === 0 ? "There is no other folder to move it to." : "No folder matches.",
    });
    if (to === null) return;
    await moveTo(fileName, to);
  };
  const action = (
    id: string,
    label: string,
    icon: ReactNode,
    run: () => void,
    extra: Partial<PaletteItem> = {},
  ): PaletteItem => ({ id: `action:${id}`, group: "Actions", label, text: label, icon, run, ...extra });
  const listing = selected ? features.find((f) => f.fileName === selected) : undefined;
  const paletteActions: PaletteItem[] = [
    shortcutAction(
      "create",
      editing || onFeaturePage ? <Plus size={14} /> : <NewFeatureIcon size={14} />,
    ),
    action("new-folder", "New folder", <NewFolderIcon size={14} />, () => void createFolder()),
    // Only while Import from Aha! is switched on in Settings
    // (specs/external-links/aha-import.feature.md).
    shortcutAction("import-aha", <Import size={14} />),
    ...(selectedFolder
      ? [
          action("rename-folder", `Rename folder “${selectedFolder.split("/").pop()}”`, <Pencil size={14} />, () =>
            void renameFolder(selectedFolder),
          ),
          action(
            "folder-display-name",
            `Edit display name of folder “${selectedFolder.split("/").pop()}”`,
            <Tag size={14} />,
            () => void editFolderDisplayName(selectedFolder),
          ),
          action(
            "move-folder",
            `Move folder “${selectedFolder.split("/").pop()}” to folder…`,
            <FolderInput size={14} />,
            () => void moveFolderPrompt(selectedFolder),
          ),
          action("move-folder-up", `Move folder “${selectedFolder.split("/").pop()}” up`, <ArrowUp size={14} />, () =>
            reorderFolder(selectedFolder, -1),
          ),
          action(
            "move-folder-down",
            `Move folder “${selectedFolder.split("/").pop()}” down`,
            <ArrowDown size={14} />,
            () => reorderFolder(selectedFolder, 1),
          ),
          action("delete-folder", `Delete folder “${selectedFolder.split("/").pop()}”`, <Trash2 size={14} />, () =>
            void removeFolder(selectedFolder),
          ),
        ]
      : []),
    shortcutAction("publish", <StatusIcon status="published" size={14} />),
    shortcutAction("copy-link", <Link size={14} />),
    ...(selected && feature
      ? [
          action("rename", "Rename feature", <Pencil size={14} />, () =>
            setRenameDraft(feature.name || titleFromFileName(selected)),
          ),
          action("move", "Move feature to folder…", <FolderInput size={14} />, () =>
            void moveFeaturePrompt(),
          ),
          action("move-feature-up", "Move feature up", <ArrowUp size={14} />, () => reorderFeature(selected, -1)),
          action("move-feature-down", "Move feature down", <ArrowDown size={14} />, () =>
            reorderFeature(selected, 1),
          ),
          ...(listing
            ? [
                action("delete", "Delete feature", <Trash2 size={14} />, () =>
                  void removeFeature(listing),
                ),
              ]
            : []),
        ]
      : []),
    ...(codeGen && specSelection.size > 0 && !sessionRunning
      ? [action("session", "Start AI Session", <StartSessionIcon size={14} />, () => startSession())]
      : []),
    // Off in Settings: the Pomodoro is not part of this app, so the palette
    // does not offer it either (src/frontend/pomodoroPref.ts).
    ...(pomodoroOn
      ? [
          ...(pom.timer
            ? [action("pomodoro-stop", "Stop Pomodoro", <Timer size={14} />, () => pomodoro.stop())]
            : [shortcutAction("pomodoro", <Timer size={14} />)]),
          action("pomodoro-settings", "Pomodoro settings…", <Timer size={14} />, () =>
            setPomodoroSettings(true),
          ),
        ]
      : []),
    // A code repository syncs nothing (specs/app/code-repo-mode.feature.md
    // "The app runs no git in a code repository").
    ...(!demo && codeRepoDir === null
      ? [action("sync", "Sync now", <RefreshCw size={14} />, () => void syncNow())]
      : []),
    // Manage folders (specs/app/spec-folders.feature.md) is the one way to
    // open, add or remove a folder — and the way back to the specs from a
    // code repository.
    ...(!demo && !readOnly
      ? [action("manage-folders", "Manage folders…", <FolderInput size={14} />, () => setFoldersOpen(true))]
      : []),
    ...(canOpenCodeRepo
      ? [action("open-code-repo", "Open a code repository…", <FolderTree size={14} />, () => void openCodeRepoPrompt())]
      : []),
    shortcutAction("go-home", <Home size={14} />),
    // The plugins' tabs: the way there, and each tab's own commands —
    // "New notebook entry" among them (specs/app/engineering-notebook
    // .feature.md), since the tab's own button is a tab away.
    ...pluginTabs.flatMap((tab) => [
      shortcutAction(`go-${tab.id}`, <tab.icon size={14} />),
      ...(tab.palette?.commands?.({
        prompt,
        promptWithChoice,
        confirm,
        navigate: navigateIn(tab.id),
      }) ?? []),
    ]),
    shortcutAction("editor-pane", <PanelRight size={14} />),
    shortcutAction("agent-pane", <Bot size={14} />),
    ...(codeGen && canOpenAgentPane
      ? [
          action("agent-new", "New coding agent session", <Bot size={14} />, () => {
            agentChat.setActive(null);
            agentChat.openPane();
          }),
        ]
      : []),
    shortcutAction("settings", <Settings size={14} />),
    shortcutAction("plugins", <Puzzle size={14} />),
    shortcutAction("observability", <Activity size={14} />),
    shortcutAction("data", <Database size={14} />),
    shortcutAction(
      "sidebar",
      compact ? (
        <MenuIcon size={14} />
      ) : sidebarCollapsed ? (
        <PanelLeftOpen size={14} />
      ) : (
        <PanelLeftClose size={14} />
      ),
    ),
    ...(["system", "light", "dark"] as ThemePref[]).map((pref) =>
      action(`theme-${pref}`, `Theme: ${pref}`, <Sun size={14} />, () => {
        setTheme(pref);
        applyThemePref(pref);
      }),
    ),
    shortcutAction("sheet", <Keyboard size={14} />),
  ]
    .filter((x): x is PaletteItem => x !== null)
    // The read-only site: the keyboard's own commands left above, plus the
    // theme — no create, move, publish, sync or settings, and none of a
    // plugin tab's own commands.
    .filter((x) => !readOnly || READ_ONLY_PALETTE.test(x.id));

  const scenarioStatus = (fileName: string, s: { name: string; version: number }) =>
    features
      .find((f) => f.fileName === fileName)
      ?.scenarios.find((x) => x.name === s.name && x.version === s.version)?.status ?? "proposed";
  const resolvePalette = async (q: string, signal: AbortSignal): Promise<PaletteItem[]> => {
    // A plugin's tab searches its own data when it offers a search — its
    // store (the server's full-text index knows only markdown), or its own
    // scope of that index (a special folder's pages).
    const shownPlugin = pluginTabs.find((tab) => tab.id === shownTab);
    if (shownPlugin?.palette?.search) {
      const { group } = shownPlugin.palette;
      const Icon = shownPlugin.icon;
      return (await shownPlugin.palette.search(q, signal)).map(
        (hit): PaletteItem => ({
          id: hit.id,
          group,
          label: hit.label,
          text: hit.label,
          sub: hit.sub,
          icon: <Icon size={14} />,
          href: hit.href,
          run: () => void openPluginView(shownPlugin.id, hit.view, { push: true }),
        }),
      );
    }
    const res = await fetch(`/api/search?scope=specs&q=${encodeURIComponent(q)}`, { signal });
    const data = (await res.json()) as { results?: SearchResultItem[]; error?: string };
    if (!res.ok) throw new Error(data.error ?? "Search failed");
    return (data.results ?? []).map(
      (r): PaletteItem => ({
        id: `${r.kind}:${r.fileName}:${r.scenario?.name ?? ""}@${r.scenario?.version ?? 0}`,
        group: r.scenario ? "Scenarios" : "Features",
        label: r.scenario ? r.scenario.name : r.featureName,
        text: r.scenario ? r.scenario.name : r.featureName,
        sub: r.scenario ? (
          <>
            {r.featureName}
            {r.snippet && <> · {markText(r.snippet, r.terms)}</>}
          </>
        ) : r.snippet ? (
          markText(r.snippet, r.terms)
        ) : undefined,
        icon: r.scenario ? (
          <StatusIcon status={scenarioStatus(r.fileName, r.scenario)} size={14} />
        ) : (
          <FileText size={14} />
        ),
        href: resultHref(r),
        run: ({ alt }) => openResult(r, alt),
      }),
    );
  };
  // A plugin view is offered while its tab is mounted — a page of a folder
  // switched off since is not.
  const recentItems: PaletteItem[] = recent.flatMap((e): PaletteItem[] => {
    const owner = e.kind === "plugin" ? pluginTabs.find((t) => t.id === e.tab) : undefined;
    if (e.kind === "plugin" && !owner) return [];
    return [
      {
        id: `recent:${e.kind}:${e.fileName}:${e.scenario?.name ?? ""}@${e.scenario?.version ?? 0}`,
        group: "Recent",
        label: e.scenario ? e.scenario.name : e.name,
        text: e.scenario ? e.scenario.name : e.name,
        sub: e.scenario ? e.name : owner?.title,
        icon: owner ? (
          <owner.icon size={14} aria-hidden="true" />
        ) : e.scenario ? (
          <StatusIcon status={scenarioStatus(e.fileName, e.scenario)} size={14} />
        ) : (
          <FileText size={14} />
        ),
        href: owner
          ? e.fileName
          : e.scenario
            ? scenarioPath(e.fileName, e.scenario)
            : featurePath(e.fileName),
        run: ({ alt }) => {
          if (owner) {
            const view = owner.route.match(e.fileName);
            if (view !== null) openPluginView(owner.id, view, { push: true });
            return;
          }
          openResult(
            {
              kind: e.scenario ? "scenario" : "feature",
              fileName: e.fileName,
              featureName: e.name,
              scenario: e.scenario,
              score: 0,
              terms: [],
              snippet: "",
            },
            alt,
          );
        },
      },
    ];
  });
  // Remember what is open, for the palette's empty state.
  useEffect(() => {
    if (loading) return;
    let entry: RecentEntry | null = null;
    if (selected) {
      const name = features.find((f) => f.fileName === selected)?.name ?? titleFromFileName(selected);
      entry = paneScenario
        ? {
            kind: "scenario",
            fileName: selected,
            name,
            scenario: { name: paneScenario.name, version: paneScenario.version },
          }
        : { kind: "feature", fileName: selected, name };
    } else if (pluginView && activeTab?.recent) {
      // A plugin's view the tab says is worth remembering — a page, say —
      // by its url, so it reopens the way a link to it would.
      const name = activeTab.recent(pluginView.view);
      if (name !== null) {
        entry = {
          kind: "plugin",
          fileName: activeTab.route.path(pluginView.view),
          name,
          tab: activeTab.id,
        };
      }
    }
    if (!entry) return;
    const added = entry;
    const key = (e: RecentEntry) =>
      `${e.kind}:${e.fileName}:${e.scenario?.name ?? ""}@${e.scenario?.version ?? 0}`;
    setRecent((prev) => {
      const next = [added, ...prev.filter((e) => key(e) !== key(added))].slice(0, 8);
      writeRecent(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, selected, paneScenario?.name, paneScenario?.version, pluginViewKey]);

  // The header's trail (src/frontend/Breadcrumbs.tsx): the data folder, then
  // the feature's folders — a click selects the folder in the sidebar, so
  // "+ New folder" and "+ New feature" land beside the feature.
  const repoName = codeRepoDir
    ? repoDisplayName(codeRepoDir)
    : demo
      ? "demo-data"
      : dataRepo
        ? repoDisplayName(dataRepo)
        : "SpecDriven";
  const repoCrumb: Crumb = {
    label: repoName,
    href: "/",
    title: "Home",
    onClick: (e) =>
      spaClick(e, () => {
        goHome();
        void loadReadme();
      }),
  };
  /** What a plugin's tab gets from App (src/plugins/client/tabs.ts). */
  const tabApp: TabApp = {
    features,
    members,
    assignments,
    repoCrumb,
    autosaveSeconds,
    prompt,
    promptWithChoice,
    confirm,
    pick,
    openSettings,
    openFeature: (fileName) => void openFeature(fileName, { push: true }),
    featureCreated: async (fileName) => {
      await loadFeatures();
      await openFeature(fileName, { push: true });
    },
    startSession: codeGen ? startSession : undefined,
    copyLink: (path) => void copyLink(path),
    copied,
    goHome,
    readOnly,
  };
  const folderCrumbs = (fileName: string): Crumb[] => {
    const parts = fileName.split("/").slice(0, -1);
    return parts.map((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      return {
        label: part,
        title: `Select the folder ${path}`,
        onClick: () => {
          setSelectedFolder(path);
          setCollapsed((prev) => {
            const next = new Set(prev);
            for (let k = 1; k <= i + 1; k++) next.delete(parts.slice(0, k).join("/"));
            return next;
          });
        },
      };
    });
  };

  // The way back into a module (src/plugins/client/tabs.ts featureCrumbs): a
  // feature holding an Event Model slice's scenarios carries a crumb naming
  // the model, say, that opens its canvas. None while the module is off.
  const pluginCrumbs = (fileName: string): Crumb[] =>
    pluginTabs.flatMap((tab) =>
      (tab.featureCrumbs?.(fileName) ?? []).map(
        (c): Crumb => ({
          label: c.label,
          title: c.title,
          href: tab.route.path(c.view),
          onClick: (e) => spaClick(e, () => void openPluginView(tab.id, c.view, { push: true })),
        }),
      ),
    );

  // The sidebar filter (specs/ui/ui.feature.md "Design system"): a feature
  // matches by having a scenario in the chosen status, by its assignee, and
  // by a custom attribute it or a scenario of it carries
  // (specs/app/custom-attributes.feature.md, src/frontend/treeFilter.ts).
  const matchesFilter = (f: FeatureListing) => featureMatches(f, filter);
  const me = user?.name || user?.login || user?.username || null;
  const filtering = isFiltering(filter);

  const treePicksCount = readOnly ? 0 : pickedTreeScenarios().length;

  // Tree keyboard: ↑/↓ walk the visible rows, → opens a folder (or steps
  // in), ← closes it or climbs to it from a feature, Home/End jump,
  // Shift+F10 or the menu key opens a feature's ⋯. Enter stays the row's own.
  const onTreeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=treeitem]")];
    const i = rows.indexOf(t);
    if (i === -1) return;
    const move = (to: number) => rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
    const folderPath = t.dataset.folder;
    // Shift+↑/↓ from a scenario row grows the pick to the next scenario row
    // ("delete several scenarios at once"), as Shift-click would.
    const extend = (to: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      const from = t.dataset.scenario;
      if (!next?.dataset.scenario || from === undefined) return false;
      if (treePickAnchor.current === null || !treePicks.has(treePickAnchor.current)) {
        treePickAnchor.current = from;
      }
      pickTreeScenario(next.dataset.scenario, "range");
      next.focus();
      return true;
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (e.shiftKey && !readOnly && extend(i + 1)) return;
        move(i + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (e.shiftKey && !readOnly && extend(i - 1)) return;
        move(i - 1);
        return;
      case "Delete":
      case "Backspace": {
        // Delete on a scenario row: the picks when there are any, else the
        // row itself — each with its confirmation.
        const key = t.dataset.scenario;
        if (key === undefined || readOnly) return;
        e.preventDefault();
        if (treePicks.size > 0) {
          void deletePickedScenarios();
          return;
        }
        const [file, name, version] = key.split("\u0000");
        const listing = features.find((f) => f.fileName === file);
        const row = listing
          ? scenarioRows(listing, selected, feature).find(
              (r) => r.name === name && String(r.version) === version,
            )
          : undefined;
        if (!row || (row.status === "published" && !deletePublished)) return;
        void deleteTreeScenario(file!, row);
        return;
      }
      case "Home":
        e.preventDefault();
        move(0);
        return;
      case "End":
        e.preventDefault();
        move(rows.length - 1);
        return;
      case "ArrowRight":
        // A feature row opens its scenario outline the way a folder opens its
        // subtree (specs/ui/navigation.feature.md "Scenario navigation").
        if (folderPath === undefined) {
          const file = t.dataset.file;
          if (file === undefined) return;
          e.preventDefault();
          // Already outlined: step into it, as ArrowRight on an open folder
          // moves to its first child.
          if (outlined.has(file)) move(i + 1);
          else toggleOutline(file);
          return;
        }
        e.preventDefault();
        if (collapsed.has(folderPath)) toggleFolder(folderPath);
        else move(i + 1);
        return;
      case "ArrowLeft": {
        e.preventDefault();
        if (folderPath !== undefined && !collapsed.has(folderPath)) {
          toggleFolder(folderPath);
          return;
        }
        const file = t.dataset.file;
        if (file !== undefined && outlined.has(file)) {
          toggleOutline(file);
          return;
        }
        t.closest("[role=group]")
          ?.parentElement?.querySelector<HTMLElement>("[role=treeitem]")
          ?.focus();
        return;
      }
      case "F10":
        if (!e.shiftKey) return;
        if (t.dataset.scenario) setTreeMenu(t.dataset.scenario);
        else if (t.dataset.file) setTreeMenu(t.dataset.file);
        else if (folderPath !== undefined) setTreeMenu(folderMenuKey(folderPath));
        else return;
        e.preventDefault();
        return;
      case "ContextMenu":
        if (t.dataset.scenario) setTreeMenu(t.dataset.scenario);
        else if (t.dataset.file) setTreeMenu(t.dataset.file);
        else if (folderPath !== undefined) setTreeMenu(folderMenuKey(folderPath));
        else return;
        e.preventDefault();
        return;
    }
  };

  if (loading)
    return (
      <main className="layout skeleton-shell" aria-busy="true" aria-label="Loading">
        <aside>
          <span className="skeleton" style={{ height: "1.75rem", width: "60%" }} />
          <span className="skeleton" style={{ height: "2rem" }} />
          {[70, 55, 65, 50, 60, 45].map((w, i) => (
            <span key={i} className="skeleton" style={{ height: "1.1rem", width: `${w}%` }} />
          ))}
        </aside>
        <section className="editor">
          <PageSkeleton cards={3} />
        </section>
      </main>
    );

  // The page's first read failed (specs/ui/app-start.feature.md "the server
  // cannot be reached at start"): say so, and keep trying in the background.
  if (bootError)
    return (
      <main className="centered">
        <section className="repo-prompt" role="alert" aria-label="Server unreachable">
          <h1>SpecDriven</h1>
          {bootError.unreachable ? (
            <>
              <p>Can't reach the SpecDriven server at {location.origin}.</p>
              <p className="error">{bootError.message}</p>
              <p>
                Start or restart it with <code>bun run dev</code>; this page opens on its own once
                the server answers.
              </p>
            </>
          ) : (
            <p className="error">{bootError.message}</p>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void boot()}>
            Retry now
          </button>
          {hostedAccount && <HostedStartNav account={hostedAccount} onSignOut={signOutHosted} />}
        </section>
      </main>
    );

  // specs/app/data-format.feature.md: the folder holds data a newer app
  // wrote; nothing else is shown until the user updates or switches folders.
  if (outdated && !needsRepo)
    return (
      <AppOutdated
        appVersion={appVersion}
        minAppVersion={outdated.minAppVersion}
        checking={checkingOutdated}
        onCheckAgain={async () => {
          setCheckingOutdated(true);
          try {
            // One sync tick re-reads the marker after a pull; boot then
            // reports the verdict and, if it cleared, loads the folder.
            await fetch("/api/reload", { method: "POST" }).catch(() => {});
            await boot();
          } finally {
            setCheckingOutdated(false);
          }
        }}
        onOtherFolder={() => {
          setOutdated(null);
          setRepoError(null);
          setNeedsRepo(true);
        }}
      />
    );

  if (needsRepo) {
    const folderForm = (
      <>
        <p>
          {hosted
            ? "Enter the GitHub url of your specs repository:"
            : "Enter the path to the spec data directory:"}
        </p>
        {/* Hosted mode (src/server/hostedMode.ts): a GitHub repository
            only, reached with the token from the account page. */}
        {hosted && !auth?.signedIn && (
          <p className="hint">
            First <a href="/account">add a GitHub token</a> that can read and write it.
          </p>
        )}
        <div className="input-row">
          <input
            ref={repoInputRef}
            name="repo"
            placeholder={hosted ? "https://github.com/owner/specs" : "/path/to/spec-data"}
            autoFocus
          />
          {canChooseFolder && (
            <button type="button" className="browse" onClick={() => void browseIntoRepoInput()}>
              Browse…
            </button>
          )}
        </div>
        <button type="submit" className="btn btn-primary" disabled={settingRepo}>
          {settingRepo ? "Checking access…" : hosted ? "Open this repository" : "Use this directory"}
        </button>
        {repoError && <p className="error">{repoError}</p>}
        {hosted && auth?.signedIn && hostedCloneHint(repoError) && (
          <p className="hint">
            {hostedCloneHint(repoError)} <a href="/account">Open your account page</a>.
          </p>
        )}
      </>
    );
    return (
      <main className="centered">
        <form
          className="repo-prompt"
          onSubmit={(e) => {
            e.preventDefault();
            const input = new FormData(e.currentTarget).get("repo") as string;
            if (!input?.trim()) return;
            // A code repository opens directly (specs/app/code-repo-mode.feature.md).
            if (startChoice === "code" && !hosted && !demo) void openCodeRepo(input.trim());
            else saveRepo(input.trim());
          }}
        >
          <h1>SpecDriven</h1>
          {hosted || demo ? (
            folderForm
          ) : (
            <>
              <p>No spec data directory configured yet. Where are your specs?</p>
              <div className="issue-filter start-choice" role="radiogroup" aria-label="Where the specs are">
                {(canOpenCodeRepo ? (["folder", "clone", "code"] as const) : (["folder", "clone"] as const)).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={startChoice === choice}
                    className={startChoice === choice ? "active" : ""}
                    onClick={() => {
                      setStartChoice(choice);
                      setRepoError(null);
                    }}
                  >
                    {choice === "folder"
                      ? "Open a folder on this computer"
                      : choice === "clone"
                        ? "Clone from GitHub"
                        : "A code repository"}
                  </button>
                ))}
              </div>
              {startChoice === "folder" ? (
                folderForm
              ) : startChoice === "code" && canOpenCodeRepo ? (
                /* Code repository mode (specs/app/code-repo-mode.feature.md
                   "Open a code repository"): no specs — the app shows the
                   repository's files and runs the coding agent there, and
                   runs no git of its own. */
                <>
                  <p>
                    The folder of a code repository on this computer. The app shows its files and runs
                    the coding agent there; it never pulls, commits or pushes — git stays yours.
                  </p>
                  <div className="input-row">
                    <input ref={repoInputRef} name="repo" placeholder="/path/to/your/code" autoFocus />
                    {canChooseFolder && (
                      <button type="button" className="browse" onClick={() => void browseIntoRepoInput("code-repo")}>
                        Browse…
                      </button>
                    )}
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={settingRepo}>
                    {settingRepo ? "Opening…" : "Open this code repository"}
                  </button>
                  {repoError && <p className="error">{repoError}</p>}
                </>
              ) : (
                <CloneFromGitHub
                  auth={auth}
                  busy={settingRepo}
                  error={repoError}
                  onSignedIn={(signedIn) => {
                    setAuth(signedIn);
                    void refreshUser();
                  }}
                  onClone={saveRepo}
                />
              )}
            </>
          )}
          {hostedAccount && <HostedStartNav account={hostedAccount} onSignOut={signOutHosted} />}
        </form>
      </main>
    );
  }

  const editingPublished = editing?.scenario.status === "published";
  // The scenario as last saved into the feature: what a delete removes, and
  // what the Draft checkbox is locked against — neither follows the dialog's
  // unsaved edits.
  const savedEntry =
    editing !== null && editing.index !== null ? (feature?.scenarios[editing.index] ?? null) : null;
  // Delete applies to [proposed] scenarios and to drafts
  // (specs/ui/ui.feature.md "Scenario editor") — not to a scenario that isn't
  // part of the feature yet (index === null; a new one autosave has already
  // placed does have an index, and can be deleted). Published ones are
  // immutable, unless deletion is turned on in Settings
  // (specs/editor/spec-editor.feature.md "Delete Published Spec").
  const editingDeletable =
    savedEntry !== null && (savedEntry.status !== "published" || deletePublished);
  const hasProposed = feature?.scenarios.some((s) => s.status === "proposed") ?? false;

  // Settings (specs/ui/ui.feature.md "Settings", specs/user-info-settings.
  // feature.md "open Settings"): a page in the editor pane with the room a
  // dialog lacked — the sections listed on the left, each a titled group of
  // label-left, control-right rows. Every control saves itself the moment it
  // changes (macOS style), so there is no Save button; the ✕ or ESC goes
  // back. The plugins have their own page, linked under the sections.
  // A plugin's Settings sections after a core one (src/plugins/client/
  // settings.ts): the navigation entries, and the sections themselves,
  // each given the state payload and the page's patchSettings.
  const pluginSettingsNav = (after: Parameters<typeof sectionsAfter>[1] | null) =>
    (after === null ? sectionsBeforeAll(pluginSettingsSections) : sectionsAfter(pluginSettingsSections, after)).map(
      (s) => ({ id: `settings-${s.id}`, title: s.title }),
    );
  // An agent's model list (specs/agents/agent-plugins.feature.md "Each
  // agent offers the models the data repo lists") sits in its plugin's own
  // section — Settings → Claude — after what the plugin renders; an agent
  // whose plugin adds none gets a section of its own, titled after it. A
  // local agent only, so not in the demo or hosted app.
  // The lists live in the specifications folder: none while a code repository is open.
  const modelListsShown = !demo && !hosted && codeRepoDir === null;
  const agentModelList = (agent: (typeof agents)[number]) => (
    <AgentModelList key={agent.id} agent={agent} models={agentModels[agent.id] ?? []} onSaved={saveAgentModels} />
  );
  const sectionlessAgents = modelListsShown
    ? agentsWithoutSection(agents, pluginSettingsSections.map((s) => s.id))
    : [];
  const renderPluginSettings = (after: Parameters<typeof sectionsAfter>[1] | null) =>
    (after === null ? sectionsBeforeAll(pluginSettingsSections) : sectionsAfter(pluginSettingsSections, after)).map(
      (s: SettingsSection) => {
        const agent = modelListsShown ? agents.find((a) => a.id === s.id) : undefined;
        return (
          <PageSection key={s.id} id={`settings-${s.id}`} title={s.title} hint={s.hint}>
            <s.Component settings={settingsPayload} patchSettings={patchSettings} demo={demo} hosted={hosted} />
            {agent && agentModelList(agent)}
          </PageSection>
        );
      },
    );
  const renderSettingsPage = () => (
    <AppPageLayout
      title="Settings"
      sections={[
        ...pluginSettingsNav(null),
        { id: "settings-general", title: "General" },
        ...pluginSettingsNav("general"),
        ...(demo ? [] : [{ id: "settings-git", title: "Git & GitHub" }]),
        ...pluginSettingsNav("git"),
        ...(demo || codeRepoDir !== null ? [] : [{ id: "settings-sync", title: "Sync" }]),
        ...pluginSettingsNav("sync"),
        { id: "settings-editor", title: "Specs" },
        ...pluginSettingsNav("specs"),
        ...(customAttributesText !== null ? [{ id: "settings-attributes", title: "Custom attributes" }] : []),
        ...pluginSettingsNav("attributes"),
        { id: "settings-project", title: "Project management" },
        ...pluginSettingsNav("project"),
        ...RESOURCE_LINK_KINDS.map((kind) => ({
          id: `settings-links-${kind}`,
          title: RESOURCE_LINK_TOOLS[kind].name,
        })),
        ...pluginSettingsNav("links"),
        { id: "settings-qtest", title: "qTest" },
        ...pluginSettingsNav("qtest"),
        ...(demo || hosted ? [] : [{ id: "settings-jira", title: "Jira" }]),
        ...(demo || hosted ? [] : [{ id: "settings-confluence", title: "Confluence" }]),
        ...pluginSettingsNav("confluence"),
        { id: "settings-workflow", title: "Workflow" },
        ...pluginSettingsNav("workflow"),
        ...pluginSettingsNav("agents"),
        ...sectionlessAgents.map((a) => ({ id: `settings-agent-${a.id}`, title: a.label })),
      ]}
      onClose={closeAppPage}
      actions={<span className="app-page-status">Saved to .specdriven/settings.json as you change it</span>}
      aside={
        <button type="button" className="app-page-nav-link" onClick={openPlugins}>
          <Puzzle size={13} aria-hidden="true" /> Plugins
        </button>
      }
    >
      {renderPluginSettings(null)}
      <PageSection
        id="settings-general"
        title="General"
        hint="How the app looks and which editing aids it offers. These are remembered on this device, not in the settings file."
      >
        {/* Appearance (specs/ui/ui.feature.md "Settings"): applied right away
            and remembered on this device, not in the settings file. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Appearance
            <span className="settings-row-hint">
              Applied immediately and remembered on this device.
            </span>
          </span>
          <select
            value={theme}
            onChange={(e) => {
              const pref = e.target.value as ThemePref;
              setTheme(pref);
              applyThemePref(pref);
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        {/* Vim mode: adds a Vim tab to every Markdown editor, remembered
            on this device like the theme (src/frontend/SourceEditor.tsx).
            Hidden in the demo, which pins it off — modal editing is a
            trap for a visitor who did not ask for it. */}
        {!demo && (
        <label className="settings-row">
          <span className="settings-row-label">
            Vim mode
            <span className="settings-row-hint">
              Adds a Vim tab to every Markdown editor: modal editing with Vim&apos;s
              keys and a status line for : commands. Esc stays inside the editor.
              Remembered on this device.
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={vimMode}
              onChange={(e) => applyVimPref(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        )}
        {/* Spell check (specs/editor/common-editor.feature.md "Spell check"):
            the browser's checker in every prose field, on by default and
            remembered on this device (src/frontend/spellCheckPref.ts). */}
        <label className="settings-row">
          <span className="settings-row-label">
            Spell check
            <span className="settings-row-hint">
              Underlines misspelt words in every editor and message box, with
              suggestions on right-click. Fields that hold urls, names and code are
              left alone. Remembered on this device.
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={spellCheckOn}
              onChange={(e) => applySpellCheckPref(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        {/* Excalidraw support (specs/editor/excalidraw-support.feature.md):
            a diagram button in every Markdown editor's toolbar, remembered
            on this device. The demo keeps the row and starts it on
            (src/frontend/excalidrawPref.ts). */}
        <label className="settings-row">
          <span className="settings-row-label">
            Excalidraw diagrams
            <span className="settings-row-hint">
              Adds a diagram button to every Markdown editor&apos;s toolbar: draw in
              Excalidraw and the drawing is embedded as an SVG image in the data repo.
              Remembered on this device.
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={excalidrawOn}
              onChange={(e) => applyExcalidrawPref(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        {/* The Pomodoro (specs/app/pomodoro.feature.md): off by default —
            a timer nobody asked for is a row of sidebar taken from the
            work. Turning it on opens the bar, so the switch shows what
            it just switched on (src/frontend/pomodoroPref.ts). */}
        <label className="settings-row">
          <span className="settings-row-label">
            Pomodoro timer
            <span className="settings-row-hint">
              Times your own work in pomodoros: a timer icon in the sidebar header
              that opens the bar beneath it, the <kbd>p</kbd> key, and the command
              palette. Close the bar and the icon keeps the clock. Remembered on
              this device.
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={pomodoroOn}
              onChange={(e) => {
                applyPomodoroEnabled(e.target.checked);
                if (e.target.checked) applyPomodoroShown(true);
              }}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
      </PageSection>
      {renderPluginSettings("general")}
      {/* Git & GitHub (specs/app/user-info-settings.feature.md "Git
          access"), right after General: where git gets its GitHub
          credentials. Hidden in demo mode — the demo dataset never syncs
          with GitHub. */}
      {hosted ? (
      <PageSection
        id="settings-git"
        title="Git & GitHub"
        hint="The GitHub account the hosted app syncs and publishes with."
      >
        {/* Hosted mode: the token is pasted on the gateway's account page,
            stored encrypted there, and handed to this app on start. */}
        <div className="settings-row auth-section">
          <span className="auth-title">GitHub account</span>
          <p className="hint">
            {auth?.signedIn ? (
              <>
                Using the token for <strong>{auth.login}</strong> from your account.
              </>
            ) : (
              <>No GitHub token yet — add one to open and publish your specs repository.</>
            )}
          </p>
          <div className="auth-row">
            <a className="secondary" href="/account">
              Manage GitHub token and agent keys
            </a>
          </div>
        </div>
      </PageSection>
      ) : !demo && (
      <PageSection
        id="settings-git"
        title="Git & GitHub"
        hint="Where git gets its GitHub credentials for syncing and publishing."
      >
        {/* Git access (specs/app/user-info-settings.feature.md "Git
            access"): the GitHub CLI, a personal access token, or — behind
            the GitHub account switch below — the account sign-in; the panel
            under the radios is the chosen one's. */}
        <GitAccessChoice
          value={settingsAccessShown}
          ghInstalled={Boolean(gh?.available)}
          accountOffered={settingsGithubAccountDraft}
          onPick={(access) => void pickGitAccess(access)}
        />
        {settingsAccessShown === "gh" && (
          <div className="settings-row auth-section">
            <span className="auth-title">GitHub CLI</span>
            <p className="hint">
              {!gh?.available ? (
                <>
                  The GitHub CLI is not installed — get it from{" "}
                  <a href="https://cli.github.com" target="_blank" rel="noreferrer">
                    cli.github.com
                  </a>
                  , run <code>gh auth login</code>, then reopen Settings.
                </>
              ) : gh.signedIn ? (
                <>
                  Signed in
                  {gh.login ? (
                    <>
                      {" "}
                      as <strong>{gh.login}</strong>
                    </>
                  ) : null}
                  {gh.hosts && gh.hosts.length > 0 ? <> on {gh.hosts.join(", ")}</> : null}. For
                  another GitHub Enterprise host, run{" "}
                  <code>gh auth login --hostname &lt;host&gt;</code>.
                </>
              ) : (
                <>
                  Installed but signed out — run <code>gh auth login</code>, then reopen
                  Settings.
                </>
              )}
            </p>
          </div>
        )}
        {settingsAccessShown === "token" && (
        <div className="settings-row auth-section">
          <span className="auth-title">GitHub Personal Access Token</span>
          {auth?.signedIn && (
            <div className="auth-row">
              <span>
                Signed in as <strong>{auth.login}</strong>
                {auth.host && auth.host !== GITHUB_HOST ? <> on {auth.host}</> : null}
              </span>
              <button className="secondary" onClick={signOutGitHub}>
                Sign out
              </button>
            </div>
          )}
          {!deviceFlow && !webConnecting && (
            <PasteToken replacing={Boolean(auth?.signedIn)} onSignedIn={signedInWithToken} />
          )}
          {authStatus && <p className="error">{authStatus}</p>}
          <p className="hint">
            Git uses this token on github.com or the host it was made for; without one,
            git's own credentials on this computer. Local folders work without either.
          </p>
        </div>
        )}
        {settingsAccessShown === "account" && (
        <div className="settings-row auth-section">
          <span className="auth-title">GitHub account</span>
          {auth?.signedIn && (
            <div className="auth-row">
              <span>
                Signed in as <strong>{auth.login}</strong>
                {auth.host && auth.host !== GITHUB_HOST ? <> on {auth.host}</> : null}
              </span>
              <button className="secondary" onClick={signOutGitHub}>
                Sign out
              </button>
            </div>
          )}
          {authStatus && <p className="error">{authStatus}</p>}
          {auth?.signedIn ? null : deviceFlow ? (
            <div className="auth-device">
              <p>
                Enter code <code className="device-code">{deviceFlow.userCode}</code> at{" "}
                <a href={deviceFlow.verificationUri} target="_blank" rel="noreferrer">
                  {deviceFlow.verificationUri.replace(/^https?:\/\//, "")}
                </a>
              </p>
              <p className="hint">Waiting for GitHub…</p>
            </div>
          ) : webConnecting ? (
            <div className="auth-device">
              <p>Finish signing in to GitHub in your browser, then come back here.</p>
              <p className="hint">Waiting for GitHub…</p>
              <button className="secondary" onClick={() => setWebConnecting(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="auth-row">
              {/* Browser OAuth needs an http(s) callback; the desktop
                  app:// pages offer the device code only. */}
              {canConnectViaBrowser && (
                <button className="secondary" onClick={connectGitHub}>
                  Connect to GitHub
                </button>
              )}
              <button className={canConnectViaBrowser ? "link" : "secondary"} onClick={startSignIn}>
                {canConnectViaBrowser ? "Use a device code instead" : "Sign in with GitHub"}
              </button>
            </div>
          )}
        </div>
        )}
        <label className="settings-row">
          <span className="settings-row-label">
            GitHub account
            <span className="settings-row-hint">
              {settingsGithubAccountDraft
                ? "Preview: offers GitHub account sign-in — the browser or a device code — as a Git access. Not finished yet."
                : "Offers GitHub account sign-in as a Git access. Hidden while it is not ready."}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="GitHub account"
              checked={settingsGithubAccountDraft}
              onChange={(e) => void toggleGithubAccount(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
      </PageSection>
      )}
      {renderPluginSettings("git")}
      {/* Demo mode has nothing to sync with: the whole autosync/live
          sync group hides — the server refuses the changes anyway. */}
      {!demo && codeRepoDir === null && (
      <PageSection
        id="settings-sync"
        title="Sync"
        hint="How the data repo is pulled and pushed, and whether running apps share edits live."
      >
        {/* Autosync (specs/ui/ui.feature.md "Settings"): the switch is on by
            default; off stores a frequency of 0, which stops the reload. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Autosync
            <span className="settings-row-hint">
              {settingsAutosyncOnDraft
                ? "The data repo is git-pulled automatically at this interval, and locally saved scenarios are pushed."
                : "Autosync is off: the data repo is only pulled and pushed when you publish."}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settingsAutosyncOnDraft}
              onChange={(e) => void toggleAutosync(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        {settingsAutosyncOnDraft && (
          <label className="settings-row">
            <span className="settings-row-label">Autosync frequency (seconds)</span>
            <input
              type="number"
              min={1}
              value={settingsDraft}
              onChange={(e) => setSettingsDraft(e.target.value)}
              onBlur={() => void commitAutosyncSeconds()}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
        )}
        {/* Live sync (specs/datastore/automerge-store.feature.md): opt-in
            websocket accelerator on top of git, with an explicit privacy
            warning. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Live sync server (optional)
            <span className="settings-row-hint">
              Syncs edits between running apps in near-real time over websocket; git
              remains the source of record. On a public server such as
              wss://sync.automerge.org, anyone who has a document&apos;s id can read
              that document — leave it off to keep specs in the git repo only.
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settingsSyncOnDraft}
              onChange={(e) => void toggleLiveSync(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        {settingsSyncOnDraft && (
          <div className="settings-row">
            <input
              type="text"
              aria-label="Live sync server url"
              value={settingsSyncDraft}
              onChange={(e) => setSettingsSyncDraft(e.target.value)}
              onBlur={() => void commitSyncUrl()}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder="wss://sync.automerge.org"
            />
          </div>
        )}
      </PageSection>
      )}
      {renderPluginSettings("sync")}
      <PageSection
        id="settings-editor"
        title="Specs"
        hint="How the scenario editor saves and how scenarios read in the feature list."
      >
        {/* Editor autosave (specs/editor/editor-autosave.feature.md): the open
            editor saves itself at this interval. There is no off switch —
            only how often, at least 3 seconds. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Autosave interval (seconds)
            <span className="settings-row-hint">
              An open scenario editor saves itself this often, so an unsaved edit is
              never more than a few seconds old. Minimum {MIN_AUTOSAVE_SECONDS} seconds;
              the default is {DEFAULT_AUTOSAVE_SECONDS}.
            </span>
          </span>
          <input
            type="number"
            min={MIN_AUTOSAVE_SECONDS}
            value={settingsAutosaveDraft}
            onChange={(e) => setSettingsAutosaveDraft(e.target.value)}
            onBlur={() => void commitAutosaveSeconds()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
        <label className="settings-row">
          <span className="settings-row-label">
            Scenario preview lines
            <span className="settings-row-hint">
              How many lines of the rendered Markdown body each scenario shows in the
              list.
            </span>
          </span>
          <input
            type="number"
            min={1}
            value={settingsLinesDraft}
            onChange={(e) => setSettingsLinesDraft(e.target.value)}
            onBlur={() => void commitPreviewLines()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
        {/* specs/traceability.feature.md: the test-links table is optional,
            controlled here; default ON. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Show links to automated tests
            <span className="settings-row-hint">
              Each scenario ends with a table of GitHub links to its automated tests,
              when it has any.
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settingsTestLinksDraft}
              onChange={(e) => void toggleTestLinks(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        {/* specs/traceability.feature.md "Open test in idea": a click on
            a test link runs `idea --line <n> <file>` on the file in the
            code repo instead of opening GitHub; default OFF. */}
        {settingsTestLinksDraft && (
          <label className="settings-row">
            <span className="settings-row-label">
              Open test links in IntelliJ IDEA
              <span className="settings-row-hint">
                {canOpenInIdea
                  ? "A click on a test link opens the file at its line in IntelliJ IDEA, from the project's code repo, instead of on GitHub."
                  : "Needs idea on PATH. On a Mac: "}
                {!canOpenInIdea && (
                  <code>
                    ln -s &quot;/Applications/IntelliJ IDEA.app/Contents/MacOS/idea&quot;
                    /usr/local/bin/idea
                  </code>
                )}
              </span>
            </span>
            <span className="switch">
              <input
                type="checkbox"
                role="switch"
                checked={settingsOpenInIdeaDraft}
                onChange={(e) => void toggleOpenInIdea(e.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
            </span>
          </label>
        )}
        {/* specs/app/feature-flags.feature.md: opt-in — with the switch
            off no flag chips or editors show, and the `[ff:…]` lines
            already in feature files stay as written. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Feature flags
            <span className="settings-row-hint">
              {settingsFeatureFlagsDraft ? (
                <>
                  Features and scenarios show the flags that gate them, written <code>[ff:name:on|off]</code>{" "}
                  under their heading, and the editors add, toggle and remove them.
                </>
              ) : (
                <>
                  Flags are hidden; any <code>[ff:…]</code> line already in a feature file stays there.
                </>
              )}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="Feature flags"
              checked={settingsFeatureFlagsDraft}
              onChange={(e) => void toggleFeatureFlags(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        {/* specs/ui/scenario-polarity.feature.md: opt-in — with the switch
            off no pill shows and the Confluence page is one run of
            scenarios; a `[negative]` line already in a feature file stays
            as written. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Positive and negative scenarios
            <span className="settings-row-hint">
              {settingsScenarioPolarityDraft ? (
                <>
                  Each scenario shows a green Positive or red Negative pill that flips on a click, written{" "}
                  <code>[negative]</code> under its heading; its Confluence page groups the scenarios into a
                  Positive and a Negative section.
                </>
              ) : (
                <>
                  Scenarios carry no polarity; any <code>[negative]</code> line already in a feature file stays
                  there.
                </>
              )}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="Positive and negative scenarios"
              checked={settingsScenarioPolarityDraft}
              onChange={(e) => void toggleScenarioPolarity(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
      </PageSection>
      {renderPluginSettings("specs")}
      {/* specs/app/custom-attributes.feature.md "Custom attributes are
          defined in Settings": the data repo's definitions, shared with the
          team through git rather than kept on this device. */}
      {customAttributesText !== null && (
        <PageSection
          id="settings-attributes"
          title="Custom attributes"
          hint={
            <>
              The attributes your team tags features and scenarios with, such as{" "}
              <code>[br:young-driver-surcharge:on]</code>. Saved in the data folder&apos;s{" "}
              <code>custom-attributes.txt</code> and pushed with the next sync.
            </>
          }
        >
          <CustomAttributesEditor
            content={customAttributesText}
            autosaveSeconds={autosaveSeconds}
            onSaved={setCustomAttributesText}
            onError={(message) => toast.error(message)}
          />
        </PageSection>
      )}
      {renderPluginSettings("attributes")}
      <PageSection
        id="settings-project"
        title="Project management"
        hint="Links from features and scenarios to the tickets tracking them."
      >
        {/* Project management (specs/external-links/project-management-
            jira-linear-etc.feature.md): the master switch for tickets;
            default ON. Off, no feature or scenario shows or asks for
            one. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Project management
            <span className="settings-row-hint">
              {settingsProjectManagementDraft
                ? "Features and scenarios carry a link to the ticket tracking them; the editors ask for the ticket's url."
                : "Ticket links are off: nothing in the app shows or asks for one. Links already recorded are kept."}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settingsProjectManagementDraft}
              onChange={(e) => void toggleProjectManagement(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        {settingsProjectManagementDraft && (
          <>
            {/* The tool chosen here is the `<program>` of every new
                link, which is why the editors need only the url. */}
            <label className="settings-row">
              <span className="settings-row-label">
                Project management tool
                <span className="settings-row-hint">
                  Where the tickets live. Its name is what a link shows —{" "}
                  <code>{settingsToolDraft.trim() || DEFAULT_PROJECT_MANAGEMENT_TOOL}:ABC-123</code>.
                </span>
              </span>
              <span className="settings-tool">
                <select
                  aria-label="Project management tool"
                  value={
                    PROJECT_MANAGEMENT_TOOLS.includes(settingsToolDraft.trim())
                      ? settingsToolDraft.trim()
                      : "Other"
                  }
                  onChange={(e) => void changeTool(e.target.value === "Other" ? "" : e.target.value)}
                >
                  {PROJECT_MANAGEMENT_TOOLS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                  <option value="Other">Other</option>
                </select>
                {!PROJECT_MANAGEMENT_TOOLS.includes(settingsToolDraft.trim()) && (
                  <input
                    className="settings-tool-name"
                    value={settingsToolDraft}
                    placeholder="Tool name"
                    aria-label="Project management tool name"
                    spellCheck={false}
                    onChange={(e) => void changeTool(e.target.value)}
                  />
                )}
              </span>
            </label>
            {/* specs/external-links/project-management-jira-linear-etc.
                feature.md "Publishing links into projected feature (.md)
                files": the ticket links go into the markdown only while
                this is on; default ON. */}
            <label className="settings-row">
              <span className="settings-row-label">
                Publish external links
                <span className="settings-row-hint">
                  Write each feature's and scenario's ticket link (Jira, Linear…) into the
                  .feature.md as <code>[Jira:ABC-123](url)</code>, so it shows on GitHub. Off
                  keeps the links in the app only.
                </span>
              </span>
              <span className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={settingsPublishLinksDraft}
                  onChange={(e) => void toggleExternalLinks(e.target.checked)}
                />
                <span className="switch-track" aria-hidden="true" />
              </span>
            </label>
          </>
        )}
      </PageSection>
      {/* specs/external-links/aha-and-figma-links.feature.md: one opt-in
          switch per tool, each in its own section. Off, nothing in the app
          shows or asks for that tool's links; the ones already recorded are
          kept. */}
      {renderPluginSettings("project")}
      {RESOURCE_LINK_KINDS.map((kind) => {
        const { name, noun } = RESOURCE_LINK_TOOLS[kind];
        return (
          <PageSection
            key={kind}
            id={`settings-links-${kind}`}
            title={name}
            hint={`Links from features and scenarios to the ${name} ${noun}s behind them.`}
          >
            <label className="settings-row">
              <span className="settings-row-label">
                {name} links
                <span className="settings-row-hint">
                  {settingsResourceLinksDraft[kind]
                    ? `Features and scenarios carry links to the ${name} ${noun}s behind them. They are kept with the feature in the app, not written into the .feature.md.`
                    : `${name} links are off: nothing in the app shows or asks for one. Links already recorded are kept.`}
                </span>
              </span>
              <span className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`${name} links`}
                  checked={settingsResourceLinksDraft[kind]}
                  onChange={(e) => void toggleResourceLinks(kind, e.target.checked)}
                />
                <span className="switch-track" aria-hidden="true" />
              </span>
            </label>
            {/* specs/external-links/aha-import.feature.md "Import from Aha!
                is switched on in Settings": opt-in, like the links. On, it
                offers "Import from Aha!…" in the folder menu, beside "New
                feature" and in the palette, and the key form ("An Aha! API
                key is kept per site on this device"). Not in the demo or the
                hosted app, which keep no device secrets. */}
            {kind === "aha" && !demo && !hosted && (
              <>
                <label className="settings-row">
                  <span className="settings-row-label">
                    Import features from Aha!
                    <span className="settings-row-hint">
                      {settingsAhaImportDraft
                        ? `With a key for the site, "Import from Aha!…" turns an Aha! feature into a feature here: its name and description, its requirements as scenarios, each linking its Aha! record. Importing switches Aha! links on.`
                        : "Import from Aha! is off: nothing in the app offers it. Keys already saved are kept."}
                    </span>
                  </span>
                  <span className="switch">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label="Import features from Aha!"
                      checked={settingsAhaImportDraft}
                      onChange={(e) => void toggleAhaImport(e.target.checked)}
                    />
                    <span className="switch-track" aria-hidden="true" />
                  </span>
                </label>
                {settingsAhaImportDraft && (
                  <div className="settings-row">
                    <span className="settings-row-label">
                      Aha! API keys
                      <AhaTokens sites={ahaSites} onChange={setAhaSites} />
                    </span>
                  </div>
                )}
              </>
            )}
          </PageSection>
        );
      })}
      {renderPluginSettings("links")}
      <PageSection
        id="settings-qtest"
        title="qTest"
        hint="Links from features and scenarios to the qTest test cases covering them."
      >
        {/* specs/external-links/qtest-test-cases.feature.md: opt-in, like
            the Aha! and Figma links. Off, nothing in the app shows or asks
            for a test case; the links already recorded are kept. */}
        <label className="settings-row">
          <span className="settings-row-label">
            qTest test cases
            <span className="settings-row-hint">
              {settingsQtestLinksDraft ? (
                <>
                  Features and scenarios carry a link to the qTest test case covering them,
                  written into the .feature.md as <code>[qTest:TC-42](url)</code> while Publish
                  external links is on.
                </>
              ) : (
                "qTest links are off: nothing in the app shows or asks for one. Links already recorded are kept."
              )}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="qTest test cases"
              checked={settingsQtestLinksDraft}
              onChange={(e) => void toggleQtestLinks(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        {/* specs/external-links/qtest-test-cases.feature.md "A qTest token is
            kept per site on this device": the token that lets a feature's
            scenarios be created as test cases, from its ⋯ menu. Not in the
            hosted app, which keeps no device secrets. */}
        {!demo && !hosted && settingsQtestLinksDraft && (
          <div className="settings-row">
            <span className="settings-row-label">
              Create test cases from a feature
              <span className="settings-row-hint">
                With a token for the site, a feature's ⋯ menu offers "Publish qTest Test Cases…": one module
                named after the feature under a parent module you pick, one test case per scenario. "Publish to
                Wiki &amp; qTest…" publishes the Confluence page first and then the test cases, which link it.
              </span>
              <QtestTokens sites={qtestSites} onChange={setQtestSites} />
            </span>
          </div>
        )}
      </PageSection>
      {renderPluginSettings("qtest")}
      {/* Jira (specs/external-links/jira-wiki-import.feature.md "Jira and
          Confluence imports are switched on in Settings"): opt-in, like the
          Aha! import. On, "Import from Jira…" reads issues into a new feature
          and the token form shows. Not in the hosted app, which keeps no
          device secrets. */}
      {!demo && !hosted && (
        <PageSection
          id="settings-jira"
          title="Jira"
          hint="Read Jira issues into a new feature, from a folder's ⋯ menu. One personal access token per Jira site, kept on this device."
        >
          <label className="settings-row">
            <span className="settings-row-label">
              Import issues from Jira
              <span className="settings-row-hint">
                {settingsJiraEnabledDraft
                  ? `With a token for the site, "Import from Jira…" in a folder's ⋯ menu reads Jira issues into a new feature. With Confluence on too, the combined "Import from Jira/Wiki…" reads both.`
                  : "Jira is off: nothing in the app offers the Jira import. Tokens already saved are kept."}
              </span>
            </span>
            <span className="switch">
              <input
                type="checkbox"
                role="switch"
                aria-label="Import issues from Jira"
                checked={settingsJiraEnabledDraft}
                onChange={(e) => void toggleJiraEnabled(e.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
            </span>
          </label>
          {settingsJiraEnabledDraft && (
            <div className="settings-row">
              <span className="settings-row-label">
                Jira personal access tokens
                <JiraTokens sites={jiraSites} onChange={setJiraSites} />
              </span>
            </div>
          )}
        </PageSection>
      )}
      {/* specs/external-links/confluence-wiki.feature.md: opt-in. On,
          "Publish to Confluence…" shows, the Confluence import is offered,
          the agent's wiki MCP server is handed to sessions, and the token
          form shows. Not in the hosted app, which keeps no device secrets. */}
      {!demo && !hosted && (
        <PageSection
          id="settings-confluence"
          title="Confluence"
          hint="Publish features as pages of a Confluence wiki, from a feature's ⋯ menu. One personal access token per wiki, kept on this device."
        >
          <label className="settings-row">
            <span className="settings-row-label">
              Publish pages to Confluence
              <span className="settings-row-hint">
                {settingsConfluenceEnabledDraft
                  ? `With a token for the wiki, a feature's ⋯ menu offers "Publish to Confluence…", a folder's offers it for all its features, "Import from Confluence…" reads pages into a new feature, and a coding-agent session can read the wiki.`
                  : "Confluence is off: nothing in the app offers publishing to or importing from Confluence, and agent sessions cannot read the wiki. Tokens already saved are kept."}
              </span>
            </span>
            <span className="switch">
              <input
                type="checkbox"
                role="switch"
                aria-label="Publish pages to Confluence"
                checked={settingsConfluenceEnabledDraft}
                onChange={(e) => void toggleConfluenceEnabled(e.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
            </span>
          </label>
          {settingsConfluenceEnabledDraft && (
            <div className="settings-row">
              <span className="settings-row-label">
                Confluence personal access tokens
                <ConfluenceTokens wikis={confluenceWikis} onChange={setConfluenceWikis} />
              </span>
            </div>
          )}
        </PageSection>
      )}
      {renderPluginSettings("confluence")}
      <PageSection
        id="settings-workflow"
        title="Workflow"
        hint="What the app lets people do with specs: hand them to a coding agent, assign them, schedule them, delete or move them."
      >
        {/* Code gen (specs/agents/claude.feature.md): off takes the selection
            checkboxes and Start session away, and the server refuses a
            session, so no spec can reach Claude — neither the CLI nor
            Claude Code Desktop. Hidden in demo mode, where it is pinned
            off (no Claude to hand specs to). */}
        {!demo && (
        <label className="settings-row">
          <span className="settings-row-label">
            Code generation
            <span className="settings-row-hint">
              {settingsCodeGenDraft
                ? "Specs and scenarios can be selected and handed to a coding agent — a new session in Claude Code Desktop, or a chat in the app's own coding agent pane — which implements them in the data repo."
                : "Code generation is off: no selection checkboxes, and sessions are refused."}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settingsCodeGenDraft}
              onChange={(e) => void toggleCodeGen(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        )}
        {/* Ghostty (specs/agents/agent-pane.feature.md "A worktree session
            opens in a Ghostty shell"): a click on a worktree session's
            branch in the coding agent pane opens a Ghostty shell in the
            worktree; default OFF. Hidden in the demo and the hosted app,
            which run on a server with no Ghostty to open. */}
        {!demo && !hosted && (
        <label className="settings-row">
          <span className="settings-row-label">
            Open worktrees in Ghostty
            <span className="settings-row-hint">
              {canOpenGhostty
                ? "A click on a worktree session's branch in the coding agent pane opens a Ghostty shell in the folder the agent works in."
                : "Needs Ghostty, from ghostty.org — on a Mac in Applications, elsewhere as ghostty on PATH. Then a click on a worktree session's branch in the coding agent pane opens a shell there."}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settingsGhosttyDraft}
              onChange={(e) => void toggleGhostty(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        )}
        {/* Authorship (specs/app/specs-authorship.feature.md): a setting
            of the open data folder, kept in its project-settings.json —
            the app records who created and last updated every feature and
            scenario either way; this decides whether the markdown says so. */}
        {authorsInMarkdown !== null && (
        <label className="settings-row">
          <span className="settings-row-label">
            Write authors into feature files
            <span className="settings-row-hint">
              {authorsInMarkdown
                ? "Each feature and scenario in this data folder carries “Created by” and “Updated by” lines (authors-in-markdown in its project-settings.json)."
                : "Who created and last updated each feature and scenario is recorded and shown here, but not written into this data folder's markdown."}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={authorsInMarkdown}
              onChange={(e) => void toggleAuthorsInMarkdown(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        )}
        {/* Feature assignment (src/server/members.ts): opt-in — with
            the switch off the feature page offers no "Assigned"
            dropdown, and nothing already assigned is rewritten. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Assign features to project members
            <span className="settings-row-hint">
              {settingsAssignmentsDraft
                ? "The feature page offers an “Assigned” dropdown of the members listed in the data folder's project-settings.json."
                : "Features are not assigned to anyone; any assignment already in a feature file stays there."}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settingsAssignmentsDraft}
              onChange={(e) => void toggleAssignments(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        {/* Google Calendar (specs/app/tasks.feature.md "Add task to
            Google Calendar"): opt-in — a calendar chip on every task
            that estimates it and opens a prefilled event. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Google Calendar
            <span className="settings-row-hint">
              {settingsGoogleCalendarDraft
                ? "An Add to calendar button on every task: an estimate of the time it takes, proposed by Claude when the CLI is on PATH, and a prefilled Google Calendar event. Nothing is sent to Google until you confirm the event there."
                : "Tasks have no calendar button."}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settingsGoogleCalendarDraft}
              onChange={(e) => void toggleGoogleCalendar(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        {/* Deleting or moving published scenarios
            (specs/editor/spec-editor.feature.md "Delete Published
            Spec", specs/ui/navigation.feature.md "move a scenario to
            another feature"): opt-in — with the switch off published
            scenarios stay immutable and nothing offers to delete or move
            them. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Allow deleting or moving published specs
            <span className="settings-row-hint">
              {settingsDeletePublishedDraft
                ? "Published scenarios can be deleted, behind a Danger Zone confirmation, or moved to another feature. Either change is committed and pushed."
                : "Published scenarios are immutable and cannot be deleted or moved."}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settingsDeletePublishedDraft}
              onChange={(e) => void toggleDeletePublished(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
      </PageSection>
      {renderPluginSettings("workflow")}
      {renderPluginSettings("agents")}
      {sectionlessAgents.map((a) => (
        <PageSection
          key={a.id}
          id={`settings-agent-${a.id}`}
          title={a.label}
          hint={`The models ${a.label} offers in its model menus.`}
        >
          {agentModelList(a)}
        </PageSection>
      ))}
      {settingsError && <p className="error settings-error">{settingsError}</p>}
    </AppPageLayout>
  );

  // The user menu (specs/user-info-settings.feature.md), behind the avatar
  // in the sidebar's corner and on the rail alike. Three inline sections —
  // the account, this project, the app — so a dozen unlike rows read as
  // three short lists. The read-only site's visitor has no settings,
  // plugins or logs: the release notes and the app's source alone.
  const userMenuItems: MenuItem[] = readOnly
    ? [whatsNewMenuItem(notesUnseen, openWhatsNew), ...sourceCodeMenuItems(sourceUrl)]
    : [
        {
          id: "account",
          label: "Account",
          inline: true,
          items: [
            {
              id: "user-info",
              label: "User info",
              icon: <UserRound size={13} />,
              onSelect: () => {
                setDrawerOpen(false);
                setUserInfoOpen(true);
              },
            },
            // The desktop and local app's own GitHub sign-in: paste a
            // token, switch to another account's, or sign out — always
            // offered, unlike the browser sign-in behind the GitHub
            // account switch.
            ...(hosted || demo
              ? []
              : auth?.signedIn
                ? [
                    {
                      id: "switch-account",
                      label: "Switch account…",
                      icon: <KeyRound size={13} />,
                      onSelect: () => {
                        setDrawerOpen(false);
                        setTokenSignInOpen(true);
                      },
                    },
                    {
                      id: "sign-out",
                      label: "Sign out",
                      icon: <LogOut size={13} />,
                      onSelect: () => void signOutGitHub(),
                    },
                  ]
                : [
                    {
                      id: "sign-in",
                      label: "Sign in with token…",
                      icon: <KeyRound size={13} />,
                      onSelect: () => {
                        setDrawerOpen(false);
                        setTokenSignInOpen(true);
                      },
                    },
                  ]),
            // The hosted gateway's own pages (src/gateway): the account with
            // its tokens and password, and signing out.
            ...(hosted
              ? [
                  {
                    id: "account-tokens",
                    label: "Account & tokens",
                    icon: <KeyRound size={13} />,
                    onSelect: () => window.location.assign("/account"),
                  },
                  {
                    id: "sign-out",
                    label: "Sign out",
                    icon: <LogOut size={13} />,
                    onSelect: signOutHosted,
                  },
                ]
              : []),
          ],
        },
        {
          id: "project",
          label: "Project",
          inline: true,
          items: [
            // The data repo's own settings (specs/app/project-settings
            // .feature.md): the code repos and their specs symlinks, the
            // members, the authorship switch.
            {
              id: "project-settings",
              label: "Project settings",
              icon: <FolderInput size={13} />,
              onSelect: () => {
                setDrawerOpen(false);
                openProjectSettings();
              },
            },
            {
              id: "plugins",
              label: "Plugins",
              icon: <Puzzle size={13} />,
              keys: "g p",
              onSelect: () => {
                setDrawerOpen(false);
                openPlugins();
              },
            },
            // The hosted gateway's admin page (src/gateway/admin.ts): the
            // allowed emails and the users' roles, for admins only.
            ...(hosted && hostedAdmin
              ? [
                  {
                    id: "admin",
                    label: "Admin",
                    icon: <ShieldCheck size={13} />,
                    onSelect: () => window.location.assign("/admin"),
                  },
                ]
              : []),
          ],
        },
        {
          id: "app",
          label: "App",
          inline: true,
          items: [
            {
              id: "settings",
              label: "Settings",
              icon: <Settings size={13} />,
              keys: "mod+,",
              onSelect: () => {
                setDrawerOpen(false);
                openSettings();
              },
            },
            // The app's own logs and their verbosity; the hosted demo's
            // server logs are not a visitor's to read.
            ...(demo
              ? []
              : [
                  {
                    id: "observability",
                    label: "Observability",
                    icon: <Activity size={13} />,
                    keys: "g o",
                    onSelect: () => {
                      setDrawerOpen(false);
                      openObservability();
                    },
                  },
                ]),
            // The Automerge store, browsed read-only (src/frontend/DataPage.tsx).
            {
              id: "data",
              label: "Data",
              icon: <Database size={13} />,
              keys: "g d",
              onSelect: () => {
                setDrawerOpen(false);
                openData();
              },
            },
            // The stored images, the unreferenced ones first (src/frontend/ImagesPage.tsx).
            {
              id: "images",
              label: "Images",
              icon: <Images size={13} />,
              keys: "g m",
              onSelect: () => {
                setDrawerOpen(false);
                openImages();
              },
            },
            // The release notes and the running build's source, which every copy offers.
            whatsNewMenuItem(notesUnseen, () => {
              setDrawerOpen(false);
              openWhatsNew();
            }),
            ...sourceCodeMenuItems(sourceUrl),
          ],
        },
      ];

  return (
    <main
      className={`layout${resizingSidebar || resizingAgent ? " resizing" : ""}${sidebarCollapsed && !compact ? " collapsed" : ""}${compact ? " compact" : ""}${paneShown && !compact ? " agent-open" : ""}${editorOff ? " editor-hidden" : ""}${readOnly ? " read-only" : ""}`}
      style={{ "--sidebar-w": `${sidebarWidth}px`, "--agent-w": `${pane.width}px` } as CSSProperties}
    >
      {compact && (
        /* One pane: a top bar stands in for the sidebar's header — the menu
           button opens the drawer, the mark is the way home, and search opens
           the palette, since ⌘K has no key to live on. */
        <div className="topbar">
          <button
            type="button"
            className="ibtn topbar-menu"
            aria-label={drawerOpen ? "Close the menu" : "Open the menu"}
            aria-expanded={drawerOpen}
            aria-controls="sidebar"
            onClick={toggleSidebar}
          >
            <MenuIcon size={18} aria-hidden="true" />
          </button>
          <a
            href="/"
            className="topbar-home"
            aria-label="Open the data folder's README"
            onClick={(e) =>
              spaClick(e, () => {
                goHome();
                void loadReadme();
              })
            }
          >
            <Logo size={22} />
            {dataRepo && (
              <span className="topbar-repo">{demo ? "demo-data" : repoDisplayName(dataRepo)}</span>
            )}
          </a>
          <button
            type="button"
            className="ibtn"
            aria-label="Search or run a command"
            onClick={() => setPalette({ query: "" })}
          >
            <Search size={18} aria-hidden="true" />
          </button>
          {codeGen && canOpenAgentPane && (
            <button
              type="button"
              className="ibtn"
              aria-label="Coding agent pane"
              aria-pressed={paneShown}
              onClick={() => agentChat.togglePane()}
            >
              <Bot size={18} aria-hidden="true" />
            </button>
          )}
          {/* Demo mode: the sandbox note sits under the bar here, since a
              phone visitor may never open the drawer that holds it. */}
          {demo && <div className="demo-banner topbar-banner">Demo — edits reset on refresh</div>}
        </div>
      )}
      {compact && drawerOpen && (
        <div className="drawer-backdrop" aria-hidden="true" onClick={() => setDrawerOpen(false)} />
      )}
      {sidebarCollapsed && !compact ? (
        /* The rail (specs/ui/ui.feature.md "Design system"): the sidebar
           folded to its icons — search, Home, the page tabs, and the way
           back out. */
        <aside className="rail">
          {/* The logo is the home link, as the folder name is in the expanded
              sidebar (app-startup.md "The data folder name links to the
              README"); the one Expand sits at the foot, where the sidebar's
              Collapse icon has its mirror. */}
          <Tooltip label="Home (README)" keys="g h">
            <a
              href="/"
              className="rail-btn rail-logo"
              aria-label="Home"
              onClick={(e) =>
                spaClick(e, () => {
                  goHome();
                  void loadReadme();
                })
              }
            >
              <Logo size={24} />
            </a>
          </Tooltip>
          <Tooltip label="Search or run a command" keys="mod+k">
            <button
              type="button"
              className="rail-btn"
              aria-label="Search or run a command"
              onClick={() => setPalette({ query: "" })}
            >
              <Search size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          {/* The rail mirrors the sidebar's tab bar: Specs first, then the
              plugins' tabs, lit the way the bar's tabs are (shownTab) — so
              collapsing the sidebar never loses the tree. */}
          {codeRepoDir === null && (
          <Tooltip label="Specs" keys="g s">
            <a
              href="/"
              className={`rail-link${!pluginView && shownTab === "specs" ? " active" : ""}`}
              aria-label="Specs"
              onClick={(e) =>
                spaClick(e, () => {
                  selectSidebarTab("specs");
                  if (pluginView || appPage) {
                    goHome();
                    void loadReadme();
                  }
                })
              }
            >
              <FileText size={16} aria-hidden="true" />
            </a>
          </Tooltip>
          )}
          {/* The plugins' tabs — the special folders first. A tab with nothing
              to open — an empty folder — has no icon on the rail. */}
          {pluginTabs.filter(tabReachable).map((tab) => (
            <Tooltip key={tab.id} label={tab.title} keys={tab.shortcut}>
              <a
                href={tab.route.path(tab.route.home)}
                className={`rail-link${
                  pluginView?.tab === tab.id || (!pluginView && shownTab === tab.id) ? " active" : ""
                }`}
                aria-label={tab.title}
                onClick={(e) =>
                  spaClick(e, () => void openPluginView(tab.id, tab.route.home, { push: true }))
                }
              >
                <tab.icon size={16} aria-hidden="true" />
              </a>
            </Tooltip>
          ))}
          <div className="rail-bottom">
            <PomodoroBar
              compact
              onExpand={toggleSidebar}
              settingsOpen={pomodoroSettings}
              onSettingsOpen={setPomodoroSettings}
            />
            {canHideEditor && (
              <Tooltip label={editorOff ? "Show the editor pane" : "Hide the editor pane"} keys="\">
                <button
                  type="button"
                  className={`rail-btn${editorOff ? "" : " active"}`}
                  aria-label="Editor pane"
                  aria-pressed={!editorOff}
                  onClick={toggleEditor}
                >
                  <PanelRight size={16} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
            {codeGen && canOpenAgentPane && (
              <Tooltip label={pane.open ? "Close the coding agent pane" : "Open the coding agent pane"} keys="]">
                <button
                  type="button"
                  className={`rail-btn${paneShown ? " active" : ""}`}
                  aria-label="Coding agent pane"
                  aria-pressed={paneShown}
                  onClick={() => agentChat.togglePane()}
                >
                  <Bot size={16} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
            <Tooltip label="Expand the sidebar" keys="[">
              <button type="button" className="rail-btn" aria-label="Expand the sidebar" onClick={toggleSidebar}>
                <PanelLeftOpen size={16} aria-hidden="true" />
              </button>
            </Tooltip>
            {/* The same user menu the sidebar's corner opens
                (specs/user-info-settings.feature.md), not a shortcut to
                Settings alone. */}
            <span className="rail-user">
              <Menu
                open={userMenuOpen}
                onClose={() => setUserMenuOpen(false)}
                label="User menu"
                className="user-menu"
                containerSelector=".rail-user"
                items={userMenuItems}
              />
              <Tooltip label={user ? (user.login ?? user.username) : "User menu"}>
                <button
                  type="button"
                  className="rail-btn"
                  aria-label="User menu"
                  aria-haspopup="menu"
                  aria-expanded={userMenuOpen}
                  onClick={() => setUserMenuOpen((o) => !o)}
                >
                  <span className="avatar" aria-hidden="true">
                    {initials}
                  </span>
                </button>
              </Tooltip>
            </span>
          </div>
        </aside>
      ) : (
      <aside
        id="sidebar"
        className={compact ? `drawer${drawerOpen ? " open" : ""}` : undefined}
        ref={drawerTrapRef}
        aria-hidden={compact && !drawerOpen ? true : undefined}
        // Following any link in the drawer — a feature, a page,
        // Home — is leaving it; buttons that only change the drawer itself
        // (folder twists, the filter, the tabs) keep it open.
        onClickCapture={(e) => {
          if (compact && e.target instanceof Element && e.target.closest("a[href]"))
            setDrawerOpen(false);
        }}
      >
        <header>
          {/* The data repo name leads the header, which costs a single row of
              vertical space. It is the home link (app-startup.md
              "The data folder name links to the README"): a real `/` anchor,
              so a plain click opens the README editor and right-click → Copy
              Link works. */}
          <div className="repo-row">
            {codeRepoDir !== null ? (
              /* A code repository (specs/app/code-repo-mode.feature.md): its
                 name is the home link, which opens its README.md. */
              <a
                href="/"
                className="repo-name"
                title={`${codeRepoDir} — a code repository`}
                aria-label="Open the code repository's home"
                onClick={(e) => spaClick(e, goHome)}
              >
                {repoDisplayName(codeRepoDir)}
              </a>
            ) : dataRepo && (
              <a
                href="/"
                className="repo-name"
                title={`${dataRepo} — open its README`}
                aria-label="Open the data folder's README"
                onClick={(e) => spaClick(e, goHome)}
              >
                {/* The demo's working copy is a numbered throwaway folder —
                    show the dataset's name, not the generation counter. */}
                {demo ? "demo-data" : repoDisplayName(dataRepo)}
              </a>
            )}
            {/* Recent folder list (specs/ui/ui.feature.md "Recent folder
                list"): a small ▾ next to the folder name drops down the
                folders used before (up to 10, most recent first), by name
                only — the full path is the tooltip. Picking one switches
                to it and opens its README; the current folder is ticked,
                and picking it just goes home to the README. */}
            {(dataRepo || codeRepoDir !== null) && !demo && !readOnly && (
              <div className="repo-recent">
                <button
                  type="button"
                  className="ibtn repo-recent-toggle"
                  title="Recent folders"
                  aria-label="Recent folders"
                  aria-haspopup="menu"
                  aria-expanded={recentMenuOpen}
                  disabled={settingRepo}
                  onClick={() => setRecentMenuOpen((o) => !o)}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path
                      d="M1.5 3.5 5 7l3.5-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <Menu
                  open={recentMenuOpen}
                  onClose={() => setRecentMenuOpen(false)}
                  label="Recent folders"
                  className="repo-recent-menu"
                  containerSelector=".repo-recent"
                  items={[
                    // Every kind of folder, the newest ten, each marked
                    // by its kind's icon (specs/app/spec-folders.feature.md
                    // "Manage specification folders").
                    ...recentFolders.slice(0, 10).map((folder): MenuItem => {
                      const current =
                        folder.kind === "code" ? folder.path === codeRepoDir : codeRepoDir === null && folder.path === dataRepo;
                      return {
                        id: `${folder.kind}:${folder.path}`,
                        label: repoDisplayName(folder.path),
                        icon: <FolderKindIcon kind={folder.kind} size={13} />,
                        title: `${FOLDER_KIND_LABEL[folder.kind]} — ${folder.path}`,
                        checked: current,
                        onSelect: () => {
                          if (folder.kind === "code") void openCodeRepo(folder.path);
                          else if (current) {
                            goHome();
                            void loadReadme();
                          } else {
                            void switchRepo(folder.path);
                          }
                        },
                      };
                    }),
                    // Manage specification folders
                    // (specs/app/spec-folders.feature.md): the list as a
                    // dialog, where folders can be opened, removed or added.
                    {
                      id: "manage-folders",
                      label: "Manage folders…",
                      icon: <FolderInput size={13} />,
                      onSelect: () => setFoldersOpen(true),
                    },
                  ]}
                />
              </div>
            )}
            {/* Sync (specs/ui/ui.feature.md "Main page"): immediate data
                reload, next to the folder it reloads. Disabled with a progress
                label while running, the icon turning; no status line at the
                bottom of the page. Up here it works from the home view too, not
                only with a feature open. */}
            {!demo && !readOnly && codeRepoDir === null && (
              <Tooltip
                label={
                  syncing
                    ? "Syncing…"
                    : syncProblem !== null
                      ? `${syncProblemMessage(syncProblem)}. Click to try again.`
                      : "Sync — pull the data folder and push saved changes"
                }
              >
                <button
                  type="button"
                  className={syncProblem !== null ? "ibtn repo-sync failing" : "ibtn repo-sync"}
                  aria-label={
                    syncing ? "Syncing…" : syncProblem !== null ? "Sync — saved changes are not being pushed" : "Sync"
                  }
                  disabled={syncing}
                  onClick={() => void syncNow()}
                >
                  {/* While pushes fail the icon itself says so, struck
                      through — the tooltip gives the reason. */}
                  {syncProblem !== null && !syncing ? (
                    <RefreshCwOff size={14} className="sync-icon" aria-hidden="true" />
                  ) : (
                    <RefreshCw
                      size={14}
                      className={syncing ? "sync-icon spinning" : "sync-icon"}
                      aria-hidden="true"
                    />
                  )}
                </button>
              </Tooltip>
            )}
          </div>
          {/* The Pomodoro (specs/app/pomodoro.feature.md): its icon lives here,
              left of the pane toggles, and opens the bar beneath the header.
              Nothing renders while the Settings switch is off. */}
          <PomodoroToggle />
          {/* The pane toggles sit in the order their panes do: the editor
              first, then the coding agent's Bot to its right. */}
          {canHideEditor && (
            <Tooltip label={editorOff ? "Show the editor pane" : "Hide the editor pane"} keys="\">
              <button
                type="button"
                className={`ibtn${editorOff ? "" : " active"}`}
                aria-label="Editor pane"
                aria-pressed={!editorOff}
                onClick={toggleEditor}
              >
                <PanelRight size={15} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
          {codeGen && canOpenAgentPane && (
            <Tooltip label={pane.open ? "Close the coding agent pane" : "Open the coding agent pane"} keys="]">
              <button
                type="button"
                className={`ibtn${paneShown ? " active" : ""}`}
                aria-label="Coding agent pane"
                aria-pressed={paneShown}
                onClick={() => agentChat.togglePane()}
              >
                <Bot size={15} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
          <Tooltip label={compact ? "Close the menu" : "Collapse the sidebar"} keys="[">
            <button
              type="button"
              className="ibtn collapse-btn"
              aria-label={compact ? "Close the menu" : "Collapse the sidebar"}
              onClick={toggleSidebar}
            >
              {compact ? (
                <X size={16} aria-hidden="true" />
              ) : (
                <PanelLeftClose size={15} aria-hidden="true" />
              )}
            </button>
          </Tooltip>
        </header>
        {/* Demo mode: say what the sandbox does — edits are ephemeral. On a
            small screen the top bar carries the note instead. */}
        {demo && !compact && <div className="demo-banner">Demo — edits reset on refresh</div>}
        {/* Search (specs/search.feature.md): top-left, under the header so the
            macOS drag region above it stays draggable. The field opens the
            command palette, where the results are. */}
        <div className="sidebar-search">
          <button
            type="button"
            className="sidebar-search-btn"
            aria-label="Search or run a command"
            onClick={() => setPalette({ query: "" })}
          >
            <Search size={14} className="search-icon" aria-hidden="true" />
            <span>Search or run a command…</span>
            <kbd>{IS_MAC ? "⌘K" : "Ctrl K"}</kbd>
          </button>
        </div>
        {/* The Pomodoro bar (specs/app/pomodoro.feature.md): the pane the
            header's timer icon opens, right under the icon that opens it.
            Renders nothing while the Settings switch is off or the bar is
            closed (src/frontend/pomodoroPref.ts). */}
        <PomodoroBar settingsOpen={pomodoroSettings} onSettingsOpen={setPomodoroSettings} />
        {/* Sidebar tabs (specs/app/roadmap.feature.md, specs/app/tasks.feature
            .md): Specs is the feature tree, and each mounted plugin — each
            special folder the Settings switches show among them — adds its
            own beside it. The bar only shows once there is something to
            switch to — one tab is no tab bar. */}
        {pluginTabs.length > (codeRepoDir !== null ? 1 : 0) && (
          <div className="side-tabs" role="tablist" aria-label="Sidebar">
            {/* Each tab's tooltip carries its `g` chord, as the rail's icons
                do. A code repository has no Specs tab. */}
            {codeRepoDir === null && (
            <Tooltip label="Specs" keys="g s">
              <button
                type="button"
                role="tab"
                id="side-tab-specs"
                aria-selected={shownTab === "specs"}
                aria-controls="side-panel-specs"
                className={shownTab === "specs" ? "active" : ""}
                onClick={() => selectSidebarTab("specs")}
              >
                <FileText size={14} aria-hidden="true" /> <span className="side-tab-label">Specs</span>
              </button>
            </Tooltip>
            )}
            {/* The plugins' tabs (specs/app/plugins.feature.md), in their
                order, after the core's. */}
            {pluginTabs.map((tab) => (
              <Tooltip key={tab.id} label={tab.title} keys={tab.shortcut}>
                <button
                  type="button"
                  role="tab"
                  id={`side-tab-${tab.id}`}
                  aria-selected={shownTab === tab.id}
                  aria-controls={`side-panel-${tab.id}`}
                  className={shownTab === tab.id ? "active" : ""}
                  onClick={() => {
                    selectSidebarTab(tab.id);
                    // The tab is the module's door: with none of its views
                    // open yet, it opens the tab's home view — unless the tab
                    // is a list to pick from (a special folder's pages).
                    if (tab.opensOnSelect !== false && pluginViewRef.current?.tab !== tab.id) {
                      openPluginView(tab.id, tab.route.home, { push: true });
                    }
                  }}
                >
                  <tab.icon size={14} aria-hidden="true" /> <span className="side-tab-label">{tab.title}</span>
                </button>
              </Tooltip>
            ))}
          </div>
        )}
        {shownTab === "specs" && (
        <div
          className="side-panel"
          role={pluginTabs.length > 0 ? "tabpanel" : undefined}
          id="side-panel-specs"
          aria-labelledby={pluginTabs.length > 0 ? "side-tab-specs" : undefined}
        >
        {/* A load that failed every retry offers the manual one: without it
            the sidebar would sit empty until the next page load, and with
            the cron refresh off (reloadFrequencySeconds 0) nothing else asks. */}
        {loadError && (
          <p className="error">
            {loadError}{" "}
            <button type="button" className="link" onClick={() => void loadFeatures()}>
              Try again
            </button>
          </p>
        )}
        {/* The Features section head carries the filter: by status, by
            assignee. Active filters show as chips that clear on click, on a
            row of their own under the head so they never crowd its icons. */}
        <SidebarSection
          label={<>Features <StatusCounts {...statusTotals} /></>}
          filter={<>
            <Tooltip label="Filter features">
              <button
                type="button"
                className={`chip${filtering ? " on" : ""}`}
                aria-label="Filter features"
                aria-haspopup="menu"
                aria-expanded={filterMenuOpen}
                onClick={() => setFilterMenuOpen((o) => !o)}
              >
                <ListFilter size={12} aria-hidden="true" /> Filter
              </button>
            </Tooltip>
            <Menu
              open={filterMenuOpen}
              onClose={() => setFilterMenuOpen(false)}
              label="Filter features"
              className="filter-menu"
              containerSelector=".filter-anchor"
              items={[
                {
                  id: "status",
                  label: "Status",
                  items: [
                    {
                      id: "status-any",
                      label: "Any status",
                      checked: filter.status === null,
                      onSelect: () => setFilter((f) => ({ ...f, status: null })),
                    },
                    ...(["draft", "proposed", "published"] as const).map((st) => ({
                      id: `status-${st}`,
                      label: st[0]!.toUpperCase() + st.slice(1),
                      icon: <StatusIcon status={st} size={13} />,
                      checked: filter.status === st,
                      onSelect: () => setFilter((f) => ({ ...f, status: st })),
                    })),
                  ],
                },
                ...(assignments
                  ? [
                      {
                        id: "assignee",
                        label: "Assignee",
                        items: [
                          {
                            id: "assignee-any",
                            label: "Anyone",
                            checked: filter.assignee === null,
                            onSelect: () => setFilter((f) => ({ ...f, assignee: null })),
                          },
                          ...members.map((m) => ({
                            id: `assignee-${m.name}`,
                            label: m.name,
                            icon: (
                              <span className="avatar chip-avatar" aria-hidden="true">
                                {initialsOf(m.name)}
                              </span>
                            ),
                            checked: filter.assignee === m.name,
                            onSelect: () => setFilter((f) => ({ ...f, assignee: m.name })),
                          })),
                        ],
                      },
                    ]
                  : []),
                // One entry per attribute key the specs use: "Any …", each
                // attribute by its names, and each with its value.
                ...attributeFilterGroups(features, attributeDefs).map((group) => ({
                  id: `attribute-${group.key}`,
                  label: group.label,
                  items: group.items.map((item) => ({
                    id: `attribute-${item.id}`,
                    label: item.label,
                    title: item.label,
                    checked: sameAttributeFilter(filter.attribute, item.filter),
                    onSelect: () =>
                      setFilter((f) => ({
                        ...f,
                        attribute: sameAttributeFilter(f.attribute, item.filter) ? null : item.filter,
                      })),
                  })),
                })),
              ]}
            />
          </>}
          /* The tree's actions (src/frontend/ActionIcons.tsx) sit on its
              head rather than in rows of their own. New folder and New
              feature create inside the clicked folder, and their tooltips
              name it. Code gen session (specs/agents/claude.feature.md): check
              whole specs in the tree or single scenarios on their cards,
              then Start session asks for a name and where to run; the
              count of checked specs rides on its button. Timing your own
              work is the Pomodoro at the foot of the sidebar
              (specs/app/pomodoro.feature.md), not a kind of session. */
          actions={!readOnly && (<>
            <Tooltip label={selectedFolder ? `New folder in "${selectedFolder}"` : "New folder"}>
              <button type="button" className="ibtn" aria-label="New folder" onClick={createFolder}>
                <NewFolderIcon size={15} />
              </button>
            </Tooltip>
            <Tooltip
              label={selectedFolder ? `New feature in "${selectedFolder}"` : "New feature"}
              keys="c"
            >
              <button type="button" className="ibtn" aria-label="New feature" onClick={createFeature}>
                <NewFeatureIcon size={15} />
              </button>
            </Tooltip>
            {ahaImport && (
              <Tooltip label={selectedFolder ? `Import from Aha! into "${selectedFolder}"` : "Import from Aha!"}>
                <button
                  type="button"
                  className="ibtn"
                  aria-label="Import from Aha!"
                  onClick={() => setAhaImportOpen({ folder: selectedFolder })}
                >
                  <Import size={15} />
                </button>
              </Tooltip>
            )}
            <Tooltip
              label={
                sessionRunning
                  ? "Session running…"
                  : codeGen && sessionCount > 0
                    ? `Start an AI session in ${codeGenTargetLabel(sessionTarget, agents)} with ${selectionLabel}`
                    : "Start an AI session"
              }
            >
              <button
                type="button"
                className={`ibtn session-btn${codeGen && specSelection.size > 0 ? " armed" : ""}${
                  sessionRunning ? " running" : ""
                }`}
                aria-label={
                  sessionRunning
                    ? "Session running…"
                    : `Start session…${codeGen && specSelection.size > 0 ? ` (${specSelection.size})` : ""}`
                }
                onClick={() => startSession()}
                disabled={sessionRunning}
              >
                <StartSessionIcon size={15} />
                {codeGen && specSelection.size > 0 && !sessionRunning && (
                  <span className="action-count" aria-hidden="true">
                    {specSelection.size}
                  </span>
                )}
              </button>
            </Tooltip>
          </>)}
        >
        {filtering && (
          <div className="filter-chips">
            {filter.status && (
              <button
                type="button"
                className="chip on"
                aria-label={`Clear the ${filter.status} filter`}
                onClick={() => setFilter((f) => ({ ...f, status: null }))}
              >
                <StatusIcon status={filter.status} size={12} /> {filter.status}{" "}
                <X size={11} aria-hidden="true" />
              </button>
            )}
            {filter.assignee && (
              <button
                type="button"
                className="chip on"
                aria-label="Clear the assignee filter"
                onClick={() => setFilter((f) => ({ ...f, assignee: null }))}
              >
                {filter.assignee === me ? "Mine" : filter.assignee} <X size={11} aria-hidden="true" />
              </button>
            )}
            {filter.attribute && (
              <button
                type="button"
                className="chip on attribute-filter-chip"
                aria-label="Clear the attribute filter"
                title={attributeFilterLabel(filter.attribute, attributeDefs)}
                onClick={() => setFilter((f) => ({ ...f, attribute: null }))}
              >
                <Tag size={12} aria-hidden="true" />{" "}
                <span className="filter-chip-label">{attributeFilterLabel(filter.attribute, attributeDefs)}</span>{" "}
                <X size={11} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {/* What a session would run over, so a scenario checked on a card
            two clicks away is still visible from here. */}
        {codeGen && selectionLabel && !sessionRunning && (
          <p className="session-notice">Selected: {selectionLabel}</p>
        )}
        {sessionNotice && <p className="session-notice">{sessionNotice}</p>}
        </SidebarSection>
        {/* Folder tree (specs/ui/folders.feature.md): folders are drop targets
            for drag-moving features; the tree background is the top level. */}
        {(
          <div
            className={`tree${(dragging !== null || folderDrag !== null) && dropTarget === "" ? " drop-target" : ""}`}
            ref={treeRef}
            role="tree"
            aria-label="Features"
            aria-multiselectable={readOnly ? undefined : true}
            onKeyDown={onTreeKeyDown}
            onClick={(e) => {
              // A click on the bare background deselects the folder, so the
              // next "+ New folder" creates at the top level again.
              if (e.target === e.currentTarget) setSelectedFolder(null);
            }}
            onDragOver={(e) => {
              // A folder from inside another folder moves to the top level
              // here ("move a folder"); a top-level one is already there.
              if (folderDrag !== null) {
                if (!folderDropsInto(folderDrag, SPECS_FOLDER)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropTarget("");
                return;
              }
              if (dragging === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropTarget("");
            }}
            onDragLeave={() => setDropTarget((t) => (t === "" ? null : t))}
            onDrop={(e) => {
              if (folderDrag !== null) {
                if (!folderDropsInto(folderDrag, SPECS_FOLDER)) return;
                e.preventDefault();
                const dragged = folderDrag.path;
                setFolderDrag(null);
                setFolderDropAt(null);
                setDropTarget(null);
                void moveFolder(dragged, SPECS_FOLDER);
                return;
              }
              if (dragging === null) return;
              e.preventDefault();
              void moveTo(dragging, "");
            }}
          >
            {renderTree(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), 0)}
            {features.length === 0 && folders.length === 0 && (
              <p className="empty">No feature files yet</p>
            )}
          </div>
        )}
        {/* The scenarios picked in the tree (specs/ui/navigation.feature.md
            "delete several scenarios at once"): how many, Delete, and a way
            out — Esc does the same. Under the tree, not over it, so the
            rows stay put while the next one is clicked. */}
        {treePicksCount > 0 && (
          <div className="tree-picks-bar" role="toolbar" aria-label="Selected scenarios">
            <span className="tree-picks-count">
              {treePicksCount} selected
            </span>
            <button
              type="button"
              className="btn btn-danger tree-picks-delete"
              onClick={() => void deletePickedScenarios()}
            >
              <Trash2 size={13} aria-hidden="true" /> Delete
            </button>
            <Tooltip label="Clear the selection" keys="Esc">
              <button
                type="button"
                className="ibtn"
                aria-label="Clear the selection"
                onClick={clearTreePicks}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        )}
        </div>
        )}
        {/* A plugin's tab (specs/app/plugins.feature.md) — a special folder's
            page list or the Tests tab's plans and case library, say: the
            tab's own sidebar. */}
        {pluginTabs
          .filter((tab) => tab.id === shownTab)
          .map((tab) => (
            <tab.Sidebar
              key={tab.id}
              view={pluginView?.tab === tab.id ? pluginView.view : null}
              app={tabApp}
              navigate={navigateIn(tab.id)}
            />
          ))}
        {/* specs/user-info-settings.feature.md: the lower left corner shows the
            current user; its menu holds User info, Settings and Plugins. */}
        <div className="user-corner">
          <Menu
            open={userMenuOpen}
            onClose={() => setUserMenuOpen(false)}
            label="User menu"
            className="user-menu"
            containerSelector=".user-corner"
            // The read-only site's visitor has no settings, plugins or logs:
            // the menu offers the release notes and the app's source alone.
            items={userMenuItems}
          />
          <div className="user-row">
            <button
              type="button"
              className="user-chip"
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              onClick={() => setUserMenuOpen((o) => !o)}
            >
              <span className="avatar" aria-hidden="true">
                {initials}
              </span>
              <span className="user-name">{user ? (user.login ?? user.username) : "…"}</span>
              {/* The build on screen, right of the user name. */}
              {appVersion && !canUpdate && (
                <VersionChip version={appVersion} notesUnseen={notesUnseen} updateAvailable={updateAvailable} />
              )}
            </button>
            {/* Check for Updates… (specs/app/app-updates.feature.md): on the
                desktop app the version is its own button, opening the Updates
                page — beside the user chip, since a button cannot hold one. */}
            {appVersion && canUpdate && (
              <VersionChip
                version={appVersion}
                notesUnseen={notesUnseen}
                updateAvailable={updateAvailable}
                onOpen={() => {
                  setUserMenuOpen(false);
                  setDrawerOpen(false);
                  openUpdates();
                }}
              />
            )}
          </div>
        </div>
      </aside>
      )}
      {/* Divider (specs/ui/ui.feature.md "Sidebar resize"): drag to resize the
          left pane, double-click to restore the default width. Gone while
          the sidebar is a rail, and on one-pane screens. */}
      {!sidebarCollapsed && !compact && (
      <div
        className="sidebar-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={Math.max(SIDEBAR_MIN, Math.round(window.innerWidth * 0.6))}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setResizingSidebar(true);
        }}
        onPointerMove={(e) => {
          if (resizingSidebar) setSidebarWidth(clampSidebarWidth(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!resizingSidebar) return;
          setResizingSidebar(false);
          storeSidebarWidth(clampSidebarWidth(e.clientX));
        }}
        onLostPointerCapture={() => setResizingSidebar(false)}
        onDoubleClick={() => {
          setSidebarWidth(SIDEBAR_DEFAULT);
          storeSidebarWidth(SIDEBAR_DEFAULT);
        }}
        onKeyDown={(e) => {
          const delta = e.key === "ArrowRight" ? 16 : e.key === "ArrowLeft" ? -16 : 0;
          if (delta === 0) return;
          e.preventDefault();
          const w = clampSidebarWidth(sidebarWidth + delta);
          setSidebarWidth(w);
          storeSidebarWidth(w);
        }}
      />
      )}
      {/* Hidden ("\", specs/ui/ui.feature.md "Hide the editor pane") so the
          coding agent pane can take the window — not rendered rather than
          hidden in CSS, the way the agent pane itself is gated. */}
      {!editorOff && (
      <section className="editor" aria-busy={featureLoading || undefined}>
        {/* A render error in one view shows a note with a way back, never a
            blank window; the key follows the page so navigating resets it. */}
        <ErrorBoundary
          key={appPage ?? selected ?? pluginViewKey ?? "home"}
        >
        {appPageShown === "settings" ? (
          renderSettingsPage()
        ) : appPageShown === "project-settings" ? (
          /* Project settings (specs/app/project-settings.feature.md): the
             data repo's project-settings.json — code repos with their specs
             symlinks, the default, the members, the authorship switch. */
          <ProjectSettingsPage
            key={projectSettingsKey}
            prompt={prompt}
            confirm={confirm}
            browseFolder={canChooseFolder ? () => chooseFolderNative("code-repo") : undefined}
            onChanged={() => void loadFeatures()}
            onClose={closeAppPage}
          />
        ) : appPageShown === "plugins" ? (
          /* Plugins (specs/app/plugins.feature.md): its own page, opened
             from the user menu — the plugins on in tab order, the ones off,
             the folders they load from and the marketplaces. */
          <PluginsPage
            initialWanted={pluginsWanted}
            plugins={plugins}
            loadErrors={pluginLoadErrors}
            hasIssuesRepo={Boolean(issuesRepo)}
            demo={demo}
            sources={pluginSources}
            marketplaces={pluginMarketplaces}
            error={settingsError}
            setEnabled={setPluginEnabled}
            move={movePlugin}
            patchSettings={patchSettings}
            prompt={prompt}
            confirm={confirm}
            browseFolder={canChooseFolder ? () => chooseFolderNative() : undefined}
            onChanged={refreshPlugins}
            onOpenSettings={openSettings}
            onClose={closeAppPage}
          />
        ) : appPageShown === "observability" ? (
          /* Observability: browse and search the app's own logs, and set
             how verbose they are. */
          <ObservabilityPage
            key={observabilityComponent}
            onClose={closeAppPage}
            copyText={copyText}
            initialComponent={observabilityComponent}
          />
        ) : appPageShown === "data" ? (
          /* Data: the Automerge store as tables, documents and history. */
          <DataPage onClose={closeAppPage} />
        ) : appPageShown === "images" ? (
          /* Images: every stored image with where it is used; delete the unreferenced. */
          <ImagesPage onClose={closeAppPage} confirm={confirm} demo={demo} />
        ) : appPageShown === "whats-new" ? (
          /* What's new: every release's notes, the installed one marked. */
          <WhatsNewPage installed={appVersion} onClose={closeAppPage} />
        ) : appPageShown === "updates" ? (
          /* Updates: the newest release, and the desktop app installing it. */
          <UpdatesPage onClose={closeAppPage} />
        ) : readOnly && editing && selected && feature ? (
          /* The read-only site: a scenario's page is a page, not the editor —
             its trail, the way to its neighbours, and the scenario rendered
             with its links. */
          <div className="scenario-pane">
            <div className="editor-bar scenario-pane-bar page-header">
              <div className="scenario-pane-title">
                <Breadcrumbs
                  items={[
                    repoCrumb,
                    ...folderCrumbs(selected),
                    {
                      label: feature.name || titleFromFileName(selected),
                      href: featurePath(selected),
                      title: `Back to ${feature.name || titleFromFileName(selected)}`,
                      onClick: (e) => {
                        e.preventDefault();
                        backToFeature();
                      },
                    },
                  ]}
                />
              </div>
              <div className="editor-actions scenario-pane-actions">
                <span className="scenario-nav" role="group" aria-label="Scenario navigation">
                  <Tooltip label="Previous scenario" keys="<">
                    <button
                      type="button"
                      className="ibtn"
                      aria-label="Previous scenario"
                      disabled={scenarioNav.prev === null}
                      onClick={() => stepScenario(-1)}
                    >
                      <ChevronLeft size={18} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Tooltip label="Next scenario" keys=">">
                    <button
                      type="button"
                      className="ibtn"
                      aria-label="Next scenario"
                      disabled={scenarioNav.next === null}
                      onClick={() => stepScenario(1)}
                    >
                      <ChevronRight size={18} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </span>
                <CopyLinkButton
                  keys="mod+shift+c"
                  copied={copied === scenarioLink(selected, editing.scenario)}
                  onCopy={() => void copyLink(scenarioLink(selected, editing.scenario))}
                />
              </div>
            </div>
            <div className="scenario-pane-head">
              {editing.index !== null && scenarioNumbers(feature.scenarios)[editing.index] != null && (
                <span className="scenario-number">S{scenarioNumbers(feature.scenarios)[editing.index]}</span>
              )}
              <h2 className="scenario-pane-heading">{editing.scenario.name}</h2>
              <span className="version">v{editing.scenario.version}</span>
              <span className="chip static">
                <StatusIcon status={editing.scenario.status} size={14} />
                {editing.scenario.status}
              </span>
            </div>
            <div className="scenario-pane-body read-only-scenario">
              <div className="md-preview">{renderMarkdown(editing.scenario.body)}</div>
              {showTestLinks && testsTable(editing.scenario.tests)}
              {(editing.scenario.link || (editing.scenario.prs ?? []).length > 0) && (
                <div className="props">
                  {editing.scenario.link && (
                    <a
                      className="chip"
                      href={editing.scenario.link.url}
                      target="_blank"
                      rel="noreferrer"
                      title={editing.scenario.link.url}
                    >
                      <Ticket size={14} aria-hidden="true" />
                      {externalLinkLabel(editing.scenario.link)}
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                  {(editing.scenario.prs ?? []).map((pr) => (
                    <a key={pr.url} className="chip" href={pr.url} target="_blank" rel="noreferrer" title={pr.url}>
                      <GitPullRequest size={14} aria-hidden="true" />
                      {pr.title || pr.url.replace(/^https:\/\/github\.com\//, "")}
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : editing && selected && feature ? (
          /* specs/editor/spec-editor.feature.md "Spec editor pane": the
             scenario editor takes the feature pane's slot — the sidebar stays
             beside it — with a bar on top and one scrolling column below. */
          <div className="scenario-pane">
            <div className="editor-bar scenario-pane-bar page-header">
              <div className="scenario-pane-title">
                {/* The top line is the trail alone — the data folder, the
                    feature's folders and the feature (specs/editor/
                    spec-editor.feature.md "Adding Scanarios"). The feature
                    crumb is the way back: like ESC, it leaves the scenario in
                    its autosaved state and lands on its card. */}
                <Breadcrumbs
                  items={[
                    repoCrumb,
                    ...folderCrumbs(selected),
                    {
                      label: feature.name || titleFromFileName(selected),
                      href: featurePath(selected),
                      title: `Back to ${feature.name || titleFromFileName(selected)}`,
                      onClick: (e) => {
                        e.preventDefault();
                        backToFeature();
                      },
                    },
                  ]}
                />
              </div>
              <div className="editor-actions scenario-pane-actions">
                {/* Previous / next scenario across the whole tree, as `<`
                    and `>` (or k / j) do from the keyboard. */}
                <span className="scenario-nav" role="group" aria-label="Scenario navigation">
                  <Tooltip
                    label={
                      scenarioNav.prev
                        ? `Previous: ${scenarioNav.prev.scenario.name} v${scenarioNav.prev.scenario.version}`
                        : "No previous scenario"
                    }
                    keys="<"
                  >
                    <button
                      type="button"
                      className="ibtn"
                      aria-label="Previous scenario"
                      disabled={scenarioNav.prev === null}
                      onClick={() => stepScenario(-1)}
                    >
                      <ChevronLeft size={18} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Tooltip
                    label={
                      scenarioNav.next
                        ? `Next: ${scenarioNav.next.scenario.name} v${scenarioNav.next.scenario.version}`
                        : "No next scenario"
                    }
                    keys=">"
                  >
                    <button
                      type="button"
                      className="ibtn"
                      aria-label="Next scenario"
                      disabled={scenarioNav.next === null}
                      onClick={() => stepScenario(1)}
                    >
                      <ChevronRight size={18} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </span>
                {/* Copy link (specs/ui/navigation.feature.md "share a link"):
                    the scenario's versioned url, as the card's ⋯ menu and
                    mod+shift+c copy it. A scenario with no name has no url
                    yet. */}
                <Tooltip
                  label={copied === scenarioPath(selected, editing.scenario) ? "Copied" : "Copy link"}
                  keys="mod+shift+c"
                >
                  <button
                    type="button"
                    className="ibtn"
                    aria-label="Copy link"
                    disabled={!editing.scenario.name.trim()}
                    onClick={() => void copyLink(scenarioPath(selected, editing.scenario))}
                  >
                    {copied === scenarioPath(selected, editing.scenario) ? (
                      <Check size={16} aria-hidden="true" />
                    ) : (
                      <Link size={16} aria-hidden="true" />
                    )}
                  </button>
                </Tooltip>
                {/* The next scenario, from here (specs/editor/
                    spec-editor.feature.md "Spec editor pane"): the pane saves
                    on the way out and the new draft opens right after it. */}
                <Tooltip label="New scenario after this one" keys="c">
                  <button
                    type="button"
                    className="ibtn"
                    aria-label="New scenario after this one"
                    disabled={!canAddAfter || publishing !== null}
                    onClick={() => void newScenarioAfterCurrent()}
                  >
                    <Plus size={16} aria-hidden="true" />
                  </button>
                </Tooltip>
                <SaveIndicator saving={saving} savedAt={savedAt} dirty={dirty} />
                {/* The rest of the pane's actions as a menu, like a card's ⋯.
                    Delete sits last, apart and red: proposed scenarios and
                    drafts can be deleted (specs/editor/spec-editor.feature.md)
                    — published ones too while Settings allows it ("Delete
                    Published Spec") — confirmed first, then saved out of the
                    feature or removed from the document. Propose and Publish
                    are not here: they are the status chip's, under the bar. A
                    published scenario is read-only apart from its links, which
                    save themselves, so its bar carries no save action. */}
                <span className="page-more editor-more">
                  <Tooltip label="More actions">
                    <button
                      type="button"
                      className="ibtn"
                      aria-label="Scenario actions"
                      aria-haspopup="menu"
                      aria-expanded={editorMenuOpen}
                      onClick={() => setEditorMenuOpen((o) => !o)}
                    >
                      <Ellipsis size={15} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Menu
                    open={editorMenuOpen}
                    onClose={() => setEditorMenuOpen(false)}
                    label="Scenario actions"
                    className="page-menu"
                    containerSelector=".editor-more"
                    items={[
                      {
                        id: "new-below",
                        label: "New scenario below",
                        icon: <Plus size={13} />,
                        keys: "c",
                        disabled: !canAddAfter || publishing !== null,
                        onSelect: () => void newScenarioAfterCurrent(),
                      },
                      {
                        id: "clone",
                        label: "Clone",
                        icon: <CopyPlus size={13} />,
                        disabled: savedEntry === null,
                        onSelect: () => {
                          if (savedEntry) void cloneTreeScenario(selected, savedEntry);
                        },
                      },
                      ...(editingPublished && editing.index !== null
                        ? [
                            {
                              id: "new-version",
                              label: "New version",
                              icon: <History size={13} />,
                              onSelect: () => newVersion(editing.index!),
                            },
                          ]
                        : []),
                      {
                        id: "copy",
                        label:
                          copied === scenarioPath(selected, editing.scenario) ? "Copied" : "Copy link",
                        icon: <Link size={13} />,
                        keys: "mod+shift+c",
                        disabled: !editing.scenario.name.trim(),
                        onSelect: () => void copyLink(scenarioPath(selected, editing.scenario)),
                      },
                      ...(editingDeletable
                        ? [
                            {
                              id: "delete",
                              label: "Delete",
                              icon: <Trash2 size={13} />,
                              danger: true,
                              onSelect: () => void deleteScenario(),
                            },
                          ]
                        : []),
                    ]}
                  />
                </span>
              </div>
            </div>
            {/* The scenario's name sits above the editor's top left corner
                (specs/editor/spec-editor.feature.md "Adding Scanarios") —
                editable until published (specs/ui/ui.feature.md "Scenario
                editor"), a read-only heading after. The version is assigned by
                the app, never typed: a new scenario takes the next version for
                its name (specs/ui/ui.feature.md). The status rides along as a
                badge: a scenario starts as a draft — persisted by autosave,
                kept out of the .feature.md — until Propose or Publish advances
                it. */}
            <div className="scenario-pane-head">
              {editing.index !== null &&
                feature !== null &&
                scenarioNumbers(feature.scenarios)[editing.index] != null && (
                  <span className="scenario-number">
                    S{scenarioNumbers(feature.scenarios)[editing.index]}
                  </span>
                )}
              {editingPublished ? (
                <h2 className="scenario-pane-heading">{editing.scenario.name}</h2>
              ) : (
                <input
                  className="scenario-pane-name"
                  // While this field has the caret autosave stands down, so
                  // the name is saved once, whole
                  // (specs/editor/editor-autosave.feature.md).
                  ref={nameFieldRef}
                  value={editing.scenario.name}
                  placeholder="Scenario name"
                  aria-label="Scenario name"
                  spellCheck={false}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      scenario: { ...editing.scenario, name: e.target.value },
                    })
                  }
                />
              )}
              {/* Its polarity (specs/ui/scenario-polarity.feature.md),
                  flipped in the draft; the pane's save writes it. */}
              {scenarioPolarity && (
                <PolarityPill
                  negative={!!editing.scenario.negative}
                  onToggle={() =>
                    setEditing({
                      ...editing,
                      scenario: withPolarity(editing.scenario, !editing.scenario.negative),
                    })
                  }
                />
              )}
              {/* The status as a chip (specs/editor/spec-editor.feature.md
                  "Spec editor pane"): a draft's menu offers the two ways
                  forward — Propose moves it into the .feature.md as
                  [proposed]; Publish takes it straight to [published],
                  committed and pushed — a proposed scenario's only Publish,
                  and a published one is a plain badge, unless Settings allows
                  deleting published specs: then its menu offers Back to
                  proposed ("Unpublish a Spec"). Closing without either keeps
                  the autosaved draft. mod+enter picks the first. */}
              <div className="version-field">
                Version <span className="version">v{draftVersion}</span>
                {editingPublished && deletePublished && savedEntry?.status === "published" ? (
                  <span className="chip-anchor status-anchor">
                    <button
                      type="button"
                      className="chip status-chip"
                      aria-haspopup="menu"
                      aria-expanded={statusMenuOpen}
                      aria-label="Status: published"
                      disabled={unpublishing}
                      onClick={() => setStatusMenuOpen((o) => !o)}
                    >
                      <StatusIcon status="published" size={14} />
                      published
                      <ChevronDown size={12} aria-hidden="true" />
                    </button>
                    <Menu
                      open={statusMenuOpen}
                      onClose={() => setStatusMenuOpen(false)}
                      label="Scenario status"
                      className="chip-menu"
                      containerSelector=".status-anchor"
                      items={[
                        {
                          id: "unpublish",
                          label: unpublishing ? "Moving back…" : "Back to proposed",
                          icon: <StatusIcon status="proposed" size={13} />,
                          disabled: unpublishing,
                          onSelect: () => void unpublishScenario(),
                        },
                      ]}
                    />
                  </span>
                ) : editingPublished ? (
                  <span className="chip static status-chip">
                    <StatusIcon status="published" size={14} />
                    published
                  </span>
                ) : (
                  <span className="chip-anchor status-anchor">
                    <button
                      type="button"
                      className="chip status-chip"
                      aria-haspopup="menu"
                      aria-expanded={statusMenuOpen}
                      aria-label={`Status: ${editing.scenario.status}`}
                      disabled={publishing !== null}
                      onClick={() => setStatusMenuOpen((o) => !o)}
                    >
                      <StatusIcon status={editing.scenario.status} size={14} />
                      {editing.scenario.status}
                      <ChevronDown size={12} aria-hidden="true" />
                    </button>
                    <Menu
                      open={statusMenuOpen}
                      onClose={() => setStatusMenuOpen(false)}
                      label="Scenario status"
                      className="chip-menu"
                      containerSelector=".status-anchor"
                      items={[
                        ...(editing.scenario.status === "draft"
                          ? [
                              {
                                id: "propose",
                                label: "Propose",
                                icon: <SendHorizontal size={13} />,
                                keys: "mod+enter",
                                disabled: !editing.scenario.name.trim() || publishing !== null,
                                onSelect: () => void proposeScenario(),
                              },
                            ]
                          : []),
                        {
                          id: "publish",
                          label: publishing !== null ? "Publishing…" : "Publish",
                          icon: <StatusIcon status="published" size={13} />,
                          ...(editing.scenario.status === "proposed" ? { keys: "mod+enter" } : {}),
                          disabled: !editing.scenario.name.trim() || publishing !== null,
                          onSelect: () => void publishScenario(),
                        },
                      ]}
                    />
                  </span>
                )}
              </div>
            </div>
            <div className="scenario-pane-body">
              <div
                className={`body-field${bodyHeight === null ? "" : " sized"}${resizingBody ? " resizing" : ""}`}
                ref={bodyFieldRef}
                style={
                  bodyHeight === null ? undefined : ({ "--body-h": `${bodyHeight}px` } as CSSProperties)
                }
              >
                <span className="field-label">Body</span>
                <MarkdownEditor
                  value={editing.scenario.body}
                  readOnly={editingPublished}
                  highlight={searchTerms ?? undefined}
                  placeholder="Describe the scenario in Markdown…"
                  // Opens rendered, like the feature description; a new
                  // scenario's blank body opens ready to type into instead.
                  initialTab={editing.scenario.body.trim() ? "preview" : "write"}
                  // specs/editor/table-editor.feature.md "variable creates a
                  // column": a {var} in the body names an example column.
                  tableVariables
                  onChange={(body) =>
                    setEditing({ ...editing, scenario: { ...editing.scenario, body } })
                  }
                />
                {/* The body's lower boundary is a grab strip like the
                    description editor's: drag it to give the body more room
                    when the ticket and test links crowd it, double-click to
                    restore the default. */}
                <HeightResizer
                  label="Resize the body editor"
                  min={BODY_MIN}
                  height={bodyHeight}
                  target={bodyFieldRef}
                  clamp={clampBodyHeight}
                  onHeight={setBodyHeight}
                  onCommit={(h) => storeEditorHeight(BODY_HEIGHT_KEY, h)}
                  onReset={() => {
                    setBodyHeight(null);
                    storeEditorHeight(BODY_HEIGHT_KEY, null);
                  }}
                  onResizing={setResizingBody}
                />
              </div>
              {/* specs/traceability.feature.md: GitHub links to the automated
                  tests covering this scenario — added, corrected in place (✎)
                  and removed (✕). Editable even for a published scenario: the
                  links track the tests, not the immutable spec. Hidden
                  entirely when the Settings toggle is off. */}
              {showTestLinks && (
                <div className="tests-field">
                  <span className="field-label">Automated tests</span>
                  {editing.scenario.tests.length > 0 && (
                    <ul className="test-list">
                      {editing.scenario.tests.map((t, i) => (
                        <li key={t}>
                          {testEdit === i ? (
                            <form
                              className="test-edit"
                              onSubmit={(e) => {
                                e.preventDefault();
                                commitTestEdit();
                              }}
                            >
                              <input
                                value={testEditDraft.url}
                                aria-label="Test link (GitHub url with #L line)"
                                spellCheck={false}
                                autoFocus
                                onChange={(e) =>
                                  setTestEditDraft({ ...testEditDraft, url: e.target.value })
                                }
                                // ESC backs out of the row, not out of the
                                // whole editor pane (specs/ui/ui.feature.md).
                                onKeyDown={(e) => {
                                  if (e.key !== "Escape") return;
                                  e.stopPropagation();
                                  setTestEdit(null);
                                  cancelTestLookup();
                                }}
                              />
                              <input
                                className="test-name"
                                value={testEditDraft.name}
                                placeholder="test name"
                                aria-label="Test name"
                                spellCheck={false}
                                onChange={(e) =>
                                  setTestEditDraft({ ...testEditDraft, name: e.target.value })
                                }
                                onKeyDown={(e) => {
                                  if (e.key !== "Escape") return;
                                  e.stopPropagation();
                                  setTestEdit(null);
                                  cancelTestLookup();
                                }}
                              />
                              <button
                                type="submit"
                                className="link"
                                disabled={
                                  !canSetTestLink(editing.scenario.tests, i, testEditDraft)
                                }
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="link"
                                onClick={() => {
                                  setTestEdit(null);
                                  cancelTestLookup();
                                }}
                              >
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <>
                              <a
                                href={testLinkUrl(t)}
                                target="_blank"
                                rel="noreferrer"
                                title={testLinkUrl(t)}
                                data-test-link=""
                              >
                                {testLinkLabel(t)}
                              </a>
                              <button
                                type="button"
                                className="link"
                                title={`Edit ${testLinkUrl(t)}`}
                                aria-label={`Edit ${testLinkUrl(t)}`}
                                onClick={() => startTestEdit(i)}
                              >
                                <Pencil size={12} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="link"
                                title={`Remove ${testLinkUrl(t)}`}
                                aria-label={`Remove ${testLinkUrl(t)}`}
                                onClick={() => removeTest(i)}
                              >
                                <X size={12} aria-hidden="true" />
                              </button>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <form
                    className="test-add"
                    onSubmit={(e) => {
                      e.preventDefault();
                      addTest();
                    }}
                  >
                    <input
                      value={testDraft}
                      placeholder="https://github.com/owner/repo/blob/main/…/MyTest.java#L32"
                      aria-label="Test link (GitHub url with #L line)"
                      spellCheck={false}
                      onChange={(e) => setTestDraft(e.target.value)}
                    />
                    <input
                      className="test-name"
                      value={testNameDraft}
                      placeholder="test name"
                      aria-label="Test name"
                      spellCheck={false}
                      onChange={(e) => setTestNameDraft(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="link"
                      disabled={
                        !canSetTestLink(editing.scenario.tests, null, {
                          url: testDraft,
                          name: testNameDraft,
                        })
                      }
                    >
                      Add
                    </button>
                  </form>
                  {testNameHint && <p className="test-name-hint">{testNameHint}</p>}
                  {testsError && <p className="error">{testsError}</p>}
                </div>
              )}
              {/* specs/external-links/project-management-jira-linear-etc.
                  feature.md "Add link at spec level": the ticket tracking this
                  scenario. Editable on a published scenario too — like the test
                  links, it is bookkeeping around the spec, not the spec. */}
              {projectManagement && (
                <div className="link-field">
                  <span className="field-label">Ticket link</span>
                  <ExternalLinkField
                    draft={linkDraft}
                    onChange={changeLinkDraft}
                    error={linkError}
                    tool={projectManagementTool}
                  />
                </div>
              )}
              {/* specs/external-links/qtest-test-cases.feature.md: the qTest
                  test case covering this scenario. Editable on a published
                  scenario too, like the ticket link. */}
              {qtestLinks && (
                <div className="link-field">
                  <span className="field-label">qTest test case</span>
                  <QtestLinkField draft={qtestDraft} onChange={changeQtestDraft} error={qtestError} />
                </div>
              )}
              {/* specs/app/feature-flags.feature.md: the flags gating this
                  scenario, saved with it. Editable on a published scenario
                  too — like the ticket link, bookkeeping around the spec. */}
              {featureFlags && (
                <div className="feature-flags-field-wrap">
                  <span className="field-label">Feature flags</span>
                  <FeatureFlagsField
                    flags={editing.scenario.flags ?? []}
                    onChange={(flags) => {
                      const { flags: _previous, ...rest } = editing.scenario;
                      setEditing({ ...editing, scenario: flags.length > 0 ? { ...rest, flags } : rest });
                    }}
                  />
                </div>
              )}
              {/* specs/app/custom-attributes.feature.md: the scenario's custom
                  attributes, saved with it — editable on a published
                  scenario too, like the flags. Shown once the data repo
                  defines attributes for scenarios, or while it has some. */}
              {(definitionsFor(attributeDefs, "scenario").length > 0 ||
                (editing.scenario.attributes?.length ?? 0) > 0) && (
                <div className="attributes-field-wrap">
                  <span className="field-label">Attributes</span>
                  <AttributesField
                    attributes={editing.scenario.attributes ?? []}
                    where="scenario"
                    defs={attributeDefs}
                    known={knownAttributes}
                    onChange={(attributes) => {
                      const { attributes: _previous, ...rest } = editing.scenario;
                      setEditing({
                        ...editing,
                        scenario: attributes.length > 0 ? { ...rest, attributes } : rest,
                      });
                    }}
                  />
                </div>
              )}
              {/* specs/external-links/related-pull-requests.feature.md: the
                  pull requests implementing this scenario. Saved to the
                  document on every add and remove, never to the markdown —
                  so it needs the scenario to be in the document, which the
                  first autosave of a new one sees to. Editable on a
                  published scenario too. */}
              <div className="prs-field-wrap">
                <span className="field-label">Pull requests</span>
                <PullRequestField
                  prs={editing.scenario.prs ?? []}
                  disabled={editing.scenario.id === undefined}
                  disabledHint="Pull requests can be linked once the scenario has been saved."
                  onChange={(prs) => savePullRequests(scenarioTarget(editing.scenario), prs)}
                />
              </div>
              {/* specs/external-links/aha-and-figma-links.feature.md: the
                  Aha! records and Figma designs behind this scenario, each
                  tool only while Settings switches it on. Saved to the
                  document like the pull requests; editable on a published
                  scenario too. */}
              {RESOURCE_LINK_KINDS.filter((kind) => resourceLinksOn[kind]).map((kind) => (
                <div className="prs-field-wrap" key={kind}>
                  <span className="field-label">{RESOURCE_LINK_TOOLS[kind].name}</span>
                  <ResourceLinkField
                    kind={kind}
                    links={editing.scenario[kind] ?? []}
                    disabled={editing.scenario.id === undefined}
                    disabledHint={`${RESOURCE_LINK_TOOLS[kind].name} links can be added once the scenario has been saved.`}
                    onChange={(links) => saveResourceLinks(scenarioTarget(editing.scenario), kind, links)}
                  />
                </div>
              ))}
              {/* specs/editor/store-associated-files.feature.md: the files
                  the scenario needs at run time — test data to upload into
                  the system under test. Stored in the data repo and listed
                  on the document, like the pull requests; editable on a
                  published scenario too. */}
              <div className="prs-field-wrap">
                <span className="field-label">Files</span>
                <ScenarioFilesField
                  files={editing.scenario.files ?? []}
                  disabled={editing.scenario.id === undefined}
                  disabledHint="Files can be uploaded once the scenario has been saved."
                  onUpload={(chosen, replacing) =>
                    uploadScenarioFiles(
                      scenarioTarget(editing.scenario),
                      editing.scenario.files ?? [],
                      chosen,
                      replacing,
                    )
                  }
                  onChange={(files) => saveScenarioFileList(scenarioTarget(editing.scenario), files)}
                />
              </div>
            </div>
          </div>
        ) : selected && feature ? (
          <>
            <header className="editor-bar page-header">
              {/* specs/ui/ui.feature.md "Main page": the trail ends in the
                  feature name (the file's `# <name>` heading), never the file
                  name. Clicking the name edits it — committed and pushed on the
                  server; the file name never changes. */}
              <Breadcrumbs
                items={[repoCrumb, ...folderCrumbs(selected), ...pluginCrumbs(selected)]}
                tail={
                  readOnly ? (
                    <span className="crumb current">{feature.name || titleFromFileName(selected)}</span>
                  ) : renameDraft === null ? (
                    <Tooltip label="Rename feature">
                      <button
                        type="button"
                        className="crumb current"
                        onClick={() =>
                          setRenameDraft(feature.name || titleFromFileName(selected))
                        }
                      >
                        {feature.name || titleFromFileName(selected)}
                      </button>
                    </Tooltip>
                  ) : (
                    <form
                      className="rename-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void renameSelected();
                      }}
                    >
                      <input
                        className="rename-input"
                        value={renameDraft}
                        aria-label="Feature name"
                        autoFocus
                        spellCheck={false}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            renameDraftRef.current = null;
                            setRenameDraft(null);
                          }
                        }}
                        // Leaving the field saves, as in-place edits do; ESC
                        // or Cancel is the way out without saving.
                        onBlur={() => void renameSelected()}
                      />
                      {/* mousedown would blur the field first — save on
                          blur — so the buttons keep the focus where it is
                          and act on click alone. */}
                      <button
                        type="submit"
                        className="link"
                        disabled={renaming || !renameDraft.trim()}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        {renaming ? "Renaming…" : "Save"}
                      </button>
                      <button
                        type="button"
                        className="link"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          renameDraftRef.current = null;
                          setRenameDraft(null);
                        }}
                      >
                        Cancel
                      </button>
                    </form>
                  )
                }
              />
              <div className="editor-actions page-actions">
                <SaveIndicator
                  saving={saving}
                  savedAt={savedAt}
                  dirty={dirty || (!!descEdit && descEdit.text !== descSaved.current)}
                />
                {/* The read-only site has no ⋯ menu, so the feature's
                    "Copy link" is a button of its own. */}
                {readOnly && (
                  <CopyLinkButton
                    keys="mod+shift+c"
                    copied={copied === featurePath(selected)}
                    onCopy={() => void copyLink(featurePath(selected))}
                  />
                )}
                {/* New scenario (specs/ui/ui.feature.md "Add A Scenario
                    Button"): from the header, pinned above the list, so it is
                    always in view — at the end of the feature; a card's ⋯
                    adds one below that card. */}
                {!readOnly && (
                <>
                <Tooltip label="New scenario" keys="c">
                  <button
                    type="button"
                    className="ibtn"
                    aria-label="New scenario"
                    onClick={() => void newScenario()}
                  >
                    <Plus size={16} aria-hidden="true" />
                  </button>
                </Tooltip>
                {/* The description editor (specs/editor/feature-editor
                    .feature.md): switches the description pane below between
                    rendered and editable. */}
                <Tooltip
                  label={
                    descOpen
                      ? "Done editing the description"
                      : feature.description
                        ? "Edit description"
                        : "Add description"
                  }
                >
                  <button
                    type="button"
                    className={`ibtn${descOpen ? " active" : ""}`}
                    aria-label={descOpen ? "Done editing the description" : "Edit description"}
                    aria-pressed={descOpen}
                    onClick={() =>
                      descOpen
                        ? void closeDescriptionEditor()
                        : openDescriptionEditor(selected, feature.description)
                    }
                  >
                    <Pencil size={15} aria-hidden="true" />
                  </button>
                </Tooltip>
                <span className="page-more">
                  <Tooltip label="More actions">
                    <button
                      type="button"
                      className="ibtn"
                      aria-label="More actions"
                      aria-haspopup="menu"
                      aria-expanded={featureMenuOpen}
                      onClick={() => setFeatureMenuOpen((o) => !o)}
                    >
                      <Ellipsis size={15} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Menu
                    open={featureMenuOpen}
                    onClose={() => setFeatureMenuOpen(false)}
                    label="Feature actions"
                    className="page-menu"
                    containerSelector=".page-more"
                    items={[
                      {
                        id: "rename",
                        label: "Rename feature",
                        icon: <Pencil size={13} />,
                        onSelect: () =>
                          setRenameDraft(feature.name || titleFromFileName(selected)),
                      },
                      {
                        id: "rename-file",
                        label: `Rename file “${fileStem(selected)}”`,
                        icon: <FileText size={13} />,
                        onSelect: () => void renameFile(selected),
                      },
                      {
                        id: "move",
                        label: "Move to folder…",
                        icon: <FolderInput size={13} />,
                        onSelect: () => void moveFeaturePrompt(),
                      },
                      ...(codeGen
                        ? [
                            {
                              id: "session",
                              label: "Start AI Session",
                              icon: <StartSessionIcon size={13} />,
                              disabled: sessionRunning || specSelection.size === 0,
                              onSelect: () => void startSession(),
                            },
                          ]
                        : []),
                      {
                        id: "copy",
                        label: copied === featurePath(selected) ? "Copied" : "Copy link",
                        icon: <Link size={13} />,
                        keys: "mod+shift+c",
                        onSelect: () => void copyLink(featurePath(selected)),
                      },
                      // Publish All (crud-feature.md "publish each scenario
                      // individually"): marks every scenario published —
                      // here and on the publish rollup chip; individual
                      // scenarios publish from their cards.
                      {
                        id: "publish-all",
                        label: publishing === "all" ? "Publishing…" : "Publish all",
                        icon: <CloudUpload size={13} />,
                        keys: "mod+enter",
                        disabled: publishing !== null,
                        onSelect: () => void publish(),
                      },
                      // "Publish to Confluence…" only while Confluence is
                      // switched on in Settings (confluence-wiki.feature.md).
                      ...(confluenceEnabled
                        ? [
                            {
                              id: "confluence",
                              label: "Publish to Confluence…",
                              icon: <BookOpen size={13} />,
                              onSelect: () => setConfluencePublishOpen(true),
                            },
                          ]
                        : []),
                      ...(demo || hosted || !qtestLinks
                        ? []
                        : [
                            {
                              id: "qtest",
                              label: "Publish qTest Test Cases…",
                              icon: <ClipboardCheck size={13} />,
                              onSelect: () => void openQtestPublish(feature),
                            },
                            // Both at once ("Publish the page and the test
                            // cases from one dialog"): the page first, so the
                            // test cases link their scenarios on it. The page
                            // needs Confluence on, so this shows only then.
                            ...(confluenceEnabled
                              ? [
                                  {
                                    id: "wiki-qtest",
                                    label: "Publish to Wiki & qTest…",
                                    icon: <ClipboardCheck size={13} />,
                                    onSelect: () => setWikiQtestPublishOpen(true),
                                  },
                                ]
                              : []),
                          ]),
                      {
                        id: "delete",
                        label: "Delete feature",
                        icon: <Trash2 size={13} />,
                        danger: true,
                        onSelect: () => {
                          const listing = features.find((f) => f.fileName === selected);
                          if (listing) void removeFeature(listing);
                        },
                      },
                    ]}
                  />
                </span>
                </>
                )}
              </div>
            </header>
            {/* Properties as chips (specs/ui/ui.feature.md "Design system"):
                the publish rollup; the assignee (src/server/members.ts —
                the data repo's project-settings.json, saved on the spot,
                off unless Settings turns assignments on); the ticket
                (specs/external-links/project-management-jira-linear-etc
                .feature.md "Add link to feature"), edited in a popover. */}
            {readOnly ? (
              /* The read-only site: the same properties, as plain chips and
                 links — nothing to assign, link or publish. */
              <div className="props">
                <span className="chip static">
                  <StatusIcon status="published" size={14} />
                  {feature.scenarios.filter((s) => s.status === "published").length} /{" "}
                  {feature.scenarios.length} published
                </span>
                {authorshipLine(feature) && (
                  <span className="chip static feature-authors">
                    <UserRound size={14} aria-hidden="true" />
                    {authorshipLine(feature)}
                  </span>
                )}
                {(feature.links ?? []).map((l) => (
                  <a key={l.url} className="chip" href={l.url} target="_blank" rel="noreferrer" title={l.url}>
                    <Ticket size={14} aria-hidden="true" />
                    {externalLinkLabel(l)}
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                ))}
                {(feature.prs ?? []).map((pr) => (
                  <a key={pr.url} className="chip" href={pr.url} target="_blank" rel="noreferrer" title={pr.url}>
                    <GitPullRequest size={14} aria-hidden="true" />
                    {pr.title || pr.url.replace(/^https:\/\/github\.com\//, "")}
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                ))}
                {feature.confluence && (
                  <a className="chip" href={feature.confluence.url} target="_blank" rel="noreferrer">
                    <BookOpen size={14} aria-hidden="true" />
                    Confluence
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                )}
              </div>
            ) : (
            <div className="props">
              {/* The publish rollup, and the way to Publish All (crud-feature
                  .md "publish each scenario individually"): its menu marks
                  every scenario published; the dot means there is something
                  unpublished. Sync lives in the sidebar header, beside the
                  data folder. */}
              <span className="chip-anchor publish-anchor">
                <button
                  type="button"
                  className="chip"
                  aria-haspopup="menu"
                  aria-expanded={publishMenuOpen}
                  aria-label={`${feature.scenarios.filter((s) => s.status === "published").length} of ${feature.scenarios.length} published${publishing === null && (dirty || hasProposed) ? ", unpublished changes" : ""}`}
                  onClick={() => setPublishMenuOpen((o) => !o)}
                >
                  <StatusIcon status="published" size={14} />
                  {feature.scenarios.filter((s) => s.status === "published").length} /{" "}
                  {feature.scenarios.length} published
                  {publishing === null && (dirty || hasProposed) && (
                    <span className="dot" role="img" aria-label="unpublished changes" />
                  )}
                  <ChevronDown size={12} aria-hidden="true" />
                </button>
                <Menu
                  open={publishMenuOpen}
                  onClose={() => setPublishMenuOpen(false)}
                  label="Publish"
                  className="chip-menu"
                  containerSelector=".publish-anchor"
                  items={[
                    {
                      id: "all",
                      label: publishing === "all" ? "Publishing…" : "Publish all",
                      icon: <CloudUpload size={13} />,
                      keys: "mod+enter",
                      disabled: publishing !== null,
                      onSelect: () => void publish(),
                    },
                  ]}
                />
              </span>
              {/* Who created the feature and last changed it
                  (specs/app/specs-authorship.feature.md). */}
              {authorshipLine(feature) && (
                <span className="chip static feature-authors">
                  <UserRound size={14} aria-hidden="true" />
                  {authorshipLine(feature)}
                </span>
              )}
              {assignments && (
                <span className="chip-anchor assignee-anchor">
                  <button
                    type="button"
                    className={`chip${feature.assigned ? "" : " muted"}`}
                    aria-haspopup="menu"
                    aria-expanded={assigneeMenuOpen}
                    aria-label={`Assigned: ${feature.assigned ?? "nobody"}`}
                    disabled={assignedSaving}
                    onClick={() => setAssigneeMenuOpen((o) => !o)}
                  >
                    {feature.assigned ? (
                      <span className="avatar chip-avatar" aria-hidden="true">
                        {initialsOf(feature.assigned)}
                      </span>
                    ) : (
                      <UserRound size={14} aria-hidden="true" />
                    )}
                    {feature.assigned ?? "Unassigned"}
                  </button>
                  <Menu
                    open={assigneeMenuOpen}
                    onClose={() => setAssigneeMenuOpen(false)}
                    label="Assigned member"
                    className="chip-menu"
                    containerSelector=".assignee-anchor"
                    items={[
                      {
                        id: "",
                        label: "Unassigned",
                        checked: !feature.assigned,
                        onSelect: () => void saveAssigned(""),
                      },
                      ...assignableMembers().map((m) => ({
                        id: m.name,
                        label: m.name,
                        checked: feature.assigned === m.name,
                        icon: (
                          <span className="avatar chip-avatar" aria-hidden="true">
                            {initialsOf(m.name)}
                          </span>
                        ),
                        onSelect: () => void saveAssigned(m.name),
                      })),
                    ]}
                  />
                </span>
              )}
              {projectManagement && (
                <span className="chip-anchor ticket-anchor">
                  {/* "Several tickets on a feature": the chip reads the one
                      ticket, or counts them; the popover lists them and
                      takes another, up to five. */}
                  <button
                    type="button"
                    className={`chip${feature.links?.length ? "" : " muted"}`}
                    aria-haspopup="dialog"
                    aria-expanded={featureLinkOpen}
                    onClick={() => {
                      setFeatureTicketsError(null);
                      setFeatureTicketsOpen((open) => !open);
                    }}
                  >
                    <Ticket size={14} aria-hidden="true" />
                    {ticketChipLabel(feature.links)}
                  </button>
                  {feature.links?.length === 1 && (
                    <a
                      className="chip-ext"
                      href={feature.links[0]!.url}
                      target="_blank"
                      rel="noreferrer"
                      title={feature.links[0]!.url}
                      aria-label={`Open ${externalLinkLabel(feature.links[0]!)}`}
                    >
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                  <Popover
                    open={featureLinkOpen}
                    onClose={() => setFeatureTicketsOpen(false)}
                    label="Tickets for this feature"
                    className="chip-popover ticket-popover"
                    containerSelector=".ticket-anchor"
                  >
                    <p className="hint">The {projectManagementTool} tickets that track this feature.</p>
                    <TicketLinkField
                      links={feature.links ?? []}
                      tool={projectManagementTool}
                      error={featureTicketsError}
                      saving={featureTicketsSaving}
                      autoFocus
                      onChange={(links) => saveFeatureTickets(links)}
                    />
                    <div className="dialog-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setFeatureTicketsOpen(false)}
                      >
                        Close
                      </button>
                    </div>
                  </Popover>
                </span>
              )}
              {/* specs/external-links/qtest-test-cases.feature.md: the qTest
                  test case covering the feature as a whole. */}
              {qtestLinks && (
                <span className="chip-anchor qtest-anchor">
                  <button
                    type="button"
                    className={`chip${feature.qtest ? "" : " muted"}`}
                    aria-haspopup="dialog"
                    aria-expanded={featureQtestOpen}
                    onClick={() => {
                      if (featureQtestOpen) {
                        setFeatureQtestDraft(null);
                      } else {
                        setFeatureQtestError(null);
                        setFeatureQtestDraft(linkDraftOf(feature.qtest));
                      }
                    }}
                  >
                    <ClipboardCheck size={14} aria-hidden="true" />
                    {feature.qtest ? externalLinkLabel(feature.qtest) : "Link qTest"}
                  </button>
                  {feature.qtest && (
                    <a
                      className="chip-ext"
                      href={feature.qtest.url}
                      target="_blank"
                      rel="noreferrer"
                      title={feature.qtest.url}
                      aria-label={`Open ${externalLinkLabel(feature.qtest)}`}
                    >
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                  <Popover
                    open={featureQtestOpen}
                    onClose={() => setFeatureQtestDraft(null)}
                    label="qTest test case for this feature"
                    className="chip-popover"
                    containerSelector=".qtest-anchor"
                  >
                    {featureQtestDraft !== null && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveFeatureQtest();
                        }}
                      >
                        <p className="hint">
                          The qTest test case that covers this feature. Clear the fields to
                          remove the link.
                        </p>
                        <div className="link-field">
                          <QtestLinkField
                            draft={featureQtestDraft}
                            onChange={(draft) => {
                              setFeatureQtestError(null);
                              setFeatureQtestDraft(draft);
                            }}
                            error={featureQtestError}
                            autoFocus
                          />
                        </div>
                        <div className="dialog-actions">
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => setFeatureQtestDraft(null)}
                          >
                            Cancel
                          </button>
                          <button type="submit" className="btn btn-primary" disabled={featureQtestSaving}>
                            {featureQtestSaving
                              ? "Saving…"
                              : feature.qtest && isBlankLinkDraft(featureQtestDraft)
                                ? "Remove link"
                                : "Save"}
                          </button>
                        </div>
                      </form>
                    )}
                  </Popover>
                </span>
              )}
              {/* specs/external-links/confluence-wiki.feature.md: the page the
                  feature was published to. Read-only — publishing sets it. */}
              {feature.confluence && (
                <span className="chip-anchor confluence-anchor">
                  <a
                    className="chip"
                    href={feature.confluence.url}
                    target="_blank"
                    rel="noreferrer"
                    title={feature.confluence.url}
                    aria-label="Open the Confluence page"
                  >
                    <BookOpen size={14} aria-hidden="true" />
                    Confluence
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                </span>
              )}
              {/* specs/external-links/related-pull-requests.feature.md "Link
                  a pull request to a feature": the chip counts the feature's
                  pull requests; the popover lists them and takes another. */}
              <span className="chip-anchor pr-anchor">
                <button
                  type="button"
                  className={`chip${feature.prs?.length ? "" : " muted"}`}
                  aria-haspopup="dialog"
                  aria-expanded={featurePrsOpen}
                  onClick={() => setFeaturePrsOpen((open) => !open)}
                >
                  <GitPullRequest size={14} aria-hidden="true" />
                  {feature.prs?.length
                    ? `${feature.prs.length} PR${feature.prs.length === 1 ? "" : "s"}`
                    : "Link PR"}
                </button>
                <Popover
                  open={featurePrsOpen}
                  onClose={() => setFeaturePrsOpen(false)}
                  label="Pull requests for this feature"
                  className="chip-popover pr-popover"
                  containerSelector=".pr-anchor"
                >
                  <p className="hint">The pull requests implementing this feature.</p>
                  <PullRequestField
                    prs={feature.prs ?? []}
                    autoFocus
                    onChange={(prs) => savePullRequests(null, prs)}
                  />
                  <div className="dialog-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setFeaturePrsOpen(false)}>
                      Close
                    </button>
                  </div>
                </Popover>
              </span>
              {/* specs/app/feature-flags.feature.md: the flags gating the
                  feature as a whole, a chip each, and a chip whose popover
                  adds, toggles and removes them — saved on the spot. Only
                  while Settings turns feature flags on. The edit chip comes
                  first, so adding a flag never moves the popover's anchor. */}
              {featureFlags && (
                <span className="chip-anchor feature-flags-anchor">
                  <button
                    type="button"
                    className={`chip${feature.flags?.length ? "" : " muted"}`}
                    aria-haspopup="dialog"
                    aria-expanded={featureFlagsOpen}
                    onClick={() => setFeatureFlagsOpen((open) => !open)}
                  >
                    <Flag size={14} aria-hidden="true" />
                    {feature.flags?.length ? "Edit flags" : "Add flag"}
                  </button>
                  <Popover
                    open={featureFlagsOpen}
                    onClose={() => setFeatureFlagsOpen(false)}
                    label="Feature flags for this feature"
                    className="chip-popover feature-flags-popover"
                    containerSelector=".feature-flags-anchor"
                  >
                    <p className="hint">
                      The feature flags gating this feature, written <code>[ff:name:on|off]</code> under its
                      heading.
                    </p>
                    <FeatureFlagsField
                      flags={feature.flags ?? []}
                      autoFocus
                      onChange={(flags) => saveFeatureFlags(flags)}
                    />
                    <div className="dialog-actions">
                      <button type="button" className="btn btn-secondary" onClick={() => setFeatureFlagsOpen(false)}>
                        Close
                      </button>
                    </div>
                  </Popover>
                </span>
              )}
              {featureFlags && <FeatureFlagChips flags={feature.flags} />}
              {/* specs/app/custom-attributes.feature.md: the feature's own
                  attributes, a chip each, whenever it carries any, and —
                  once the data repo defines attributes for features — a
                  chip whose popover adds, changes and removes them, saved
                  on the spot. */}
              {definitionsFor(attributeDefs, "feature").length > 0 && (
                <span className="chip-anchor feature-attributes-anchor">
                  <button
                    type="button"
                    className={`chip${feature.attributes?.length ? "" : " muted"}`}
                    aria-haspopup="dialog"
                    aria-expanded={featureAttributesOpen}
                    onClick={() => setFeatureAttributesOpen((open) => !open)}
                  >
                    <Tag size={14} aria-hidden="true" />
                    {feature.attributes?.length ? "Edit attributes" : "Add attribute"}
                  </button>
                  <Popover
                    open={featureAttributesOpen}
                    onClose={() => setFeatureAttributesOpen(false)}
                    label="Attributes of this feature"
                    className="chip-popover feature-flags-popover attributes-popover"
                    containerSelector=".feature-attributes-anchor"
                  >
                    <p className="hint">
                      The custom attributes of this feature, as Settings → Custom attributes defines them.
                    </p>
                    <AttributesField
                      attributes={feature.attributes ?? []}
                      where="feature"
                      defs={attributeDefs}
                      known={knownAttributes}
                      autoFocus
                      onChange={(attributes) => saveFeatureAttributes(attributes)}
                    />
                    <div className="dialog-actions">
                      <button type="button" className="btn btn-secondary" onClick={() => setFeatureAttributesOpen(false)}>
                        Close
                      </button>
                    </div>
                  </Popover>
                </span>
              )}
              <AttributeChips
                attributes={feature.attributes}
                where="feature"
                defs={attributeDefs}
                known={knownAttributes}
              />
              {/* specs/external-links/aha-and-figma-links.feature.md "Link
                  Aha! and Figma to a feature": a chip per tool switched on
                  in Settings, counting the feature's links; the popover
                  lists them and takes another. */}
              {RESOURCE_LINK_KINDS.filter((kind) => resourceLinksOn[kind]).map((kind) => {
                const { name, noun } = RESOURCE_LINK_TOOLS[kind];
                const Icon = RESOURCE_LINK_ICON[kind];
                const links = feature[kind] ?? [];
                return (
                  <span className={`chip-anchor resource-anchor-${kind}`} key={kind}>
                    <button
                      type="button"
                      className={`chip${links.length ? "" : " muted"}`}
                      aria-haspopup="dialog"
                      aria-expanded={featureResourceOpen === kind}
                      onClick={() => setFeatureResourceOpen((open) => (open === kind ? null : kind))}
                    >
                      <Icon size={14} aria-hidden="true" />
                      {resourceChipLabel(kind, links.length)}
                    </button>
                    <Popover
                      open={featureResourceOpen === kind}
                      onClose={() => setFeatureResourceOpen(null)}
                      label={`${name} links for this feature`}
                      className="chip-popover pr-popover"
                      containerSelector={`.resource-anchor-${kind}`}
                    >
                      <p className="hint">
                        The {name} {noun}s behind this feature.
                      </p>
                      <ResourceLinkField
                        kind={kind}
                        links={links}
                        autoFocus
                        onChange={(next) => saveResourceLinks(null, kind, next)}
                      />
                      <div className="dialog-actions">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => setFeatureResourceOpen(null)}
                        >
                          Close
                        </button>
                      </div>
                    </Popover>
                  </span>
                );
              })}
            </div>
            )}
            {descOpen && descEdit ? (
              /* specs/editor/feature-editor.feature.md "Edit feature
                 descrition": the description pane becomes the editor, sized
                 like the rendered pane so the scenario list stays in view. */
              <div
                className={`feature-desc-editor${resizingDesc ? " resizing" : ""}`}
                ref={descPaneRef}
                style={
                  descHeight === null ? undefined : ({ "--desc-h": `${descHeight}px` } as CSSProperties)
                }
              >
                <MarkdownEditor
                  value={descEdit.text}
                  onChange={(text) => setDescEdit({ file: descEdit.file, text })}
                  placeholder="Describe this feature — any markdown. Saved automatically."
                  // Opens rendered — a description is read far more often
                  // than rewritten. A blank one has nothing to render, so a
                  // new feature's editor opens ready to type into instead.
                  initialTab={descSaved.current ? "preview" : "write"}
                />
                <span className={syncProblem !== null ? "readme-hint sync-failing" : "readme-hint"}>
                  Saved automatically every {autosaveSeconds} seconds; {pushHint(syncProblem)}{" "}
                  Done shows it rendered.
                </span>
                {/* The editor's lower boundary is a grab strip: drag it to give
                    the description more or less room, double-click to restore
                    the default third of the window. Sized like the sidebar
                    divider, and nudged by the arrow keys when focused. */}
                <HeightResizer
                  label="Resize the description editor"
                  min={DESC_MIN}
                  height={descHeight}
                  target={descPaneRef}
                  clamp={clampDescHeight}
                  onHeight={setDescHeight}
                  onCommit={(h) => storeEditorHeight(DESC_HEIGHT_KEY, h)}
                  onReset={() => {
                    setDescHeight(null);
                    storeEditorHeight(DESC_HEIGHT_KEY, null);
                  }}
                  onResizing={setResizingDesc}
                />
              </div>
            ) : (
              feature.description && (
                /* Clicking the rendered description opens the editor too —
                   links inside it still open as links. */
                <div
                  className={`feature-desc md-preview${readOnly ? "" : " editable"}`}
                  title={readOnly ? undefined : "Click to edit the description"}
                  onClick={(e) => {
                    if (readOnly || (e.target as HTMLElement).closest("a")) return;
                    openDescriptionEditor(selected, feature.description);
                  }}
                >
                  {renderMarkdown(feature.description)}
                </div>
              )
            )}
            {/* specs/ui/ui.feature.md "Scenario List": each card renders its
                body as a Markdown preview, clamped to n lines (n set in
                Settings). */}
            <div
              className="scenarios"
              style={{ "--preview-lines": previewLines } as CSSProperties}
            >
              {feature.scenarios.map((s, i) => {
                if (!scenarioMatches(s, feature, filter)) return null;
                // A card is a drag source (specs/ui/navigation.feature.md
                // "drag a scenario to another feature"): onto another
                // feature in the sidebar it moves there; onto another card
                // here it lands before or after it, as a drag in the
                // sidebar outline does — or, dragged out of another
                // feature's outline, moves in at that spot.
                const isCard = (x: { file?: string; name: string; version: number } | null) =>
                  x !== null && x.file === selected && x.name === s.name && x.version === s.version;
                const droppable =
                  scenarioDrag !== null &&
                  !isCard(scenarioDrag) &&
                  (scenarioDrag.file === selected || scenarioMovesInto(scenarioDrag, selected, deletePublished));
                const dropEdge =
                  droppable && isCard(scenarioDropAt)
                    ? scenarioDropAt!.after
                      ? " drop-after"
                      : " drop-before"
                    : "";
                return (
                <article
                  key={i}
                  ref={(el) => {
                    scenarioRefs.current[i] = el;
                  }}
                  className={`scenario-card ${s.status}${i === selectedScenario ? " selected" : ""}${dropEdge}${
                    isCard(scenarioDrag) ? " dragging" : ""
                  }`}
                  draggable={!readOnly}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", scenarioPath(selected, s));
                    e.dataTransfer.effectAllowed = "move";
                    setScenarioDrag({ file: selected, name: s.name, version: s.version, status: s.status });
                  }}
                  onDragEnd={endScenarioDrag}
                  onDragOver={(e) => {
                    if (!droppable) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const box = e.currentTarget.getBoundingClientRect();
                    const after = e.clientY > box.top + box.height / 2;
                    if (!isCard(scenarioDropAt) || scenarioDropAt!.after !== after) {
                      setScenarioDropAt({ file: selected, name: s.name, version: s.version, after });
                    }
                  }}
                  onDrop={(e) => {
                    if (!droppable) return;
                    e.preventDefault();
                    const box = e.currentTarget.getBoundingClientRect();
                    const dragged = scenarioDrag!;
                    const at = { name: s.name, version: s.version, after: e.clientY > box.top + box.height / 2 };
                    endScenarioDrag();
                    if (dragged.file === selected) void dropTreeScenario(selected, dragged, at, at.after);
                    else void moveScenarioToFeature(dragged.file, dragged, selected, at);
                  }}
                  // A click anywhere on the card highlights it (the title link
                  // does so itself); a double-click opens it in the editor
                  // pane, like Enter. The card's controls keep their own
                  // clicks.
                  onClick={(e) => {
                    if (isCardControl(e.target)) return;
                    setSelectedScenario(i);
                  }}
                  onDoubleClick={(e) => {
                    if (isCardControl(e.target)) return;
                    setEditing({ index: i, scenario: { ...s } });
                  }}
                  // A right-click opens the card's ⋯ menu, on the card it
                  // also highlights.
                  onContextMenu={(e) => {
                    if (readOnly || isCardControl(e.target)) return;
                    e.preventDefault();
                    setSelectedScenario(i);
                    setCardMenu(i);
                  }}
                >
                  <header>
                    <span className="scenario-title">
                      {/* Code gen selection (specs/agents/claude.feature.md): a
                          session takes whole specs, checked in the sidebar,
                          or single scenarios, checked here. Gone when the
                          Settings switch is off. */}
                      {codeGen && (
                        <input
                          type="checkbox"
                          className="scenario-check"
                          checked={scenarioSelected(selected, s)}
                          onChange={() =>
                            toggleScenarioSelected(selected, feature.scenarios, scenarioKey(s))
                          }
                          aria-label={`Select scenario ${s.name} for an AI session`}
                          title="Include this scenario in an AI session"
                        />
                      )}
                      {/* The title is the scenario's permalink
                          (specs/ui/navigation.feature.md "share a link"). */}
                      {/* Status as a glyph, not a word (specs/ui/ui.feature.md
                          "Design system"): draft, proposed or published. */}
                      {/* Its number — its place in the file (specs/ui/
                          ui.feature.md "number scenarios"); a draft has none. */}
                      {scenarioNumbers(feature.scenarios)[i] !== null && (
                        <span className="scenario-number">
                          S{scenarioNumbers(feature.scenarios)[i]}
                        </span>
                      )}
                      <StatusIcon status={s.status} />
                      <a
                        href={scenarioPath(selected, s)}
                        onClick={(e) => spaClick(e, () => setSelectedScenario(i))}
                      >
                        {s.name}
                      </a>{" "}
                      <span className="version">v{s.version}</span>
                      {/* The scenario's ticket (specs/external-links/project-
                          management-jira-linear-etc.feature.md "Add link at
                          spec level"), opening in a new tab. */}
                      {projectManagement && s.link && (
                        <a
                          className="ext-link"
                          href={s.link.url}
                          target="_blank"
                          rel="noreferrer"
                          title={s.link.url}
                        >
                          {externalLinkLabel(s.link)}
                        </a>
                      )}
                      {/* Its qTest test case (specs/external-links/qtest-test-
                          cases.feature.md), opening in a new tab. */}
                      {qtestLinks && s.qtest && (
                        <a
                          className="ext-link"
                          href={s.qtest.url}
                          target="_blank"
                          rel="noreferrer"
                          title={s.qtest.url}
                        >
                          {externalLinkLabel(s.qtest)}
                        </a>
                      )}
                      {/* The flags gating it (specs/app/feature-flags.feature.md). */}
                      {featureFlags && <FeatureFlagChips flags={s.flags} />}
                      {/* Its polarity (specs/ui/scenario-polarity.feature.md),
                          a dot on the card: a click flips it; still while
                          the editor is open, as Move is, so the pane's copy
                          cannot go stale. */}
                      {scenarioPolarity && (
                        <PolarityPill
                          compact
                          negative={!!s.negative}
                          disabled={editing !== null || readOnly}
                          onToggle={() => void toggleScenarioPolarityAt(i)}
                        />
                      )}
                    </span>
                    {readOnly ? (
                      /* The read-only site's card offers only its link
                         (specs/app/public-specs-site.feature.md "copies a
                         deep link"), on hover, focus or selection like the
                         editing card's actions. */
                      <span className="card-actions">
                        <CopyLinkButton
                          size={14}
                          label={`Copy link to ${s.name}`}
                          copied={copied === scenarioLink(selected, s)}
                          onCopy={() => void copyLink(scenarioLink(selected, s))}
                        />
                      </span>
                    ) : (
                    <span className="card-actions">
                      {/* Edit up front, the rest behind ⋯ — Publish or New
                          version, Copy link (crud-feature.md
                          "publish each scenario individually"). Shown while
                          the card is hovered, focused or selected; a
                          right-click opens the same menu. A published card's
                          Edit opens the same pane: its test links
                          (specs/traceability.feature.md) and its ticket link
                          stay editable. */}
                      <Tooltip label="Edit" keys="e">
                        <button
                          type="button"
                          className="ibtn"
                          aria-label={`Edit ${s.name}`}
                          onClick={() => setEditing({ index: i, scenario: { ...s } })}
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                      </Tooltip>
                      <Tooltip label="More actions">
                        <button
                          type="button"
                          className="ibtn"
                          aria-label={`Menu for ${s.name}`}
                          aria-haspopup="menu"
                          aria-expanded={cardMenu === i}
                          onClick={() => setCardMenu((m) => (m === i ? null : i))}
                        >
                          <Ellipsis size={14} aria-hidden="true" />
                        </button>
                      </Tooltip>
                      <Menu
                        open={cardMenu === i}
                        onClose={() => setCardMenu(null)}
                        label={`Menu for ${s.name}`}
                        className="card-menu"
                        containerSelector=".card-actions"
                        items={[
                          {
                            id: "edit",
                            label: "Edit",
                            icon: <Pencil size={13} />,
                            keys: "e",
                            onSelect: () => setEditing({ index: i, scenario: { ...s } }),
                          },
                          // A new scenario right after this one (specs/ui/
                          // ui.feature.md "Add A Scenario Button").
                          {
                            id: "new-below",
                            label: "New scenario below",
                            icon: <Plus size={13} />,
                            disabled: editing !== null,
                            onSelect: () => void newScenario(i + 1),
                          },
                          s.status !== "published"
                            ? {
                                id: "publish",
                                label: publishing === scenarioKey(s) ? "Publishing…" : "Publish",
                                icon: <StatusIcon status="published" size={13} />,
                                disabled: publishing !== null,
                                onSelect: () => void publish(scenarioTarget(s)),
                              }
                            : {
                                id: "new-version",
                                label: "New version",
                                icon: <History size={13} />,
                                onSelect: () => newVersion(i),
                              },
                          {
                            id: "clone",
                            label: "Clone",
                            icon: <CopyPlus size={13} />,
                            onSelect: () => void cloneTreeScenario(selected, s),
                          },
                          {
                            id: "copy",
                            label: copied === scenarioPath(selected, s) ? "Copied" : "Copy link",
                            icon: <Link size={13} />,
                            onSelect: () => void copyLink(scenarioPath(selected, s)),
                          },
                          // Move up / Move down (specs/ui/ui.feature.md
                          // "number scenarios"): the order is the user's,
                          // saved like any other change to the feature.
                          {
                            id: "move-up",
                            label: "Move up",
                            icon: <ArrowUp size={13} />,
                            keys: "alt+arrowup",
                            disabled: i === 0 || editing !== null,
                            onSelect: () => void reorderScenario(i, -1),
                          },
                          {
                            id: "move-down",
                            label: "Move down",
                            icon: <ArrowDown size={13} />,
                            keys: "alt+arrowdown",
                            disabled: i === feature.scenarios.length - 1 || editing !== null,
                            onSelect: () => void reorderScenario(i, 1),
                          },
                        ]}
                      />
                    </span>
                    )}
                  </header>
                  {/* Its custom attributes (specs/app/custom-attributes.feature.md),
                      a row of chips under the title whenever it carries any. */}
                  {s.attributes && s.attributes.length > 0 && (
                    <div className="scenario-attributes">
                      <AttributeChips
                        attributes={s.attributes}
                        where="scenario"
                        defs={attributeDefs}
                        known={knownAttributes}
                      />
                    </div>
                  )}
                  {s.body && (
                    <div className="md-preview scenario-body">{renderMarkdown(s.body)}</div>
                  )}
                  {/* specs/traceability.feature.md: links to the automated
                      tests, as a table at the end of the scenario. Optional —
                      the Settings toggle hides it (default ON). */}
                  {showTestLinks && testsTable(s.tests)}
                  {/* specs/external-links/related-pull-requests.feature.md
                      "The scenario card lists its pull requests". */}
                  {s.prs && s.prs.length > 0 && (
                    <div className="scenario-prs">
                      <span className="scenario-prs-head">Pull requests</span>
                      <PullRequestList prs={s.prs} />
                    </div>
                  )}
                  {/* specs/external-links/aha-and-figma-links.feature.md "The
                      scenario card lists its Aha! and Figma links". */}
                  {RESOURCE_LINK_KINDS.filter((kind) => resourceLinksOn[kind] && s[kind]?.length).map(
                    (kind) => (
                      <div className={`scenario-prs scenario-${kind}`} key={kind}>
                        <span className="scenario-prs-head">{RESOURCE_LINK_TOOLS[kind].name}</span>
                        <ResourceLinkList kind={kind} links={s[kind]!} />
                      </div>
                    ),
                  )}
                  {/* specs/editor/store-associated-files.feature.md: the
                      scenario's files, each a download. */}
                  {s.files && s.files.length > 0 && (
                    <div className="scenario-prs scenario-files">
                      <span className="scenario-prs-head">Files</span>
                      <ScenarioFileList files={s.files} />
                    </div>
                  )}
                  {/* specs/app/specs-authorship.feature.md: who created the
                      scenario and who last changed it. */}
                  {authorshipLine(s) && <p className="scenario-authors">{authorshipLine(s)}</p>}
                </article>
                );
              })}
              {feature.scenarios.length > 0 &&
                !feature.scenarios.some((s) => scenarioMatches(s, feature, filter)) && (
                  <p className="empty">
                    {filter.attribute
                      ? `No ${filter.status ? `${filter.status} ` : ""}scenarios here carry ${attributeFilterLabel(filter.attribute, attributeDefs)}`
                      : `No ${filter.status} scenarios here`}{" "}
                    — the sidebar filter hides the rest.
                  </p>
                )}
              {feature.scenarios.length === 0 && (
                <p className="empty">
                  {readOnly ? "No scenarios yet." : "No scenarios yet. Press c, or the + above, to add one."}
                </p>
              )}
            </div>
          </>
        ) : selected && !feature && featureLoading ? (
          /* A feature opened by deep link, still on its way. */
          <PageSkeleton cards={3} />
        ) : pluginView && activeTab ? (
          /* A plugin's view (specs/app/plugins.feature.md) — a roadmap page,
             a task, or the test management module's plans, cases and runs,
             say — takes the whole pane; App only knows which tab and view
             are open. */
          <activeTab.Pane view={pluginView.view} app={tabApp} navigate={navigateIn(activeTab.id)} />
        ) : (
          <>
            {/* Home (app-startup.md "App Starts with existing
                specs folder selected"): the data repo's README.md, open for
                editing and autosaved at the scenario editor's interval. */}
            <header className="editor-bar page-header">
              <Breadcrumbs
                items={[repoCrumb]}
                tail={<span className="crumb current plain">README.md</span>}
              />
              {!readOnly && (
              <div className="editor-actions page-actions">
                <SaveIndicator
                  saving={saving}
                  savedAt={savedAt}
                  dirty={readme !== null && readme !== readmeSaved.current}
                />
                <span className={syncProblem !== null ? "readme-hint sync-failing" : "readme-hint"}>
                  {readme === null
                    ? "Loading…"
                    : `Autosaves every ${autosaveSeconds}s; ${pushHint(syncProblem)}`}
                </span>
              </div>
              )}
            </header>
            {/* The read-only site shows the README rendered, as a page. */}
            {readme !== null && readOnly && <div className="md-preview read-only-page">{renderMarkdown(readme)}</div>}
            {readme !== null && !readOnly && (
              <MarkdownEditor
                value={readme}
                onChange={setReadme}
                placeholder="This data folder has no README.md yet — write one here and it is created on the next autosave."
              />
            )}
            {/* A stale deep link lands here with a note
                (specs/ui/navigation.feature.md). */}
          </>
        )}
        </ErrorBoundary>
      </section>
      )}
      {/* Coding agent pane (specs/agents/agent-pane.feature.md): a third
          column right of the editor, resized from its left edge the way the
          sidebar is from its right; on one-pane screens it covers the page. */}
      {paneShown && !compact && (
        <div
          className="agent-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the coding agent pane"
          aria-valuemin={AGENT_MIN_WIDTH}
          aria-valuenow={pane.width}
          tabIndex={0}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            setResizingAgent(true);
          }}
          onPointerMove={(e) => {
            if (resizingAgent) {
              agentChat.setWidth(clampAgentWidth(window.innerWidth - e.clientX, window.innerWidth), false);
            }
          }}
          onPointerUp={(e) => {
            if (!resizingAgent) return;
            setResizingAgent(false);
            agentChat.setWidth(clampAgentWidth(window.innerWidth - e.clientX, window.innerWidth));
          }}
          onLostPointerCapture={() => setResizingAgent(false)}
          onDoubleClick={() => agentChat.setWidth(AGENT_DEFAULT_WIDTH)}
          onKeyDown={(e) => {
            // Left widens: the pane grows toward the editor.
            const delta = e.key === "ArrowLeft" ? 16 : e.key === "ArrowRight" ? -16 : 0;
            if (delta === 0) return;
            e.preventDefault();
            agentChat.setWidth(clampAgentWidth(pane.width + delta, window.innerWidth));
          }}
        />
      )}
      {paneShown && (
        <AgentPane
          // A code repository open directly (specs/app/code-repo-mode.feature
          // .md "The coding agent works in the code repository") is the
          // folder, with no specifications folder behind it.
          codeRepos={codeRepoDir !== null ? [] : codeRepos}
          compact={compact}
          demo={demo}
          codeRepo={codeRepoDir !== null ? null : codeRepo}
          // An agent works in a folder: a GitHub url's own clone, so the
          // folder menu offers it once, not as the url and again as its path.
          // The server's absolute path for the open folder: settings may
          // name it relative to the app, and an agent's folder must be absolute.
          dataRepo={codeRepoDir ?? dataDir ?? (dataRepo && (recentRepoDirs[dataRepo] ?? dataRepo))}
          homeDir={homeDir}
          prompt={prompt}
          confirm={confirm}
          ghostty={ghosttyOn && !demo && !hosted}
          codeRepoOpen={codeRepoDir !== null}
          // What the main pane shows goes with a message by default: the
          // open feature, or the Files tab's file (both relative to the
          // open folder). A plugin's other views and the app's pages name none.
          current={
            pluginView
              ? pluginView.tab === FILES_TAB
                ? (pluginView.view as FilesView).path
                : null
              : appPage
                ? null
                : selected
          }
          browseFolder={canChooseFolder ? () => chooseFolderNative(codeRepoDir !== null ? "code-repo" : "data-repo") : undefined}
          onClose={() => agentChat.closePane()}
          onOpenPlugins={(wanted) => {
            setPluginsWanted(wanted ?? null);
            openPlugins();
          }}
          agentSettings={(id) =>
            pluginSettingsSections.some((s) => s.id === id) ? () => openSettingsAt(`settings-${id}`) : undefined
          }
        />
      )}
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
            void (async () => {
              await loadFeatures();
              await openFeature(data.fileName, { push: true });
            })();
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
            void (async () => {
              await loadFeatures();
              await openFeature(data.created[0]!.fileName, { push: true });
            })();
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
            void (async () => {
              await loadFeatures();
              await openFeature(data.fileName, { push: true });
            })();
            toast.success(`Imported “${data.title}” with ${data.scenarios} scenario${data.scenarios === 1 ? "" : "s"}`);
          }}
        />
      )}
      {tokenSignInOpen && (
        <TokenSignInDialog
          auth={auth}
          trapRef={tokenSignInTrapRef}
          onSignedIn={(signedIn) => {
            signedInWithToken(signedIn);
            setTokenSignInOpen(false);
          }}
          onClose={() => setTokenSignInOpen(false)}
        />
      )}
      {userInfoOpen && (
        <div className="dialog-backdrop" {...backdropDismiss(() => setUserInfoOpen(false))}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label="User info"
            ref={userInfoTrapRef}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>User info</h3>
            <dl className="user-info">
              <dt>OS user</dt>
              <dd>{user?.username ?? "unknown"}</dd>
              <dt>GitHub account</dt>
              <dd>{user?.login ?? <span className="unset">not signed in</span>}</dd>
              <dt>Name</dt>
              <dd>{user?.name ?? <span className="unset">not set</span>}</dd>
              {!hosted && (
                <>
                  <dt>Settings file</dt>
                  <dd className="user-info-settings-file">
                    <code>~/.specdriven/settings.json</code>
                    <button type="button" className="btn btn-secondary" onClick={openSettingsFile}>
                      View settings file…
                    </button>
                  </dd>
                </>
              )}
            </dl>
            <p className="hint">
              Commits to the data repo are authored with this identity — the signed-in
              GitHub account, or the system git identity when signed out.
            </p>
            <div className="dialog-actions">
              <button autoFocus className="btn btn-primary" onClick={() => setUserInfoOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {settingsFileOpen && (
        <SettingsFileDialog
          file={settingsFile}
          loadError={settingsFileError}
          trapRef={settingsFileTrapRef}
          onClose={() => setSettingsFileOpen(false)}
        />
      )}
      {/* Manage specification folders (specs/app/spec-folders.feature.md):
          open, remove or add spec folders. Opening one closes this and runs
          the same switch the recent menu does. */}
      {foldersOpen && (
        <SpecFoldersDialog
          folders={recentFolders}
          current={
            codeRepoDir !== null
              ? { path: codeRepoDir, kind: "code" }
              : dataRepo
                ? { path: dataRepo, kind: "spec" }
                : null
          }
          dirs={recentRepoDirs}
          busy={settingRepo}
          trapRef={foldersTrapRef}
          onClose={() => setFoldersOpen(false)}
          onOpen={(folder) => {
            setFoldersOpen(false);
            void (folder.kind === "code" ? openCodeRepo(folder.path) : switchRepo(folder.path));
          }}
          onRemove={(folder) => void (folder.kind === "code" ? forgetCodeRepo(folder.path) : forgetRepo(folder.path))}
          onAdd={() => {
            setFoldersOpen(false);
            void changeRepo();
          }}
          // Code repositories opened directly (specs/app/code-repo-mode
          // .feature.md "Open a code repository"), where they can be.
          {...(canOpenCodeRepo
            ? {
                onAddCodeRepo: () => {
                  setFoldersOpen(false);
                  void openCodeRepoPrompt();
                },
              }
            : {})}
        />
      )}
      {/* Error box (specs/agents/claude.feature.md): what the coding agent said
          when it exited with an error code. */}
      {sessionError && (
        <div className="dialog-backdrop" {...backdropDismiss(() => setSessionError(null))}>
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label="Code gen session failed"
            ref={sessionErrorTrapRef}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Code gen session failed</h3>
            <p className="error session-error">{sessionError}</p>
            <div className="dialog-actions">
              <button className="btn btn-primary" onClick={() => setSessionError(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {sheetOpen && <ShortcutSheet shortcuts={shortcuts} onClose={() => setSheetOpen(false)} />}
      {palette && (
        <CommandPalette
          initialQuery={palette.query}
          scope={shownTab}
          onClose={() => setPalette(null)}
          actions={paletteActions}
          recent={recentItems}
          resolve={resolvePalette}
        />
      )}
      {/* Below the prompts: an offer waits while another dialog asks. */}
      {pluginUpdates && !modalOpen && (
        <PluginUpdatesDialog
          updates={pluginUpdates}
          onClose={() => {
            clearPluginUpdates();
            void dismissPluginUpdates();
          }}
        />
      )}
      {/* Last, so a stacked prompt/confirm renders above any open dialog. */}
      {modal}
      {/* Switch spec folder (specs/app/spec-folders.feature.md): above all
          of it — while a switch runs, nothing else in the app is reachable. */}
      {switching && (
        <FolderSwitchDialog folder={switching.folder} step={switching.step} trapRef={switchTrapRef} />
      )}
      {startDialog && (
        <StartSessionDialog
          ai={{
            dialog: aiSessionDialog().dialog,
            state: aiTabState({ codeGen, specCount: sessionCount, sessionRunning }),
            onConfirm: (name, choice) => {
              setStartDialog(false);
              void runAiSession(name, choice);
            },
          }}
          onClose={() => setStartDialog(false)}
        />
      )}
      <Toaster />
    </main>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { backdropDismiss } from "./backdropDismiss";
import type {
  CSSProperties,
  MouseEvent,
  ReactNode,
} from "react";
import {
  scenarioNumbers,
  slugify,
  titleFromFileName,
} from "../server/parser";
import type {
  Scenario,
  ScenarioPick,
} from "../server/parser";
import { RESOURCE_LINK_KINDS, RESOURCE_LINK_TOOLS } from "../server/resourceLinks";
import type { ResourceLinkKind } from "../server/resourceLinks";
import type { FeatureListing } from "../server/features";
import type { ProjectMember } from "../server/members";
import type { GitHubRepo } from "../server/issues";
import type { CurrentUser } from "../server/user";
import {
  codeGenTargetLabel,
  readCodeGenTarget,
  resolveCodeGenTarget,
  usableAgents,
  type CodeGenTarget,
} from "./codeGenTarget";
import { Logo } from "./Logo";
import {
  AppWindow,
  Activity,
  Import,
  Pencil,
  Timer,
  Plus,
  RefreshCw,
  RefreshCwOff,
  Search,
  ExternalLink,
  FolderInput,
  Home,
  Tag,
  Keyboard,
  Link,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Puzzle,
  Settings,
  Sun,
  Trash2,
  UserRound,
  X,
  ArrowDown,
  ArrowUp,
  Bot,
  KeyRound,
  LogOut,
  ShieldCheck,
  Database,
  Images,
  Sparkles,
  Lock,
} from "lucide-react";
import { StatusIcon } from "./StatusIcon";
import { NewFeatureIcon, NewFolderIcon, StartSessionIcon } from "./ActionIcons";
import { Tooltip } from "./Tooltip";
import { Menu, type MenuItem } from "./Menu";
import { VersionChip } from "./updateHint";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";
import { CommandPalette, type PaletteItem } from "./CommandPalette";
import { ErrorBoundary } from "./ErrorBoundary";
import { createPromiseQueue } from "./promiseQueue";
export { createPromiseQueue };

import { setShareProject, setShareRepo, shareUrl } from "./shareLink";
import {
  chooseProject,
  parseReadOnlyProjects,
  setTabProject,
  showProjectInUrl,
  type ReadOnlyProjectInfo,
} from "./readOnlyProject";
import { SaveIndicator, Toaster, toast } from "./Toasts";
import { missedFeatureNote, pullProblemOf, syncForLink } from "./linkSync";
import { currentSyncProblem, pushHint, setSyncProblem, syncProblemMessage, useSyncProblem } from "./syncProblem";
import { currentRepoReadOnly, parseRepoReadOnly, readOnlySummary, setRepoReadOnly, useRepoReadOnly } from "./repoReadOnly";
import type { RepoReadOnly } from "./repoReadOnly";
import { ReadOnlyRepoDialog } from "./ReadOnlyRepoDialog";
import { IS_MAC, ShortcutSheet, isTypingTarget, useShortcuts, type Shortcut } from "./shortcuts";
import { MarkdownEditor } from "./MarkdownEditor";
import { applyVimPref, setVimDemoMode, useVimMode } from "./vimPref";
import { applySpellCheckPref, useSpellCheck } from "./spellCheckPref";
import {
  applyExcalidrawPref,
  useExcalidrawEnabled,
} from "./excalidrawPref";
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
import { StartSessionDialog, aiTabState, hostedSessionPick, sessionSelection } from "./StartSessionDialog";
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
import { coalesced } from "./coalesce";
import {
  tabHref,
  tabReachable,
  useRegistry,
  useTabStores,
  type OpenViewOptions,
  type PluginView,
  type TabApp,
  type TabPlugin,
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
  closedSessionsNote,
  defaultSessionName,
  useAgentChat,
} from "./agentChat";
import {
  featureMatches,
  isFiltering,
} from "./treeFilter";
import { CustomAttributesEditor } from "./CustomAttributesEditor";
import { knownNames, parseAttributeDefinitions } from "../server/customAttributes";
import { linkDraftOf } from "./externallinks";
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
} from "./route";
import type { AppPage } from "./route";
import {
  testLinkTarget,
  openTestInIdea,
  type TestDraft,
} from "./testlinks";
import {
  buildTree,
  folderLabel,
  revealed,
  folderOptions,
  scenarioNeighbors,
  scenarioRows,
  treeScenarioKey,
  scenarioSequence,
  withOpenScenarios,
} from "./tree";
import type { FolderNode, ScenarioRow } from "./tree";
import { useFocusTrap } from "./useFocusTrap";
import {
  FOLDER_KIND_LABEL,
  FolderKindIcon,
  FolderSwitchDialog,
  parseRecentFolders,
  SpecFoldersDialog,
  type FolderEntry,
  type FolderKind,
  type SwitchStep,
} from "./SpecFolders";
import {
  parseFolderVerdict,
  recentKindOf,
  showsFirstRun,
  StartFolderField,
  startFolderStep,
  type KindQuestion,
} from "./StartFolder";
import { FILES_TAB } from "./files/plugin";
import { SPECS_TAB } from "../plugins/builtin/specs/client";
import type { SpecsView } from "../plugins/builtin/specs/route";
import { FILES_HOME } from "./files/route";
import { CloneFromGitHub, GITHUB_HOST, PasteToken, TokenSignInDialog } from "./GitHubToken";
import { accountMenuEntries } from "./accountMenu";
import { SettingsFileDialog, type SettingsFile } from "./SettingsFileDialog";
import { accessShown, GitAccessChoice, type GitAccess } from "./GitAccessChoice";
import { SignedCommits } from "./SignedCommits";
import { ConfluenceTokens, fetchConfluenceTokens, type ConfluenceWiki } from "./ConfluenceToken";
import { JiraTokens, fetchJiraTokens, type JiraSite } from "./JiraToken";
import { AgentModelList, agentModelsOf, agentsWithoutSection, type AgentModels } from "./AgentModels";
import { type FolderFeature } from "./ConfluenceFolderPublishDialog";
import { QtestTokens, fetchQtestTokens, type QtestSite } from "./QtestToken";
import { AhaTokens, fetchAhaTokens, type AhaSite } from "./AhaToken";
import { ExtractSpecsDialog, type ExtractCreated } from "./ExtractSpecsDialog";
import { ExtractionProgress, PublishSpecsDialog, useExtraction } from "./ExtractionProgress";
import { LinkTestsDialog } from "./LinkTestsDialog";
import { EXTRACT_SPECS_EVENT } from "../server/intentNames";
import { HostedStartNav, hostedCloneHint, type HostedAccount } from "./HostedStartNav";
import { copyText, copyWhenReady } from "./clipboard";
import {
  CLAUDE_CODE_WEB_URL,
  CLAUDE_WEB_LABEL,
  CLAUDE_WEB_TARGET,
  claudeWebEnv,
  openPendingTab,
  startClaudeWebSession,
} from "./claudeWeb";
import { ClaudeWebNote } from "./ClaudeWebNote";
import { openWebLink } from "./weblinks";
import {
  cardOfScenario,
  featureFromResponse,
  insertAfterScenario,
  isCardControl,
  landedScenario,
  namingInProgress,
  newScenarioDraft,
  nextVersionIn,
  pageScenario,
  placeScenario,
  savedScenarioName,
  scenarioSignature,
  withPolarity,
  withScenario,
  withScenarioMoved,
  withScenarioPolarity,
} from "./specs/scenarioEdit";
import type { EditState, Placement } from "./specs/scenarioEdit";
import {
  clampBodyHeight,
  clampDescHeight,
} from "./specs/editorHeight";
import {
  resetEditorState,
  setConflict,
  setLinkDraft,
  setLinkError,
  setQtestDraft,
  setQtestError,
  setResolving,
  setSaving,
  setTestDraft,
  setTestEdit,
  setTestNameDraft,
  setTestNameHint,
  setTestsError,
  useEditorState,
} from "./specs/editorState";
import {
  resetFeaturePageState,
  setDescEdit,
  setFeatureAttributesOpen,
  setFeatureFlagsOpen,
  setFeaturePrsOpen,
  setFeatureQtestDraft,
  setFeatureResourceOpen,
  setFeatureTicketsOpen,
  setRenameDraft,
  useFeaturePageState,
} from "./specs/featurePageState";
import {
  resetSpecsDialogs,
  setAhaImportOpen,
  setConfluenceFolder,
  setConfluencePublishOpen,
  setExtractOpen,
  setImportOpen,
  setLinkTestsOpen,
  setOpenSpecImportOpen,
  setPublishOpen,
  setQtestPublishOpen,
  setWikiQtestPublishOpen,
  useSpecsDialogs,
} from "./specs/dialogs";
import { useDescriptionEditor } from "./specs/descriptionEditor";
import { useTreeScenarios } from "./specs/treeScenarios";
import { useScenarioOps } from "./specs/scenarioOps";
import { useTestLinks } from "./specs/testLinks";
import { useFeatureFields } from "./specs/featureFields";
import { useScenarioSave } from "./specs/scenarioSave";
import { usePublish } from "./specs/publish";
import { useFeatureOps } from "./specs/featureOps";
import { useSpecsRefs } from "./specs/refs";
import { useEditorEffects } from "./specs/editorEffects";
import { useOpenFeatureActions } from "./specs/openActions";
import { provideSpecsHost, type SpecsActions } from "./specs/host";
import {
  DEFAULT_PROJECT_MANAGEMENT_TOOL,
  NO_RESOURCE_LINKS,
  resetSpecsSettings,
  setAhaImportOn,
  setAssignments,
  setConfluenceEnabledOn,
  setDeletePublished,
  setFeatureFlags,
  setJiraEnabledOn,
  setPreviewLines,
  setProjectManagement,
  setProjectManagementTool,
  setPublishExternalLinks,
  setQtestLinks,
  setResourceLinksOn,
  setScenarioPolarity,
  setShowTestLinks,
  useSpecsSettings,
  type ResourceLinkSwitches,
} from "./specs/settings";
import {
  resetSpecSelection,
  scenarioKey,
  setSpecSelection,
  toggleSpecSelected,
  useSpecSelection,
} from "./specs/selection";
import {
  resetOpenFeature,
  setDirty,
  setEditing,
  setFeature,
  setFeatureLoading,
  setPaneRequest,
  setSearchTerms,
  setSelected,
  setSelectedScenario,
  useOpenFeature,
  type OpenOptions,
} from "./specs/openFeature";
import { SpecsSidebar, type SpecsSidebarProps } from "./specs/SpecsSidebar";
import {
  resetTreeState,
  setCollapsed,
  setOutlined,
  setSelectedFolder,
  useTreeState,
} from "./specs/treeState";
import {
  resetListing,
  setFeatures,
  setListing,
  useSpecsListing,
  type Listing,
} from "./specs/listing";

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
/** How long a peer's edit waits for others arriving with it before the view is re-read. */
const PEER_EDIT_REFRESH_MS = 100;

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
const PROJECT_MANAGEMENT_TOOLS = ["Jira", "Linear", "GitHub", "GitLab", "Asana", "Azure DevOps"];

// Aha! and Figma links (specs/external-links/aha-and-figma-links.feature.md):
// each tool is offered only once its Settings switch is on — both start off.
/** The Settings key that switches each tool on. */
const RESOURCE_LINK_SETTING = { aha: "ahaLinks", figma: "figmaLinks" } as const;

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

// The description's and the scenario body's heights moved to
// src/frontend/specs/editorHeight.ts; the clamps are re-exported for the
// tests that import them from here.
export { clampBodyHeight, clampDescHeight };

// The sidebar's tabs, one per mounted plugin by its id (src/plugins/client/
// tabs.ts) — Specs' feature tree, the special folders' page lists among
// them. They all share the one column, so the choice is remembered like the
// sidebar width: a tab left open is meant to stay open, not to reset on
// every reload.
type SidebarTab = string;

function readSidebarTab(): SidebarTab | null {
  try {
    // Every stored name is kept: one that is not on offer any more — and
    // none stored at all — falls back to the first tab where `shownTab` is
    // derived.
    return localStorage.getItem("sd-sidebar-tab");
  } catch {
    return null;
  }
}

function storeSidebarTab(tab: SidebarTab): void {
  try {
    localStorage.setItem("sd-sidebar-tab", tab);
  } catch {
    // Storage unavailable (private mode): the choice just won't stick.
  }
}

// Moved to src/frontend/specs/scenarioEdit.ts; re-exported for the tests
// that import them from here.
export {
  cardOfScenario,
  insertAfterScenario,
  isCardControl,
  landedScenario,
  namingInProgress,
  newScenarioDraft,
  nextVersionIn,
  pageScenario,
  placeScenario,
  savedScenarioName,
  scenarioSignature,
  withPolarity,
  withScenario,
  withScenarioMoved,
  withScenarioPolarity,
};
export type { EditState, Placement };

// Each scenario's number lives beside the file format it labels, so the
// Confluence page numbers its scenarios as the cards do.
export { scenarioNumbers };

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
      // A feature or a scenario, from before Specs was a plugin's tab: the
      // view at its url on that tab.
      if (kind === "feature" || kind === "scenario") {
        return {
          kind: "plugin" as const,
          fileName: e.scenario ? scenarioPath(e.fileName, e.scenario) : featurePath(e.fileName),
          name: e.scenario ? e.scenario.name : e.name,
          tab: SPECS_TAB,
        };
      }
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
          readOnlyRepo: parseRepoReadOnly(data.readOnlyRepo),
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
// The folders whose read-only dialog this window has shown, kept for the
// window's session — a reload does not ask again, a new start does.
const READ_ONLY_ANNOUNCED_KEY = "sd-read-only-announced";
function readOnlyAnnouncedStored(): string[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(READ_ONLY_ANNOUNCED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}
function storeReadOnlyAnnounced(dirs: Set<string>): void {
  try {
    sessionStorage.setItem(READ_ONLY_ANNOUNCED_KEY, JSON.stringify([...dirs]));
  } catch {
    // Storage refused: the dialog may come up again after a reload.
  }
}

// A read-only folder (src/frontend/repoReadOnly.ts) keeps every command but
// the ones that change its specs: create, import, publish, rename, move,
// delete, and the editor's formatting keys.
const WRITES_SPECS =
  /^(?:action:)?(?:create|publish|rename(?:-[\w-]+)?|move(?:-[\w-]+)?|delete(?:-[\w-]+)?|new-folder|import-[\w-]+|md-[\w-]+|divider)$/;
const READ_ONLY_PALETTE = new RegExp(`^action:(${[...READ_ONLY_SHORTCUTS].join("|")}|go-[\\w-]+|theme-\\w+)$`);

export function App() {
  const [dataRepo, setDataRepo] = useState<string | null>(null);
  // Recent folder list (specs/ui/ui.feature.md "Recent folder list",
  // specs/app/spec-folders.feature.md "Manage specification folders"): every
  // folder used before, spec folders and code repositories together, each
  // with its kind, the open one first, then most recent first — what the ▾
  // beside the folder name drops down (up to 10) and the folder dialog lists.
  const [recentFolders, setRecentFolders] = useState<FolderEntry[]>([]);
  // Those of them the app's other windows show (specs/app/multiple-windows
  // .feature.md "The folder dialog and the windows"): the folder dialog
  // offers each one's window in place of opening it a second time.
  const [otherWindowFolders, setOtherWindowFolders] = useState<FolderEntry[]>([]);
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
    otherWindowFolders?: unknown;
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
    if (Array.isArray(state.otherWindowFolders)) setOtherWindowFolders(parseRecentFolders(state.otherWindowFolders));
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
  const [startChoice, setStartChoice] = useState<"folder" | "clone" | "extract">("folder");
  // The first-run field's folder is neither kind by its contents
  // (src/server/folderKind.ts): the question the screen asks about it.
  const [kindQuestion, setKindQuestion] = useState<KindQuestion | null>(null);
  // The recent folder the field was last filled from — its kind is known,
  // even where the list has the same path as both kinds.
  const pickedRecent = useRef<FolderEntry | null>(null);
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
  // Several windows (specs/app/multiple-windows.feature.md): whether a folder
  // can be opened in a window of its own — the desktop app — and the folder
  // this window was opened for, which it opens once it has booted.
  const [canOpenWindows, setCanOpenWindows] = useState(false);
  const [pendingFolder, setPendingFolder] = useState<{ path: string; kind?: FolderKind } | null>(null);
  // The window is opening the folder it was opened for: until that is
  // settled the first-run screen stays away (StartFolder.tsx showsFirstRun).
  const [openingOwnFolder, setOpeningOwnFolder] = useState(false);
  // Demo mode: the data directory is a fixed ephemeral copy — everything that
  // changes or syncs it (✎, recents ▾, Sync, git/GitHub settings) hides.
  const [demo, setDemo] = useState(false);
  // Read-only mode (src/server/readOnlyMode.ts): the public spec site. The
  // server refuses every write; the client hides what would make one — the
  // folder switch and Sync, every create, edit, move and delete, settings,
  // agents — and opens editors as previews.
  const [readOnly, setReadOnly] = useState(false);
  // The projects the read-only site shows, and the visitor's
  // (src/frontend/readOnlyProject.ts): with more than one, the folder name's
  // ▾ picks among them.
  const [readOnlyProjects, setReadOnlyProjects] = useState<ReadOnlyProjectInfo[]>([]);
  const [readOnlyProject, setReadOnlyProject] = useState<string | null>(null);
  // A spec folder that cannot be pushed to opens read only (src/frontend/
  // repoReadOnly.ts, git-operations.md): no remote, or a remote that turns
  // this computer down. Its specs lock like the read-only site's — every
  // create, edit, move and delete hidden, editors opened as pages — while
  // the rest of the app stays: Settings, the folder switch, Sync's pulls.
  const repoReadOnly = useRepoReadOnly();
  /** Whether the specs on screen can be changed from here: not on the site, not in a read-only folder. */
  const locked = readOnly || repoReadOnly !== null;
  /** The dialog that says why (ReadOnlyRepoDialog.tsx). */
  const [readOnlyDialogOpen, setReadOnlyDialogOpen] = useState(false);
  /** The folder the remote last answered for, when the folder opened — until then a null is no news. */
  const [repoAccessFor, setRepoAccessFor] = useState<string | null>(null);
  // Check for Updates… belongs to the desktop app (src/frontend/main.tsx marks
  // it): the web server cannot replace itself, so its version is not a way in.
  const canCheckForUpdates = typeof document !== "undefined" && Boolean(document.documentElement.dataset.desktop);
  // Hosted mode (src/server/hostedMode.ts): the app runs behind the hosted
  // gateway, whose account page holds the GitHub token and agent keys.
  const [hosted, setHosted] = useState(false);
  // Whether the hosted service reaches GitHub through its own app
  // (src/server/hostedToken.ts) rather than a token pasted on the account page.
  const [hostedGithubApp, setHostedGithubApp] = useState(false);
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
  // The spec listing lives in a core store (src/frontend/specs/listing.ts)
  // the Specs tab reads too. A fresh App starts from nothing listed, as its
  // own state did: once, before the first read of the store.
  useState(() => {
    resetListing();
    resetTreeState();
    resetOpenFeature();
    resetEditorState();
    resetFeaturePageState();
    resetSpecSelection();
    resetSpecsDialogs();
    resetSpecsSettings();
  });
  const { features, folders, folderDescriptions, folderOrders, featureOrders } = useSpecsListing();
  // The open feature — its file, what was read of it, the card highlighted
  // and the scenario in the editor — lives in a store the Specs tab reads
  // too (src/frontend/specs/openFeature.ts); set here under the same names.
  const { featureLoading, selected, feature, selectedScenario, dirty, editing, paneRequest } = useOpenFeature();
  // What the editor pane and the feature page hold of their own — menus,
  // drafts, heights, a save or a publish under way — likewise
  // (src/frontend/specs/editorState.ts, featurePageState.ts).
  const {
    editorMenuOpen,
    statusMenuOpen,
    conflict,
    resolving,
    saving,
    savedAt,
    publishing,
    testDraft,
    testNameDraft,
    testEdit,
    testEditDraft,
    linkDraft,
    qtestDraft,
  } = useEditorState();
  const {
    featureMenuOpen,
    cardMenu,
    assigneeMenuOpen,
    publishMenuOpen,
    renameDraft,
    featureTicketsOpen,
    featureQtestDraft,
    featurePrsOpen,
    featureFlagsOpen,
    featureAttributesOpen,
    featureResourceOpen,
    descEdit,
  } = useFeaturePageState();
  // The switches of Settings the tree, the feature page and the editor read
  // (src/frontend/specs/settings.ts), set from /api/state further down.
  const {
    previewLines,
    showTestLinks,
    publishExternalLinks,
    projectManagement,
    projectManagementTool,
    resourceLinksOn,
    qtestLinks,
    ahaImportOn,
    jiraEnabledOn,
    confluenceEnabledOn,
    deletePublished,
    assignments,
    featureFlags,
    scenarioPolarity,
  } = useSpecsSettings();
  // Project members (src/server/members.ts): the data repo's
  // project-settings.yaml, as the feature's "Assigned" dropdown offers them.
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
  // The tree's own state (src/frontend/specs/treeState.ts): folds, outlines,
  // the folder picked, drags, the row menu, scenario picks and the filter.
  const {
    collapsed,
    outlined,
    selectedFolder,
    dragging,
    treePicks,
    treeMenu,
    dropTarget,
    featureDropAt,
    scenarioDrag,
    scenarioDropAt,
    scenarioDropInto,
    folderDrag,
    folderDropAt,
    filter,
    filterMenuOpen,
  } = useTreeState();
  /** Sidebar width in px (specs/ui/ui.feature.md "Sidebar resize"). */
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  /** True while the sidebar divider is being dragged. */
  const [resizingSidebar, setResizingSidebar] = useState(false);
  // Code gen sessions (specs/agents/claude.feature.md): what is checked for
  // one, in a store the tree and the feature page set
  // (src/frontend/specs/selection.ts).
  const specSelection = useSpecSelection();
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
  const [sessionNotice, setSessionNotice] = useState<ReactNode>(null);
  /** A failed session's message, shown in an error box until dismissed. */
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Full-text search (specs/search.feature.md) lives in the command palette
  // (⌘K, src/frontend/CommandPalette.tsx): open, with the text it starts on.
  const [palette, setPalette] = useState<{ query: string } | null>(null);
  /** The pages opened most recently — the palette's empty state. */
  const [recent, setRecent] = useState<RecentEntry[]>(readRecent);
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
  /** The `?` keyboard cheat sheet. */
  const [sheetOpen, setSheetOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reloadSeconds, setReloadSeconds] = useState(60);
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
  // Which of the Specs tab's dialogs is open — imports, publishing,
  // extracting, linking tests — is in a store their openers set
  // (src/frontend/specs/dialogs.ts); they are still rendered here.
  const {
    confluencePublishOpen,
    confluenceFolder,
    qtestPublishOpen,
    wikiQtestPublishOpen,
    ahaImportOpen,
    openSpecImportOpen,
    extractOpen,
    importOpen,
    publishOpen,
    linkTestsOpen,
  } = useSpecsDialogs();
  /** Confluence (specs/external-links/confluence-wiki.feature.md): the wikis
      this device holds a token for. */
  const [confluenceWikis, setConfluenceWikis] = useState<ConfluenceWiki[]>([]);
  /** qTest (specs/external-links/qtest-test-cases.feature.md "Create qTest
      test cases from a feature"): the sites this device holds a token for,
      and the last parent module created under. */
  const [qtestSites, setQtestSites] = useState<QtestSite[]>([]);
  const [qtestParentUrl, setQtestParentUrl] = useState("");
  /** Aha! (specs/external-links/aha-import.feature.md): the sites this
      device holds an API key for. */
  const [ahaSites, setAhaSites] = useState<AhaSite[]>([]);
  /** Whether "Import from Aha!" is offered at all — switched on in Settings
      → Aha!. Never in the demo or the hosted app, which keep no API key. */
  const ahaImport = ahaImportOn && !demo && !hosted;
  /** Import from OpenSpec (specs/external-links/openspec-import.feature.md)
      needs no key, so no Settings switch; never in the demo or the hosted
      app, which have no code repo on disk. */
  const openSpecImport = !demo && !hosted;
  /** Extract specs from a code project (specs/app/extract-specs-from-code
      .feature.md) is offered wherever a code repository can be opened: the
      user's own machine, never the demo, the hosted app or the read-only
      site. */
  const extractSpecs = canOpenCodeRepo && !demo && !hosted;
  /** Import from Jira/Wiki (specs/external-links/jira-wiki-import
      .feature.md): the Jira sites this device holds a token for. Never in
      the demo or the hosted app. */
  const [jiraSites, setJiraSites] = useState<JiraSite[]>([]);
  /** Jira and Confluence, switched on in Settings: never in the demo or the
      hosted app, which keep no tokens. */
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
  // The tabs on screen, in the profile's order. With a code repository open
  // (specs/app/code-repo-mode.feature.md) the Files tab is the only one;
  // otherwise it is never shown.
  const barTabs = useMemo(
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
  // Another tab's open view, which App holds; null when none is open.
  const [tabView, setPluginView] = useState<PluginView | null>(null);
  // The view that has the pane: another tab's, or the Specs tab's open
  // feature — App still holds that one as `selected`, so the Specs view is
  // read from it (src/plugins/builtin/specs/route.ts). Opening either
  // closes the other: openFeature drops the tab's view, openPluginView the
  // feature.
  // The scenario whose page is open goes in the view, so its url and its
  // Recent entry are the scenario's.
  const viewScenario = pageScenario(editing, feature?.scenarios);
  const pluginView = useMemo<PluginView | null>(
    () =>
      tabView ??
      (selected !== null
        ? {
            tab: SPECS_TAB,
            view: {
              feature: selected,
              scenario: viewScenario ? { slug: slugify(viewScenario.name), version: viewScenario.version } : null,
            } satisfies SpecsView,
          }
        : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabView, selected, viewScenario?.name, viewScenario?.version],
  );
  const pluginViewRef = useRef<PluginView | null>(null);
  pluginViewRef.current = pluginView;
  const activeTab = pluginView ? (barTabs.find((t) => t.id === pluginView.tab) ?? null) : null;
  /** Ticks with the tabs' stores, so titles read through them stay current. */
  const tabsTick = useTabStores(barTabs);
  // Google Calendar (specs/app/tasks.feature.md "Add task to Google
  // Calendar"): the Settings switch behind every task's calendar chip, as
  // the Settings dialog's row shows it; the tasks plugin reads it too.
  const [googleCalendarOn, setGoogleCalendarOn] = useState(false);
  /** Which sidebar tab is open — Specs or a plugin's; remembered. */
  const [sidebarTab, setSidebarTab] = useState<SidebarTab | null>(readSidebarTab);
  /**
   * The tab on screen: the remembered one while it is still mounted, else
   * the first there is — the notebook, in a folder that shows it alone.
   */
  const shownTab: SidebarTab = sidebarTab !== null && barTabs.some((tab) => tab.id === sidebarTab)
    ? sidebarTab
    : (barTabs[0]?.id ?? (codeRepoDir !== null ? FILES_TAB : ""));
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
  // .feature.md "view the settings file"): ~/.specdriven/settings.yaml,
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
    setListing(listing);
    setMembers(listing.members);
    setCodeRepo(listing.codeRepo);
    setCodeRepos(listing.codeRepos ?? []);
    setAuthorsInMarkdown(listing.authorsInMarkdown);
    setIssuesRepo(listing.issuesRepo);
    setCustomAttributesText(listing.customAttributes);
    setSyncProblem(listing.syncProblem);
    setRepoReadOnly(listing.readOnlyRepo);
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
        setCanOpenWindows(Boolean(state.canOpenWindows));
        if (typeof state.pendingFolder?.path === "string") {
          const kind = state.pendingFolder.kind;
          setPendingFolder({ path: state.pendingFolder.path, ...(kind === "spec" || kind === "code" ? { kind } : {}) });
          setOpeningOwnFolder(true);
        }
        setDemo(Boolean(state.demo));
        setReadOnly(Boolean(state.readOnly));
        {
          const projects = parseReadOnlyProjects(state.readOnlyProjects);
          const project = typeof state.readOnlyProject === "string" ? state.readOnlyProject : null;
          setReadOnlyProjects(projects);
          setReadOnlyProject(project);
          setTabProject(project);
          // A link, and the address bar, name the project only where there
          // is a choice of them.
          setShareProject(projects.length > 1 ? project : null);
          showProjectInUrl(projects.length > 1 ? project : null);
        }
        setHosted(Boolean(state.hosted));
        setHostedGithubApp(Boolean(state.hostedGithubApp));
        // The demo pins Vim mode off (src/frontend/vimPref.ts): any editor open
        // when this lands drops its Vim tab, and the Settings row hides.
        setVimDemoMode(Boolean(state.demo));
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
    // The app's own host answers this much of the account and no more
    // (src/gateway/server.ts): the account pages are on a host of their own.
    fetch("/_session/me")
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
    void fetch("/_session/logout", { method: "POST" }).finally(() => window.location.assign("/login"));
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
    // The public specs site re-reads the open page too (specs/app/
    // public-specs-site.feature.md "A change pushed to the spec repo shows up
    // on the site"), and a scenario's page there is the editor pane — which
    // the rule above leaves alone so a refresh cannot clobber an edit. Nothing
    // is edited on that site, so the pane re-opens on the scenario as the
    // server now has it, once the feature changed.
    if (locked && selected && editing && editing.index !== null && !editing.isNew) {
      loads.push(refreshReadOnlyPane(selected, editing.scenario));
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

  /** Whether the url already stands for an open scenario page. */
  const panePushed = useRef(false);
  const {
    editingOpen,
    paneScenario,
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
  const extractTrapRef = useFocusTrap(extractOpen !== null);
  // The drafting of the open folder's specs from its code, as it goes: asked
  // of the server when the folder opens and while a run is at work; each
  // feature it writes shows in the sidebar as it lands.
  const [extractKick, setExtractKick] = useState(0);
  const extraction = useExtraction(
    extractSpecs && !needsRepo && codeRepoDir === null ? dataDir : null,
    extractKick,
    () => void loadFeatures(),
  );
  // "Link tests to specs" (specs/app/extract-specs-from-code.feature.md
  // "Tests are linked later, on their own") is offered on a specification
  // folder that is open, where specs can be extracted at all.
  const linkTestsTrapRef = useFocusTrap(linkTestsOpen);
  const canLinkTests = extractSpecs && !needsRepo && codeRepoDir === null;
  // The desktop app's File → Extract Specs from Code Project… (src/electron/
  // main.ts) asks the window in front: with a folder open the dialog opens
  // on it, and on the first-run screen its choice is picked.
  useEffect(() => {
    if (!extractSpecs) return;
    const onMenu = () => {
      if (needsRepo) setStartChoice("extract");
      else setExtractOpen({ codeDir: codeRepoRef.current });
    };
    window.addEventListener(EXTRACT_SPECS_EVENT, onMenu);
    return () => window.removeEventListener(EXTRACT_SPECS_EVENT, onMenu);
  }, [extractSpecs, needsRepo]);
  const foldersTrapRef = useFocusTrap(foldersOpen);
  // The folder dialog lists what is so now (specs/app/multiple-windows
  // .feature.md "The folder dialog and the windows"): a folder another
  // window opened since this page last asked is on the list, and every
  // other window's folder is marked. Read as the dialog opens, and again
  // whenever this window comes back to the front while it is up.
  useEffect(() => {
    if (!foldersOpen) return;
    let gone = false;
    const read = async () => {
      try {
        const res = await fetch("/api/state");
        const state = res.ok ? await res.json() : null;
        if (!state || gone) return;
        if (Array.isArray(state.recentFolders)) setRecentFolders(parseRecentFolders(state.recentFolders));
        if (Array.isArray(state.otherWindowFolders)) setOtherWindowFolders(parseRecentFolders(state.otherWindowFolders));
        const dirs = state.recentDataRepoDirs;
        if (dirs && typeof dirs === "object") setRecentRepoDirs(dirs as Record<string, string>);
      } catch {
        // The list stays as this page last heard it.
      }
    };
    void read();
    window.addEventListener("focus", read);
    return () => {
      gone = true;
      window.removeEventListener("focus", read);
    };
  }, [foldersOpen]);
  const switchTrapRef = useFocusTrap(switching !== null);
  const sessionErrorTrapRef = useFocusTrap(sessionError !== null);

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
    // Another tab's view owns its url (openPluginView pushes it), and so
    // does an app page; with no feature selected this effect would
    // otherwise rewrite it to `/`.
    if (appPage || (pluginView && selected === null)) return;
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
  }, [loading, needsRepo, codeRepoDir, pluginView, appPage, barTabs]);

  // Window title follows what is open (specs/ui/navigation.feature.md) — chat
  // and email link previews show it.
  const clock = titlePrefix(pom.timer, pom.now);
  useEffect(() => {
    // The open view names the window — a feature and the scenario in its
    // pane (the Specs tab's), a roadmap page or a task — so a shared link
    // previews as that page (specs/app/tasks.feature.md).
    const base = appPage
      ? `SpecDriven — ${appPage === "settings" ? "Settings" : appPage === "project-settings" ? "Project settings" : appPage === "plugins" ? "Plugins" : appPage === "data" ? "Data" : appPage === "images" ? "Images" : appPage === "whats-new" ? "What's new" : appPage === "updates" ? "Updates" : "Observability"}`
      : pluginView && activeTab
        ? `SpecDriven — ${activeTab.route.title(pluginView.view)}`
        : "SpecDriven";
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
    /** The user called it a specification folder: add `.specdriven` and `specs`. */
    init = false,
  ): Promise<{ res: Response; state: any } | null> => {
    const put = async (create: boolean) => {
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // A folder made here starts as a specification folder, with the two
        // folders that mark one (src/server/folderKind.ts).
        body: JSON.stringify({
          dataRepo: repo,
          ...(create ? { createDataRepo: true } : {}),
          ...(create || init ? { initSpecFolder: true } : {}),
        }),
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

  const saveRepo = async (repo: string, init = false) => {
    // Capture the entry url now: once needsRepo flips, the canonical-url
    // effect would rewrite a deep link before we get to honor it
    // (specs/ui/navigation.feature.md "deep link before a data repo is
    // configured").
    const entryPath = location.pathname;
    const entryLink = isLinkEntry(location.search);
    setSettingRepo(true);
    setRepoError(null);
    try {
      const put = await putDataRepo(repo, undefined, init);
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
    purpose: "data-repo" | "code-repo" | "folder" = "data-repo",
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
  const browseIntoRepoInput = async (purpose: "data-repo" | "folder" | "code-repo" = "data-repo") => {
    const picked = await chooseFolderNative(purpose);
    if (picked && repoInputRef.current) {
      repoInputRef.current.value = picked;
      pickedRecent.current = null;
      setKindQuestion(null);
    }
  };

  /**
   * The first-run screen's one folder field (specs/ui/app-start.feature.md
   * "one field opens a specification folder or a code repository"): a
   * folder opened before opens as the kind it was; any other is told apart
   * by its contents (src/server/folderKind.ts) — and where they do not say,
   * the user is asked. `as` is the answer to that question.
   */
  const openStartFolder = async (input: string, as?: FolderKind) => {
    const typed = input.trim();
    if (!typed) return;
    const asked = kindQuestion;
    setKindQuestion(null);
    if (as && asked) {
      // The user said which: a specification folder gets its two folders.
      if (as === "code") await openCodeRepo(asked.path);
      else await saveRepo(asked.open, true);
      return;
    }
    // Where no code repository can be opened, every folder is a spec folder.
    if (hosted || demo || !canOpenCodeRepo) return saveRepo(typed);
    const known = pickedRecent.current?.path === typed ? pickedRecent.current.kind : recentKindOf(recentFolders, typed);
    if (known === "code") return void (await openCodeRepo(typed));
    if (known === "spec") return saveRepo(typed);
    setSettingRepo(true);
    setRepoError(null);
    let verdict: ReturnType<typeof parseFolderVerdict> = null;
    try {
      const res = await fetch("/api/folder-kind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: typed }),
      });
      const body = await res.json().catch(() => null);
      verdict = res.ok ? parseFolderVerdict(body) : null;
      if (!verdict) {
        setRepoError((body as { error?: string } | null)?.error ?? "Could not read this folder");
        return;
      }
    } catch {
      setRepoError("Could not read this folder — the app did not answer");
      return;
    } finally {
      setSettingRepo(false);
    }
    switch (startFolderStep(verdict)) {
      case "spec":
        return saveRepo(verdict.open);
      case "code":
        return void (await openCodeRepo(verdict.path));
      case "refuse":
        setRepoError(`Not a folder: ${verdict.path}`);
        return;
      case "ask":
        setKindQuestion({ open: verdict.open, path: verdict.path, name: verdict.name });
        return;
      case "confirm-specs": {
        const yes = await confirm({
          title: "Set up a specification folder?",
          body: `${verdict.name} is empty. Is it a specification folder? Setting it up adds a .specdriven folder and a specs folder inside ${verdict.path}.`,
          confirmLabel: "Yes, set it up",
          danger: false,
        });
        // A no leaves the folder as it was, and the screen where it is.
        if (yes) await saveRepo(verdict.open, true);
        return;
      }
    }
  };

  // A window opened for a folder (specs/app/multiple-windows.feature.md
  // "Opening a window" — File → Open Folder…, Open Recent, "Open in new
  // window", a link to a folder no window shows) starts with none and opens
  // that one here, the way the first-run screen opens the folder typed into
  // it: asked about when it is missing or its kind is not clear, and with
  // the entry link honored. The first-run screen is not shown meanwhile: it
  // comes up only when the folder did not open, with the reason or the
  // question on it.
  useEffect(() => {
    if (!pendingFolder || !needsRepo || settingRepo) return;
    const { path, kind } = pendingFolder;
    setPendingFolder(null);
    void Promise.resolve(kind === "code" ? openCodeRepo(path) : kind === "spec" ? saveRepo(path) : openStartFolder(path))
      .catch(() => {})
      .finally(() => setOpeningOwnFolder(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFolder, needsRepo, settingRepo]);

  /**
   * Open a folder in a window of its own, or — with none named — a new
   * window that asks for one. The window that already shows the folder
   * comes forward instead (the shell's answer either way).
   */
  const openInNewWindow = async (folder?: FolderEntry) => {
    try {
      const res = await fetch("/api/windows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(folder ? { path: folder.path, kind: folder.kind } : {}),
      });
      if (!res.ok) toast.error((await res.json().catch(() => null))?.error ?? "Could not open a window");
    } catch {
      toast.error("Could not open a window — the app did not answer");
    }
  };

  // Open another folder — Manage folders → "Open another folder…"
  // (specs/ui/app-start.feature.md "changing the data repo"): a prompt
  // pre-filled with the open folder. A specification folder or a code
  // repository, where both can be opened — told apart as the first-run
  // screen tells them (openStartFolder above): a folder opened before opens
  // as the kind it was, any other by what is inside, and one that does not
  // say is asked about. On success the view resets to home, since the
  // current selection belonged to the old folder.
  const changeRepo = async () => {
    const both = canOpenCodeRepo && !hosted && !demo;
    const input = await prompt({
      title: "Open a folder",
      hint: both
        ? "The path of a specification folder or a code repository on this computer, or the GitHub url of a spec data repo."
        : "Path or GitHub url of the spec data repo.",
      initial: codeRepoDir ?? dataRepo ?? "",
      confirmLabel: "Open",
      browse: canChooseFolder ? () => chooseFolderNative(both ? "folder" : "data-repo") : undefined,
    });
    const typed = input?.trim() ?? "";
    if (!typed) return;
    if (!both) return switchRepo(typed);
    const known = recentKindOf(recentFolders, typed);
    if (known === "code") return void (await openCodeRepo(typed));
    if (known === "spec") return switchRepo(typed);
    let verdict: ReturnType<typeof parseFolderVerdict> = null;
    setSettingRepo(true);
    try {
      const res = await fetch("/api/folder-kind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: typed }),
      });
      const body = await res.json().catch(() => null);
      verdict = res.ok ? parseFolderVerdict(body) : null;
      if (!verdict) {
        toast.error((body as { error?: string } | null)?.error ?? "Could not read this folder");
        return;
      }
    } catch {
      toast.error("Could not read this folder — the app did not answer");
      return;
    } finally {
      setSettingRepo(false);
    }
    switch (startFolderStep(verdict)) {
      case "spec":
        return switchRepo(verdict.open);
      case "code":
        return void (await openCodeRepo(verdict.path));
      case "refuse":
        toast.error(`Not a folder: ${verdict.path}`);
        return;
      case "ask": {
        const kind = await pick({
          title: `Open ${verdict.name} as…`,
          hint: "Can't tell what this folder is: it has no .specdriven and specs folders, and no build file.",
          placeholder: "Specification folder or code repository",
          options: [
            {
              value: "spec",
              label: "A specification folder",
              hint: "Adds a .specdriven folder and a specs folder inside it",
            },
            { value: "code", label: "A code repository", hint: "Left as it is" },
          ],
        });
        if (kind === "code") await openCodeRepo(verdict.path);
        else if (kind === "spec") await switchRepo(verdict.open, undefined, true);
        return;
      }
      case "confirm-specs": {
        const yes = await confirm({
          title: "Set up a specification folder?",
          body: `${verdict.name} is empty. Is it a specification folder? Setting it up adds a .specdriven folder and a specs folder inside ${verdict.path}.`,
          confirmLabel: "Yes, set it up",
          danger: false,
        });
        // A no leaves the folder as it was, and the open one open.
        if (yes) await switchRepo(verdict.open, undefined, true);
        return;
      }
    }
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
  /**
   * The coding agent pane follows a folder switch
   * (specs/agents/agent-pane.feature.md "Switching folders closes the other
   * folder's sessions"): the server closed the other folder's sessions, so
   * their tabs go, and a toast says how many.
   */
  const afterFolderSwitch = (state: { closedSessions?: unknown }) => {
    void agentChat.switchedFolder();
    const note = closedSessionsNote(state.closedSessions);
    if (note) toast.info(note);
  };

  const switchRepo = async (
    next: string,
    entryPath?: string,
    /** The user called it a specification folder: it gets its two folders. */
    init = false,
  ) => {
    if (!next || next === reposRef.current.open) return;
    setSettingRepo(true);
    // The switch is modal (specs/app/spec-folders.feature.md "Switch spec
    // folder"): the dialog names the folder and the step, and everything
    // else waits until it comes down in the finally below.
    setSwitching({ folder: next, step: "saving" });
    await landEditors();
    try {
      setSwitching({ folder: next, step: "opening" });
      const put = await putDataRepo(
        next,
        (asking) => setSwitching(asking ? null : { folder: next, step: "opening" }),
        init,
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
        afterFolderSwitch(state);
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
        // A folder another window shows came forward there
        // (specs/app/multiple-windows.feature.md); nothing failed here.
        if (state.openElsewhere !== true) toast.error(state.error ?? "Could not use this directory");
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
   * "Open a code repository"): from the first-run screen or the folder
   * dialog. What the editors hold lands first; then the Files tab
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
          // Open in another window, which came forward: nothing failed here.
          if (state.openElsewhere !== true) toast.error(error);
          // The README was emptied to leave; the folder stays, so it comes back.
          await loadReadme();
        }
        return false;
      }
      if (!first) setSwitching({ folder: next, step: "loading" });
      applyRepos(state);
      afterFolderSwitch(state);
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

  /**
   * The first-run screen's "Extract specs from code"
   * (specs/app/extract-specs-from-code.feature.md): the project opens as a
   * code repository — so its agents are at hand — and the dialog starts on it.
   */
  const startExtract = async (input: string) => {
    const dir = input.trim();
    if (!dir) return;
    if (await openCodeRepo(dir)) setExtractOpen({ codeDir: codeRepoRef.current ?? dir });
  };

  /**
   * The specification folder was made: it opens in this window, in place of
   * the code repository or folder that was open, and what could not be done
   * on the way — the repository on GitHub, the project's specs link — is said.
   */
  const afterExtract = async ({ created, codeDir, folders, agent, model, linkTests }: ExtractCreated) => {
    setExtractOpen(null);
    setFoldersOpen(false);
    // A repository that was cloned opens by its url, as it would from the folder field.
    const open = created.open ?? created.dir;
    if (needsRepo) await saveRepo(open);
    else if (created.dir === dataDir && codeRepoDir === null) await loadFeatures();
    else await switchRepo(open);
    const count = `${created.folders.length} folder${created.folders.length === 1 ? "" : "s"}`;
    const made = created.existing
      ? `${count} added to ${repoDisplayName(created.dir)}`
      : `${repoDisplayName(created.dir)} is made, with ${count}`;
    toast.success(created.github ? `${made}, and published at ${created.github}` : made);
    if (created.githubProblem) toast.error(`Not published to GitHub: ${created.githubProblem}`);
    if (created.linkProblem) toast.error(created.linkProblem);
    // The folder is open: its specs are drafted from here on, in the
    // background, and the pill in the sidebar's corner says how far it is.
    if (!folders.some((f) => f.draft)) return;
    try {
      const res = await fetch("/api/extract/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The project is named: a folder that was there may describe others too.
        body: JSON.stringify({
          folders,
          codeDir,
          specsDir: created.dir,
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          // And the project's tests linked to the scenarios, once they are drafted.
          ...(linkTests ? { tests: true } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(`The specs are not being drafted: ${data.error ?? `HTTP ${res.status}`}`);
      }
    } catch {
      toast.error("The specs are not being drafted: could not reach the server");
    }
    setExtractKick((k) => k + 1);
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

  // How the Specs tab opens a feature from its url (src/plugins/builtin/
  // specs/client.tsx) — a link, Back, a palette hit: published here, before
  // App's loading screen returns early, since a link is opened at start.
  provideSpecsHost({
    open: (view, opts) => {
      // Opened from the palette or Recent: "New feature" lands beside it,
      // not in a folder picked before.
      if (opts.push) setSelectedFolder(null);
      void openFeature(view.feature, {
        scenario: view.scenario ?? null,
        pane: !view.page,
        push: opts.push,
        pullProblem: opts.pullProblem ?? null,
        ...(view.terms ? { terms: view.terms } : {}),
      });
    },
  });

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
   * A tab's door — its rail icon and its `g` chord (specs/app/plugins
   * .feature.md): the tab's home view, pushed. A tab with no home view of
   * its own (Specs, "Specs is a built-in plugin") turns the sidebar to
   * itself instead, and another tab's view or an app page leaves for the
   * README; the tab's own open view stays.
   */
  const openTab = (tab: TabPlugin) => {
    if (tab.route.home !== null) {
      void openPluginView(tab.id, tab.route.home, { push: true });
      return;
    }
    selectSidebarTab(tab.id);
    if (appPage || (pluginView && pluginView.tab !== tab.id)) {
      goHome();
      void loadReadme();
    }
  };

  /**
   * Open a view of a plugin's tab (specs/app/plugins.feature.md) — the Tests
   * tab, say. The pane is the module's alone, so the feature and the page
   * leave — saving what their editors hold, the way goHome does — and the
   * sidebar turns to that tab. The view owns its url from here on; the tab
   * says what the url is. A view that names no one thing — `/models` — opens
   * the one the tab resolves it to; false when there is nothing to open.
   */
  const openPluginView = (tab: string, view: unknown, opts: OpenViewOptions = {}): boolean => {
    const owner = tabs.get(tab);
    if (!owner) return false;
    const resolved = owner.route.resolve ? owner.route.resolve(view) : view;
    if (resolved === null) return false;
    view = resolved;
    // A tab that loads its views itself — Specs reads the feature first —
    // takes it from here, the leaving and the url included.
    if (owner.open) return owner.open(view, opts);
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
    // The page lives in the editor column: a hidden editor would open it out
    // of sight (Updates from the version chip, Settings, Plugins…), so the
    // editor comes back, as "\" would bring it.
    if (editorHidden) {
      setEditorHidden(false);
      storeEditorHidden(false);
    }
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
  /** Project settings (src/frontend/ProjectSettingsPage.tsx): the data repo's project-settings.yaml. */
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
    // One question at a time: a read-only folder's dialog is read first.
    if (!dataDir || loading || needsRepo || outdated || demo || readOnly || hosted || modalOpen || readOnlyDialogOpen) return;
    if (cloneOffered.current.has(dataDir)) return;
    cloneOffered.current.add(dataDir);
    void offerClonesRef.current();
  }, [dataDir, loading, needsRepo, outdated, demo, readOnly, hosted, modalOpen, readOnlyDialogOpen]);
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
  /** Whether the open folder's write access is known — or not asked for here at all. */
  const repoAccessSettled =
    !dataDir || repoAccessFor === dataDir || readOnly || demo || needsRepo || codeRepoDir !== null;
  /** Whether Sync shows the failing push: not in a read-only folder, nor before its answer is in. */
  const pushFailing = syncProblem !== null && repoReadOnly === null && repoAccessSettled;
  const announceSyncProblem = (reason: string) => {
    if (syncProblemToast.current !== null) toast.dismiss(syncProblemToast.current);
    // A credential problem is fixed in Settings; the hosted app's token
    // lives on the account page instead, which the message itself names.
    // So is a commit that could not be signed (src/server/git/signing.ts).
    const settingsFixIt = !hosted && /authentication required|sign in with GitHub|Signed commits/i.test(reason);
    syncProblemToast.current = toast.error(
      syncProblemMessage(reason),
      settingsFixIt ? { action: { label: "Open Settings", run: () => openSettingsAt("settings-git") } } : undefined,
    );
  };
  const announceSyncProblemRef = useRef(announceSyncProblem);
  announceSyncProblemRef.current = announceSyncProblem;
  useEffect(() => {
    // A read-only folder's dialog and chip already say why nothing is
    // pushed from it, in fewer and kinder words than a push's error.
    if (syncProblem !== null && repoReadOnly !== null) {
      if (syncProblemToast.current !== null) toast.dismiss(syncProblemToast.current);
      syncProblemToast.current = null;
      return;
    }
    // A folder that just opened may yet turn out read only: its push
    // problem waits for the remote's answer rather than flashing up first.
    if (syncProblem !== null && !repoAccessSettled) return;
    if (syncProblem !== null) {
      announceSyncProblemRef.current(syncProblem);
      return;
    }
    if (syncProblemToast.current === null) return;
    toast.dismiss(syncProblemToast.current);
    syncProblemToast.current = null;
    toast.success("Saved changes pushed");
  }, [syncProblem, repoReadOnly, repoAccessSettled]);

  // A spec folder that cannot be pushed to opens read only (git-operations.md
  // "a spec folder that cannot be pushed to opens read only"): when a folder
  // opens the remote is asked, and the page waits for its answer, so the
  // dialog comes up with the folder rather than a tick later. The listing
  // keeps the answer current after that.
  useEffect(() => {
    setRepoReadOnly(null);
    setRepoAccessFor(null);
    if (!dataDir || readOnly || demo || needsRepo || codeRepoDir !== null) return;
    let live = true;
    void fetch("/api/repo-access")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { readOnly?: unknown } | null) => {
        if (live && data) setRepoReadOnly(parseRepoReadOnly(data.readOnly));
      })
      .catch(() => {})
      // Answered or not, the folder's other news need wait no longer.
      .finally(() => {
        if (live) setRepoAccessFor(dataDir);
      });
    return () => {
      live = false;
    };
  }, [dataDir, readOnly, demo, needsRepo, codeRepoDir]);
  // The folders whose read-only dialog was shown on this page: once each,
  // and again only after the folder could be edited in between.
  const readOnlyAnnounced = useRef(new Set<string>(readOnlyAnnouncedStored()));
  useEffect(() => {
    if (!dataDir) return;
    if (repoReadOnly === null) {
      // Gone read-write: said once, and only of an answer about this folder.
      if (repoAccessFor === dataDir && readOnlyAnnounced.current.delete(dataDir)) {
        storeReadOnlyAnnounced(readOnlyAnnounced.current);
        setReadOnlyDialogOpen(false);
        toast.success(`${repoDisplayName(dataRepo ?? dataDir)} can be edited again`);
      }
      return;
    }
    // Shown once whatever dialog is up has been answered.
    if (readOnlyAnnounced.current.has(dataDir) || modalOpen) return;
    readOnlyAnnounced.current.add(dataDir);
    storeReadOnlyAnnounced(readOnlyAnnounced.current);
    setReadOnlyDialogOpen(true);
  }, [repoReadOnly, dataDir, modalOpen, repoAccessFor]);
  const checkRepoAccessAgain = async (): Promise<RepoReadOnly | null> => {
    try {
      const res = await fetch("/api/repo-access", { method: "POST" });
      const data = (await res.json()) as { readOnly?: unknown };
      const next = res.ok ? parseRepoReadOnly(data.readOnly) : repoReadOnly;
      // Unlocked with commits an earlier push left behind: a sync pushes
      // them now, before the page lets go of the lock — rather than the
      // old push error showing until the next tick.
      if (next === null && currentSyncProblem() !== null) {
        await fetch("/api/reload", { method: "POST" }).catch(() => null);
        await refreshViewRef.current().catch(() => {});
      }
      setRepoReadOnly(next);
      return next;
    } catch {
      return repoReadOnly;
    }
  };
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
    // Specs too ("Specs is a built-in plugin"): switched off while a
    // feature has the pane, the feature leaves for home.
    if (pluginView && !barTabs.some((t) => t.id === pluginView.tab) && !isRemounting(pluginView.tab)) {
      goHome();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barTabs]);

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
    // The stream also says when a peer's edit arrived over live sync
    // (specs/datastore/automerge-store.feature.md): the view is re-read then,
    // by the rules of the timed refresh, not up to a minute later. Edits that
    // arrive together — a peer catching up — share one re-read.
    const showPeerEdits = coalesced(() => refreshViewRef.current(), PEER_EDIT_REFRESH_MS);
    const unwatch = watchPluginChanges(
      () => {
        // A change is also an agent's sign-in moving on: its models and the
        // pane header's account chip are asked for again.
        void refreshPlugins();
        void agentChat.reloadChoices();
      },
      () => showPeerEdits(),
    );
    return () => {
      showPeerEdits.cancel();
      unwatch();
    };
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
      // A feature's url is the Specs tab's (src/plugins/builtin/specs/route
      // .ts): with Specs off it matches nothing and reads as home.
      if (!openPluginView(pluginHit.tab.id, pluginHit.view, { pullProblem })) goHome();
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

  // What the current selection sends to a session. Selections can outlive
  // the list (a checked spec deleted elsewhere, a scenario replaced by a new
  // version) — only specs and scenarios still listed go in.
  // With nothing checked, the scenarios picked in the tree, the open
  // scenario, or the open feature stand in (sessionSelection).
  const sessionFiles = (): { fileName: string; scenarios?: ScenarioPick[] }[] => {
    const picks: { file: string; row: ScenarioRow }[] = [];
    if (!locked && treePicks.size > 0) {
      for (const f of features) {
        for (const row of scenarioRows(f, selected, feature)) {
          if (treePicks.has(treeScenarioKey(f.fileName, row))) picks.push({ file: f.fileName, row });
        }
      }
    }
    return sessionSelection({
      checked: checkedSessionFiles(),
      treePicks: picks,
      openFeature: selected && feature ? selected : null,
      openScenario: paneScenario,
    });
  };

  /** The specs and scenarios checked for a session, still listed. */
  const checkedSessionFiles = (): { fileName: string; scenarios?: ScenarioPick[] }[] => {
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
  /** The sidebar's "Selected:" note: what was checked, not what stands in. */
  const checkedLabel = describeSelection(checkedSessionFiles());
  // What a session would run over, counted: the Start session button is
  // off at zero (nothing checked, picked or open).
  const sessionCount = sessionFiles().length + sessionBundle().count;

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
  // The fetch starts in the click's own turn and the clipboard is handed it
  // straight away (copyWhenReady): Safari copies only during the click.
  /** The prompt a session would run, on its way; `cloud` for Claude Code on the web. */
  const fetchSessionPrompt = (
    name: string,
    files: { fileName: string; scenarios?: ScenarioPick[] }[],
    attachments: Record<string, string[]>,
    cloud = false,
  ): Promise<string> =>
    fetch("/api/agent/session/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, files, attachments, ...(cloud ? { cloud: true } : {}) }),
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not build the prompt");
      return data.prompt as string;
    });

  const copySessionPrompt = async (
    name: string,
    files: { fileName: string; scenarios?: ScenarioPick[] }[],
    attachments: Record<string, string[]>,
  ) => {
    setSessionRunning(true);
    setSessionNotice(`Building the prompt for "${name}"…`);
    const prompt = fetchSessionPrompt(name, files, attachments);
    try {
      if (!(await copyWhenReady(prompt))) {
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

  // Claude Code on the web (src/frontend/claudeWeb.ts): nothing runs here —
  // the person's own browser opens claude.ai/code with the prompt in the
  // link, and the prompt is copied too, to paste when it is too long for
  // one. Everything up to startClaudeWebSession happens in the click's own
  // turn, which is when a browser lets a tab open and a copy start.
  const openClaudeWebSession = async (
    name: string,
    files: { fileName: string; scenarios?: ScenarioPick[] }[],
    attachments: Record<string, string[]>,
  ) => {
    const env = claudeWebEnv(navigator.userAgent);
    const started = startClaudeWebSession({
      prompt: fetchSessionPrompt(name, files, attachments, true),
      copy: copyWhenReady,
      openPending: () => openPendingTab(),
      openUrl: openWebLink,
      ...env,
    });
    setSessionRunning(true);
    setSessionNotice(`Building the prompt for "${name}"…`);
    try {
      const outcome = await started;
      setSessionNotice(<ClaudeWebNote outcome={outcome} desktop={env.desktop} onCopy={copyClaudeWebPrompt} />);
      // A prompt that went nowhere leaves the selection to try again with.
      if (outcome.kind !== "copy") setSpecSelection(new Map());
    } catch (e) {
      setSessionNotice(null);
      setSessionError((e as Error).message);
    } finally {
      setSessionRunning(false);
    }
  };

  /** The note's "Copy prompt": the prompt is in hand, so this click can copy it; the link is then theirs to click. */
  const copyClaudeWebPrompt = async (prompt: string) => {
    if (!(await copyText(prompt))) {
      setSessionNotice(null);
      setSessionError("Could not copy the prompt to the clipboard.");
      return;
    }
    setSessionNotice(
      <ClaudeWebNote
        outcome={{ kind: "link", url: CLAUDE_CODE_WEB_URL, paste: true }}
        desktop={claudeWebEnv(navigator.userAgent).desktop}
        onCopy={copyClaudeWebPrompt}
      />,
    );
    setSpecSelection(new Map());
  };

  // The hosted app (specs/app/hosted-app.feature.md) runs no agent and keeps
  // no agent's API key: its session button sends the prompt for the checked
  // specs and scenarios — or the open feature — to Claude Code on the web at
  // once, with no dialog, in a tab of the person's own browser.
  const openHostedSession = () => {
    if (sessionRunning) return;
    if (!codeGen) {
      toast.info("Code generation is switched off in Settings.");
      return;
    }
    const { attachments, count } = sessionBundle();
    const pick = hostedSessionPick({ picked: sessionFiles(), bundled: count, openFeature: selected });
    if ("hint" in pick) {
      toast.info(pick.hint);
      return;
    }
    void openClaudeWebSession(defaultSessionName(), pick.files, attachments);
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
    // With a code repo named in project-settings.yaml the session runs
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
    // run — to paste into an agent the app doesn't drive. Claude Code on the
    // web needs nothing installed either: the browser opens it with the
    // prompt, and the work runs in the cloud.
    const choices = [
      {
        value: CLIPBOARD_TARGET,
        label: "Copy prompt to clipboard",
        hint: `Copies the prompt for ${repoWord} — paste it into any agent`,
        confirmLabel: "Copy prompt",
      },
      {
        value: CLAUDE_WEB_TARGET,
        label: CLAUDE_WEB_LABEL,
        hint: "Opens claude.ai in your browser with the prompt — runs in the cloud, on the GitHub repository you pick there",
        confirmLabel: "Open Claude Code",
      },
      ...agentChoices,
    ];
    // The agent a session falls back on here; with none installed, the
    // clipboard — which is also what the dialog then opens on.
    const only = (agentChoices[0]?.value ?? CLIPBOARD_TARGET) as CodeGenTarget;
    const dialog = {
      title: "Name the session",
      // With a choice of agents each option says what it runs, so the hint
      // names none of them; with only one, it names that one's agent.
      hint:
        agentChoices.length === 0
          ? `Builds a prompt over ${describeSelection(files)}${where} to copy, or to open in ${CLAUDE_WEB_LABEL} — no coding agent found to run it here.`
          : `Runs ${agentChoices.length > 1 ? "the chosen agent" : only === "desktop" ? "Claude" : (agents.find((a) => a.id === only)?.label ?? only)} over ${describeSelection(files)}${where}, or copies the prompt.`,
      initial: defaultSessionName(),
      placeholder: "e.g. implement billing quotes",
      confirmLabel: "Start AI Session",
    };
    // "Run in" opens on the remembered target; one that is not on offer
    // here (no agent installed, none chosen) leaves it on the first, the
    // clipboard. The hint only makes sense over a selection.
    const opts: PromptOptions = { ...dialog, choicesLabel: "Run in", choices, initialChoice: sessionTarget };
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
    if (choice === CLAUDE_WEB_TARGET) {
      // Started before anything else: the tab opens in the click's own turn.
      const opening = openClaudeWebSession(sessionName, files, attachments);
      // Remembered, so the next dialog opens on the same choice.
      if (codeGenTarget !== CLAUDE_WEB_TARGET) void patchSettings({ codeGenTarget: CLAUDE_WEB_TARGET });
      await opening;
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

  /** Open the Start session dialog — every entry point lands here; the hosted app opens Claude Code on the web instead. */
  const startSession = () => (hosted ? openHostedSession() : setStartDialog(true));

  /**
   * Start a pomodoro: one click, no dialog and no name. Called straight from
   * the click or the key, which is also what unlocks the sound.
   */
  const startPomodoro = () => {
    pomodoro.start();
    toast.success("Pomodoro started");
  };

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
      if (stillFailing !== null && currentRepoReadOnly() === null) announceSyncProblemRef.current(stillFailing);
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
  // project-settings.yaml, and every feature file rewritten on the spot.
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

  // The scenario as last saved into the feature: what a delete removes, and
  // what the Draft checkbox is locked against — neither follows the dialog's
  // unsaved edits.
  const savedEntry =
    editing !== null && editing.index !== null ? (feature?.scenarios[editing.index] ?? null) : null;

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
    extractOpen !== null ||
    publishOpen ||
    linkTestsOpen ||
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
    if (extractOpen !== null) return setExtractOpen(null);
    if (publishOpen) return setPublishOpen(false);
    if (linkTestsOpen) return setLinkTestsOpen(false);
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
  // What the Specs tab's `c` and its own commands read (src/plugins/
  // builtin/specs/client.tsx), published before they are read below.
  provideSpecsHost({
    createFeature: () => void createFeature(),
    // Imports into the selected spec folder (specs/external-links/aha-import
    // .feature.md, OpenSpec's likewise), while their switches are on.
    shortcuts: [
      {
        id: "import-aha",
        keys: [],
        label: selectedFolder ? `Import from Aha! into "${selectedFolder}"…` : "Import from Aha!…",
        group: "Create",
        inFields: false,
        reveal: false,
        icon: <Import size={14} />,
        when: () => ahaImport && editing === null,
        run: () => setAhaImportOpen({ folder: selectedFolder }),
      },
      {
        id: "import-openspec",
        keys: [],
        label: selectedFolder ? `Import from OpenSpec into "${selectedFolder}"…` : "Import from OpenSpec…",
        group: "Create",
        inFields: false,
        reveal: false,
        icon: <Import size={14} />,
        when: () => openSpecImport && editing === null,
        run: () => setOpenSpecImportOpen({ folder: selectedFolder }),
      },
    ],
    createInView: editing
      ? { label: "New scenario after this one", run: canAddAfter ? () => void newScenarioAfterCurrent() : null }
      : onFeaturePage
        ? { label: "New scenario", run: () => void newScenario() }
        : null,
  });
  // `c` (specs/app/plugins.feature.md): what the open view makes — a
  // scenario on a feature's page — else the shown tab's own "new": a
  // feature from the tree, a task from the Tasks tab, a case from Tests.
  // Quiet on a tab with none.
  const viewCreate = pluginView && activeTab?.create?.inView ? activeTab.create.inView(pluginView.view) : null;
  const shownCreate = barTabs.find((tab) => tab.id === shownTab)?.create;
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
    // Each tab has its own `g` chord (specs/app/plugins.feature.md) — `g s`
    // turns the sidebar to the tree, `g r`, `g t` and `g n` open the special
    // folders on their first page. Only while the tab is on: a folder may
    // have it switched off, and a code repository shows the Files tab alone
    // (specs/app/code-repo-mode.feature.md). A tab with nothing to open (an
    // empty folder) has no chord.
    ...barTabs
      .filter((tab) => tab.shortcut)
      .map(
        (tab): Shortcut => ({
          id: `go-${tab.id}`,
          keys: tab.shortcut!,
          label: `Go to the ${tab.title.toLowerCase()}`,
          group: "Navigate",
          when: () => !quiet && tabReachable(tab),
          palette: () => !quietBehindPalette && tabReachable(tab),
          run: () => openTab(tab),
        }),
      ),
    // ...and the keys a tab adds of its own (⇧⌘F, search in files): the
    // sidebar shows the tab first, whatever it showed and however it was put
    // away.
    ...barTabs.flatMap((tab) =>
      (tab.shortcuts ?? []).map(
        (s): Shortcut => ({
          id: s.id,
          keys: s.keys,
          label: s.label,
          group: s.group ?? "Navigate",
          inFields: s.inFields ?? true,
          when: () => !quiet && (s.when?.() ?? true),
          palette: () => !quietBehindPalette && (s.when?.() ?? true),
          run: () => {
            if (s.reveal !== false) {
              selectSidebarTab(tab.id);
              if (compact) setDrawerOpen(true);
              else if (sidebarCollapsed) toggleSidebar();
            }
            s.run();
          },
        }),
      ),
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
      label: viewCreate?.label ?? shownCreate?.label ?? "New",
      group: "Create",
      when: () => !quiet && (viewCreate ? viewCreate.run !== null : shownCreate !== undefined),
      palette: () => !quietBehindPalette && (viewCreate ? viewCreate.run !== null : shownCreate !== undefined),
      run: () => {
        if (viewCreate) viewCreate.run?.();
        // The shown tab's own "new": never a feature from the Tasks tab.
        else shownCreate?.run(tabApp, navigateIn(shownTab));
      },
    },
    {
      id: "extract-specs",
      keys: [],
      label: codeRepoDir !== null ? "Extract specs from this project…" : "Extract specs from a code project…",
      group: "Create",
      when: () => !quiet && extractSpecs && editing === null,
      palette: () => !quietBehindPalette && extractSpecs && editing === null,
      run: () => setExtractOpen({ codeDir: codeRepoDir }),
    },
    {
      id: "link-tests",
      keys: [],
      label: "Link tests to specs…",
      group: "Create",
      when: () => !quiet && canLinkTests && editing === null,
      palette: () => !quietBehindPalette && canLinkTests && editing === null,
      run: () => setLinkTestsOpen(true),
    },
    {
      id: "publish-folder",
      keys: [],
      label: "Publish this folder to GitHub…",
      group: "Create",
      when: () => !quiet && extraction.status?.published === false && editing === null,
      palette: () => !quietBehindPalette && extraction.status?.published === false && editing === null,
      run: () => setPublishOpen(true),
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
    : locked
      ? allShortcuts.filter((x) => !WRITES_SPECS.test(x.id))
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
    // A specification folder for a code project, drafted from its code
    // (specs/app/extract-specs-from-code.feature.md); and, for a folder made
    // on this computer only, its repository on GitHub.
    shortcutAction("extract-specs", <Sparkles size={14} />),
    shortcutAction("link-tests", <Sparkles size={14} />),
    shortcutAction("publish-folder", <Import size={14} />),
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
    ...(codeGen && sessionCount > 0 && !sessionRunning
      ? [action("session", hosted ? "Open Prompt in Claude Code" : "Start AI Session", <StartSessionIcon size={14} />, () => startSession())]
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
    shortcutAction("go-home", <Home size={14} />),
    // The plugins' tabs: the way there, and each tab's own commands —
    // "New notebook entry" among them (specs/app/engineering-notebook
    // .feature.md), since the tab's own button is a tab away.
    ...barTabs.flatMap((tab) => [
      shortcutAction(`go-${tab.id}`, <tab.icon size={14} />),
      ...(tab.shortcuts ?? []).map((s) => shortcutAction(s.id, s.icon ?? <Search size={14} />)),
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
    .filter((x) => (readOnly ? READ_ONLY_PALETTE.test(x.id) : !locked || !WRITES_SPECS.test(x.id)));

  const resolvePalette = async (q: string, signal: AbortSignal): Promise<PaletteItem[]> => {
    // The tab on screen searches its own data when it offers a search — its
    // store (the server's full-text index knows only markdown), or its own
    // scope of that index (a special folder's pages); else the tab that
    // searches for every other (Specs: the spec files). With none of them
    // on, the palette offers commands alone.
    const shown = barTabs.find((tab) => tab.id === shownTab);
    const owner = shown?.palette?.search
      ? shown
      : barTabs.find((tab) => tab.palette?.fallback && tab.palette.search);
    const search = owner?.palette?.search;
    if (!owner || !search) return [];
    const { group } = owner.palette!;
    const Icon = owner.icon;
    return (await search(q, signal)).map(
      (hit): PaletteItem => ({
        id: hit.id,
        group: hit.group ?? group,
        label: hit.label,
        text: hit.label,
        sub: hit.sub,
        icon: hit.icon ?? <Icon size={14} />,
        href: hit.href,
        run: ({ alt }) =>
          void openPluginView(owner.id, alt && hit.altView !== undefined ? hit.altView : hit.view, { push: true }),
      }),
    );
  };
  // A view is offered while its tab is on — a page of a folder switched off
  // since is not, nor a feature while Specs is off. The tab says how it
  // shows now (a scenario's status, say); the stored name is the fallback.
  const recentItems: PaletteItem[] = recent.flatMap((e): PaletteItem[] => {
    const owner = barTabs.find((t) => t.id === e.tab);
    const view = owner?.route.match(e.fileName) ?? null;
    if (!owner || view === null) return [];
    const live = owner.recent?.(view) ?? null;
    const item = typeof live === "object" ? live : null;
    return [
      {
        id: `recent:${e.kind}:${e.fileName}:${e.scenario?.name ?? ""}@${e.scenario?.version ?? 0}`,
        group: "Recent",
        label: item?.label ?? (typeof live === "string" ? live : e.name),
        text: item?.label ?? (typeof live === "string" ? live : e.name),
        sub: item ? item.sub : owner.title,
        icon: item?.icon ?? <owner.icon size={14} aria-hidden="true" />,
        href: e.fileName,
        run: ({ alt }) =>
          void openPluginView(owner.id, alt && item?.altView !== undefined ? item.altView : view, { push: true }),
      },
    ];
  });
  // Remember what is open, for the palette's empty state.
  useEffect(() => {
    if (loading) return;
    let entry: RecentEntry | null = null;
    if (pluginView && activeTab?.recent) {
      // A view the tab says is worth remembering — a feature, a scenario, a
      // page — by its url, so it reopens the way a link to it would.
      const shown = activeTab.recent(pluginView.view);
      if (shown !== null) {
        entry = {
          kind: "plugin",
          fileName: activeTab.route.path(pluginView.view),
          name: typeof shown === "string" ? shown : shown.label,
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
    readOnly: locked,
  };
  // The way back into a module (src/plugins/client/tabs.ts featureCrumbs): a
  // feature holding an Event Model slice's scenarios carries a crumb naming
  // the model, say, that opens its canvas. None while the module is off.
  const pluginCrumbs = (fileName: string): Crumb[] =>
    barTabs.flatMap((tab) =>
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

  const treePicksCount = locked ? 0 : pickedTreeScenarios().length;

  // Also while a window opens the folder it was opened for, so that it goes
  // from this to the folder with no first-run screen between. A question
  // on the way — make a missing folder? — is the app's own dialog.
  const openingFolder = needsRepo && !showsFirstRun(needsRepo, openingOwnFolder);
  if (loading || openingFolder)
    return (
      <>
        <main className="layout skeleton-shell" aria-busy="true" aria-label={loading ? "Loading" : "Opening the folder"}>
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
        {openingFolder && modal}
      </>
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
  // wrote; nothing else is shown until the user updates.
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
      />
    );

  if (needsRepo) {
    // The hosted app and the demo keep their single field: a GitHub url on
    // the one, the pinned dataset on the other.
    const folderForm = (
      <>
        <p>
          {hosted
            ? "Enter the GitHub url of your specs repository:"
            : "Enter the path to the spec data directory:"}
        </p>
        {/* Hosted mode (src/server/hostedMode.ts): a GitHub repository
            only, reached through what the account page holds: the GitHub
            account the person connected, or the token they pasted. */}
        {hosted && !auth?.signedIn && (
          <p className="hint">
            {hostedGithubApp ? (
              <>
                First <a href="/account">connect GitHub</a>, and install the SpecDriven app on the repository.
              </>
            ) : (
              <>
                First <a href="/account">add a GitHub token</a> that can read and write it.
              </>
            )}
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
        {hosted && auth?.signedIn && hostedCloneHint(repoError, hostedGithubApp) && (
          <p className="hint">
            {hostedCloneHint(repoError, hostedGithubApp)} <a href="/account">Open your account page</a>.
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
            // A code project to extract specs from opens as a code
            // repository first, and the dialog then starts on it
            // (specs/app/extract-specs-from-code.feature.md).
            if (startChoice === "extract") return void startExtract(input);
            // One field for both kinds of folder: what is inside says which
            // (specs/ui/app-start.feature.md).
            void openStartFolder(input);
          }}
        >
          <h1>SpecDriven</h1>
          {hosted || demo ? (
            folderForm
          ) : (
            <>
              <p>No folder is open yet. Where is your work?</p>
              <div className="issue-filter start-choice" role="radiogroup" aria-label="Where the folder is">
                {(canOpenCodeRepo ? (["folder", "clone", "extract"] as const) : (["folder", "clone"] as const)).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={startChoice === choice}
                    className={startChoice === choice ? "active" : ""}
                    onClick={() => {
                      setStartChoice(choice);
                      setRepoError(null);
                      setKindQuestion(null);
                    }}
                  >
                    {choice === "folder"
                      ? "Open a folder on this computer"
                      : choice === "clone"
                        ? "Clone from GitHub"
                        : "Extract specs from code"}
                  </button>
                ))}
              </div>
              {startChoice === "folder" ? (
                canOpenCodeRepo ? (
                  /* A specification folder or a code repository, told apart
                     by what is inside; the folders opened before are a
                     click away on the field. */
                  <StartFolderField
                    inputRef={repoInputRef}
                    recent={recentFolders}
                    busy={settingRepo}
                    error={repoError}
                    question={kindQuestion}
                    onPickRecent={(folder) => {
                      pickedRecent.current = folder;
                      setKindQuestion(null);
                      setRepoError(null);
                    }}
                    onEdit={() => {
                      pickedRecent.current = null;
                      if (kindQuestion) setKindQuestion(null);
                    }}
                    onBrowse={canChooseFolder ? () => void browseIntoRepoInput("folder") : undefined}
                    onAnswer={(kind) => void openStartFolder(kindQuestion?.open ?? "", kind)}
                  />
                ) : (
                  folderForm
                )
              ) : startChoice === "extract" ? (
                <>
                  <p>
                    Enter the path to a code project. Its modules are proposed as folders for its specifications,
                    which get a new folder beside the project.
                  </p>
                  <div className="input-row">
                    <input
                      ref={repoInputRef}
                      name="repo"
                      placeholder="/path/to/project"
                      aria-label="Code project folder"
                      autoFocus
                    />
                    {canChooseFolder && (
                      <button type="button" className="browse" onClick={() => void browseIntoRepoInput("code-repo")}>
                        Browse…
                      </button>
                    )}
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={settingRepo}>
                    {settingRepo ? "Opening…" : "Analyse this project"}
                  </button>
                  <p className="hint">Java, JavaScript, TypeScript and Python projects are read. Nothing is written into the project.</p>
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
        {/* The questions this screen asks — make a missing folder, set up an
            empty specs- one — are the app's own dialogs. */}
        {modal}
      </main>
    );
  }

  const editingPublished = editing?.scenario.status === "published";
  // Delete applies to [proposed] scenarios and to drafts
  // (specs/ui/ui.feature.md "Scenario editor") — not to a scenario that isn't
  // part of the feature yet (index === null; a new one autosave has already
  // placed does have an index, and can be deleted). Published ones are
  // immutable, unless deletion is turned on in Settings
  // (specs/editor/spec-editor.feature.md "Delete Published Spec").
  const editingDeletable =
    savedEntry !== null && (savedEntry.status !== "published" || deletePublished);

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
      actions={<span className="app-page-status">Saved to .specdriven/settings.yaml as you change it</span>}
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
        {/* Hosted mode: GitHub is set up on the gateway's account page. With
            the service's GitHub App the account is connected there and this
            app is handed an hour's token per repository; without it a token
            is pasted there, stored encrypted, and handed over on start. */}
        <div className="settings-row auth-section">
          <span className="auth-title">GitHub account</span>
          <p className="hint">
            {auth?.signedIn && hostedGithubApp ? (
              <>
                Connected as <strong>{auth.login}</strong> on your account page.
              </>
            ) : auth?.signedIn ? (
              <>
                Using the token for <strong>{auth.login}</strong> from your account.
              </>
            ) : hostedGithubApp ? (
              <>GitHub is not connected yet — connect it to open and publish your specs repository.</>
            ) : (
              <>No GitHub token yet — add one to open and publish your specs repository.</>
            )}
          </p>
          <div className="auth-row">
            <a className="secondary" href="/account">
              {hostedGithubApp ? "Manage GitHub and agent keys" : "Manage GitHub token and agent keys"}
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
        {/* Signed commits (specs/app/user-info-settings.feature.md "Signed
            commits"): whether the app signs the open folder's commits, and
            the passphrase of the SSH key that signs them. */}
        <SignedCommits
          signing={settingsPayload.commitSigning}
          passphraseKept={settingsPayload.signingPassphrase === true}
          onPassphraseKept={(kept) => setSettingsPayload((p) => ({ ...p, signingPassphrase: kept }))}
        />
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
              that document — leave it off to keep specs in the git repo only. An
              address with {"{repo}"} in it, such as wss://sync.example.com/{"{repo}"},
              names a SpecDriven sync server that keeps a separate server for each data
              repository and lets in only people who can push to it: your GitHub access
              is sent to that server to prove it.
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
        {/* specs/external-links/qtest-test-cases.feature.md "One qTest token is
            kept on this device": the token that lets a feature's
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
            of the open data folder, kept in its project-settings.yaml —
            the app records who created and last updated every feature and
            scenario either way; this decides whether the markdown says so. */}
        {authorsInMarkdown !== null && (
        <label className="settings-row">
          <span className="settings-row-label">
            Write authors into feature files
            <span className="settings-row-hint">
              {authorsInMarkdown
                ? "Each feature and scenario in this data folder carries “Created by” and “Updated by” lines (authors-in-markdown in its project-settings.yaml)."
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
                ? "The feature page offers an “Assigned” dropdown of the members listed in the data folder's project-settings.yaml."
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

  // "Log out" (specs/app/user-info-settings.feature.md "log out from the
  // user menu"): the server forgets the app's GitHub token and closes the
  // folder; a fresh load then opens on the first-run screen — a folder, or a
  // clone with a token — with nothing of the old folder left in the page.
  const logOut = async () => {
    setDrawerOpen(false);
    const res = await fetch("/api/logout", { method: "POST" }).catch(() => null);
    if (res?.ok) {
      window.location.assign("/");
      return;
    }
    // A failed log out still leaves for the first-run screen, which says
    // what went wrong — the menu that offered it is gone by now.
    const body = res ? ((await res.json().catch(() => null)) as { error?: string } | null) : null;
    setRepoError(`Could not log out: ${body?.error ?? (res ? `HTTP ${res.status}` : "the app did not answer")}`);
    setNeedsRepo(true);
  };
  const logOutItem: MenuItem = {
    id: "log-out",
    label: "Log out",
    icon: <LogOut size={13} />,
    onSelect: () => void logOut(),
  };

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
            // The desktop and local app's own GitHub sign-in: switch to
            // another account's token while signed in, and log out — always
            // offered, unlike the browser sign-in behind the GitHub account
            // switch. Signing in is the first-run screen's, where log out
            // leads.
            ...accountMenuEntries({ hosted, demo, signedIn: auth?.signedIn === true }).map(
              (entry): MenuItem =>
                entry === "log-out"
                  ? logOutItem
                  : {
                      id: "switch-account",
                      label: "Switch account…",
                      icon: <KeyRound size={13} />,
                      onSelect: () => {
                        setDrawerOpen(false);
                        setTokenSignInOpen(true);
                      },
                    },
            ),
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
  const specsSidebarProps: SpecsSidebarProps = {
    agents,
    ahaImport,
    assignments,
    attributeDefs,
    barTabs,
    clearTreePicks,
    cloneTreeScenario,
    codeGen,
    confluenceEnabled,
    copyLink,
    createFeature,
    createFeatureIn,
    createFolder,
    createFolderIn,
    deletePickedScenarios,
    deletePublished,
    deleteTreeScenario,
    dropTreeScenario,
    editFeatureDisplayName,
    editFolderDisplayName,
    endScenarioDrag,
    feature,
    filtering,
    folderMenuKey,
    hosted,
    jiraEnabled,
    loadError,
    loadFeatures,
    locked,
    matchesFilter,
    me,
    members,
    moveFeaturePrompt,
    moveFeatureTo,
    moveFolder,
    moveFolderPrompt,
    moveFolderTo,
    moveScenarioToFeature,
    moveTo,
    moveTreeScenario,
    openConfluenceFolder,
    openFeature,
    openScenarioRow,
    openSpecImport,
    paneScenario,
    pickTreeScenario,
    removeFeature,
    removeFolder,
    renameFile,
    renameFolder,
    selected,
    selectionLabel,
    checkedLabel,
    sessionCount,
    sessionNotice,
    sessionRunning,
    sessionTarget,
    setAhaImportOpen,
    setImportOpen,
    setOpenSpecImportOpen,
    spaClick,
    specSelection,
    startSession,
    statusTotals,
    toggleFolder,
    toggleOutline,
    toggleSpecSelected,
    treePickAnchor,
    treePicksCount,
    treeRef,
  };
  const specsSidebar = <SpecsSidebar {...specsSidebarProps} />;
  // What the Specs tab's page components still call here
  // (src/frontend/specs/host.ts SpecsActions).
  const specsActions: SpecsActions = {
    backToFeature,
    scenarioLink,
    scenarioNav,
    stepScenario,
    testsTable,
    // The editor pane's.
    addTest,
    attributeDefs,
    bodyFieldRef,
    canAddAfter,
    cancelTestLookup,
    changeLinkDraft,
    changeQtestDraft,
    cloneTreeScenario,
    commitTestEdit,
    deleteScenario,
    draftVersion,
    editingDeletable,
    editingPublished,
    knownAttributes,
    nameFieldRef,
    newScenarioAfterCurrent,
    newVersion,
    proposeScenario,
    publishScenario,
    removeTest,
    savePullRequests,
    saveResourceLinks,
    saveScenarioFileList,
    savedEntry,
    startTestEdit,
    unpublishScenario,
    uploadScenarioFiles,
    // The feature page's.
    assignableMembers,
    closeDescriptionEditor,
    codeGen,
    confluenceEnabled,
    demo,
    descPaneRef,
    descSaved,
    dropTreeScenario,
    endScenarioDrag,
    hosted,
    locked,
    moveFeaturePrompt,
    moveScenarioToFeature,
    newScenario,
    openDescriptionEditor,
    openQtestPublish,
    pluginCrumbs,
    publish,
    removeFeature,
    renameDraftRef,
    renameFile,
    renameSelected,
    reorderScenario,
    saveAssigned,
    saveFeatureAttributes,
    saveFeatureFlags,
    saveFeatureQtest,
    saveFeatureTickets,
    scenarioRefs,
    sessionCount,
    sessionRunning,
    spaClick,
    startSession,
    toggleScenarioPolarityAt,
    // The dialogs'.
    agentModels,
    agents,
    ahaSites,
    confluencePublished,
    confluenceWikis,
    dismissConflict,
    jiraSites,
    markSaved,
    openObservability,
    qtestParentUrl,
    qtestPublished,
    qtestSites,
    resolveWith,
  };
  provideSpecsHost({
    sidebar: specsSidebar,
    actions: specsActions,
  });

  return (
    <main
      className={`layout${resizingSidebar || resizingAgent ? " resizing" : ""}${sidebarCollapsed && !compact ? " collapsed" : ""}${compact ? " compact" : ""}${paneShown && !compact ? " agent-open" : ""}${editorOff ? " editor-hidden" : ""}${locked ? " read-only" : ""}`}
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
          {/* The rail mirrors the sidebar's tab bar: the tabs in the
              profile's order, lit the way the bar's tabs are (shownTab) — so
              collapsing the sidebar never loses the tree. A tab with nothing
              to open — an empty folder — has no icon on the rail. */}
          {barTabs.filter(tabReachable).map((tab) => (
            <Tooltip key={tab.id} label={tab.title} keys={tab.shortcut}>
              <a
                href={tabHref(tab)}
                className={`rail-link${
                  pluginView?.tab === tab.id || (!pluginView && shownTab === tab.id) ? " active" : ""
                }`}
                aria-label={tab.title}
                onClick={(e) => spaClick(e, () => openTab(tab))}
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
            {/* The read-only site's projects (src/frontend/readOnlyProject.ts):
                where it shows more than one, the ▾ lists them by name, the
                repository as the tooltip, the visitor's ticked; picking one
                opens its home. */}
            {readOnly && readOnlyProjects.length > 1 && (
              <div className="repo-recent">
                <button
                  type="button"
                  className="ibtn repo-recent-toggle"
                  title="Projects"
                  aria-label="Projects"
                  aria-haspopup="menu"
                  aria-expanded={recentMenuOpen}
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
                  label="Projects"
                  className="repo-recent-menu"
                  containerSelector=".repo-recent"
                  items={readOnlyProjects.map(
                    (project): MenuItem => ({
                      id: `project:${project.id}`,
                      label: project.id,
                      icon: <FolderKindIcon kind="spec" size={13} />,
                      title: project.repo,
                      checked: project.id === readOnlyProject,
                      onSelect: () => {
                        if (project.id !== readOnlyProject) chooseProject(project.id);
                        else {
                          goHome();
                          void loadReadme();
                        }
                      },
                    }),
                  )}
                />
              </div>
            )}
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
                    // Another window, which asks for its folder
                    // (specs/app/multiple-windows.feature.md "Opening a
                    // window") — the desktop app's alone.
                    ...(canOpenWindows
                      ? [
                          {
                            id: "new-window",
                            label: "New window",
                            icon: <AppWindow size={13} />,
                            onSelect: () => void openInNewWindow(),
                          } satisfies MenuItem,
                        ]
                      : []),
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
                    : repoReadOnly !== null
                      ? "Sync — pull the data folder; it is read only, so nothing is pushed"
                      : pushFailing && syncProblem !== null
                      ? `${syncProblemMessage(syncProblem)}. Click to try again.`
                      : "Sync — pull the data folder and push saved changes"
                }
              >
                <button
                  type="button"
                  className={pushFailing ? "ibtn repo-sync failing" : "ibtn repo-sync"}
                  aria-label={
                    syncing
                      ? "Syncing…"
                      : pushFailing
                        ? "Sync — saved changes are not being pushed"
                        : "Sync"
                  }
                  disabled={syncing}
                  onClick={() => void syncNow()}
                >
                  {/* While pushes fail the icon itself says so, struck
                      through — the tooltip gives the reason. */}
                  {pushFailing && !syncing ? (
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
        {/* A read-only folder (src/frontend/repoReadOnly.ts) says so under
            the header for as long as it is — a line of its own, so the
            folder's name keeps its room — and the line opens the dialog
            with the reason and the way back. */}
        {repoReadOnly !== null && !readOnly && codeRepoDir === null && (
          <Tooltip label={readOnlySummary(repoReadOnly)}>
            <button type="button" className="repo-read-only" onClick={() => setReadOnlyDialogOpen(true)}>
              <Lock size={12} aria-hidden="true" />
              <span>Read only</span>
              <span className="repo-read-only-why">— why?</span>
            </button>
          </Tooltip>
        )}
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
            .md): each mounted plugin's — Specs, the feature tree, and each
            special folder the Plugins page shows among them — in the
            profile's order (specs/app/plugins.feature.md). The bar only
            shows once there is something to switch to — one tab is no tab
            bar. */}
        {barTabs.length > 1 && (
          <div className="side-tabs" role="tablist" aria-label="Sidebar">
            {/* Each tab's tooltip carries its `g` chord, as the rail's icons
                do. */}
            {barTabs.map((tab) => (
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
                    // is a list to pick from (a special folder's pages, or
                    // the feature tree).
                    if (
                      tab.opensOnSelect !== false &&
                      tab.route.home !== null &&
                      pluginViewRef.current?.tab !== tab.id
                    ) {
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
        {/* Every plugin switched off in this folder, Specs included: the
            sidebar says where they are switched on. */}
        {!loading && barTabs.length === 0 && codeRepoDir === null && (
          <p className="empty">
            No plugin is on in this folder.{" "}
            <a href="/plugins" onClick={(e) => spaClick(e, () => openAppPage("plugins"))}>
              Open Plugins
            </a>{" "}
            to switch one on.
          </p>
        )}
        {/* The shown tab's own sidebar (specs/app/plugins.feature.md) — the
            feature tree, a special folder's page list or the Tests tab's
            plans and case library, say. */}
        {barTabs
          .filter((tab) => tab.id === shownTab)
          .map((tab) => (
            <tab.Sidebar
              key={tab.id}
              view={pluginView?.tab === tab.id ? pluginView.view : null}
              app={tabApp}
              navigate={navigateIn(tab.id)}
            />
          ))}
        {/* specs/app/extract-specs-from-code.feature.md: while the open
            folder's specs are drafted from its code — and until the run is
            dismissed — a pill says how far it is. */}
        <ExtractionProgress
          extraction={extraction}
          onOpenFeature={(file) => void openFeature(file, { push: true })}
          onPublish={() => setPublishOpen(true)}
          onLinkTests={() => setLinkTestsOpen(true)}
          onError={(message) => toast.error(message)}
        />
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
             data repo's project-settings.yaml — code repos with their specs
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
            confirm={confirm}
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
              {!locked && (
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
            {readme !== null && locked && <div className="md-preview read-only-page">{renderMarkdown(readme)}</div>}
            {readme !== null && !locked && (
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
          // file the open view names (src/plugins/client/tabs.ts `current`)
          // — the open feature, or the Files tab's file, both relative to
          // the open folder. Other views and the app's pages name none.
          current={
            !appPage && pluginView && activeTab?.current ? activeTab.current(pluginView.view) : null
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
      {/* Each tab's own dialogs, whatever the pane shows (src/plugins/client/
          tabs.ts Overlay): the Specs tab's merge conflict, publish and import
          dialogs among them. */}
      {barTabs.map((tab) => tab.Overlay && <tab.Overlay key={tab.id} app={tabApp} />)}
      {publishOpen && (
        <PublishSpecsDialog
          onClose={() => setPublishOpen(false)}
          onPublished={(url) => {
            setPublishOpen(false);
            extraction.published();
            toast.success(`Published at ${url}`);
          }}
        />
      )}
      {linkTestsOpen && (
        <LinkTestsDialog
          agents={agents}
          agentModels={agentModels}
          folder={selectedFolder}
          trapRef={linkTestsTrapRef}
          onClose={() => setLinkTestsOpen(false)}
          onStarted={() => {
            setLinkTestsOpen(false);
            setExtractKick((k) => k + 1);
            toast.success("The tests are being linked in the background");
          }}
        />
      )}
      {extractOpen !== null && (
        <ExtractSpecsDialog
          codeDir={extractOpen.codeDir}
          agents={agents}
          agentModels={agentModels}
          browse={canChooseFolder ? () => chooseFolderNative("code-repo") : undefined}
          browseSpecs={canChooseFolder ? () => chooseFolderNative("data-repo") : undefined}
          // The folder that is open is the likeliest one to add to.
          openSpecFolder={codeRepoDir === null && !needsRepo ? dataRepo : null}
          trapRef={extractTrapRef}
          onClose={() => setExtractOpen(null)}
          onCreated={(result) => void afterExtract(result)}
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
                    <code>~/.specdriven/settings.yaml</code>
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
      {/* A spec folder that cannot be pushed to opens read only
          (git-operations.md, src/frontend/repoReadOnly.ts): why, and the
          way back — shown when the folder is found so, and from the
          sidebar's "Read only" chip. */}
      {readOnlyDialogOpen && repoReadOnly !== null && dataDir && (
        <ReadOnlyRepoDialog
          why={repoReadOnly}
          folder={repoDisplayName(dataRepo ?? dataDir)}
          onClose={() => setReadOnlyDialogOpen(false)}
          onCheckAgain={checkRepoAccessAgain}
          onOpenSettings={hosted ? undefined : () => openSettingsAt("settings-git")}
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
          elsewhere={otherWindowFolders}
          dirs={recentRepoDirs}
          busy={settingRepo}
          // Code repositories opened directly (specs/app/code-repo-mode
          // .feature.md "Open a code repository"), where they can be.
          codeRepos={canOpenCodeRepo}
          trapRef={foldersTrapRef}
          {...(extractSpecs
            ? {
                onExtract: () => {
                  setFoldersOpen(false);
                  setExtractOpen({ codeDir: codeRepoDir });
                },
              }
            : {})}
          {...(canLinkTests
            ? {
                onLinkTests: () => {
                  setFoldersOpen(false);
                  setLinkTestsOpen(true);
                },
              }
            : {})}
          onClose={() => setFoldersOpen(false)}
          onOpen={(folder) => {
            setFoldersOpen(false);
            void (folder.kind === "code" ? openCodeRepo(folder.path) : switchRepo(folder.path));
          }}
          onRemove={(folder) => void (folder.kind === "code" ? forgetCodeRepo(folder.path) : forgetRepo(folder.path))}
          // A window of its own for a folder, in the desktop app
          // (specs/app/multiple-windows.feature.md "Opening a window").
          {...(canOpenWindows
            ? {
                onOpenInNewWindow: (folder: FolderEntry) => {
                  setFoldersOpen(false);
                  void openInNewWindow(folder);
                },
                // A folder another window shows: asking for its window
                // brings that one forward.
                onShowWindow: (folder: FolderEntry) => {
                  setFoldersOpen(false);
                  void openInNewWindow(folder);
                },
              }
            : {})}
          onAdd={() => {
            setFoldersOpen(false);
            void changeRepo();
          }}
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

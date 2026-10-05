import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import {
  parseFeature,
  serializeFeature,
  slugify,
  sortScenarios,
  titleFromFileName,
} from "../server/parser";
import type {
  Feature,
  PullRequestLink,
  Scenario,
  ScenarioPick,
  ScenarioTarget,
} from "../server/parser";
import type { FeatureListing } from "../server/features";
import type { ProjectMember } from "../server/members";
import type { GitHubRepo } from "../server/issues";
import type { SearchResultItem } from "../server/search";
import type { CurrentUser } from "../server/user";
import type { CodeGenTarget } from "../server/state";
import { Logo } from "./Logo";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Pencil,
  Timer,
  Plus,
  RefreshCw,
  Search,
  ExternalLink,
  FileText,
  FolderInput,
  GitPullRequest,
  Home,
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
  Bot,
} from "lucide-react";
import { PublishRing, StatusIcon } from "./StatusIcon";
import { NewFeatureIcon, NewFolderIcon, StartSessionIcon } from "./ActionIcons";
import { Tooltip } from "./Tooltip";
import { Menu, type MenuItem } from "./Menu";
import { Popover } from "./Popover";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";
import { CommandPalette, type PaletteItem } from "./CommandPalette";
import { ErrorBoundary } from "./ErrorBoundary";
import { createPromiseQueue } from "./promiseQueue";
export { createPromiseQueue };

import { setShareRepo, shareUrl } from "./shareLink";
import { SaveIndicator, Toaster, toast } from "./Toasts";
import { IS_MAC, ShortcutSheet, isTypingTarget, useShortcuts, type Shortcut } from "./shortcuts";
import { MarkdownEditor } from "./MarkdownEditor";
import { applyVimPref, setVimDemoMode, useVimMode } from "./vimPref";
import {
  applyExcalidrawPref,
  setExcalidrawDemoMode,
  useExcalidrawEnabled,
} from "./excalidrawPref";
import { markText } from "./highlight";
import { PageSkeleton } from "./Skeleton";
import { useModalPrompts } from "./ModalPrompts";
import { AppPageLayout, PageSection } from "./AppPage";
import { PluginsPage } from "./PluginsPage";
import { ObservabilityPage } from "./ObservabilityPage";
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
import { entityFields } from "./entityFields";
import {
  AGENT_DEFAULT_WIDTH,
  AGENT_MIN_WIDTH,
  agentChat,
  clampAgentWidth,
  defaultSessionName,
  useAgentChat,
} from "./agentChat";
import { ExternalLinkField } from "./ExternalLinkField";
import { PullRequestField, PullRequestList } from "./PullRequestField";
import {
  EMPTY_LINK_DRAFT,
  externalLinkLabel,
  isBlankLinkDraft,
  linkDraftOf,
  resolveLinkDraft,
} from "./externallinks";
import type { LinkDraft } from "./externallinks";
import { ScenarioTable } from "./ScenarioTable";
import {
  appPagePath,
  featurePath,
  isLinkEntry,
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
import { buildTree, scenarioRows, withOpenScenarios } from "./tree";
import type { FolderNode, ScenarioRow } from "./tree";
import { useFocusTrap } from "./useFocusTrap";
import { FolderSwitchDialog, SpecFoldersDialog, type SwitchStep } from "./SpecFolders";
import type { ScenarioRef } from "./route";

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
}

/** What the GitHub CLI reports (specs/git-operations.spec.md). */
interface GhInfo {
  available: boolean;
  signedIn: boolean;
  login: string | null;
}

/** A device flow in progress: the code to enter and where to enter it. */
interface DeviceFlow {
  userCode: string;
  verificationUri: string;
  interval: number;
}

// Appearance (specs/ui.spec.md "Settings"): system, light or dark. The
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

// Live sync (specs/automerge-store.spec.md): the url the Settings field is
// pre-filled with, so turning the switch on needs no typing. Sync itself stays
// opt-in — nothing is sent anywhere until the switch is on and saved.
const DEFAULT_SYNC_SERVER_URL = "wss://sync.automerge.org";

// Autosync (specs/ui.spec.md "Settings"): the frequency the seconds field
// falls back to when the switch is turned back on. Autosync is on by default,
// so a stored 0 is the only way it is off.
const DEFAULT_AUTOSYNC_SECONDS = 60;

// Editor autosave (specs/editor-autosave.feature.md): the open editor saves
// itself every n seconds. Always on — the setting is only how often — and
// never faster than the floor, which keeps a save off the keystrokes.
// Mirrors the server's defaults in src/server/state.ts.
const DEFAULT_AUTOSAVE_SECONDS = 6;
const MIN_AUTOSAVE_SECONDS = 3;

// Project management (specs/external-links/project-management-jira-linear-
// etc.feature.md): the tool tickets live in until Settings names another, and
// the tools the Settings dropdown offers by name — anything else is typed in
// beside it. Mirrors the server's default in src/server/state.ts.
const DEFAULT_PROJECT_MANAGEMENT_TOOL = "Jira";
const PROJECT_MANAGEMENT_TOOLS = ["Jira", "Linear", "GitHub", "GitLab", "Asana", "Azure DevOps"];

// Sidebar width (specs/ui.spec.md "Sidebar resize"): dragged via the divider
// so a deep folder tree gets room. Device-local, like the theme.
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

export function clampDescHeight(h: number, windowHeight: number): number {
  // The scenario list below keeps at least a quarter of the window, so the
  // editor can never swallow the page it belongs to.
  const max = Math.max(DESC_MIN, Math.round(windowHeight * 0.75));
  return Math.min(Math.max(Math.round(h), DESC_MIN), max);
}

function readDescHeight(): number | null {
  try {
    const h = Number(localStorage.getItem("sd-desc-height"));
    // Nothing stored, or junk: the CSS default stands until a first drag.
    return Number.isFinite(h) && h >= DESC_MIN ? Math.round(h) : null;
  } catch {
    return null;
  }
}

function storeDescHeight(h: number): void {
  try {
    localStorage.setItem("sd-desc-height", String(h));
  } catch {
    // Storage unavailable (private mode): the height just won't stick.
  }
}

/** Double-click on the strip: back to the CSS default, and it stays there. */
function clearDescHeight(): void {
  try {
    localStorage.removeItem("sd-desc-height");
  } catch {
    // Storage unavailable: nothing was stored to clear.
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
 * (specs/editor-autosave.feature.md "Autosave Never Adds the Same Scenario
 * Twice").
 */
export interface EditState {
  index: number | null;
  scenario: Scenario;
  /**
   * True while the editor pane is creating a scenario, which it stays even
   * after autosave (specs/editor-autosave.feature.md) has put the scenario in
   * the feature and given `index` a value. The pane keeps its new-scenario
   * behavior for as long as it is open: retyping the name re-derives the
   * version, and the Draft checkbox stays unlocked.
   */
  isNew?: boolean;
}

/**
 * The feature as the server sent it — its parsed form, which carries each
 * scenario's document id (the markdown never does) — with its name resolved
 * the way the page shows it: the `# <name>` heading, or the file stem when
 * the heading is missing (specs/ui.spec.md "Main page"). Resolving it here
 * and not only at render time matters: every save serializes this object
 * back to the file, and a blank name would write a nameless `# ` heading
 * over the real one.
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
 * scenario one scenario through a rename (specs/editor-autosave.feature.md
 * "Autosave Never Adds the Same Scenario Twice").
 */
function scenarioTarget(s: Scenario): ScenarioTarget {
  return { name: s.name, version: s.version, id: s.id };
}

/**
 * What autosave (specs/editor-autosave.feature.md) compares to decide whether
 * the editor is holding anything new: everything a save would write, under
 * the version the dialog will save it as rather than the one on the object.
 */
export function scenarioSignature(s: Scenario, version: number): string {
  // The name as a save writes it: a stray space is nothing new to save.
  return JSON.stringify([s.name.trim(), version, s.status, s.body, s.tests, s.link ?? null]);
}

/**
 * Whether the scenario's name is still being typed — the dialog's title field
 * holds the caret (specs/editor-autosave.feature.md "Autosave Waits While the
 * Name Is Being Typed"). A tick that fires mid-word would save the half-typed
 * name as a draft, so it stands down until focus moves on.
 */
export function namingInProgress(nameField: Element | null, active: Element | null): boolean {
  return nameField !== null && nameField === active;
}

/**
 * The feature with the editor's scenario written in — over the entry the
 * editor opened on (or the one a previous save placed), or appended when it
 * has none — in canonical order, which is where its card will be. Every save
 * places the scenario this way, so the way back (specs/editor/spec-editor
 * .feature.md "Spec editor pane") can predict where to land.
 */
export function withScenario(feature: Feature, at: number | null, s: Scenario): Feature {
  return {
    ...feature,
    scenarios: sortScenarios(
      at === null ? [...feature.scenarios, s] : feature.scenarios.map((sc, i) => (i === at ? s : sc)),
    ),
  };
}

/**
 * The version a scenario takes in `feature` when its version is derived
 * (specs/ui.spec.md): one past the highest version already carrying that
 * name, or 1 when the name is new; `ignoreIndex` leaves its own entry out.
 */
export function nextVersionIn(
  feature: Feature | null,
  name: string,
  ignoreIndex?: number,
): number {
  const versions = (feature?.scenarios ?? [])
    .filter((s, i) => i !== ignoreIndex && s.name.trim() === name.trim())
    .map((s) => s.version);
  return versions.length ? Math.max(...versions) + 1 : 1;
}

/**
 * Where the editor's scenario sits on the server: the feature a save was
 * answered with, the scenario's index in it and its document id. A save
 * queued behind another places itself here rather than where the render
 * that queued it thought the scenario was.
 */
export type Placement = { feature: Feature; index: number | null; id?: string };

/**
 * The editor's scenario written into the feature at `placement`: over the
 * entry found there (or appended when there is none), adopting the document
 * id a save gave it. A `derived` version (a new scenario) is re-derived
 * against that feature with its own entry left out, or it would bump past
 * itself.
 */
export function placeScenario(
  draft: Scenario,
  { feature, index, id }: Placement,
  derived: boolean,
): { s: Scenario; next: Feature } {
  const version =
    derived || index === null ? nextVersionIn(feature, draft.name, index ?? undefined) : draft.version;
  // The name goes out trimmed, as the server parses every heading
  // (parser.ts SCENARIO_RE): the scenario the save lands is then the one
  // this save names, and the editor finds it again (landedScenario).
  const s: Scenario = { ...draft, name: draft.name.trim(), version, id: draft.id ?? id };
  return { s, next: withScenario(feature, index, s) };
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
  // Names compare trimmed, as headings parse (parser.ts SCENARIO_RE) and
  // as nextVersionIn counts them.
  const name = s.name.trim();
  const i = scenarios.findIndex((sc) => sc.name.trim() === name && sc.version === s.version);
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
 * The scenario whose page is open (specs/navigation.spec.md "URL scheme") —
 * what the address bar and the window title name. Read through the pane's
 * index into the feature, so a rename follows the scenario the moment its
 * save lands; a highlighted card is not a page, and a new scenario no save
 * has placed in the feature yet has no url of its own.
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

/**
 * Text onto the clipboard, false when neither way works. navigator.clipboard
 * needs a secure context and permission — absent e.g. on a plain-http LAN
 * host — so a selection-based copy stands in for it there.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

// Code gen sessions (specs/agents/claude.feature.md): which agent "Start
// session" runs in — a new session in Claude Code Desktop, or the app's own
// coding agent pane (specs/agents/coding-agent-ui.feature.md) with Claude,
// with Pi (specs/agents/integration-with-pi-dev-agent.feature.md) or with
// Codex (src/server/codexChat.ts).
export type { CodeGenTarget };

/** The stored target as the server reports it; anything else is "not chosen". */
export function readCodeGenTarget(value: unknown): CodeGenTarget | null {
  return value === "desktop" || value === "pane" || value === "pi" || value === "codex"
    ? value
    : null;
}

/** The session dialog's one non-agent option: copy the prompt, run nothing. */
export const CLIPBOARD_TARGET = "clipboard";

export const CODE_GEN_TARGET_LABEL: Record<CodeGenTarget, string> = {
  desktop: "Claude Code Desktop",
  pane: "Coding agent pane",
  pi: "Pi in the coding agent pane",
  codex: "Codex in the coding agent pane",
};

/** The target a session dialog opens on: the remembered choice when it is
    still usable, else desktop when Claude.app is installed, else the pane
    when the Claude CLI is. Codex and Pi are picked, never defaulted to — an
    unchosen dialog opens on one of them only where there is no Claude at
    all, Codex first. With nothing installed the answer is desktop, and the
    server says what is missing. */
export function resolveCodeGenTarget(
  stored: string | null | undefined,
  canOpenDesktop: boolean,
  canRunPane = false,
  canRunPi = false,
  canRunCodex = false,
): CodeGenTarget {
  if (stored === "desktop" && canOpenDesktop) return "desktop";
  if (stored === "pane" && canRunPane) return "pane";
  if (stored === "pi" && canRunPi) return "pi";
  if (stored === "codex" && canRunCodex) return "codex";
  if (canOpenDesktop) return "desktop";
  if (canRunPane) return "pane";
  if (canRunCodex) return "codex";
  return canRunPi ? "pi" : "desktop";
}

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

/** The sidebar's filter: features by scenario status and by assignee. */
interface TreeFilter {
  status: Scenario["status"] | null;
  assignee: string | null;
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
   * Deep-link target (specs/navigation.spec.md): select this scenario, or
   * clear the selection when null. Undefined keeps the same-file selection
   * preservation used by sync/cron refreshes.
   */
  scenario?: ScenarioRef | null;
  /**
   * Open the scenario's own page — the editor pane — on top of selecting its
   * card (specs/navigation.spec.md "open a scenario link"). Deep links do;
   * in-app navigation that merely lands on a card does not.
   */
  pane?: boolean;
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
  members: ProjectMember[];
  codeRepo: string | null;
  /** The GitHub repo the code repo pushes to — whose issues the Issues tab shows. */
  issuesRepo: GitHubRepo | null;
}

/** How many times a feature-list load tries before it reports an error, and
    the step it backs off by (1×, 2×, …). Short enough that a real outage
    still surfaces quickly, long enough to outlast a demo-mode reseed
    swapping the data directory (src/server/demo.ts reseedDemo). */
export const LOAD_RETRIES = 3;
export const LOAD_RETRY_MS = 300;

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
          members: Array.isArray(data.members) ? (data.members as ProjectMember[]) : [],
          codeRepo: typeof data.codeRepo === "string" ? data.codeRepo : null,
          issuesRepo:
            data.issuesRepo &&
            typeof data.issuesRepo === "object" &&
            typeof (data.issuesRepo as GitHubRepo).owner === "string"
              ? (data.issuesRepo as GitHubRepo)
              : null,
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

export function App() {
  const [dataRepo, setDataRepo] = useState<string | null>(null);
  // Recent folder list (specs/ui/ui.feature.md "Recent folder list"): the
  // data folders used before, most recent first, up to 10 — what the ▾
  // beside the folder name drops down.
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
  /**
   * The same two, for a link that names its spec folder
   * (`specdriven://<folder>/...`): openFromLocation runs from closures older
   * than either state — the boot effect's, the popstate listener's — so it
   * reads them here.
   */
  const reposRef = useRef<{ open: string | null; recent: string[] }>({ open: null, recent: [] });
  /**
   * Take the open folder and the recent list from an /api/state answer. The
   * open folder is also the one "Copy link" names (src/frontend/shareLink.ts).
   */
  const applyRepos = (state: { dataRepo?: string | null; recentDataRepos?: unknown }) => {
    const open = state.dataRepo ?? null;
    const recent = Array.isArray(state.recentDataRepos) ? (state.recentDataRepos as string[]) : [];
    reposRef.current = { open, recent };
    setShareRepo(open);
    setDataRepo(open);
    setRecentRepos(recent);
  };
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const [needsRepo, setNeedsRepo] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [settingRepo, setSettingRepo] = useState(false);
  // Switch spec folder (specs/app/spec-folders.feature.md): while a switch
  // runs, a modal covers the app with the folder being opened and the step
  // it is on; null between switches.
  const [switching, setSwitching] = useState<{ folder: string; step: SwitchStep } | null>(null);
  // Manage specification folders (specs/app/spec-folders.feature.md): the
  // dialog listing the folders the app knows, from the recent folders menu.
  const [foldersOpen, setFoldersOpen] = useState(false);
  // Whether the runtime offers a native folder chooser (specs/app-start.spec.md).
  const [canChooseFolder, setCanChooseFolder] = useState(false);
  // Demo mode: the data directory is a fixed ephemeral copy — everything that
  // changes or syncs it (✎, recents ▾, Sync, git/GitHub settings) hides.
  const [demo, setDemo] = useState(false);
  // The running app's version, shown beside the user name in demo mode.
  const [appVersion, setAppVersion] = useState<string | null>(null);
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
  // GitHub issues (specs/app/github-issues.feature.md): the repository the
  // code repo pushes to, when it is a GitHub one — the Issues tab shows for
  // it. Null (no code repo, or not on GitHub) means no tab.
  const [issuesRepo, setIssuesRepo] = useState<GitHubRepo | null>(null);
  /** Whether an assignment change is in flight — the dropdown waits for it. */
  const [assignedSaving, setAssignedSaving] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  /** Folder paths whose subtree is collapsed in the sidebar. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /**
   * Feature files whose scenario outline is expanded in the sidebar
   * (specs/navigation.feature.md "Scenario navigation"). Folders default to
   * open because a repo has few of them; scenario outlines are many, so they
   * default to closed and this tracks the ones opened — the mirror image of
   * `collapsed`. Kept for the session, like the folder state.
   */
  const [outlined, setOutlined] = useState<Set<string>>(new Set());
  /** Sidebar width in px (specs/ui.spec.md "Sidebar resize"). */
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  /** True while the sidebar divider is being dragged. */
  const [resizingSidebar, setResizingSidebar] = useState(false);
  /** Folder highlighted by a click; "+ New folder" creates inside it. */
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  /** File name of the feature being dragged, if any. */
  const [dragging, setDragging] = useState<string | null>(null);
  // Code gen sessions (specs/agents/claude.spec.md): specs checked in the
  // sidebar, and scenarios checked on their cards, go into a named session
  // that runs the coding agent. Per file the selection is the whole spec
  // ("all") or a set of scenario keys.
  const [specSelection, setSpecSelection] = useState<Map<string, "all" | Set<string>>>(new Map());
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
  // Full-text search (specs/search.spec.md) lives in the command palette
  // (⌘K, src/frontend/CommandPalette.tsx): open, with the text it starts on.
  const [palette, setPalette] = useState<{ query: string } | null>(null);
  /** The pages opened most recently — the palette's empty state. */
  const [recent, setRecent] = useState<RecentEntry[]>(readRecent);
  /** The header's ⋯ menu, a card's ⋯ menu (by index), the assignee chips. */
  const [featureMenuOpen, setFeatureMenuOpen] = useState(false);
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
  const [filter, setFilter] = useState<TreeFilter>({ status: null, assignee: null });
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  /** A feature is being fetched — the skeleton shows until it lands. */
  const [featureLoading, setFeatureLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [feature, setFeature] = useState<Feature | null>(null);
  /** Draft for the inline file-name editor; null while not editing. */
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState<number | null>(null);
  const scenarioRefs = useRef<(HTMLElement | null)[]>([]);
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
  // Editor autosave (specs/editor-autosave.feature.md): the signature of what
  // the open dialog last had saved, and whether a tick is still saving. Refs,
  // because a tick reads them between renders and must not cause one.
  // Scenario PUTs share a queue with the description editor's reason: a
  // folder switch must wait for a tick already on its way. A boolean
  // in-flight flag would make that wait a no-op, and the server resolves
  // the data folder per request, so the late PUT would write this scenario
  // into the folder that comes next.
  const autosaved = useRef<string | null>(null);
  /** The tick still saving, resolving to where it left the scenario — null when none is away. */
  const autosaveInFlight = useRef<Promise<Placement> | null>(null);
  const scenarioSaveQueue = useRef(createPromiseQueue());
  /** The editor pane's title field, so a tick can see whether the name is
      still being typed (specs/editor-autosave.feature.md). Null once the
      scenario is published, when the name is no longer editable. */
  const nameFieldRef = useRef<HTMLInputElement | null>(null);
  /** The ways out of the editor pane, for the handlers that leave it from
      outside the render that defines them — ESC, and every navigation away
      from the feature (specs/editor/spec-editor.feature.md "Spec editor
      pane"). Kept in a ref so they always run the current ones. `close`
      returns the last save when one went out, for a caller that must order
      itself after it. */
  const editorRef = useRef<{ close: () => Promise<boolean> | null; back: () => void }>({
    close: () => null,
    back: () => {},
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
  const [reloadSeconds, setReloadSeconds] = useState(60);
  const [previewLines, setPreviewLines] = useState(8);
  /** How often the open editor saves itself (specs/editor-autosave.feature.md). */
  const [autosaveSeconds, setAutosaveSeconds] = useState(DEFAULT_AUTOSAVE_SECONDS);
  // The data repo's README.md (specs/app-startup.feature.md "App Starts with
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
  // Test links (specs/traceability.spec.md): the table of automated-test
  // links at the end of each scenario card is optional; default ON.
  const [showTestLinks, setShowTestLinks] = useState(true);
  // Open test links in IntelliJ IDEA (specs/traceability.feature.md "Open
  // test in idea"): a click on one runs `idea --line` on the file in the
  // code repo instead of opening GitHub; default OFF.
  const [openTestsInIdea, setOpenTestsInIdea] = useState(false);
  /** Whether `idea` is on the server's PATH, so the setting can work. */
  const [canOpenInIdea, setCanOpenInIdea] = useState(false);
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
  /** Code gen sessions offered at all (specs/agents/claude.spec.md). */
  const [codeGen, setCodeGen] = useState(true);
  /** Whether Claude.app is installed, so a session can open in Claude Code
      Desktop — the session dialog offers "Run in" only then. */
  const [canOpenClaudeDesktop, setCanOpenClaudeDesktop] = useState(false);
  /** The last "Run in" choice, remembered in settings; null means not chosen yet. */
  const [codeGenTarget, setCodeGenTarget] = useState<CodeGenTarget | null>(null);
  /** Whether the Claude CLI is on PATH, so a session can run in the coding
      agent pane (specs/agents/coding-agent-ui.feature.md). */
  const [canRunAgentPane, setCanRunAgentPane] = useState(false);
  /** Whether the Pi CLI is on PATH, so a pane session can be driven by Pi
      (specs/agents/integration-with-pi-dev-agent.feature.md). */
  const [canRunPi, setCanRunPi] = useState(false);
  /** Whether the Codex CLI is on PATH, so a pane session can be driven by
      Codex (src/server/codexChat.ts). */
  const [canRunCodex, setCanRunCodex] = useState(false);
  /** The pane is offered when any agent's CLI is on PATH. */
  const canOpenAgentPane = canRunAgentPane || canRunPi || canRunCodex;
  // The coding agent pane's own state (src/frontend/agentChat.ts): open,
  // width, sessions. Restored once on boot — the pane, its width and the
  // last session come back the way they were left.
  const pane = useAgentChat();
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
  const pluginTabs = useRegistry(tabs);
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
    : "specs";
  // Live sync (specs/automerge-store.spec.md): optional websocket sync
  // server; empty means off — git stays the only transport.
  const [syncServerUrl, setSyncServerUrl] = useState<string | null>(null);
  /**
   * The app's own page holding the editor pane — Settings or Plugins
   * (specs/user-info-settings.feature.md "open Settings", "open Plugins") —
   * or null. Like a plugin's view it owns the pane and its url.
   */
  const [appPage, setAppPage] = useState<AppPage | null>(null);
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
  const [settingsProjectManagementDraft, setSettingsProjectManagementDraft] = useState(true);
  /** The tool name being typed/picked in Settings; saved when it is usable. */
  const [settingsToolDraft, setSettingsToolDraft] = useState(DEFAULT_PROJECT_MANAGEMENT_TOOL);
  const [settingsPublishLinksDraft, setSettingsPublishLinksDraft] = useState(true);
  const [settingsCodeGenDraft, setSettingsCodeGenDraft] = useState(true);
  const [settingsDeletePublishedDraft, setSettingsDeletePublishedDraft] = useState(false);
  const [settingsAssignmentsDraft, setSettingsAssignmentsDraft] = useState(false);
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
  /** The feature's ticket-link dialog: its fields while open, else null. */
  const [featureLinkDraft, setFeatureLinkDraft] = useState<LinkDraft | null>(null);
  const [featureLinkError, setFeatureLinkError] = useState<string | null>(null);
  const [featureLinkSaving, setFeatureLinkSaving] = useState(false);
  /** The feature's "Pull requests" popover
      (specs/external-links/related-pull-requests.feature.md). */
  const [featurePrsOpen, setFeaturePrsOpen] = useState(false);
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
  const [descHeight, setDescHeight] = useState<number | null>(readDescHeight);
  /** True while that strip is being dragged; holds the drag's starting point. */
  const descDrag = useRef<{ y: number; height: number } | null>(null);
  const [resizingDesc, setResizingDesc] = useState(false);
  const descPaneRef = useRef<HTMLDivElement | null>(null);
  // Git engine (specs/git-operations.spec.md): the GitHub CLI (the default
  // wherever gh is installed), plain system git, or the bundled JavaScript
  // one — which is always available, so it needs no availability flag.
  const [gitEngine, setGitEngineState] = useState<string | null>(null);
  const [gitEngineEffective, setGitEngineEffective] = useState<string>("cli");
  const [cliGitAvailable, setCliGitAvailable] = useState(false);
  const [gh, setGh] = useState<GhInfo | null>(null);
  const [settingsEngineDraft, setSettingsEngineDraft] = useState("auto");
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // GitHub sign-in (specs/git-operations.spec.md): the browser flow — GitHub
  // opens in a tab and redirects back to the server while we poll — with the
  // device flow (enter the shown code at github.com/login/device) as the
  // fallback, and the only path on the desktop app's app:// pages.
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlow | null>(null);
  const [webConnecting, setWebConnecting] = useState(false);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(readThemePref);
  // Vim mode (specs/ui.spec.md "Settings"): device-local like the theme;
  // every open Markdown editor follows the switch (src/frontend/vimPref.ts).
  const vimMode = useVimMode();
  // Excalidraw support (specs/editor/excalidraw-support.feature.md): device-
  // local too; every Markdown editor's toolbar follows the switch.
  const excalidrawOn = useExcalidrawEnabled();
  // The Pomodoro (specs/app/pomodoro.feature.md): off until asked for, and
  // device-local like the rest (src/frontend/pomodoroPref.ts). Off means the
  // bar, the `p` key and the palette's entries are all gone.
  const pomodoroOn = usePomodoroEnabled();
  /** Path whose "Copy link" action just ran — its label shows "Copied". */
  const [copied, setCopied] = useState<string | null>(null);
  // Current user (specs/user-info-settings.spec.md): shown in the sidebar's
  // lower left corner; the chip opens a menu with User info and Settings.
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [userInfoOpen, setUserInfoOpen] = useState(false);
  // In-app prompt/confirm dialogs (specs/ui.spec.md "Dialogs") — the desktop
  // runtime has no window.prompt (specs/desktop-app.spec.md "Dialogs").
  const { modal, modalOpen, prompt, promptWithChoice, confirm } = useModalPrompts();

  /** Returns the listing it loaded, so callers can act on it before state settles. */
  const loadFeatures = useCallback(async (): Promise<Listing | null> => {
    const result = await fetchListing();
    if ("error" in result) {
      setLoadError(result.error);
      return null;
    }
    const { listing } = result;
    setFeatures(listing.features);
    setFolders(listing.folders);
    setMembers(listing.members);
    setCodeRepo(listing.codeRepo);
    setIssuesRepo(listing.issuesRepo);
    setLoadError(null);
    return listing;
  }, []);

  /** Read the data repo's README into the home editor, dropping any unsaved edit. */
  const loadReadme = useCallback(async (): Promise<void> => {
    const res = await fetch("/api/readme");
    if (!res.ok) return;
    const data = (await res.json()) as { content: string };
    readmeSession.current += 1;
    readmeSaved.current = data.content;
    setReadme(data.content);
  }, []);

  useEffect(() => {
    (async () => {
      // boot=1 marks the page-load fetch: in demo mode the server reseeds the
      // pristine dataset on it, so a refresh reopens on the default data.
      const state = await (await fetch("/api/state?boot=1")).json();
      applyRepos(state);
      setNeedsRepo(state.needsDataRepo);
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
      if (typeof state.publishExternalLinks === "boolean") {
        setPublishExternalLinks(state.publishExternalLinks);
      }
      if (typeof state.projectManagement === "boolean") {
        setProjectManagement(state.projectManagement);
      }
      if (typeof state.projectManagementTool === "string") {
        setProjectManagementTool(state.projectManagementTool);
      }
      if (typeof state.codeGen === "boolean") {
        setCodeGen(state.codeGen);
      }
      setCanOpenClaudeDesktop(Boolean(state.canOpenClaudeDesktop));
      setCanRunAgentPane(Boolean(state.canRunAgentPane));
      setCanRunPi(Boolean(state.canRunPi));
      setCanRunCodex(Boolean(state.canRunCodex));
      agentChat.setAvailable(
        Boolean(state.canRunAgentPane),
        Boolean(state.canRunPi),
        Boolean(state.canRunCodex),
      );
      setCodeGenTarget(readCodeGenTarget(state.codeGenTarget));
      if (typeof state.deletePublished === "boolean") {
        setDeletePublished(state.deletePublished);
      }
      if (typeof state.assignments === "boolean") {
        setAssignments(state.assignments);
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
      // The demo pins Vim mode off (src/frontend/vimPref.ts): any editor open
      // when this lands drops its Vim tab, and the Settings row hides.
      setVimDemoMode(Boolean(state.demo));
      // Excalidraw goes the other way (src/frontend/excalidrawPref.ts): the
      // demo defaults it on so a visitor finds the diagram button without
      // first finding Settings. Turning it off there still sticks.
      setExcalidrawDemoMode(Boolean(state.demo));
      setAppVersion(typeof state.version === "string" ? state.version : null);
      setGitEngineState(state.gitEngine ?? null);
      setGitEngineEffective(state.gitEngineEffective ?? "cli");
      setCliGitAvailable(Boolean(state.cliGitAvailable));
      setGh(state.gh ?? null);
      setAuth(state.auth ?? null);
      if (state.user) setUser(state.user);
      if (!state.needsDataRepo) {
        // The README rides along: a start on the bare url opens on it
        // (specs/app-startup.feature.md).
        await Promise.all([
          loadFeatures(),
          loadReadme(),
          // So do the plugins — the special folders' pages, the Tests tab and
          // its plans — before the deep link below, which may name one of
          // their views. The demo's modules read but never write
          // (src/server/demo.ts).
          syncClientPlugins(state.plugins, { demo: Boolean(state.demo), settings: state }),
        ]);
        // Deep link (specs/navigation.spec.md): the entry url picks the view.
        await openFromLocation();
      }
      setLoading(false);
    })();
  }, [loadFeatures, loadReadme]);

  // Mirror the server's cron reload (specs/crud-feature.spec.md): refresh the
  // feature list on the same cadence so pulled changes show up, without
  // clobbering an in-progress edit or conflict resolution.
  useEffect(() => {
    if (loading || needsRepo || reloadSeconds <= 0) return;
    const id = setInterval(() => {
      void loadFeatures();
      // The description editor holding an edit that hasn't landed yet keeps
      // its feature as is, like the README below.
      const descPending =
        descEditRef.current !== null && descEditRef.current.text !== descSaved.current;
      if (selected && !dirty && !editing && !conflict && !descPending) void openFeature(selected);
      // A pulled README shows up too — unless the home editor holds an edit
      // that hasn't landed yet.
      if (!selected && !pluginViewRef.current && readmeText.current === readmeSaved.current) {
        void loadReadme();
      }
      // The plugins follow the same rule — each refreshes its own store (the
      // special folders their page lists), and what is open on screen only
      // while its editor holds nothing unsaved.
      client.emit("reload/tick", pluginViewRef.current);
    }, reloadSeconds * 1000);
    return () => clearInterval(id);
  }, [
    loading,
    needsRepo,
    reloadSeconds,
    selected,
    dirty,
    editing,
    conflict,
    loadFeatures,
    loadReadme,
  ]);

  // Keyboard: every shortcut — the scenario cards' ↑/↓/Enter, ESC's many
  // meanings, "/" for search and the rest — is declared in one registry
  // further down (`shortcuts`) and dispatched by one listener.

  // The dialog's "Add test link" field starts empty each time it opens, with
  // no row left open for ✎ editing (specs/traceability.spec.md).
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
  // (specs/editor-autosave.feature.md).
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
  // now that the feature it belongs to is on screen (specs/navigation.spec.md
  // "open a scenario link"). By identity, like every other card lookup — the
  // link resolved against the same feature, so it is still there.
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

  // Reveal the open scenario in the tree (specs/navigation.feature.md
  // "Scenario navigation"): a pane opened from a link, a card or the palette
  // expands its feature's outline, so the row that is highlighted is one that
  // can be seen — the same courtesy a new feature gets in a collapsed folder.
  useEffect(() => {
    if (!selected || paneScenario === null) return;
    setOutlined((prev) => {
      if (prev.has(selected)) return prev;
      return new Set(prev).add(selected);
    });
  }, [selected, paneScenario !== null]);

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

  const featureLinkOpen = featureLinkDraft !== null;
  // ESC (specs/ui.spec.md "Dialogs", specs/editor/spec-editor.feature.md
  // "Spec editor pane", specs/folders.spec.md): one key, closing whatever is
  // on top — see `closeTopmost` in the shortcut registry below. The menus
  // (src/frontend/Menu.tsx) take their own ESC and outside clicks.

  // specs/ui.spec.md "Dialogs": Tab stays inside the foreground dialog. The
  // editor pane is part of the page, not a dialog — Tab reaches the sidebar
  // from it (specs/editor/spec-editor.feature.md "Spec editor pane").
  const userInfoTrapRef = useFocusTrap(userInfoOpen);
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

  // Canonical url (specs/navigation.spec.md "Resolution rules"): the address
  // bar shows the page that is open — the scenario page's own url while it is
  // open, the feature's otherwise. A plugin's view — an open roadmap page or
  // task among them (specs/app/tasks.feature.md "Support deep link just like
  // Features") — owns its own url. Opening a scenario page pushes, like a feature
  // switch does in openFeature, so Back leaves it the way `<` does.
  // Everything else rewrites in place: a rename moving an open page's url
  // must not leave the retired url behind for Back to land on.
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

  // Window title follows what is open (specs/navigation.spec.md) — chat and
  // email link previews show it.
  const clock = titlePrefix(pom.timer, pom.now);
  useEffect(() => {
    const s = paneScenario ?? undefined;
    const name = feature && selected ? feature.name || titleFromFileName(selected) : "";
    // A plugin's view — an open roadmap page or task, say — names the window
    // the way a feature does, so a shared link previews as that page
    // (specs/app/tasks.feature.md).
    const base = appPage
      ? `SpecDriven — ${appPage === "settings" ? "Settings" : appPage === "plugins" ? "Plugins" : "Observability"}`
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

  const saveRepo = async (repo: string) => {
    // Capture the entry url now: once needsRepo flips, the canonical-url
    // effect would rewrite a deep link before we get to honor it
    // (specs/navigation.spec.md "deep link before a data repo is configured").
    const entryPath = location.pathname;
    const entryLink = isLinkEntry(location.search);
    setSettingRepo(true);
    setRepoError(null);
    try {
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataRepo: repo }),
      });
      const state = await res.json();
      if (res.ok) {
        applyRepos(state);
        setNeedsRepo(false);
        // A freshly picked folder opens on its README, like a start does
        // (specs/app-startup.feature.md "A newly picked data folder opens on
        // its README") — unless there is a deep link to honor. The plugins —
        // the special folders' pages among them — ride along, as they do on a
        // start with a folder already configured (specs/app/roadmap.feature.md).
        await Promise.all([
          loadFeatures(),
          loadReadme(),
          syncClientPlugins(state.plugins, { demo: Boolean(state.demo), settings: state }),
        ]);
        await openFromLocation(entryPath, entryLink);
      } else {
        setRepoError(state.error ?? "Could not use this repo");
      }
    } finally {
      setSettingRepo(false);
    }
  };

  // Native OS folder chooser (specs/app-start.spec.md): the server (or the
  // desktop shell) owns the dialog; null means canceled or unavailable.
  const chooseFolderNative = async (): Promise<string | null> => {
    const res = await fetch("/api/choose-folder", { method: "POST" });
    if (!res.ok) return null;
    const data = await res.json();
    return data.path ?? null;
  };

  // First-run form (specs/app-start.spec.md): the picker fills the path
  // field; the user still confirms with the submit button.
  const browseIntoRepoInput = async () => {
    const picked = await chooseFolderNative();
    if (picked && repoInputRef.current) repoInputRef.current.value = picked;
  };

  // Change the data dir from the sidebar header (specs/app-start.spec.md
  // "changing the data repo"): pre-filled prompt; on success the view resets
  // to home, since the current selection belonged to the old repo.
  const changeRepo = async () => {
    const input = await prompt({
      title: "Data directory",
      hint: "Path or GitHub url of the spec data repo.",
      initial: dataRepo ?? "",
      confirmLabel: "Use this directory",
      browse: canChooseFolder ? chooseFolderNative : undefined,
    });
    await switchRepo(input?.trim() ?? "");
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
    // So does whatever a plugin's view holds — an open roadmap page or an
    // Event Model's canvas, say:
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
    try {
      setSwitching({ folder: next, step: "opening" });
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataRepo: next }),
      });
      const state = await res.json();
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
        // Home is the new folder's README (specs/app-startup.feature.md).
        await Promise.all([
          loadFeatures(),
          loadReadme(),
          syncClientPlugins(state.plugins, { demo: Boolean(state.demo), settings: state }).then(() =>
            client.serial("data/changed"),
          ),
        ]);
        if (entryPath && entryPath !== "/") {
          history.replaceState(null, "", entryPath);
          // Already read off the link: a folder named like its first segment
          // must not take it a second time.
          await openFromLocationRef.current(entryPath, false);
        }
      } else {
        toast.error(state.error ?? "Could not use this directory");
      }
    } finally {
      setSwitching(null);
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
      if (res.ok) applyRepos({ dataRepo: reposRef.current.open, recentDataRepos: state.recentDataRepos });
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
        // Deep link (specs/navigation.spec.md): resolve slug (+ version) to a
        // card; a miss opens the feature with no selection and a note.
        const idx = opts.scenario === null ? null : resolveScenario(parsed.scenarios, opts.scenario);
        if (opts.scenario !== null && idx === null) missingScenario = opts.scenario.slug;
        setSelectedScenario(idx);
        // A scenario link opens that scenario's page (specs/navigation.spec.md
        // "open a scenario link") — the whole point of the card's "Copy link".
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
      setRenameDraft(null);
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
      if (file === selected) {
        // The file is gone, so an editor open on it has nothing to save into.
        setEditing(null);
        setSelected(null);
        setFeature(null);
        setSelectedScenario(null);
      }
      if (opts.push || opts.scenario !== undefined) {
        toast.error(`Feature "${file}" not found — the link may be stale.`);
      }
      await loadFeatures();
    }
  };

  /**
   * Home — the data folder's README editor (specs/app-startup.feature.md
   * "The data folder name links to the README"). Drops the feature selection
   * and pushes `/`, so Back returns to the feature that was open. The README
   * editor's own unmount tick saves anything typed there, and an open
   * scenario editor leaves the way `<` does — its last save goes out before
   * the selection drops (specs/editor/spec-editor.feature.md "Spec editor
   * pane").
   */
  const goHome = () => {
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
  const openPlugins = () => openAppPage("plugins");
  const openObservability = () => openAppPage("observability");
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
    setPlugins(Array.isArray(data.plugins) ? data.plugins : []);
    setPluginSources(Array.isArray(data.pluginSources) ? data.pluginSources : []);
    setPluginMarketplaces(Array.isArray(data.pluginMarketplaces) ? data.pluginMarketplaces : []);
    await syncClientPlugins(data.plugins, { demo: Boolean(data.demo), settings: data });
    client.emit("settings/changed", data);
  }, []);
  useEffect(() => {
    if (loading || demo) return;
    return watchPluginChanges(() => void refreshPlugins());
  }, [loading, demo, refreshPlugins]);

  /**
   * Derive the view from a url (initial load, popstate, after repo setup).
   * `link` says the path came from outside the window (src/electron/main.ts
   * flags it, route.ts LINK_PARAM): only then may it name a spec folder.
   */
  const openFromLocation = async (
    pathname = location.pathname,
    link = isLinkEntry(location.search),
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
      // (specs/navigation.spec.md "open a scenario link").
      await openFeature(route.feature, { scenario: route.scenario ?? null, pane: true });
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

  // Back/forward (specs/navigation.spec.md "browser history and reload"):
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
  const createFeature = async () => {
    const parent = selectedFolder;
    const input = await prompt({
      title: parent ? `New feature in "${parent}"` : "New feature",
      hint: parent ? undefined : "Use folder/name to create inside a folder.",
      placeholder: parent ? "Basic Quote" : "billing/Basic Quote",
      confirmLabel: "Create feature",
    });
    if (!input) return;
    const res = await fetch("/api/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: parent ? `${parent}/${input}` : input }),
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
  const sessionTarget = resolveCodeGenTarget(
    codeGenTarget,
    canOpenClaudeDesktop,
    canRunAgentPane,
    canRunPi,
    canRunCodex,
  );

  // Code gen session (specs/agents/claude.spec.md): with specs or single
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
              label: CODE_GEN_TARGET_LABEL.desktop,
              hint: `Opens a new session in the Claude app, on ${repoWord}`,
            },
          ]
        : []),
      ...(canRunAgentPane
        ? [
            {
              value: "pane",
              label: CODE_GEN_TARGET_LABEL.pane,
              hint: `Chats with Claude in a pane here, on ${repoWord}`,
            },
          ]
        : []),
      // Codex (src/server/codexChat.ts): the same pane, driven over Codex's
      // app-server protocol — offered when its CLI is on PATH.
      ...(canRunCodex
        ? [
            {
              value: "codex",
              label: CODE_GEN_TARGET_LABEL.codex,
              hint: `Chats with Codex in a pane here, on ${repoWord} — with permission cards`,
            },
          ]
        : []),
      // Pi (specs/agents/integration-with-pi-dev-agent.feature.md): the same
      // pane, driven over pi's RPC mode — offered when its CLI is on PATH.
      ...(canRunPi
        ? [
            {
              value: "pi",
              label: CODE_GEN_TARGET_LABEL.pi,
              hint: `Chats with Pi in a pane here, on ${repoWord} — Pi runs its own tools`,
            },
          ]
        : []),
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
          : `Runs ${agentChoices.length > 1 ? "the chosen agent" : only === "pi" ? "Pi" : only === "codex" ? "Codex" : "Claude"} over ${describeSelection(files)}${where}, or copies the prompt.`,
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
    const target = readCodeGenTarget(choice) ?? only;
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

  // Folders (specs/folders.spec.md): plain directories in the data repo.
  // With a folder selected, the new folder is created inside it.
  const createFolder = async () => {
    const parent = selectedFolder;
    const input = await prompt({
      title: parent ? `New folder in "${parent}"` : "New folder",
      hint: parent ? undefined : "Use / for nesting.",
      confirmLabel: "Create folder",
    });
    if (!input) return;
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: parent ? `${parent}/${input}` : input }),
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
      await loadFeatures();
    } else {
      toast.error(data.error ?? "Could not create the folder");
    }
  };

  // Only empty folders can be deleted (specs/folders.spec.md) — the
  // server refuses otherwise, and the refusal lands in the status line.
  const removeFolder = async (path: string) => {
    const ok = await confirm({
      title: "Delete folder",
      body: `Delete "${path}"? Only empty folders can be deleted.`,
      confirmLabel: "Delete folder",
    });
    if (!ok) return;
    const res = await fetch(`/api/folders/${encodeURIComponent(path)}`, { method: "DELETE" });
    const data = await res.json();
    if (res.ok) {
      // A selection under the deleted folder points nowhere — drop it.
      setSelectedFolder((f) => (f === path || f?.startsWith(`${path}/`) ? null : f));
      await loadFeatures();
      toast.success(`Deleted folder "${path}".`, {
        action: { label: "Undo", run: () => void restoreFolder(path) },
      });
    } else {
      toast.error(data.error ?? "Could not delete the folder");
    }
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

  // Drag-move (specs/folders.spec.md): the server does a `git mv` into
  // the target folder, committed and pushed. A selected feature stays
  // selected under its new path — the canonical-url effect follows along.
  const moveTo = async (fileName: string, folder: string) => {
    setDragging(null);
    setDropTarget(null);
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
        const from = fileName.includes("/") ? fileName.slice(0, fileName.lastIndexOf("/")) : "";
        toast.success(`Moved to ${folder || "the top level"} — ${data.message}.`, {
          action: { label: "Undo", run: () => void moveTo(data.fileName, from) },
        });
      }
    } else {
      toast.error(data.error ?? "Move failed");
    }
  };

  // specs/ui.spec.md "Main page": the Edit link next to the feature name lets
  // the user edit the feature name — the file's `# <name>` heading. The server
  // rewrites the heading, commits and pushes; the file name (and so the
  // feature's url) stays the same.
  const renameSelected = async () => {
    if (!selected || renameDraft === null) return;
    const target = renameDraft.trim();
    const currentName = feature ? feature.name || titleFromFileName(selected) : "";
    if (!target || target === currentName) {
      setRenameDraft(null);
      return;
    }
    setRenaming(true);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: target }),
      });
      const data = await res.json();
      if (res.ok) {
        setRenameDraft(null);
        await loadFeatures();
        await openFeature(selected);
        toast.success(`Renamed to "${data.name}" — ${data.message}.`);
      } else {
        toast.error(data.error ?? "Rename failed");
      }
    } catch {
      toast.error("Rename failed — is the server running?");
    } finally {
      setRenaming(false);
    }
  };

  /** The file name shown in the menu: only the part left of the dot —
      the `.feature.md` extension is hidden (specs/ui.spec.md "Feature
      entry menu"). */
  const fileStem = (fileName: string) => fileName.split("/").pop()!.split(".")[0]!;

  // File → Rename (specs/ui.spec.md "Feature entry menu"): renames the
  // underlying file. The extension stays; a selected feature follows its
  // new file name (and so a new url — old links go stale).
  const renameFile = async (fileName: string) => {
    const stem = await prompt({
      title: "Rename file",
      hint: "The .feature.md extension is kept.",
      initial: fileStem(fileName),
      confirmLabel: "Rename",
    });
    if (!stem || stem.trim() === fileStem(fileName)) return;
    const res = await fetch(`/api/features/${encodeURIComponent(fileName)}/rename-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stem }),
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
  };

  // Delete (specs/ui.spec.md "Feature entry menu"): removes the feature file
  // after a confirmation — a `git rm`, committed and pushed on the server.
  const removeFeature = async (f: FeatureListing) => {
    const ok = await confirm({
      title: "Delete feature",
      body: `Delete "${f.name}" (${f.fileName})?`,
      confirmLabel: "Delete feature",
    });
    if (!ok) return;
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
  };

  // Publish buttons (specs/ui.spec.md "Main page"): same style and behavior as
  // Sync — disabled with a progress label while running, no "Published" status
  // line at the bottom of the page. Without a target every scenario is
  // published (the upper-left "Publish All"); with one, only that scenario
  // (specs/crud-feature.spec.md "publish each scenario individually").
  // `over` carries content the state hasn't caught up with yet: the dialog's
  // Publish saves its scenario into the feature and publishes in one motion.
  // The target carries the scenario's document id, so one going out under a
  // new name or version is published as itself, not as a second scenario.
  const publish = async (scenario?: ScenarioTarget, over?: Feature) => {
    const content = over ?? feature;
    if (!selected || !content) return;
    setPublishing(scenario ? scenarioKey(scenario) : "all");
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(content), scenario }),
      });
      const data = await res.json();
      if (res.status === 409 && data.status === "conflict") {
        setConflict({ ours: data.ours, theirs: data.theirs, message: data.message, scenario });
        setConflictDraft(data.ours);
        toast.info("Merge conflict — choose a resolution below.");
      } else if (res.ok) {
        await openFeature(selected);
      } else {
        toast.error(data.error ?? "Publish failed");
      }
    } catch {
      toast.error("Publish failed — is the server running?");
    } finally {
      setPublishing(null);
    }
  };

  // Sync button (specs/ui.spec.md "Main page"): immediate data reload — the
  // server runs one reload tick (pull + push saved), then the view refreshes.
  // Like the cron mirror above, an in-progress edit or conflict is not clobbered.
  // Progress shows only on the button — no status line at the bottom of the page.
  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/reload", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Sync failed");
        return;
      }
      await loadFeatures();
      if (selected && !dirty && !editing && !conflict) await openFeature(selected);
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
      native behavior (new tab etc — specs/navigation.spec.md "share a link"). */
  const spaClick = (e: MouseEvent, go: () => void) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go();
  };

  // "Copy link" (specs/navigation.spec.md "share a link"): absolute url on
  // the clipboard; the pressed control's label flips to "Copied" for 2 sec.
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

  // specs/crud-feature.spec.md ("Scenario is automatically saved locally and
  // pushed to GitHub"): a landed save updates the header's Saved indicator.
  const markSaved = () => {
    setSaving(false);
    setSavedAt(Date.now());
  };

  /**
   * The version a scenario gets is derived, never typed (specs/ui.spec.md):
   * one past the highest version already carrying that name, or 1 when the
   * name is new. Editing an existing entry keeps the version it was given.
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
   * (specs/editor-autosave.feature.md): the pane stays open and follows its
   * scenario into the saved feature. Resolves to whether the save landed and
   * where it left the scenario; null when there is nothing to save.
   */
  const saveScenario = (
    tests: string[],
    close: boolean,
    // Propose (specs/editor/spec-editor.feature.md) is the explicit action
    // that advances the editor's draft; every other save keeps the status.
    status?: Scenario["status"],
  ): Promise<{ ok: boolean; placed: Placement }> | null => {
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
    const known: Placement = { feature, index: editing.index, id: draft.id };
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
        // links (specs/traceability.spec.md) and its ticket link — so there is
        // nothing left to publish.
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
   * can't join the list blocks the save instead (specs/traceability.spec.md).
   * The ticket-link fields gate the save the same way: a half-filled link is
   * not written half-done, it blocks with a message
   * (specs/external-links/project-management-jira-linear-etc.feature.md).
   * Null means blocked, with the reason already on screen.
   */
  const pendingTests = (): string[] | null => {
    if (!editing) return null;
    const link = resolveLinkDraft(linkDraft);
    if (link.error) {
      setLinkError(link.error);
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
    const name = editing.scenario.name.trim();
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
   */
  const publishScenario = async () => {
    if (!editing || !feature || !selected) return;
    const tests = pendingTests();
    if (tests === null) return;
    const s = { ...editing.scenario, name: editing.scenario.name.trim(), version: draftVersion, tests };
    const next = withScenario(feature, editing.index, s);
    setFeature(next);
    setEditing(null);
    // Back on the feature page, the published scenario's card is the one to
    // land on (specs/editor/spec-editor.feature.md "Spec editor pane").
    setSelectedScenario(cardOfScenario(next.scenarios, s));
    await publish(scenarioTarget(s), next);
  };

  /**
   * One autosave tick (specs/editor-autosave.feature.md "Autosave Triggered at
   * Defined Interval"): save what the editor holds, unless it holds nothing
   * new. A url still being typed into the test-link fields stays out — those
   * join the scenario when the user adds them, or when the pane closes.
   */
  const autosaveScenario = async () => {
    if (!editing || !feature || !selected) return;
    if (autosaveInFlight.current) return; // the previous tick is still saving
    if (deletingScenario.current) return; // a delete is being confirmed or sent
    // The name is still being typed: saving now would put a half-typed name
    // on the draft (specs/editor-autosave.feature.md "Autosave Waits While the
    // Name Is Being Typed"). The tick after focus moves on saves it.
    if (namingInProgress(nameFieldRef.current, document.activeElement)) return;
    // A scenario with no name has nothing to be saved under; the Save button
    // is disabled for the same reason.
    if (!editing.scenario.name.trim()) return;
    const signature = scenarioSignature(editing.scenario, draftVersion);
    if (signature === autosaved.current) return;
    const session = editorSession.current;
    const before: Placement = { feature, index: editing.index, id: editing.scenario.id };
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
  useEffect(() => {
    if (!editingOpen) return;
    const id = setInterval(() => void autosaveTick.current(), autosaveSeconds * 1000);
    return () => clearInterval(id);
  }, [editingOpen, autosaveSeconds]);

  /**
   * One autosave tick of the home README editor (specs/app-startup.feature.md
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
      setSaving(true);
      try {
        const res = await fetch("/api/readme", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: toWrite }),
        });
        if (res.ok) {
          if (session === readmeSession.current) {
            readmeSaved.current = toWrite;
            markSaved();
          }
        } else {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
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
    const id = setInterval(() => void descTick.current(), autosaveSeconds * 1000);
    return () => {
      clearInterval(id);
      void descTick.current();
      if (descEditRef.current && descEditRef.current.file !== selectedRef.current) setDescEdit(null);
    };
  }, [descOpen, autosaveSeconds]);

  /** Done: land what the editor holds and show the description rendered. */
  const closeDescriptionEditor = async () => {
    await descTick.current();
    setDescEdit(null);
  };

  // Avatar initials: from the git name when set, else the OS user name
  // (specs/user-info-settings.spec.md).
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
  useLayoutEffect(() => {
    if (!settingsShown) return;
    // A stored 0 means autosync is off; the field keeps a usable frequency so
    // switching it back on needs no typing.
    setSettingsAutosyncOnDraft(reloadSeconds > 0);
    setSettingsDraft(String(reloadSeconds > 0 ? reloadSeconds : DEFAULT_AUTOSYNC_SECONDS));
    setSettingsLinesDraft(String(previewLines));
    setSettingsAutosaveDraft(String(autosaveSeconds));
    // No stored choice is "auto": whichever engine this machine can run.
    setSettingsEngineDraft(
      gitEngine === "cli" || gitEngine === "gh" || gitEngine === "js" ? gitEngine : "auto",
    );
    setSettingsTestLinksDraft(showTestLinks);
    setSettingsOpenInIdeaDraft(openTestsInIdea);
    setSettingsProjectManagementDraft(projectManagement);
    setSettingsToolDraft(projectManagementTool);
    setSettingsPublishLinksDraft(publishExternalLinks);
    setSettingsCodeGenDraft(codeGen);
    setSettingsDeletePublishedDraft(deletePublished);
    setSettingsAssignmentsDraft(assignments);
    setSettingsGoogleCalendarDraft(googleCalendarOn);
    setSettingsSyncDraft(syncServerUrl ?? DEFAULT_SYNC_SERVER_URL);
    setSettingsSyncOnDraft(syncServerUrl !== null);
    setSettingsError(null);
    setAuthStatus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsShown]);

  // Browser sign-in (specs/git-operations.spec.md "connect to GitHub via the
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

  // GitHub sign-in (specs/git-operations.spec.md): start the device flow,
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
  };

  const signOutGitHub = async () => {
    await fetch("/api/auth/github", { method: "DELETE" });
    setAuth({ signedIn: false });
    await refreshUser();
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
  // there is no Save button; specs/ui.spec.md "Settings"). Each change PUTs
  // only its own field; the response carries the full normalized state, so
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
    setPublishExternalLinks(data.publishExternalLinks !== false);
    setProjectManagement(data.projectManagement !== false);
    if (typeof data.projectManagementTool === "string") {
      setProjectManagementTool(data.projectManagementTool);
    }
    // Switched off, a selection left over from before must not linger as a
    // session waiting to be started.
    if (data.codeGen === false) setSpecSelection(new Map());
    setCodeGen(data.codeGen !== false);
    setCanOpenClaudeDesktop(Boolean(data.canOpenClaudeDesktop));
    setCanRunAgentPane(Boolean(data.canRunAgentPane));
    setCanRunPi(Boolean(data.canRunPi));
    setCanRunCodex(Boolean(data.canRunCodex));
    agentChat.setAvailable(
      Boolean(data.canRunAgentPane),
      Boolean(data.canRunPi),
      Boolean(data.canRunCodex),
    );
    setCodeGenTarget(readCodeGenTarget(data.codeGenTarget));
    setDeletePublished(data.deletePublished === true);
    setAssignments(data.assignments === true);
    // The profile's plugins mount and unmount to match, in its order — a
    // tab appears, goes or moves before this returns (src/plugins/client/
    // loader.ts).
    setPlugins(Array.isArray(data.plugins) ? data.plugins : []);
    setPluginSources(Array.isArray(data.pluginSources) ? data.pluginSources : []);
    setPluginMarketplaces(Array.isArray(data.pluginMarketplaces) ? data.pluginMarketplaces : []);
    await syncClientPlugins(data.plugins, { demo: Boolean(data.demo), settings: data });
    // The mounted ones follow the other switches they read — the tasks'
    // calendar chip follows Google Calendar's, say.
    client.emit("settings/changed", data);
    setGoogleCalendarOn(data.googleCalendar === true);
    setSyncServerUrl(typeof data.syncServerUrl === "string" ? data.syncServerUrl : null);
    setGitEngineState(data.gitEngine ?? null);
    setGitEngineEffective(data.gitEngineEffective ?? "cli");
    setCliGitAvailable(Boolean(data.cliGitAvailable));
    setGh(data.gh ?? null);
    // The engine decides which account authors commits, so the user corner
    // can be showing the wrong one now.
    if (patch.gitEngine !== undefined) await refreshUser();
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
  // url is the stored form of "off" (specs/automerge-store.spec.md).
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
    await patchSettings({ projectManagementTool: name });
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

  const toggleCodeGen = async (on: boolean) => {
    setSettingsCodeGenDraft(on);
    if (!(await patchSettings({ codeGen: on }))) setSettingsCodeGenDraft(!on);
  };

  const toggleDeletePublished = async (on: boolean) => {
    setSettingsDeletePublishedDraft(on);
    if (!(await patchSettings({ deletePublished: on }))) setSettingsDeletePublishedDraft(!on);
  };

  const toggleAssignments = async (on: boolean) => {
    setSettingsAssignmentsDraft(on);
    if (!(await patchSettings({ assignments: on }))) setSettingsAssignmentsDraft(!on);
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

  const pickGitEngine = async (engine: string) => {
    const prev = settingsEngineDraft;
    setSettingsEngineDraft(engine);
    if (!(await patchSettings({ gitEngine: engine }))) setSettingsEngineDraft(prev);
  };

  // The dialog's "Automated tests" list editor (specs/traceability.spec.md);
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

  /**
   * Save the feature's own ticket link (specs/external-links/project-
   * management-jira-linear-etc.feature.md "Add link to feature"): the feature
   * is saved like any scenario edit — locally, marked [proposed] where
   * applicable, pushed by the reload cron — with the link set or cleared.
   */
  const saveFeatureLink = async () => {
    if (!feature || !selected || featureLinkDraft === null) return;
    const resolved = resolveLinkDraft(featureLinkDraft);
    if (resolved.error) {
      setFeatureLinkError(resolved.error);
      return;
    }
    const { link: _previous, ...rest } = feature;
    const next: Feature = resolved.link ? { ...rest, link: resolved.link } : rest;
    setFeatureLinkSaving(true);
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
        setFeatureLinkDraft(null);
        toast.success(
          resolved.link
            ? `Linked ${externalLinkLabel(resolved.link)} — ${data.message}.`
            : `Ticket link removed — ${data.message}.`,
        );
        markSaved();
      } else {
        setFeatureLinkError(data.error ?? "Could not save the ticket link");
      }
    } catch {
      setFeatureLinkError("Could not save the ticket link — is the server running?");
    } finally {
      setFeatureLinkSaving(false);
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
      (specs/traceability.spec.md). */
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
   * Delete the dialog's scenario (specs/ui.spec.md "Scenario editor"),
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
  const closeEditor = (): Promise<boolean> | null => {
    let saving: Promise<boolean> | null = null;
    if (
      editing &&
      editing.scenario.name.trim() && // no name, nothing to be saved under
      !deletingScenario.current
    ) {
      // A url still sitting in the add field or in an open ✎ row joins the
      // scenario on the way out, as if Add (or the row's Save) had been
      // pressed — it is never silently dropped (specs/traceability.spec.md).
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
        saving = commitScenario(tests, false);
      }
    }
    setEditing(null);
    return saving;
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
    const landed = saved ? withScenario(feature, at, s) : feature;
    setSelectedScenario(cardOfScenario(landed.scenarios, s));
  };

  // ESC and the navigation paths run whichever close/back is current, from
  // listeners and callbacks bound in earlier renders.
  useEffect(() => {
    editorRef.current = { close: closeEditor, back: backToFeature };
  });

  /** Draft the next version of a published scenario as a new, editable scenario. */
  const newVersion = (i: number) => {
    if (!feature) return;
    const src = feature.scenarios[i]!;
    setEditing({
      index: null,
      // isNew marks it as new, so the version is derived on save.
      isNew: true,
      // Draft like any other new scenario, so autosave can't propose the next
      // version of a published scenario on the user's behalf — and without
      // the source's document id: this is a new scenario, not that one renamed.
      scenario: { ...src, id: undefined, version: nextVersionFor(src.name), status: "draft" },
    });
  };

  const toggleFolder = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** Open or close a feature's scenario outline (specs/navigation.feature.md). */
  const toggleOutline = (file: string) =>
    setOutlined((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });

  /**
   * Open a search hit exactly like its deep link (specs/search.spec.md): a
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
   * A scenario in the sidebar tree (specs/navigation.feature.md "Scenario
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
   * (specs/navigation.feature.md "Scenario navigation"): the
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

  /** One sidebar entry per feature; the entry is the drag source. */
  const featureItem = (f: FeatureListing, depth: number) => {
    const entry = specSelection.get(f.fileName);
    // The feature's scenarios, listed under it when the outline is expanded
    // (specs/navigation.feature.md "Scenario navigation"). The open feature
    // reads from its live state, so a save shows here before the listing's
    // next refresh.
    const rows = scenarioRows(f, selected, feature);
    const expanded = rows.length > 0 && outlined.has(f.fileName);
    return (
      <div key={f.fileName}>
        <div className={`tree-row${matchesFilter(f) ? "" : " dim"}`}>
          {/* Code gen selection (specs/agents/claude.spec.md): checking a
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
          {/* The outline twisty (specs/navigation.feature.md "Scenario
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
          {/* A real link (specs/navigation.spec.md "share a link"): plain clicks
          navigate in-app, right-click → Copy Link works. The label is the
          feature name, not the file name (specs/ui.spec.md "Main page"). */}
      <a
        href={featurePath(f.fileName)}
        className={`tree-feature${f.fileName === selected ? " active" : ""}`}
        role="treeitem"
        aria-level={depth + 1}
        aria-current={f.fileName === selected ? "page" : undefined}
        data-file={f.fileName}
        /* The checkbox and the twisty carry the depth indent before it. */
        style={{ paddingLeft: "0.2rem" }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", f.fileName);
          e.dataTransfer.effectAllowed = "move";
          setDragging(f.fileName);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDropTarget(null);
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
      {/* Drop down menu (specs/ui.spec.md "Feature entry menu"): File →
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
            {
              id: "file",
              label: "File",
              items: [
                {
                  id: "rename",
                  label: `Rename “${fileStem(f.fileName)}”`,
                  icon: <Pencil size={13} />,
                  onSelect: () => void renameFile(f.fileName),
                },
              ],
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
        {/* The expanded outline (specs/navigation.feature.md "Scenario
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
              // Its menu (specs/navigation.feature.md "Scenario
              // navigation"): Delete, offered on the same terms as the
              // editor pane's — a published scenario only while Settings
              // allows it.
              const menuKey = `${f.fileName}\u0000${s.name}\u0000${s.version}`;
              const deletable = s.status !== "published" || deletePublished;
              return (
                <div key={`${s.name}-v${s.version}`} className="tree-scenario-row">
                  <a
                    href={scenarioPath(f.fileName, s)}
                    className={`tree-scenario${here ? " active" : ""}`}
                    role="treeitem"
                    aria-level={depth + 2}
                    aria-current={here ? "page" : undefined}
                    /* Line up just past the feature's twisty: the codegen
                       checkbox, when on, already carries the depth indent for
                       the whole row, so it is not added twice. */
                    style={{ paddingLeft: `${(codeGen ? 1.5 : 0.6) + depth * 0.9}rem` }}
                    title={`${s.name} v${s.version}`}
                    onClick={(e) => spaClick(e, () => openScenarioRow(f.fileName, s))}
                  >
                    <StatusIcon status={s.status} size={12} />
                    <span className="tree-scenario-name">{s.name}</span>
                    <span className="version">v{s.version}</span>
                  </a>
                  {deletable && (
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
                          {
                            id: "delete",
                            label: "Delete",
                            icon: <Trash2 size={13} />,
                            danger: true,
                            onSelect: () => void deleteTreeScenario(f.fileName, s),
                          },
                        ]}
                      />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  /**
   * Folders then features, indented per depth (specs/folders.spec.md).
   * A folder's whole subtree is its drop zone — dropping on a feature drops
   * into the folder that holds it; nested folders win via stopPropagation.
   */
  const renderTree = (node: FolderNode, depth: number) => (
    <>
      {node.folders.map((child) => (
        <div
          key={child.path}
          onDragOver={(e) => {
            if (dragging === null) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(child.path);
          }}
          onDragLeave={() => setDropTarget((t) => (t === child.path ? null : t))}
          onDrop={(e) => {
            if (dragging === null) return;
            e.preventDefault();
            e.stopPropagation();
            void moveTo(dragging, child.path);
          }}
        >
          <div
            className={`folder-row${dragging !== null && dropTarget === child.path ? " drop-target" : ""}${
              child.path === selectedFolder ? " selected" : ""
            }`}
            style={{ paddingLeft: `${depth * 0.9}rem` }}
          >
            {/* Clicking selects the folder (specs/folders.spec.md — "+ New
                folder" then creates inside it) and toggles its subtree. */}
            <button
              type="button"
              className="folder-toggle"
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={!collapsed.has(child.path)}
              data-folder={child.path}
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
              {child.name}
            </button>
            <Tooltip label="Delete folder">
              <button
                type="button"
                className="folder-delete"
                aria-label={`Delete folder ${child.path}`}
                onClick={() => void removeFolder(child.path)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
          {!collapsed.has(child.path) && <div role="group">{renderTree(child, depth + 1)}</div>}
        </div>
      ))}
      {node.features.map((f) => featureItem(f, depth))}
    </>
  );

  // One keyboard model (specs/ui/ui.feature.md "Design system"): every
  // shortcut is declared once here, dispatched by one listener
  // (src/frontend/shortcuts.tsx) and listed by the `?` cheat sheet from the
  // same list. Single keys stay quiet while a dialog or menu is open and
  // while typing in a field; ESC works everywhere.
  const dialogOpen =
    userInfoOpen ||
    foldersOpen ||
    switching !== null ||
    modalOpen ||
    startDialog ||
    pomodoroSettings ||
    conflict !== null ||
    featureLinkOpen ||
    featurePrsOpen ||
    sessionError !== null ||
    sheetOpen ||
    palette !== null;
  const menuOpen =
    treeMenu !== null ||
    recentMenuOpen ||
    userMenuOpen ||
    featureMenuOpen ||
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
  // new scenario starts as a draft: autosave (specs/editor-autosave.feature.md)
  // writes the editor out every few seconds, and a draft stays in the
  // document. Proposing it — into the .feature.md — takes the editor's
  // Propose button, an explicit act.
  const newScenario = async () => {
    const name = await prompt({
      title: "New scenario",
      placeholder: "Scenario name",
      confirmLabel: "Create",
    });
    if (!name?.trim()) return;
    setEditing({
      index: null,
      isNew: true,
      scenario: { name: name.trim(), version: 1, status: "draft", body: "", tests: [] },
    });
  };
  // specs/ui.spec.md "Select scenarios via up and down keys": the highlight
  // walks the cards; Enter opens the highlighted one in the editor pane.
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
  // ESC closes whatever is on top (specs/ui.spec.md "Dialogs"): a dialog;
  // then the editor pane — its way back, leaving the scenario autosaved
  // (specs/editor/spec-editor.feature.md "Spec editor pane") — unless the
  // key came from the sidebar, which stays reachable beside the pane; then
  // an app page — Settings, Plugins — the same way; then a selected folder
  // (specs/folders.spec.md). A field keeps its own ESC.
  const closeTopmost = (e: KeyboardEvent): void | false => {
    if (sessionError !== null) return setSessionError(null);
    if (startDialog) return setStartDialog(false);
    if (pomodoroSettings) return setPomodoroSettings(false);
    if (conflict) {
      if (resolving) return false;
      dismissConflict();
      return;
    }
    if (userInfoOpen) return setUserInfoOpen(false);
    if (featureLinkOpen) return setFeatureLinkDraft(null);
    if (featurePrsOpen) return setFeaturePrsOpen(false);
    if (modalOpen || sheetOpen || menuOpen) return false;
    if (compact && drawerOpen) return setDrawerOpen(false);
    if (compact && pane.open) return agentChat.closePane();
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
  const shortcuts: Shortcut[] = [
    {
      id: "search",
      keys: ["mod+k", "/", "mod+f"],
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
    // (specs/agents/coding-agent-ui.feature.md).
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
      keys: ["mod+,", "g s"],
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
      label: onFeaturePage ? "New scenario" : "New feature",
      group: "Create",
      when: () => !quiet && editing === null,
      palette: () => !quietBehindPalette && editing === null,
      run: () => {
        if (onFeaturePage) void newScenario();
        else void createFeature();
      },
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
      id: "open",
      keys: ["enter", "e", "o"],
      label: "Open the selected scenario",
      group: "Scenarios",
      when: () => !quiet && onFeaturePage && selectedScenario !== null,
      run: openSelectedScenario,
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
        if (selected && editing) void copyLink(scenarioPath(selected, editing.scenario));
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
  const moveFeaturePrompt = async () => {
    if (!selected) return;
    const target = await prompt({
      title: "Move to folder",
      hint: "The folder's path, e.g. billing/renewals. Use / for nesting.",
      confirmLabel: "Move",
    });
    if (!target) return;
    await moveTo(selected, target.trim().replace(/^\/+|\/+$/g, ""));
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
    shortcutAction("create", onFeaturePage ? <Plus size={14} /> : <NewFeatureIcon size={14} />),
    action("new-folder", "New folder", <NewFolderIcon size={14} />, () => void createFolder()),
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
    ...(!demo
      ? [
          action("sync", "Sync now", <RefreshCw size={14} />, () => void syncNow()),
          action("repo", "Change data folder", <FolderInput size={14} />, () => void changeRepo()),
        ]
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
  ].filter((x): x is PaletteItem => x !== null);

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
  const repoName = demo ? "demo-data" : dataRepo ? repoDisplayName(dataRepo) : "SpecDriven";
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
  // matches by having a scenario in the chosen status, and by its assignee.
  const matchesFilter = (f: FeatureListing) =>
    (filter.status === null || f.scenarios.some((s) => s.status === filter.status)) &&
    (filter.assignee === null || f.assigned === filter.assignee);
  const me = user?.name || user?.login || user?.username || null;
  const filtering = filter.status !== null || filter.assignee !== null;

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
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(i + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(i - 1);
        return;
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
        // subtree (specs/navigation.feature.md "Scenario navigation").
        if (folderPath === undefined) {
          const file = t.dataset.file;
          if (file === undefined || outlined.has(file)) return;
          e.preventDefault();
          toggleOutline(file);
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
        if (!e.shiftKey || !t.dataset.file) return;
        e.preventDefault();
        setTreeMenu(t.dataset.file);
        return;
      case "ContextMenu":
        if (!t.dataset.file) return;
        e.preventDefault();
        setTreeMenu(t.dataset.file);
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

  if (needsRepo) {
    return (
      <main className="centered">
        <form
          className="repo-prompt"
          onSubmit={(e) => {
            e.preventDefault();
            const input = new FormData(e.currentTarget).get("repo") as string;
            if (input.trim()) saveRepo(input.trim());
          }}
        >
          <h1>SpecDriven</h1>
          <p>No spec data directory configured yet. Enter the path to the spec data directory:</p>
          <div className="input-row">
            <input ref={repoInputRef} name="repo" placeholder="/path/to/spec-data" autoFocus />
            {canChooseFolder && (
              <button type="button" className="browse" onClick={() => void browseIntoRepoInput()}>
                Browse…
              </button>
            )}
          </div>
          <button type="submit" disabled={settingRepo}>
            {settingRepo ? "Checking access…" : "Use this directory"}
          </button>
          {repoError && <p className="error">{repoError}</p>}
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
  // Delete applies to [proposed] scenarios and to drafts (specs/ui.spec.md
  // "Scenario editor") — not to a scenario that isn't part of the
  // feature yet (index === null; a new one autosave has already placed does
  // have an index, and can be deleted). Published ones are immutable, unless
  // deletion is turned on in Settings (specs/editor/spec-editor.feature.md
  // "Delete Published Spec").
  const editingDeletable =
    savedEntry !== null && (savedEntry.status !== "published" || deletePublished);
  const hasProposed = feature?.scenarios.some((s) => s.status === "proposed") ?? false;

  // Settings (specs/ui/ui.feature.md "Settings", specs/user-info-settings.
  // feature.md "open Settings"): a page in the editor pane with the room a
  // dialog lacked — the sections listed on the left, each a titled group of
  // label-left, control-right rows. Every control saves itself the moment it
  // changes (macOS style), so there is no Save button; the ✕ or ESC goes
  // back. The plugins have their own page, linked under the sections.
  const renderSettingsPage = () => (
    <AppPageLayout
      title="Settings"
      sections={[
        { id: "settings-general", title: "General" },
        ...(demo ? [] : [{ id: "settings-sync", title: "Sync" }]),
        { id: "settings-editor", title: "Specs" },
        { id: "settings-project", title: "Project management" },
        { id: "settings-workflow", title: "Workflow" },
        ...(demo ? [] : [{ id: "settings-git", title: "Git & GitHub" }]),
      ]}
      onClose={closeAppPage}
      actions={<span className="app-page-status">Saved to .specdriven/settings.json as you change it</span>}
      aside={
        <button type="button" className="app-page-nav-link" onClick={openPlugins}>
          <Puzzle size={13} aria-hidden="true" /> Plugins
        </button>
      }
    >
      <PageSection
        id="settings-general"
        title="General"
        hint="How the app looks and which editing aids it offers. These are remembered on this device, not in the settings file."
      >
        {/* Appearance (specs/ui.spec.md "Settings"): applied right away
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
            on this device like the theme (src/frontend/VimEditor.tsx).
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
      {/* Demo mode has nothing to sync with: the whole autosync/live
          sync group hides — the server refuses the changes anyway. */}
      {!demo && (
      <PageSection
        id="settings-sync"
        title="Sync"
        hint="How the data repo is pulled and pushed, and whether running apps share edits live."
      >
        {/* Autosync (specs/ui.spec.md "Settings"): the switch is on by
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
        {/* Live sync (specs/automerge-store.spec.md): opt-in websocket
            accelerator on top of git, with an explicit privacy warning. */}
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
      <PageSection
        id="settings-editor"
        title="Specs"
        hint="How the scenario editor saves and how scenarios read in the feature list."
      >
        {/* Editor autosave (specs/editor-autosave.feature.md): the open
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
        {/* specs/traceability.spec.md: the test-links table is optional,
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
      </PageSection>
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
      <PageSection
        id="settings-workflow"
        title="Workflow"
        hint="What the app lets people do with specs: hand them to a coding agent, assign them, schedule them, delete them."
      >
        {/* Code gen (specs/agents/claude.spec.md): off takes the selection
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
        {/* Deleting published scenarios
            (specs/editor/spec-editor.feature.md "Delete Published
            Spec"): opt-in — with the switch off published scenarios
            stay immutable and the editor offers no Delete for them. */}
        <label className="settings-row">
          <span className="settings-row-label">
            Allow deleting published specs
            <span className="settings-row-hint">
              {settingsDeletePublishedDraft
                ? "The editor offers Delete on published scenarios, behind a Danger Zone confirmation. The deletion is committed and pushed."
                : "Published scenarios are immutable and cannot be deleted."}
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
      {/* Git engine (specs/git-operations.spec.md): which one carries
          the operations out and who supplies GitHub credentials.
          Hidden in demo mode along with the sign-in — the demo
          dataset never syncs with GitHub. */}
      {!demo && (
      <PageSection
        id="settings-git"
        title="Git & GitHub"
        hint="Which git carries the syncing and publishing out, and the GitHub account it uses."
      >
        <label className="settings-row">
          <span className="settings-row-label">
            Git engine
            <span className="settings-row-hint">
              {gitEngineEffective === "gh"
                ? "The GitHub CLI is in use: gh supplies the credentials and clones, on top of the git binary on this machine."
                : gitEngineEffective === "js"
                  ? "The built-in engine is in use: git implemented in JavaScript, running inside the app, so nothing needs to be installed. It authenticates with the account signed in below."
                  : "System git runs the git binary on this machine, authenticating with the account signed in below, or with git's own credentials."}
            </span>
          </span>
          <select
            value={settingsEngineDraft}
            onChange={(e) => void pickGitEngine(e.target.value)}
          >
            <option value="auto">
              Automatic — GitHub CLI when installed (recommended)
            </option>
            <option value="gh" disabled={!gh?.available}>
              GitHub CLI (gh){gh?.available ? "" : " — not installed"}
            </option>
            <option value="cli" disabled={!cliGitAvailable}>
              System git{cliGitAvailable ? "" : " — not installed"}
            </option>
            {/* Bundled with the app, so never disabled. */}
            <option value="js">Built-in (no git needed)</option>
          </select>
        </label>
        {/* GitHub sign-in (specs/git-operations.spec.md): the gh account
            when that engine is in effect, else the device flow. */}
        <div className="settings-row auth-section">
          <span className="auth-title">GitHub account</span>
          {gh?.available && (
            <p className="hint">
              {gh.signedIn ? (
                <>
                  GitHub CLI signed in
                  {gh.login ? (
                    <>
                      {" "}
                      as <strong>{gh.login}</strong>
                    </>
                  ) : null}
                  .
                </>
              ) : (
                <>
                  GitHub CLI installed but signed out — run <code>gh auth login</code>,
                  then reopen Settings.
                </>
              )}
            </p>
          )}
          {auth?.signedIn ? (
            <div className="auth-row">
              <span>
                Signed in as <strong>{auth.login}</strong>
              </span>
              <button className="secondary" onClick={signOutGitHub}>
                Sign out
              </button>
            </div>
          ) : deviceFlow ? (
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
          {authStatus && <p className="error">{authStatus}</p>}
          <p className="hint">
            Publishing to GitHub uses the GitHub CLI's account on the gh engine, and this
            sign-in on the system git and built-in ones. Local folders work without
            either.
          </p>
        </div>
      </PageSection>
      )}
      {settingsError && <p className="error settings-error">{settingsError}</p>}
    </AppPageLayout>
  );

  return (
    <main
      className={`layout${resizingSidebar || resizingAgent ? " resizing" : ""}${sidebarCollapsed && !compact ? " collapsed" : ""}${compact ? " compact" : ""}${paneShown && !compact ? " agent-open" : ""}${editorOff ? " editor-hidden" : ""}`}
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
          <Tooltip label="Expand the sidebar" keys="[">
            <button type="button" className="rail-btn" aria-label="Expand the sidebar" onClick={toggleSidebar}>
              <Logo size={24} />
            </button>
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
          <Tooltip label="Home" keys="g h">
            <a
              href="/"
              className={`rail-link${!selected && !pluginView ? " active" : ""}`}
              aria-label="Home"
              onClick={(e) =>
                spaClick(e, () => {
                  goHome();
                  void loadReadme();
                })
              }
            >
              <Home size={16} aria-hidden="true" />
            </a>
          </Tooltip>
          {/* The plugins' tabs — the special folders first. A tab with nothing
              to open — an empty folder — has no icon on the rail. */}
          {pluginTabs.filter(tabReachable).map((tab) => (
            <Tooltip key={tab.id} label={tab.title} keys={tab.shortcut}>
              <a
                href={tab.route.path(tab.route.home)}
                className={`rail-link${pluginView?.tab === tab.id ? " active" : ""}`}
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
            <Tooltip label="Settings" keys="mod+,">
              <button type="button" className="rail-btn" aria-label="Settings" onClick={() => openSettings()}>
                <span className="avatar" aria-hidden="true">
                  {initials}
                </span>
              </button>
            </Tooltip>
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
              vertical space. It is the home link (specs/app-startup.feature.md
              "The data folder name links to the README"): a real `/` anchor,
              so a plain click opens the README editor and right-click → Copy
              Link works. */}
          <div className="repo-row">
            {dataRepo && (
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
            {dataRepo && !demo && (
              <div className="repo-recent">
                <button
                  type="button"
                  className="repo-recent-toggle"
                  title="Recent data folders"
                  aria-label="Recent data folders"
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
                  label="Recent data folders"
                  className="repo-recent-menu"
                  containerSelector=".repo-recent"
                  items={[
                    ...recentRepos.map(
                      (repo): MenuItem => {
                        const current = repo === dataRepo;
                        return {
                          id: repo,
                          label: repoDisplayName(repo),
                          title: repo,
                          checked: current,
                          onSelect: () => {
                            if (current) {
                              goHome();
                              void loadReadme();
                            } else {
                              void switchRepo(repo);
                            }
                          },
                        };
                      },
                    ),
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
            {!demo && (
              <Tooltip label="Change data directory">
                <button
                  type="button"
                  className="repo-edit"
                  aria-label="Change data directory"
                  disabled={settingRepo}
                  onClick={() => void changeRepo()}
                >
                  <Pencil size={13} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
            {/* Sync (specs/ui.spec.md "Main page"): immediate data reload,
                next to the folder it reloads. Disabled with a progress label
                while running, the icon turning; no status line at the bottom
                of the page. Up here it works from the home view too, not
                only with a feature open. */}
            {!demo && (
              <button
                type="button"
                className="repo-sync"
                title="Sync — pull the data folder and push saved changes"
                disabled={syncing}
                onClick={() => void syncNow()}
              >
                <RefreshCw
                  size={14}
                  className={syncing ? "sync-icon spinning" : "sync-icon"}
                  aria-hidden="true"
                />
                {syncing ? "Syncing…" : "Sync"}
              </button>
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
        {/* Search (specs/search.spec.md): top-left, under the header so the
            macOS drag region above it stays draggable. The field opens the
            command palette, where the results are. */}
        <div className="sidebar-search">
          <button
            type="button"
            className="sidebar-search-btn"
            aria-label="Search specs or run a command"
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
        {pluginTabs.length > 0 && (
          <div className="side-tabs" role="tablist" aria-label="Sidebar">
            <button
              type="button"
              role="tab"
              id="side-tab-specs"
              aria-selected={shownTab === "specs"}
              aria-controls="side-panel-specs"
              className={shownTab === "specs" ? "active" : ""}
              onClick={() => selectSidebarTab("specs")}
            >
              <FileText size={14} aria-hidden="true" /> Specs
            </button>
            {/* The plugins' tabs (specs/app/plugins.feature.md), in their
                order, after the core's. */}
            {pluginTabs.map((tab) => (
              <button
                key={tab.id}
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
                <tab.icon size={14} aria-hidden="true" /> {tab.title}
              </button>
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
        <div className="section-head">
          Features
          <span className="filter-anchor">
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
              ]}
            />
          </span>
          {/* The tree's actions (src/frontend/ActionIcons.tsx) sit on its
              head rather than in rows of their own. New folder and New
              feature create inside the clicked folder, and their tooltips
              name it. Code gen session (specs/agents/claude.spec.md): check
              whole specs in the tree or single scenarios on their cards,
              then Start session asks for a name and where to run; the
              count of checked specs rides on its button. Timing your own
              work is the Pomodoro at the foot of the sidebar
              (specs/app/pomodoro.feature.md), not a kind of session. */}
          <span className="head-actions">
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
            <Tooltip
              label={
                sessionRunning
                  ? "Session running…"
                  : codeGen && sessionCount > 0
                    ? `Start an AI session in ${CODE_GEN_TARGET_LABEL[sessionTarget]} with ${selectionLabel}`
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
          </span>
        </div>
        {(filter.status || filter.assignee) && (
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
          </div>
        )}
        {/* What a session would run over, so a scenario checked on a card
            two clicks away is still visible from here. */}
        {codeGen && selectionLabel && !sessionRunning && (
          <p className="session-notice">Selected: {selectionLabel}</p>
        )}
        {sessionNotice && <p className="session-notice">{sessionNotice}</p>}
        {/* Folder tree (specs/folders.spec.md): folders are drop targets
            for drag-moving features; the tree background is the top level. */}
        {(
          <div
            className={`tree${dragging !== null && dropTarget === "" ? " drop-target" : ""}`}
            role="tree"
            aria-label="Features"
            onKeyDown={onTreeKeyDown}
            onClick={(e) => {
              // A click on the bare background deselects the folder, so the
              // next "+ New folder" creates at the top level again.
              if (e.target === e.currentTarget) setSelectedFolder(null);
            }}
            onDragOver={(e) => {
              if (dragging === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropTarget("");
            }}
            onDragLeave={() => setDropTarget((t) => (t === "" ? null : t))}
            onDrop={(e) => {
              if (dragging === null) return;
              e.preventDefault();
              void moveTo(dragging, "");
            }}
          >
            {renderTree(buildTree(folders, features), 0)}
            {features.length === 0 && folders.length === 0 && (
              <p className="empty">No feature files yet</p>
            )}
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
        {/* specs/user-info-settings.spec.md: the lower left corner shows the
            current user; its menu holds User info, Settings and Plugins. */}
        <div className="user-corner">
          <Menu
            open={userMenuOpen}
            onClose={() => setUserMenuOpen(false)}
            label="User menu"
            className="user-menu"
            containerSelector=".user-corner"
            items={[
              {
                id: "user-info",
                label: "User info",
                icon: <UserRound size={13} />,
                onSelect: () => {
                  setDrawerOpen(false);
                  setUserInfoOpen(true);
                },
              },
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
            ]}
          />
          <button
            className="user-chip"
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            onClick={() => setUserMenuOpen((o) => !o)}
          >
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
            <span className="user-name">{user ? (user.login ?? user.username) : "…"}</span>
            {/* Demo mode: the build on screen, right of the user name. */}
            {demo && appVersion && <span className="app-version">v{appVersion}</span>}
          </button>
        </div>
      </aside>
      )}
      {/* Divider (specs/ui.spec.md "Sidebar resize"): drag to resize the
          left pane, double-click to restore the default width. Gone while
          the sidebar is a rail, and on one-pane screens. */}
      {!sidebarCollapsed && !compact && (
      <div
        className="sidebar-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN}
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
        {appPage === "settings" ? (
          renderSettingsPage()
        ) : appPage === "plugins" ? (
          /* Plugins (specs/app/plugins.feature.md): its own page, opened
             from the user menu — the plugins on in tab order, the ones off,
             the folders they load from and the marketplaces. */
          <PluginsPage
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
            browseFolder={canChooseFolder ? chooseFolderNative : undefined}
            onChanged={refreshPlugins}
            onOpenSettings={openSettings}
            onClose={closeAppPage}
          />
        ) : appPage === "observability" ? (
          /* Observability: browse and search the app's own logs, and set
             how verbose they are. */
          <ObservabilityPage onClose={closeAppPage} copyText={copyText} />
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
                <SaveIndicator saving={saving} savedAt={savedAt} dirty={dirty} />
                {/* Proposed scenarios and drafts can be deleted
                    (specs/editor/spec-editor.feature.md) — published ones too
                    while Settings allows it ("Delete Published Spec") —
                    confirmed first, then saved out of the feature or removed
                    from the document. Kept apart from Propose/Publish, at the
                    head of the actions. */}
                {editingDeletable && (
                  <button className="danger" onClick={() => void deleteScenario()}>
                    Delete
                  </button>
                )}
                {/* The two ways forward (specs/editor/spec-editor.feature.md):
                    Propose moves the draft into the .feature.md as [proposed];
                    Publish takes it straight to [published], committed and
                    pushed. Closing without either keeps the autosaved draft.
                    Propose is only offered on a draft — an already proposed
                    scenario has nowhere left to go but Publish. */}
                {!editingPublished && (
                  <>
                    {editing.scenario.status === "draft" && (
                      <button
                        className="secondary"
                        onClick={() => void proposeScenario()}
                        disabled={!editing.scenario.name.trim()}
                      >
                        Propose
                      </button>
                    )}
                    <button
                      onClick={() => void publishScenario()}
                      disabled={!editing.scenario.name.trim() || publishing !== null}
                    >
                      Publish
                    </button>
                  </>
                )}
                {/* A published scenario is read-only apart from its links —
                    test links and its ticket — and those save themselves:
                    autosave writes them locally like any other edit, and Sync
                    pushes them. So its bar carries no save action at all. */}
              </div>
            </div>
            {/* The scenario's name sits above the editor's top left corner
                (specs/editor/spec-editor.feature.md "Adding Scanarios") —
                editable until published (specs/ui.spec.md "Scenario editor"),
                a read-only heading after. The version is assigned by the app,
                never typed: a new scenario takes the next version for its name
                (specs/ui.spec.md). The status rides along as a badge: a
                scenario starts as a draft — persisted by autosave, kept out of
                the .feature.md — until Propose or Publish advances it. */}
            <div className="scenario-pane-head">
              {editingPublished ? (
                <h2 className="scenario-pane-heading">{editing.scenario.name}</h2>
              ) : (
                <input
                  className="scenario-pane-name"
                  // While this field has the caret autosave stands down, so
                  // the name is saved once, whole
                  // (specs/editor-autosave.feature.md).
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
              <p className="version-field">
                Version <span className="version">v{draftVersion}</span>
                <span className="status-field">
                  <StatusIcon status={editing.scenario.status} size={14} />
                  {editing.scenario.status}
                </span>
              </p>
            </div>
            <div className="scenario-pane-body">
              <div className="body-field">
                <span className="field-label">Body</span>
                <MarkdownEditor
                  value={editing.scenario.body}
                  readOnly={editingPublished}
                  highlight={searchTerms ?? undefined}
                  placeholder="Describe the scenario in Markdown…"
                  onChange={(body) =>
                    setEditing({ ...editing, scenario: { ...editing.scenario, body } })
                  }
                />
              </div>
              {!editingPublished && (
                // specs/scenario-table.spec.md: structured view over the
                // markdown table stored in the body.
                <div className="table-field">
                  <span className="field-label">Scenario table</span>
                  <ScenarioTable
                    body={editing.scenario.body}
                    onChange={(body) =>
                      setEditing({ ...editing, scenario: { ...editing.scenario, body } })
                    }
                  />
                </div>
              )}
              {/* specs/traceability.spec.md: GitHub links to the automated
                  tests covering this scenario — added, corrected in place (✎)
                  and removed (✕). Editable even for a published scenario: the
                  links track the tests, not the immutable spec. Hidden
                  entirely when the Settings toggle is off. */}
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
                                // whole editor pane (specs/ui.spec.md).
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
            </div>
          </div>
        ) : selected && feature ? (
          <>
            <header className="editor-bar page-header">
              {/* specs/ui.spec.md "Main page": the trail ends in the feature
                  name (the file's `# <name>` heading), never the file name.
                  Clicking the name edits it — committed and pushed on the
                  server; the file name never changes. */}
              <Breadcrumbs
                items={[repoCrumb, ...folderCrumbs(selected), ...pluginCrumbs(selected)]}
                tail={
                  renameDraft === null ? (
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
                          if (e.key === "Escape") setRenameDraft(null);
                        }}
                      />
                      <button
                        type="submit"
                        className="link"
                        disabled={renaming || !renameDraft.trim()}
                      >
                        {renaming ? "Renaming…" : "Save"}
                      </button>
                      <button type="button" className="link" onClick={() => setRenameDraft(null)}>
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
                <Tooltip
                  label={copied === featurePath(selected) ? "Copied" : "Copy link"}
                  keys="mod+shift+c"
                >
                  <button
                    type="button"
                    className="ibtn"
                    aria-label="Copy link"
                    onClick={() => void copyLink(featurePath(selected))}
                  >
                    {copied === featurePath(selected) ? (
                      <Check size={15} aria-hidden="true" />
                    ) : (
                      <Link size={15} aria-hidden="true" />
                    )}
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
                {/* Publish All (specs/crud-feature.spec.md "publish each
                    scenario individually"): marks every scenario published;
                    individual scenarios publish from their cards. The dot
                    means there is something unpublished. Sync lives in the
                    sidebar header, beside the data folder. */}
                <button
                  className="primary-action"
                  onClick={() => void publish()}
                  disabled={publishing !== null}
                >
                  {publishing === "all" ? "Publishing…" : "Publish all"}
                  {publishing === null && (dirty || hasProposed) && (
                    <span className="dot" role="img" aria-label="unpublished changes" />
                  )}
                </button>
              </div>
            </header>
            {/* Properties as chips (specs/ui/ui.feature.md "Design system"):
                the publish rollup; the assignee (src/server/members.ts —
                the data repo's project-settings.json, saved on the spot,
                off unless Settings turns assignments on); the ticket
                (specs/external-links/project-management-jira-linear-etc
                .feature.md "Add link to feature"), edited in a popover. */}
            <div className="props">
              <span className="chip static">
                <StatusIcon status="published" size={14} />
                {feature.scenarios.filter((s) => s.status === "published").length} /{" "}
                {feature.scenarios.length} published
              </span>
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
                  <button
                    type="button"
                    className={`chip${feature.link ? "" : " muted"}`}
                    aria-haspopup="dialog"
                    aria-expanded={featureLinkOpen}
                    onClick={() => {
                      if (featureLinkOpen) {
                        setFeatureLinkDraft(null);
                      } else {
                        setFeatureLinkError(null);
                        setFeatureLinkDraft(linkDraftOf(feature.link));
                      }
                    }}
                  >
                    <Ticket size={14} aria-hidden="true" />
                    {feature.link ? externalLinkLabel(feature.link) : "Link ticket"}
                  </button>
                  {feature.link && (
                    <a
                      className="chip-ext"
                      href={feature.link.url}
                      target="_blank"
                      rel="noreferrer"
                      title={feature.link.url}
                      aria-label={`Open ${externalLinkLabel(feature.link)}`}
                    >
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                  <Popover
                    open={featureLinkOpen}
                    onClose={() => setFeatureLinkDraft(null)}
                    label="Ticket for this feature"
                    className="chip-popover"
                    containerSelector=".ticket-anchor"
                  >
                    {featureLinkDraft !== null && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveFeatureLink();
                        }}
                      >
                        <p className="hint">
                          The {projectManagementTool} ticket that tracks this feature. Clear
                          the url to remove the link.
                        </p>
                        <div className="link-field">
                          <ExternalLinkField
                            draft={featureLinkDraft}
                            onChange={(draft) => {
                              setFeatureLinkError(null);
                              setFeatureLinkDraft(draft);
                            }}
                            error={featureLinkError}
                            autoFocus
                            tool={projectManagementTool}
                          />
                        </div>
                        <div className="dialog-actions">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setFeatureLinkDraft(null)}
                          >
                            Cancel
                          </button>
                          <button type="submit" disabled={featureLinkSaving}>
                            {featureLinkSaving
                              ? "Saving…"
                              : feature.link && isBlankLinkDraft(featureLinkDraft)
                                ? "Remove link"
                                : "Save"}
                          </button>
                        </div>
                      </form>
                    )}
                  </Popover>
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
                    <button type="button" className="secondary" onClick={() => setFeaturePrsOpen(false)}>
                      Close
                    </button>
                  </div>
                </Popover>
              </span>
            </div>
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
                <span className="readme-hint">
                  Saved automatically every {autosaveSeconds} seconds; the next sync pushes it.
                  Done shows it rendered.
                </span>
                {/* The editor's lower boundary is a grab strip: drag it to give
                    the description more or less room, double-click to restore
                    the default third of the window. Sized like the sidebar
                    divider, and nudged by the arrow keys when focused. */}
                <div
                  className="desc-resizer"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize the description editor"
                  aria-valuemin={DESC_MIN}
                  aria-valuenow={descHeight ?? undefined}
                  tabIndex={0}
                  onPointerDown={(e) => {
                    const pane = descPaneRef.current;
                    if (!pane) return;
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    // From wherever the pane stands now, so the first drag off
                    // the CSS default doesn't jump.
                    descDrag.current = { y: e.clientY, height: pane.getBoundingClientRect().height };
                    setResizingDesc(true);
                  }}
                  onPointerMove={(e) => {
                    const start = descDrag.current;
                    if (!start) return;
                    setDescHeight(
                      clampDescHeight(start.height + (e.clientY - start.y), window.innerHeight),
                    );
                  }}
                  onPointerUp={(e) => {
                    const start = descDrag.current;
                    if (!start) return;
                    descDrag.current = null;
                    setResizingDesc(false);
                    storeDescHeight(
                      clampDescHeight(start.height + (e.clientY - start.y), window.innerHeight),
                    );
                  }}
                  onLostPointerCapture={() => {
                    descDrag.current = null;
                    setResizingDesc(false);
                  }}
                  onDoubleClick={() => {
                    setDescHeight(null);
                    clearDescHeight();
                  }}
                  onKeyDown={(e) => {
                    const delta = e.key === "ArrowDown" ? 16 : e.key === "ArrowUp" ? -16 : 0;
                    if (delta === 0) return;
                    e.preventDefault();
                    const from = descHeight ?? descPaneRef.current?.getBoundingClientRect().height;
                    if (from === undefined) return;
                    const h = clampDescHeight(from + delta, window.innerHeight);
                    setDescHeight(h);
                    storeDescHeight(h);
                  }}
                />
              </div>
            ) : (
              feature.description && (
                /* Clicking the rendered description opens the editor too —
                   links inside it still open as links. */
                <div
                  className="feature-desc md-preview editable"
                  title="Click to edit the description"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a")) return;
                    openDescriptionEditor(selected, feature.description);
                  }}
                >
                  {renderMarkdown(feature.description)}
                </div>
              )
            )}
            {/* specs/ui.spec.md "Scenario List": each card renders its body as
                a Markdown preview, clamped to n lines (n set in Settings). */}
            <div
              className="scenarios"
              style={{ "--preview-lines": previewLines } as CSSProperties}
            >
              {feature.scenarios.map((s, i) =>
                filter.status !== null && s.status !== filter.status ? null : (
                <article
                  key={i}
                  ref={(el) => {
                    scenarioRefs.current[i] = el;
                  }}
                  className={`scenario-card ${s.status}${i === selectedScenario ? " selected" : ""}`}
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
                    if (isCardControl(e.target)) return;
                    e.preventDefault();
                    setSelectedScenario(i);
                    setCardMenu(i);
                  }}
                >
                  <header>
                    <span className="scenario-title">
                      {/* Code gen selection (specs/agents/claude.spec.md): a
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
                          (specs/navigation.spec.md "share a link"). */}
                      {/* Status as a glyph, not a word (specs/ui/ui.feature.md
                          "Design system"): draft, proposed or published. */}
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
                    </span>
                    <span className="card-actions">
                      {/* Edit up front, the rest behind ⋯ — Publish or New
                          version, Copy link (specs/crud-feature.spec.md
                          "publish each scenario individually"). Shown while
                          the card is hovered, focused or selected; a
                          right-click opens the same menu. A published card's
                          Edit opens the same pane: its test links
                          (specs/traceability.spec.md) and its ticket link
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
                                icon: <Plus size={13} />,
                                onSelect: () => newVersion(i),
                              },
                          {
                            id: "copy",
                            label: copied === scenarioPath(selected, s) ? "Copied" : "Copy link",
                            icon: <Link size={13} />,
                            onSelect: () => void copyLink(scenarioPath(selected, s)),
                          },
                        ]}
                      />
                    </span>
                  </header>
                  {s.body && (
                    <div className="md-preview scenario-body">{renderMarkdown(s.body)}</div>
                  )}
                  {/* specs/traceability.spec.md: links to the automated tests,
                      as a table at the end of the scenario. Optional — the
                      Settings toggle hides it (default ON). */}
                  {showTestLinks && testsTable(s.tests)}
                  {/* specs/external-links/related-pull-requests.feature.md
                      "The scenario card lists its pull requests". */}
                  {s.prs && s.prs.length > 0 && (
                    <div className="scenario-prs">
                      <span className="scenario-prs-head">Pull requests</span>
                      <PullRequestList prs={s.prs} />
                    </div>
                  )}
                </article>
                ),
              )}
              {filter.status !== null &&
                feature.scenarios.length > 0 &&
                !feature.scenarios.some((s) => s.status === filter.status) && (
                  <p className="empty">
                    No {filter.status} scenarios here — the sidebar filter hides the rest.
                  </p>
                )}
              {feature.scenarios.length === 0 && <p className="empty">No scenarios yet.</p>}
            </div>
            <div>
              <button className="add-spec" onClick={() => void newScenario()}>
                + Add Scenario
              </button>
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
            {/* Home (specs/app-startup.feature.md "App Starts with existing
                specs folder selected"): the data repo's README.md, open for
                editing and autosaved at the scenario editor's interval. */}
            <header className="editor-bar page-header">
              <Breadcrumbs
                items={[repoCrumb]}
                tail={<span className="crumb current plain">README.md</span>}
              />
              <div className="editor-actions page-actions">
                <SaveIndicator
                  saving={saving}
                  savedAt={savedAt}
                  dirty={readme !== null && readme !== readmeSaved.current}
                />
                <span className="readme-hint">
                  {readme === null
                    ? "Loading…"
                    : `Autosaves every ${autosaveSeconds}s; the next sync pushes it.`}
                </span>
              </div>
            </header>
            {readme !== null && (
              <MarkdownEditor
                value={readme}
                onChange={setReadme}
                placeholder="This data folder has no README.md yet — write one here and it is created on the next autosave."
              />
            )}
            {/* A stale deep link lands here with a note (specs/navigation.spec.md). */}
          </>
        )}
        </ErrorBoundary>
      </section>
      )}
      {/* Coding agent pane (specs/agents/coding-agent-ui.feature.md): a third
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
          compact={compact}
          demo={demo}
          codeRepo={codeRepo}
          dataRepo={dataRepo}
          onClose={() => agentChat.closePane()}
        />
      )}
      {/* specs/crud-feature.spec.md "Publish feature with merge conflict": a
          dialog rather than a strip appended to the page, so the two sides
          never push the resolutions out of view. The dialog is capped to the
          window; each side scrolls inside its own pane and the three
          resolutions stay pinned at the bottom (specs/ui.spec.md "Merge
          conflict dialog"). */}
      {conflict && (
        <div className="dialog-backdrop" onClick={() => resolving === null && dismissConflict()}>
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
                spellCheck={false}
              />
            </section>
            <div className="dialog-actions conflict-actions">
              <button
                className="secondary"
                onClick={dismissConflict}
                disabled={resolving !== null}
              >
                Cancel
              </button>
              <button
                onClick={() => void resolveWith("ours", conflict.ours)}
                disabled={resolving !== null}
              >
                {resolving === "ours" ? "Publishing…" : "Accept yours"}
              </button>
              <button
                onClick={() => void resolveWith("theirs", conflict.theirs)}
                disabled={resolving !== null}
              >
                {resolving === "theirs" ? "Publishing…" : "Accept theirs"}
              </button>
              <button
                onClick={() => void resolveWith("draft", conflictDraft)}
                disabled={resolving !== null}
              >
                {resolving === "draft" ? "Publishing…" : "Publish manual edit"}
              </button>
            </div>
          </div>
        </div>
      )}
      {userInfoOpen && (
        <div className="dialog-backdrop" onClick={() => setUserInfoOpen(false)}>
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
              <dt>Email</dt>
              <dd>{user?.email ?? <span className="unset">not set</span>}</dd>
            </dl>
            <p className="hint">
              Commits to the data repo are authored with this identity — the signed-in
              GitHub account, or the system git identity when signed out.
            </p>
            <div className="dialog-actions">
              <button autoFocus onClick={() => setUserInfoOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Manage specification folders (specs/app/spec-folders.feature.md):
          open, remove or add spec folders. Opening one closes this and runs
          the same switch the recent menu does. */}
      {foldersOpen && (
        <SpecFoldersDialog
          folders={recentRepos}
          current={dataRepo}
          busy={settingRepo}
          trapRef={foldersTrapRef}
          onClose={() => setFoldersOpen(false)}
          onOpen={(folder) => {
            setFoldersOpen(false);
            void switchRepo(folder);
          }}
          onRemove={(folder) => void forgetRepo(folder)}
          onAdd={() => {
            setFoldersOpen(false);
            void changeRepo();
          }}
        />
      )}
      {/* Error box (specs/agents/claude.spec.md): what the coding agent said
          when it exited with an error code. */}
      {sessionError && (
        <div className="dialog-backdrop" onClick={() => setSessionError(null)}>
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
              <button onClick={() => setSessionError(null)}>Close</button>
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

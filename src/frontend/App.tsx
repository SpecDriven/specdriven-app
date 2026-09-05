import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import {
  parseFeature,
  parsePage,
  serializeFeature,
  serializePage,
  slugify,
  sortScenarios,
  titleFromFileName,
} from "../server/parser";
import type { Feature, Scenario, ScenarioPick, ScenarioTarget } from "../server/parser";
import type { FeatureListing } from "../server/features";
import type { ProjectMember } from "../server/members";
import type { PageListing } from "../server/pages";
import type { SearchResultItem } from "../server/search";
import type { CurrentUser } from "../server/user";
import type { CodeGenTarget } from "../server/state";
import { Logo } from "./Logo";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ExternalLink,
  FileText,
  FolderInput,
  Home,
  Keyboard,
  Link,
  ListFilter,
  ListTodo,
  Map as MapIcon,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
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
import { Tooltip } from "./Tooltip";
import { Menu } from "./Menu";
import { Popover } from "./Popover";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";
import { CommandPalette, type PaletteItem } from "./CommandPalette";
import { ErrorBoundary } from "./ErrorBoundary";
import { SaveIndicator, Toaster, toast } from "./Toasts";
import { IS_MAC, ShortcutSheet, isTypingTarget, useShortcuts, type Shortcut } from "./shortcuts";
import { MarkdownEditor } from "./MarkdownEditor";
import { markText } from "./highlight";
import { useModalPrompts } from "./ModalPrompts";
import { renderMarkdown } from "./markdown";
import { AgentPane } from "./AgentPane";
import {
  AGENT_DEFAULT_WIDTH,
  AGENT_MIN_WIDTH,
  agentChat,
  clampAgentWidth,
  defaultSessionName,
  useAgentChat,
} from "./agentChat";
import { ExternalLinkField } from "./ExternalLinkField";
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
  desktopLink,
  featurePath,
  pagePath,
  parseRoute,
  repoDisplayName,
  resolveScenario,
  pageFolderOf,
  pageLink,
  scenarioPath,
} from "./route";
import {
  addTestLink,
  canSetTestLink,
  removeTestLink,
  resolvePendingTests,
  testLinkLabel,
  updateTestLink,
} from "./testlinks";
import { buildTree } from "./tree";
import type { FolderNode } from "./tree";
import { useFocusTrap } from "./useFocusTrap";
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

// The sidebar's tabs (specs/app/roadmap.feature.md, specs/app/tasks.feature
// .md): Specs, the feature tree, and one tab per special folder the settings
// show — Roadmap and Tasks, each a list of markdown pages. They all share the
// one column, so the choice is remembered like the sidebar width: a tab left
// open is meant to stay open, not to reset on every reload.
interface PageTab {
  /** The data repo's folder — the tab's id, and its `/api/<folder>` routes. */
  folder: "roadmap" | "tasks";
  /** The tab's label, the breadcrumb above one of its pages, and the palette
      group its pages fall under. */
  title: "Roadmap" | "Tasks";
  /** What one of its pages is called, in buttons and messages. */
  noun: string;
  /** What the tab says when the folder holds nothing yet. */
  empty: string;
  icon: typeof MapIcon;
}

const PAGE_TABS: PageTab[] = [
  { folder: "roadmap", title: "Roadmap", noun: "page", empty: "No roadmap pages yet", icon: MapIcon },
  { folder: "tasks", title: "Tasks", noun: "task", empty: "No tasks yet", icon: ListTodo },
];

/** The tab a page's file name belongs to — its folder is the first segment. */
function pageTabOf(fileName: string): PageTab {
  const folder = pageFolderOf(fileName);
  return PAGE_TABS.find((tab) => tab.folder === folder) ?? PAGE_TABS[0]!;
}

/** The icon of the tab a page belongs to — the map, or the task list. */
function PageTabIcon({ fileName, size = 14 }: { fileName: string; size?: number }) {
  const Icon = pageTabOf(fileName).icon;
  return <Icon size={size} aria-hidden="true" />;
}

type SidebarTab = "specs" | PageTab["folder"];

function readSidebarTab(): SidebarTab {
  try {
    const stored = localStorage.getItem("sd-sidebar-tab");
    return PAGE_TABS.find((tab) => tab.folder === stored)?.folder ?? "specs";
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
  return JSON.stringify([s.name, version, s.status, s.body, s.tests, s.link ?? null]);
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
  const i = scenarios.findIndex((sc) => sc.name === s.name && sc.version === s.version);
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
  /** `page` covers both special folders; `roadmap` is what older lists hold. */
  kind: "feature" | "scenario" | "page";
  fileName: string;
  name: string;
  scenario?: { name: string; version: number };
}

const RECENT_KEY = "sd-recent";

function readRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as RecentEntry[]) : [];
    if (!Array.isArray(list)) return [];
    // A list written before the tasks folder existed calls its pages
    // "roadmap"; they are pages like any other.
    return list
      .slice(0, 8)
      .map((e) => ((e.kind as string) === "roadmap" ? { ...e, kind: "page" as const } : e));
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
// coding agent pane (specs/agents/coding-agent-ui.feature.md) with Claude or
// with Pi (specs/agents/integration-with-pi-dev-agent.feature.md).
export type { CodeGenTarget };

/** The stored target as the server reports it; anything else is "not chosen". */
export function readCodeGenTarget(value: unknown): CodeGenTarget | null {
  return value === "desktop" || value === "pane" || value === "pi" ? value : null;
}

export const CODE_GEN_TARGET_LABEL: Record<CodeGenTarget, string> = {
  desktop: "Claude Code Desktop",
  pane: "Coding agent pane",
  pi: "Pi in the coding agent pane",
};

/** The target a session dialog opens on: the remembered choice when it is
    still usable, else desktop when Claude.app is installed, else the pane
    when the Claude CLI is. Pi is picked, never defaulted to — an unchosen
    dialog opens on it only where there is no Claude at all. With nothing
    installed the answer is desktop, and the server says what is missing. */
export function resolveCodeGenTarget(
  stored: string | null | undefined,
  canOpenDesktop: boolean,
  canRunPane = false,
  canRunPi = false,
): CodeGenTarget {
  if (stored === "desktop" && canOpenDesktop) return "desktop";
  if (stored === "pane" && canRunPane) return "pane";
  if (stored === "pi" && canRunPi) return "pi";
  if (canOpenDesktop) return "desktop";
  if (canRunPane) return "pane";
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

/** The sidebar's filter: features by scenario status and by assignee. */
interface TreeFilter {
  status: Scenario["status"] | null;
  assignee: string | null;
}

/** Pages grouped by the subfolder under their own folder, top level first. */
function pageGroups(pages: PageListing[]): { dir: string; pages: PageListing[] }[] {
  const groups = new Map<string, PageListing[]>();
  for (const page of pages) {
    const dir = page.fileName.split("/").slice(1, -1).join("/");
    const list = groups.get(dir) ?? [];
    list.push(page);
    groups.set(dir, list);
  }
  return [...groups]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([dir, list]) => ({ dir, pages: list }));
}

/** Placeholder for a page while its content is on the way. */
function PageSkeleton({ cards }: { cards: number }) {
  return (
    <div className="skeleton-page" aria-busy="true" aria-label="Loading">
      <div className="skeleton-bar">
        <span className="skeleton" style={{ height: "1.1rem", width: "18rem" }} />
        <span className="skeleton" style={{ height: "1.75rem", width: "6rem", marginLeft: "auto" }} />
      </div>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="skeleton-card">
          <span className="skeleton" style={{ height: "0.9rem", width: `${40 + (i % 3) * 10}%` }} />
          <span className="skeleton" style={{ height: "0.7rem", width: "90%" }} />
          <span className="skeleton" style={{ height: "0.7rem", width: "72%" }} />
        </div>
      ))}
    </div>
  );
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
}

export function App() {
  const [dataRepo, setDataRepo] = useState<string | null>(null);
  // Recent folder list (specs/ui/ui.feature.md "Recent folder list"): the
  // data folders used before, most recent first, up to 10 — what the ▾
  // beside the folder name drops down.
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const [needsRepo, setNeedsRepo] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [settingRepo, setSettingRepo] = useState(false);
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
  /** Whether an assignment change is in flight — the dropdown waits for it. */
  const [assignedSaving, setAssignedSaving] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  /** Folder paths whose subtree is collapsed in the sidebar. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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
  const [pageAssigneeMenuOpen, setPageAssigneeMenuOpen] = useState(false);
  /** Sidebar collapsed to a rail ("["), remembered on this device. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  /** One pane (a phone, a narrow tablet): the sidebar is a drawer over the
      page, closed by default and closed again by navigating anywhere. */
  const compact = useMediaQuery(COMPACT_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTrapRef = useFocusTrap(compact && drawerOpen);
  /** The sidebar's filter, and its menu. */
  const [filter, setFilter] = useState<TreeFilter>({ status: null, assignee: null });
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  /** A page entry's ⋯ menu (file name), if open. */
  const [pageMenu, setPageMenu] = useState<string | null>(null);
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
  /** The same for the open roadmap page's editor. */
  const [pageTerms, setPageTerms] = useState<string[] | null>(null);
  // Editor autosave (specs/editor-autosave.feature.md): the signature of what
  // the open dialog last had saved, and whether a tick is still saving. Refs,
  // because a tick reads them between renders and must not cause one.
  const autosaved = useRef<string | null>(null);
  const autosaveInFlight = useRef(false);
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
  const readmeInFlight = useRef(false);
  /** Bumped per README load, so a save landing after a repo switch stamps nothing. */
  const readmeSession = useRef(0);
  // Test links (specs/traceability.spec.md): the table of automated-test
  // links at the end of each scenario card is optional; default ON.
  const [showTestLinks, setShowTestLinks] = useState(true);
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
  /** The pane is offered when either agent's CLI is on PATH. */
  const canOpenAgentPane = canRunAgentPane || canRunPi;
  // The coding agent pane's own state (src/frontend/agentChat.ts): open,
  // width, sessions. Restored once on boot — the pane, its width and the
  // last session come back the way they were left.
  const pane = useAgentChat();
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
  // The special folders (specs/app/roadmap.feature.md, specs/app/tasks
  // .feature.md): each opt-in — with its switch on, the folder's markdown
  // pages get a sidebar tab and one of them can be open in the main pane.
  // The lists are per folder; the open page is not, since a page and a
  // feature share the one pane. `openPage` is the open page's listing (name
  // and assignment), `openPageText` what its editor holds; the refs are what
  // the last landed save put on disk and whether one is still on its way,
  // read by a tick between renders — the same shape the README editor uses.
  const [roadmap, setRoadmap] = useState(false);
  const [tasks, setTasks] = useState(false);
  const [roadmapPages, setRoadmapPages] = useState<PageListing[]>([]);
  const [taskPages, setTaskPages] = useState<PageListing[]>([]);
  const [openPage, setOpenPage] = useState<PageListing | null>(null);
  const openPageRef = useRef<PageListing | null>(null);
  openPageRef.current = openPage;
  const [openPageText, setOpenPageText] = useState<string | null>(null);
  const openPageTextRef = useRef<string | null>(null);
  openPageTextRef.current = openPageText;
  const openPageSaved = useRef<string | null>(null);
  const openPageInFlight = useRef(false);
  /** Bumped per page load, so a save landing after a move stamps nothing. */
  const openPageSession = useRef(0);
  /** Whether an assignment change on the open page is in flight. */
  const [pageAssignedSaving, setPageAssignedSaving] = useState(false);
  /** The open page's file name — what effects watch, since the listing object
      is replaced on every save and would restart their timers. */
  const openPageFile = openPage?.fileName ?? null;
  /** Which sidebar tab is open — Specs, Roadmap or Tasks; remembered. */
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(readSidebarTab);
  /** The page tabs on offer: one per folder its Settings switch shows. */
  const shownPageTabs = PAGE_TABS.filter((tab) =>
    tab.folder === "tasks" ? tasks : roadmap,
  );
  /** The tab on screen: a page tab only while its switch still shows it. */
  const shownTab: SidebarTab = shownPageTabs.some((tab) => tab.folder === sidebarTab)
    ? sidebarTab
    : "specs";
  /** The pages of one special folder, as the sidebar and palette list them. */
  const pagesIn = (folder: PageTab["folder"]): PageListing[] =>
    folder === "tasks" ? taskPages : roadmapPages;
  // Live sync (specs/automerge-store.spec.md): optional websocket sync
  // server; empty means off — git stays the only transport.
  const [syncServerUrl, setSyncServerUrl] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(String(DEFAULT_AUTOSYNC_SECONDS));
  /** The autosync switch: off saves a frequency of 0, which stops the reload. */
  const [settingsAutosyncOnDraft, setSettingsAutosyncOnDraft] = useState(true);
  const [settingsLinesDraft, setSettingsLinesDraft] = useState("8");
  const [settingsAutosaveDraft, setSettingsAutosaveDraft] = useState(
    String(DEFAULT_AUTOSAVE_SECONDS),
  );
  const [settingsTestLinksDraft, setSettingsTestLinksDraft] = useState(true);
  const [settingsProjectManagementDraft, setSettingsProjectManagementDraft] = useState(true);
  /** The tool name being typed/picked in Settings; saved when it is usable. */
  const [settingsToolDraft, setSettingsToolDraft] = useState(DEFAULT_PROJECT_MANAGEMENT_TOOL);
  const [settingsPublishLinksDraft, setSettingsPublishLinksDraft] = useState(true);
  const [settingsCodeGenDraft, setSettingsCodeGenDraft] = useState(true);
  const [settingsDeletePublishedDraft, setSettingsDeletePublishedDraft] = useState(false);
  const [settingsAssignmentsDraft, setSettingsAssignmentsDraft] = useState(false);
  const [settingsRoadmapDraft, setSettingsRoadmapDraft] = useState(false);
  const [settingsTasksDraft, setSettingsTasksDraft] = useState(false);
  const [settingsSyncDraft, setSettingsSyncDraft] = useState(DEFAULT_SYNC_SERVER_URL);
  /** The Settings switch: off saves an empty url, which turns live sync off. */
  const [settingsSyncOnDraft, setSettingsSyncOnDraft] = useState(false);
  /** Url being typed into the edit dialog's "Add test link" field. */
  const [testDraft, setTestDraft] = useState("");
  /** Index of the test link opened for in-place ✎ editing, if any. */
  const [testEdit, setTestEdit] = useState<number | null>(null);
  const [testEditDraft, setTestEditDraft] = useState("");
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
  const descInFlight = useRef(false);
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
    const res = await fetch("/api/features");
    const data = await res.json();
    if (res.ok) {
      const listing: Listing = {
        features: data.features,
        folders: data.folders ?? [],
        members: Array.isArray(data.members) ? data.members : [],
        codeRepo: typeof data.codeRepo === "string" ? data.codeRepo : null,
      };
      setFeatures(listing.features);
      setFolders(listing.folders);
      setMembers(listing.members);
      setCodeRepo(listing.codeRepo);
      setLoadError(null);
      return listing;
    }
    setLoadError(data.error ?? "Could not load features");
    return null;
  }, []);

  /** One special folder's pages, for its sidebar tab. */
  const loadPages = useCallback(async (folder: PageTab["folder"]): Promise<void> => {
    const res = await fetch(`/api/${folder}`);
    if (!res.ok) return;
    const data = (await res.json()) as { pages?: PageListing[] };
    const pages = Array.isArray(data.pages) ? data.pages : [];
    if (folder === "tasks") setTaskPages(pages);
    else setRoadmapPages(pages);
  }, []);

  /** The pages of whichever folders a settings payload says are shown. */
  const loadShownPages = useCallback(
    async (shown: { roadmap?: unknown; tasks?: unknown }): Promise<void> => {
      await Promise.all(
        PAGE_TABS.filter((tab) => shown[tab.folder] === true).map((tab) => loadPages(tab.folder)),
      );
    },
    [loadPages],
  );

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
      setDataRepo(state.dataRepo);
      setRecentRepos(Array.isArray(state.recentDataRepos) ? state.recentDataRepos : []);
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
      agentChat.setAvailable(Boolean(state.canRunAgentPane), Boolean(state.canRunPi));
      setCodeGenTarget(readCodeGenTarget(state.codeGenTarget));
      if (typeof state.deletePublished === "boolean") {
        setDeletePublished(state.deletePublished);
      }
      if (typeof state.assignments === "boolean") {
        setAssignments(state.assignments);
      }
      if (typeof state.roadmap === "boolean") {
        setRoadmap(state.roadmap);
      }
      if (typeof state.tasks === "boolean") {
        setTasks(state.tasks);
      }
      setSyncServerUrl(typeof state.syncServerUrl === "string" ? state.syncServerUrl : null);
      setCanChooseFolder(Boolean(state.canChooseFolder));
      setDemo(Boolean(state.demo));
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
          // The special folders' pages ride along when they are shown at all.
          loadShownPages(state),
        ]);
        // Deep link (specs/navigation.spec.md): the entry url picks the view.
        await openFromLocation();
      }
      setLoading(false);
    })();
  }, [loadFeatures, loadReadme, loadShownPages]);

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
      if (!selected && !openPageFile && readmeText.current === readmeSaved.current) void loadReadme();
      // The special folders follow the same rule: each shown list refreshes,
      // and the open page only while its editor has nothing unsaved in it.
      for (const tab of PAGE_TABS) {
        if (tab.folder === "tasks" ? tasks : roadmap) void loadPages(tab.folder);
      }
      if (openPageFile && openPageTextRef.current === openPageSaved.current) {
        void showPage(openPageFile);
      }
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
    roadmap,
    tasks,
    openPageFile,
    loadFeatures,
    loadReadme,
    loadPages,
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
    setTestEdit(null);
    // The ticket-link fields open showing the scenario's link, if any.
    setLinkDraft(linkDraftOf(editing?.scenario.link));
  }, [editingOpen]);

  // Autosave measures against what the dialog opened with, so a scenario that
  // is opened and read but not edited is never re-saved
  // (specs/editor-autosave.feature.md).
  useEffect(() => {
    editorSession.current += 1;
    autosaved.current = editing
      ? scenarioSignature(editing.scenario, editing.scenario.version)
      : null;
    autosaveInFlight.current = false;
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
  }, [editingOpen, testDraft, testEditDraft, testEdit]);

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
  const settingsTrapRef = useFocusTrap(settingsOpen);
  const userInfoTrapRef = useFocusTrap(userInfoOpen);
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
  // open, the feature's otherwise. Opening a scenario page pushes, like a
  // feature switch does in openFeature, so Back leaves it the way `<` does.
  // Everything else rewrites in place: a rename moving an open page's url
  // must not leave the retired url behind for Back to land on.
  useEffect(() => {
    if (loading || needsRepo) return;
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
  }, [loading, needsRepo, selected, paneScenario]);

  // Window title follows what is open (specs/navigation.spec.md) — chat and
  // email link previews show it.
  useEffect(() => {
    const s = paneScenario ?? undefined;
    const name = feature && selected ? feature.name || titleFromFileName(selected) : "";
    document.title =
      !selected || !feature
        ? "SpecDriven"
        : s
          ? `SpecDriven — ${name} · ${s.name} v${s.version}`
          : `SpecDriven — ${name}`;
  }, [selected, feature, paneScenario]);

  const saveRepo = async (repo: string) => {
    // Capture the entry url now: once needsRepo flips, the canonical-url
    // effect would rewrite a deep link before we get to honor it
    // (specs/navigation.spec.md "deep link before a data repo is configured").
    const entryPath = location.pathname;
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
        setDataRepo(state.dataRepo);
        setRecentRepos(state.recentDataRepos ?? []);
        setNeedsRepo(false);
        // A freshly picked folder opens on its README, like a start does
        // (specs/app-startup.feature.md "A newly picked data folder opens on
        // its README") — unless there is a deep link to honor. The special
        // folders' pages ride along, as they do on a start with a folder
        // already configured (specs/app/roadmap.feature.md).
        await Promise.all([loadFeatures(), loadReadme(), loadShownPages(state)]);
        await openFromLocation(entryPath);
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
  // the recent folder list (specs/ui/ui.feature.md "Recent folder list").
  const switchRepo = async (next: string) => {
    if (!next || next === dataRepo) return;
    setSettingRepo(true);
    // A README edit belongs to the repo it was typed in: land it there before
    // the switch, and empty the editor so no tick writes it into the new one.
    // The same for an open scenario editor: its last save lands in this repo
    // (specs/editor/spec-editor.feature.md "Spec editor pane").
    await readmeTick.current();
    readmeText.current = null;
    setReadme(null);
    await editorRef.current.close();
    // An open page belongs to the old folder too (specs/app/roadmap.feature
    // .md): its last save goes out there, then the pane empties so no later
    // tick writes what it held into the new folder.
    await pageTick.current();
    closePage({ save: false });
    try {
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataRepo: next }),
      });
      const state = await res.json();
      if (res.ok) {
        setDataRepo(state.dataRepo);
        setRecentRepos(state.recentDataRepos ?? []);
        setSelected(null);
        setFeature(null);
        setSelectedScenario(null);
        // The old folder's pages are not this folder's: the tabs empty, and
        // refill below for whichever folders the settings show.
        setRoadmapPages([]);
        setTaskPages([]);
        // A page url from the old folder would only miss in the new one, and
        // nothing else resets it — the selection was already empty while a
        // page was open, so the canonical-url effect has no change to react
        // to.
        if (location.pathname !== "/") history.replaceState(null, "", "/");
        // Home is the new folder's README (specs/app-startup.feature.md).
        await Promise.all([loadFeatures(), loadReadme(), loadShownPages(state)]);
      } else {
        toast.error(state.error ?? "Could not use this directory");
      }
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
      // Opening a feature leaves the open page, saving what its editor still
      // holds — the same courtesy the README editor gets.
      closePage();
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
    closePage();
    setSelectedFolder(null);
    setSelected(null);
    setFeature(null);
    setSelectedScenario(null);
    if (location.pathname !== "/") history.pushState(null, "", "/");
  };

  /** Derive the view from a url (initial load, popstate, after repo setup). */
  const openFromLocation = async (pathname = location.pathname) => {
    const route = parseRoute(pathname);
    if (route.page) {
      await showPage(route.page);
    } else if (route.feature) {
      // A scenario url is a link to that scenario's page — the card's "Copy
      // link" makes one — so it opens the pane, not just the card
      // (specs/navigation.spec.md "open a scenario link").
      await openFeature(route.feature, { scenario: route.scenario ?? null, pane: true });
    } else {
      // Back to home while the editor pane is open: it leaves the way `<`
      // does (specs/editor/spec-editor.feature.md "Spec editor pane").
      editorRef.current.close();
      closePage();
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

  /** "2 whole specs and 3 scenarios from 1 spec" — the button and the name
      dialog both say what a session would run over. */
  const describeSelection = (files: { scenarios?: ScenarioPick[] }[]): string => {
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
    return parts.join(" and ");
  };

  const selectionLabel = describeSelection(sessionFiles());

  /** The target the next session dialog opens on. */
  const sessionTarget = resolveCodeGenTarget(
    codeGenTarget,
    canOpenClaudeDesktop,
    canRunAgentPane,
    canRunPi,
  );

  // Code gen session (specs/agents/claude.spec.md): with specs or single
  // scenarios selected, "Start session" asks for a name — prefilled with a
  // timestamp name, so confirming straight away works — and, with more than
  // one agent installed, where to run. The server builds a prompt from the
  // selection and opens it in Claude Code Desktop or in the coding agent
  // pane. A failure lands in the error box.
  const startSession = async () => {
    const files = sessionFiles();
    if (files.length === 0 || sessionRunning) return;
    // With a code repo named in project-settings.json the session runs
    // there, and the dialog says so — the folder is the session's whole
    // context, so it must not come as a surprise.
    const where = codeRepo ? ` in ${codeRepo}` : "";
    let sessionName: string;
    let target: CodeGenTarget;
    // Every agent the session can run in here; a choice only when there is
    // more than one.
    const repoWord = codeRepo ? "the code repo" : "the data repo";
    const choices = [
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
    // No agent installed: nothing to run the session in, so say so instead
    // of asking for a name.
    if (choices.length === 0) {
      setSessionError(
        "No coding agent found — install Claude.app or the `claude` command to start a session",
      );
      return;
    }
    const only = choices[0]!.value as CodeGenTarget;
    const dialog = {
      title: "Name the session",
      // With a choice of agents each option says what it runs, so the hint
      // names none of them; with only one, it names that one's agent.
      hint: `Runs ${choices.length > 1 ? "the chosen agent" : only === "pi" ? "Pi" : "Claude"} over ${describeSelection(files)}${where}.`,
      initial: defaultSessionName(),
      placeholder: "e.g. implement billing quotes",
      confirmLabel: "Start session",
    };
    if (choices.length > 1) {
      const picked = await promptWithChoice({
        ...dialog,
        choicesLabel: "Run in",
        choices,
        initialChoice: sessionTarget,
      });
      if (picked === null || !picked.text.trim()) return;
      sessionName = picked.text.trim();
      target = readCodeGenTarget(picked.choice) ?? only;
      // Remembered, so the next dialog opens on the same choice.
      if (target !== codeGenTarget) void patchSettings({ codeGenTarget: target });
    } else {
      const name = await prompt(dialog);
      if (name === null || !name.trim()) return;
      sessionName = name.trim();
      target = only;
    }
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
        body: JSON.stringify({ name: sessionName, files, target }),
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
  // window, so there the shared url is the registered specdriven:// scheme.
  const copyLink = async (path: string) => {
    const url = location.protocol === "app:" ? desktopLink(path) : location.origin + path;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // navigator.clipboard needs a secure context and permission — absent
      // e.g. on a plain-http LAN host. Fall back to a selection-based copy.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (!ok) {
        toast.error("Could not copy the link to the clipboard.");
        return;
      }
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
  const nextVersionFor = (name: string, ignoreIndex?: number) => {
    const versions = (feature?.scenarios ?? [])
      .filter((s, i) => i !== ignoreIndex && s.name.trim() === name.trim())
      .map((s) => s.version);
    return versions.length ? Math.max(...versions) + 1 : 1;
  };

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
   * scenario into the saved feature. Reports whether the save landed.
   */
  const commitScenario = async (
    tests: string[],
    close: boolean,
    // Propose (specs/editor/spec-editor.feature.md) is the explicit action
    // that advances the editor's draft; every other save keeps the status.
    status?: Scenario["status"],
  ): Promise<boolean> => {
    if (!editing || !feature || !selected) return false;
    const s = { ...editing.scenario, status: status ?? editing.scenario.status, version: draftVersion, tests };
    // Where this scenario sits in the feature: the entry the editor opened
    // on, or the one a previous autosave placed — never appended twice.
    const next = withScenario(feature, editing.index, s);
    setFeature(next);
    if (close) setEditing(null);
    const session = editorSession.current;
    setSaving(true);
    const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
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
    const stillHere = selectedRef.current === selected;
    if (res.ok) {
      const saved = featureFromResponse(data, selected);
      if (stillHere) {
        setFeature(saved);
        setDirty(false);
      }
      // The feature comes back in canonical order, so a renamed scenario has
      // moved: a still-open editor has to find its scenario again, and an
      // explicit save that closed the editor lands on its card. Not finding
      // it (the entry was dropped underneath us) leaves the editor new, so
      // the next save re-adds the work rather than overwriting a neighbour.
      // The entry's document id comes back with it: a new scenario adopts it
      // here, and every later save names the entry by it.
      const moved = cardOfScenario(saved.scenarios, s);
      if (!close && session === editorSession.current) {
        const id = moved === null ? undefined : saved.scenarios[moved]!.id;
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
      return true;
    }
    setSaving(false);
    if (stillHere) {
      setDirty(true);
      toast.error(data.error ?? "Save failed");
    }
    return false;
  };

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
      testEdit === null ? null : { index: testEdit, url: testEditDraft },
      testDraft,
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
    const s = { ...editing.scenario, version: draftVersion, tests };
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
    autosaveInFlight.current = true;
    const session = editorSession.current;
    try {
      // Only a landed save may mark the content saved — a failed one is
      // retried by the next tick, and reported on the banner meanwhile. A
      // save that lands after the dialog closed belongs to nothing.
      const ok = await commitScenario(editing.scenario.tests, false);
      if (ok && session === editorSession.current) autosaved.current = signature;
    } finally {
      autosaveInFlight.current = false;
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
    if (readmeInFlight.current) return; // the previous tick is still saving
    readmeInFlight.current = true;
    setSaving(true);
    const session = readmeSession.current;
    try {
      const res = await fetch("/api/readme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        if (session === readmeSession.current) {
          readmeSaved.current = content;
          markSaved();
        }
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(`README.md not saved: ${data.error ?? res.statusText} — will retry.`);
      }
    } catch (e) {
      toast.error(`README.md not saved: ${(e as Error).message} — will retry.`);
    } finally {
      readmeInFlight.current = false;
      setSaving(false);
    }
  };
  const readmeTick = useRef(autosaveReadme);
  useEffect(() => {
    readmeTick.current = autosaveReadme;
  });
  // Ticks run while the home view shows the README editor. Leaving it (a
  // feature opens) saves what was typed since the last tick, so nothing
  // written on the home view is lost to the navigation.
  const readmeOpen =
    !loading && !needsRepo && selected === null && openPageFile === null && readme !== null;
  useEffect(() => {
    if (!readmeOpen) return;
    const id = setInterval(() => void readmeTick.current(), autosaveSeconds * 1000);
    return () => {
      clearInterval(id);
      void readmeTick.current();
    };
  }, [readmeOpen, autosaveSeconds]);

  /**
   * Open a page of a special folder — a roadmap page (specs/app/roadmap
   * .feature.md) or a task (specs/app/tasks.feature.md): its markdown takes
   * the main pane, autosaved on the scenario editor's interval like the
   * README. A page and a feature share the pane, so opening one drops the
   * other. Called again on the cron tick to show what a pull brought.
   */
  const showPage = async (
    fileName: string,
    opts: {
      push?: boolean;
      /** A search hit's matched words, marked in the page (specs/search.feature.md). */
      terms?: string[];
    } = {},
  ) => {
    const tab = pageTabOf(fileName);
    const res = await fetch(`/api/${tab.folder}/${encodeURIComponent(fileName)}`);
    const data = (await res.json().catch(() => ({}))) as PageListing & {
      content?: string;
      error?: string;
    };
    if (!res.ok || typeof data.content !== "string") {
      // Gone — deleted, renamed, or a stale deep link.
      if (openPageRef.current?.fileName === fileName) closePage({ save: false });
      toast.error(data.error ?? `The ${tab.noun} "${fileName}" was not found — the link may be stale.`);
      await loadPages(tab.folder);
      return;
    }
    editorRef.current.close();
    // The page's row lives on its own tab, so a deep link or the palette
    // turns the sidebar there; a refresh of the open page leaves it alone.
    const samePage = openPageRef.current?.fileName === fileName;
    if (!samePage) selectSidebarTab(tab.folder);
    // A refresh of the open page (the reload cron, a rename) keeps its search
    // marks too; a hit's terms replace them, and another page starts without.
    if (opts.terms !== undefined || !samePage) setPageTerms(opts.terms ?? null);
    setSelected(null);
    setFeature(null);
    setSelectedScenario(null);
    setSelectedFolder(null);
    openPageSession.current += 1;
    openPageSaved.current = data.content;
    openPageTextRef.current = data.content;
    setOpenPageText(data.content);
    setOpenPage(pageListingOf(data));
    if (opts.push && location.pathname !== pageLink(fileName)) {
      history.pushState(null, "", pageLink(fileName));
    }
  };

  /** The listing fields of a page response, without its content. */
  const pageListingOf = (page: PageListing): PageListing => ({
    fileName: page.fileName,
    name: page.name,
    ...(page.assigned ? { assigned: page.assigned } : {}),
  });

  /**
   * Leave the open page. What its editor holds goes out first, so
   * nothing typed there is lost to the navigation — the way the README
   * editor's unmount tick saves it.
   */
  const closePage = ({ save = true }: { save?: boolean } = {}) => {
    if (openPageRef.current === null) return;
    if (save) void pageTick.current();
    openPageRef.current = null;
    openPageTextRef.current = null;
    setOpenPage(null);
    setOpenPageText(null);
    setPageTerms(null);
  };

  /** One autosave tick of the open page — autosaveReadme's twin. */
  const autosavePage = async () => {
    const content = openPageTextRef.current;
    const page = openPageRef.current;
    if (content === null || page === null || content === openPageSaved.current) return;
    if (openPageInFlight.current) return; // the previous tick is still saving
    openPageInFlight.current = true;
    const session = openPageSession.current;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/${pageTabOf(page.fileName).folder}/${encodeURIComponent(page.fileName)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as PageListing & { error?: string };
      if (res.ok) {
        if (session === openPageSession.current) {
          // What went out is what counts as saved: the file holds the
          // document's projection, which can be tidier than the buffer, and
          // taking that back would have every tick save the same text again.
          openPageSaved.current = content;
          markSaved();
          // Only when the heading or the assignment actually moved: a new
          // listing object on every tick would restart the timers watching it.
          setOpenPage((open) =>
            open === null || (open.name === data.name && (open.assigned ?? "") === (data.assigned ?? ""))
              ? open
              : pageListingOf(data),
          );
        }
      } else {
        toast.error(`${page.fileName} not saved: ${data.error ?? res.statusText} — will retry.`);
      }
    } catch (e) {
      toast.error(`${page.fileName} not saved: ${(e as Error).message} — will retry.`);
    } finally {
      openPageInFlight.current = false;
      setSaving(false);
    }
  };
  const pageTick = useRef(autosavePage);
  useEffect(() => {
    pageTick.current = autosavePage;
  });
  const pageEditorOpen = !loading && !needsRepo && openPageFile !== null && openPageText !== null;
  useEffect(() => {
    if (!pageEditorOpen) return;
    const id = setInterval(() => void pageTick.current(), autosaveSeconds * 1000);
    return () => {
      clearInterval(id);
      void pageTick.current();
    };
  }, [pageEditorOpen, autosaveSeconds]);

  /**
   * The members the open page's "Assigned" dropdown offers — the project's,
   * plus whoever it is assigned to when that name is no longer on the list
   * (assignableMembers, for features).
   */
  const pageAssignableMembers = (): ProjectMember[] => {
    const assigned = openPage?.assigned;
    if (!assigned || members.some((m) => m.name === assigned)) return members;
    return [...members, { name: assigned }];
  };

  /**
   * Assign the open page to a project member, or to nobody — just like a
   * feature (src/server/members.ts), and the whole of what makes a task a
   * task. The name lands on the page's `**Assigned:**` line, saved on the
   * spot; the cron pushes it.
   */
  const savePageAssigned = async (name: string) => {
    const page = openPage;
    const content = openPageText;
    if (!page || content === null) return;
    const assigned = name.trim();
    if ((page.assigned ?? "") === assigned) return;
    const { assigned: _previous, ...rest } = parsePage(content);
    const next = serializePage(assigned ? { ...rest, assigned } : rest);
    const tab = pageTabOf(page.fileName);
    setPageAssignedSaving(true);
    try {
      const res = await fetch(`/api/${tab.folder}/${encodeURIComponent(page.fileName)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: next }),
      });
      const data = (await res.json().catch(() => ({}))) as PageListing & {
        content?: string;
        error?: string;
      };
      if (res.ok && typeof data.content === "string") {
        openPageSession.current += 1;
        openPageSaved.current = data.content;
        openPageTextRef.current = data.content;
        setOpenPageText(data.content);
        setOpenPage(pageListingOf(data));
        toast.success(
          assigned ? `Assigned to ${assigned} — saved locally.` : "Assignment cleared — saved locally.",
          { action: { label: "Undo", run: () => void savePageAssigned(_previous ?? "") } },
        );
        markSaved();
        void loadPages(tab.folder);
      } else {
        toast.error(data.error ?? "Could not save the assignment");
      }
    } catch {
      toast.error("Could not save the assignment — is the server running?");
    } finally {
      setPageAssignedSaving(false);
    }
  };

  /** "+ New page" / "+ New task": a markdown file in the tab's folder,
      opened right away. */
  const newPage = async (tab: PageTab) => {
    const input = await prompt({
      title: `New ${tab.noun}`,
      hint: `Use folder/name to create inside a subfolder of ${tab.folder}.`,
      placeholder: tab.folder === "tasks" ? "Ship v2" : "Pricing",
      confirmLabel: `Create ${tab.noun}`,
    });
    if (!input) return;
    const res = await fetch(`/api/${tab.folder}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: input }),
    });
    const data = (await res.json().catch(() => ({}))) as { fileName?: string; error?: string };
    if (!res.ok || !data.fileName) {
      toast.error(data.error ?? `Could not create the ${tab.noun}`);
      return;
    }
    await loadPages(tab.folder);
    await showPage(data.fileName, { push: true });
  };

  /** Rename a page (its `# heading`), saved through the page's document. */
  const renamePage = async (page: PageListing) => {
    const tab = pageTabOf(page.fileName);
    const name = await prompt({
      title: `Rename ${tab.noun}`,
      initial: page.name,
      confirmLabel: "Rename",
    });
    if (!name || name.trim() === page.name) return;
    const url = `/api/${tab.folder}/${encodeURIComponent(page.fileName)}`;
    const res = await fetch(url);
    const data = (await res.json().catch(() => ({}))) as { content?: string; error?: string };
    if (!res.ok || typeof data.content !== "string") {
      toast.error(data.error ?? `Could not read the ${tab.noun}`);
      return;
    }
    const next = serializePage({ ...parsePage(data.content), name: name.trim() });
    const put = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: next }),
    });
    const saved = (await put.json().catch(() => ({}))) as { error?: string };
    if (!put.ok) {
      toast.error(saved.error ?? `Could not rename the ${tab.noun}`);
      return;
    }
    toast.success(`Renamed to “${name.trim()}” — saved locally.`);
    await loadPages(tab.folder);
    if (openPageRef.current?.fileName === page.fileName) await showPage(page.fileName);
  };

  /** Delete a page — committed and pushed right away, so it is confirmed first. */
  const removePage = async (page: PageListing) => {
    const tab = pageTabOf(page.fileName);
    const ok = await confirm({
      title: `Delete ${tab.noun}`,
      body: `Delete “${page.name}”? This is committed and pushed right away.`,
      confirmLabel: `Delete ${tab.noun}`,
    });
    if (!ok) return;
    if (openPageRef.current?.fileName === page.fileName) {
      closePage({ save: false });
      history.replaceState(null, "", "/");
    }
    const res = await fetch(`/api/${tab.folder}/${encodeURIComponent(page.fileName)}`, {
      method: "DELETE",
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (!res.ok) {
      toast.error(data.error ?? `Could not delete the ${tab.noun}`);
      return;
    }
    toast.success(`Deleted “${page.name}”${data.message ? ` — ${data.message}` : ""}.`);
    await loadPages(tab.folder);
  };

  /** Switch the sidebar to the Specs, Roadmap or Tasks tab; the choice sticks. */
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
    const edit = descEditRef.current;
    if (!edit || !feature || edit.file !== selected) return;
    if (edit.text === descSaved.current) return;
    if (descInFlight.current) return; // the previous tick is still saving
    descInFlight.current = true;
    setSaving(true);
    const next: Feature = { ...feature, description: edit.text.trim() };
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(edit.file)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
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
          setFeature(featureFromResponse({ content: data.content, parsed: data.parsed }, edit.file));
          markSaved();
        }
      } else {
        toast.error(`Description not saved: ${data.error ?? res.statusText} — will retry.`);
      }
    } catch (e) {
      toast.error(`Description not saved: ${(e as Error).message} — will retry.`);
    } finally {
      descInFlight.current = false;
      setSaving(false);
    }
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

  const openSettings = () => {
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
    setSettingsProjectManagementDraft(projectManagement);
    setSettingsToolDraft(projectManagementTool);
    setSettingsPublishLinksDraft(publishExternalLinks);
    setSettingsCodeGenDraft(codeGen);
    setSettingsDeletePublishedDraft(deletePublished);
    setSettingsAssignmentsDraft(assignments);
    setSettingsRoadmapDraft(roadmap);
    setSettingsTasksDraft(tasks);
    setSettingsSyncDraft(syncServerUrl ?? DEFAULT_SYNC_SERVER_URL);
    setSettingsSyncOnDraft(syncServerUrl !== null);
    setSettingsError(null);
    setAuthStatus(null);
    setSettingsOpen(true);
  };

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
    if (!settingsOpen) {
      setDeviceFlow(null);
      setWebConnecting(false);
      setAuthStatus(null);
    }
  }, [settingsOpen]);

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
    agentChat.setAvailable(Boolean(data.canRunAgentPane), Boolean(data.canRunPi));
    setCodeGenTarget(readCodeGenTarget(data.codeGenTarget));
    setDeletePublished(data.deletePublished === true);
    setAssignments(data.assignments === true);
    setRoadmap(data.roadmap === true);
    setTasks(data.tasks === true);
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

  // The special folders (specs/app/roadmap.feature.md, specs/app/tasks
  // .feature.md): switched on, the server creates the folder if the data repo
  // has none and the sidebar lists its pages. Off, the folder is simply not
  // shown — a page of it that is open leaves the pane, and the files stay
  // where they are.
  const togglePageFolder = async (tab: PageTab, on: boolean) => {
    const setDraft = tab.folder === "tasks" ? setSettingsTasksDraft : setSettingsRoadmapDraft;
    setDraft(on);
    if (!(await patchSettings({ [tab.folder]: on }))) {
      setDraft(!on);
      return;
    }
    if (on) {
      await loadPages(tab.folder);
      return;
    }
    if (tab.folder === "tasks") setTaskPages([]);
    else setRoadmapPages([]);
    const open = openPageRef.current;
    if (open && pageTabOf(open.fileName).folder === tab.folder) goHome();
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

  const addTest = () => {
    if (!editing || !canSetTestLink(editing.scenario.tests, null, testDraft)) return;
    setTests(addTestLink(editing.scenario.tests, testDraft));
    setTestDraft("");
  };

  /** Open a row for in-place editing, seeded with the url it holds. */
  const startTestEdit = (index: number) => {
    if (!editing) return;
    setTestEdit(index);
    setTestEditDraft(editing.scenario.tests[index] ?? "");
  };

  const commitTestEdit = () => {
    if (!editing || testEdit === null) return;
    if (!canSetTestLink(editing.scenario.tests, testEdit, testEditDraft)) return;
    setTests(updateTestLink(editing.scenario.tests, testEdit, testEditDraft));
    setTestEdit(null);
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
                <a href={t} target="_blank" rel="noreferrer" title={t}>
                  {testLinkLabel(t)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
    // A published scenario gets the Danger Zone wording and a Confirm button
    // (specs/editor/spec-editor.feature.md "Delete Published Spec") — it is
    // published, immutable content, deletable only because Settings says so.
    const ok = await confirm(
      saved.status === "published"
        ? {
            title: "Danger Zone!",
            body: `Confirm that you want to delete a Published spec — "${name}" v${version}.`,
            confirmLabel: "Confirm",
          }
        : {
            title: "Delete scenario",
            body:
              saved.status === "draft"
                ? `Delete the draft "${name}" v${version}?`
                : `Delete "${name}" v${version}?`,
            confirmLabel: "Delete scenario",
          },
    );
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
    const url = `/api/features/${encodeURIComponent(selected)}`;
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
    if (res.ok) {
      // Both routes answer with the editor's view of the feature — the file
      // content with the remaining drafts folded back in.
      setFeature(featureFromResponse(data, selected));
      setDirty(false);
      toast.success(done);
      markSaved();
    } else {
      setDirty(true);
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
   * under this editor session; while a tick is still in flight that tick's
   * save is the autosaved state to leave. Returns the save when one went out.
   */
  const closeEditor = (): Promise<boolean> | null => {
    let saving: Promise<boolean> | null = null;
    if (
      editing &&
      editing.scenario.name.trim() && // no name, nothing to be saved under
      !autosaveInFlight.current &&
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
        testEdit === null ? null : { index: testEdit, url: testEditDraft },
        testDraft,
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

  /** One sidebar entry per feature; the entry is the drag source. */
  const featureItem = (f: FeatureListing, depth: number) => {
    const entry = specSelection.get(f.fileName);
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
              aria-label={`Select ${f.name} for a code gen session`}
              title={
                entry !== undefined && entry !== "all"
                  ? "Some scenarios of this spec are selected"
                  : `Select all of ${f.name} for a code gen session`
              }
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
        /* The checkbox carries the depth indent; without it the link does. */
        style={{ paddingLeft: codeGen ? "0.4rem" : `${0.6 + depth * 0.9}rem` }}
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
    settingsOpen ||
    userInfoOpen ||
    modalOpen ||
    conflict !== null ||
    featureLinkOpen ||
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
    pageAssigneeMenuOpen ||
    filterMenuOpen ||
    pageMenu !== null;
  const quiet = dialogOpen || menuOpen;
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
  // The drawer closes behind any navigation — a feature, a page, the
  // scenario editor — and when the window grows back into two panes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [compact, selected, openPage?.fileName, editing !== null]);
  const newScenario = () =>
    setEditing({
      index: null,
      isNew: true,
      scenario: { name: "", version: 1, status: "draft", body: "", tests: [] },
    });
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
  // a selected folder (specs/folders.spec.md). A field keeps its own ESC.
  const closeTopmost = (e: KeyboardEvent): void | false => {
    if (sessionError !== null) return setSessionError(null);
    if (conflict) {
      if (resolving) return false;
      dismissConflict();
      return;
    }
    if (settingsOpen) return setSettingsOpen(false);
    if (userInfoOpen) return setUserInfoOpen(false);
    if (featureLinkOpen) return setFeatureLinkDraft(null);
    if (modalOpen || sheetOpen || menuOpen) return false;
    if (compact && drawerOpen) return setDrawerOpen(false);
    if (compact && pane.open) return agentChat.closePane();
    const fromSidebar = e.target instanceof Element && e.target.closest("aside") !== null;
    if (editing && !fromSidebar) {
      editorRef.current.back();
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
      run: () => agentChat.togglePane(),
    },
    {
      id: "go-home",
      keys: "g h",
      label: "Go to Home (README)",
      group: "Navigate",
      when: () => !quiet,
      run: () => {
        goHome();
        void loadReadme();
      },
    },
    {
      id: "go-roadmap",
      keys: "g r",
      label: "Go to the roadmap",
      group: "Navigate",
      when: () => !quiet && roadmapPages.length > 0,
      run: () => {
        const page = roadmapPages[0];
        if (page) void showPage(page.fileName, { push: true });
      },
    },
    {
      id: "go-tasks",
      keys: "g t",
      label: "Go to the tasks",
      group: "Navigate",
      when: () => !quiet && taskPages.length > 0,
      run: () => {
        const page = taskPages[0];
        if (page) void showPage(page.fileName, { push: true });
      },
    },
    {
      id: "settings",
      keys: ["mod+,", "g s"],
      label: "Settings",
      group: "Navigate",
      when: () => !quiet,
      run: () => openSettings(),
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
      run: () => {
        if (onFeaturePage) newScenario();
        else void createFeature();
      },
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
      when: () => !quiet && (selected !== null || openPage !== null),
      run: () => {
        if (selected && editing) void copyLink(scenarioPath(selected, editing.scenario));
        else if (selected) void copyLink(featurePath(selected));
        else if (openPage) void copyLink(pageLink(openPage.fileName));
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
    if (!s || (s.when && !s.when())) return null;
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
    shortcutAction("create", <Plus size={14} />),
    action("new-folder", "New folder", <FolderInput size={14} />, () => void createFolder()),
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
      ? [action("session", "Start code-gen session", <Play size={14} />, () => void startSession())]
      : []),
    ...(!demo
      ? [
          action("sync", "Sync now", <RefreshCw size={14} />, () => void syncNow()),
          action("repo", "Change data folder", <FolderInput size={14} />, () => void changeRepo()),
        ]
      : []),
    shortcutAction("go-home", <Home size={14} />),
    shortcutAction("go-roadmap", <MapIcon size={14} />),
    shortcutAction("go-tasks", <ListTodo size={14} />),
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
    const res = await fetch(
      `/api/search?scope=${shownTab}&q=${encodeURIComponent(q)}`,
      { signal },
    );
    const data = (await res.json()) as { results?: SearchResultItem[]; error?: string };
    if (!res.ok) throw new Error(data.error ?? "Search failed");
    // A page tab searched its own folder, so every hit belongs to that tab.
    const pageTab = shownPageTabs.find((tab) => tab.folder === shownTab);
    if (pageTab) {
      return (data.results ?? []).map(
        (r): PaletteItem => ({
          id: `${pageTab.folder}:${r.fileName}`,
          group: pageTab.title,
          label: r.featureName,
          text: r.featureName,
          sub: r.snippet ? markText(r.snippet, r.terms) : undefined,
          icon: <pageTab.icon size={14} />,
          href: pageLink(r.fileName),
          run: () => void showPage(r.fileName, { push: true, terms: r.terms }),
        }),
      );
    }
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
  const recentItems: PaletteItem[] = recent.map((e) => ({
    id: `recent:${e.kind}:${e.fileName}:${e.scenario?.name ?? ""}@${e.scenario?.version ?? 0}`,
    group: "Recent",
    label: e.scenario ? e.scenario.name : e.name,
    text: e.scenario ? e.scenario.name : e.name,
    sub: e.scenario ? e.name : e.kind === "page" ? pageTabOf(e.fileName).title : undefined,
    icon:
      e.kind === "page" ? (
        <PageTabIcon fileName={e.fileName} />
      ) : e.scenario ? (
        <StatusIcon status={scenarioStatus(e.fileName, e.scenario)} size={14} />
      ) : (
        <FileText size={14} />
      ),
    href:
      e.kind === "page"
        ? pageLink(e.fileName)
        : e.scenario
          ? scenarioPath(e.fileName, e.scenario)
          : featurePath(e.fileName),
    run: ({ alt }) => {
      if (e.kind === "page") void showPage(e.fileName, { push: true });
      else
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
  }));
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
    } else if (openPage) {
      entry = { kind: "page", fileName: openPage.fileName, name: openPage.name };
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
  }, [loading, selected, paneScenario?.name, paneScenario?.version, openPage?.fileName]);

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
        if (folderPath === undefined) return;
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

  // The coding agent pane shows only while code gen is on at all.
  const paneShown = pane.open && codeGen;

  return (
    <main
      className={`layout${resizingSidebar || resizingAgent ? " resizing" : ""}${sidebarCollapsed && !compact ? " collapsed" : ""}${compact ? " compact" : ""}${paneShown && !compact ? " agent-open" : ""}`}
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
              className={`rail-link${!selected && !openPage ? " active" : ""}`}
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
          {shownPageTabs.map((tab) => {
            const first = pagesIn(tab.folder)[0];
            if (!first) return null;
            const active = openPage !== null && pageTabOf(openPage.fileName).folder === tab.folder;
            return (
              <Tooltip
                key={tab.folder}
                label={tab.title}
                keys={tab.folder === "tasks" ? "g t" : "g r"}
              >
                <a
                  href={pageLink(first.fileName)}
                  className={`rail-link${active ? " active" : ""}`}
                  aria-label={tab.title}
                  onClick={(e) => spaClick(e, () => void showPage(first.fileName, { push: true }))}
                >
                  <PageTabIcon fileName={first.fileName} size={16} />
                </a>
              </Tooltip>
            );
          })}
          <div className="rail-bottom">
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
          <h1>
            <Logo size={28} />
          </h1>
          {/* The data repo name sits beside the mark rather than under it, so
              the header costs a single row of vertical space. It is the home
              link (specs/app-startup.feature.md "The data folder name links
              to the README"): a real `/` anchor, so a plain click opens the
              README editor and right-click → Copy Link works. */}
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
                  items={recentRepos.map((repo) => {
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
                  })}
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
        {/* Sidebar tabs (specs/app/roadmap.feature.md, specs/app/tasks.feature
            .md): Specs is the feature tree, and each special folder the
            Settings switches show adds its own list beside it. The bar only
            shows once there is something to switch to — one tab is no tab
            bar. */}
        {shownPageTabs.length > 0 && (
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
            {shownPageTabs.map((tab) => (
              <button
                key={tab.folder}
                type="button"
                role="tab"
                id={`side-tab-${tab.folder}`}
                aria-selected={shownTab === tab.folder}
                aria-controls={`side-panel-${tab.folder}`}
                className={shownTab === tab.folder ? "active" : ""}
                onClick={() => selectSidebarTab(tab.folder)}
              >
                <tab.icon size={14} aria-hidden="true" /> {tab.title}
              </button>
            ))}
          </div>
        )}
        {shownTab === "specs" && (
        <div
          className="side-panel"
          role={shownPageTabs.length > 0 ? "tabpanel" : undefined}
          id="side-panel-specs"
          aria-labelledby={shownPageTabs.length > 0 ? "side-tab-specs" : undefined}
        >
        <div className="sidebar-actions">
          <button onClick={createFolder}>+ New folder</button>
          <button onClick={createFeature}>+ New feature</button>
        </div>
        {/* Code gen session (specs/agents/claude.spec.md): check whole specs
            here or single scenarios on their cards, then Start session asks
            for a name and where to run. The Settings switch takes it all away. */}
        {codeGen && (
          <>
            <div className="sidebar-actions">
              <button
                onClick={() => void startSession()}
                disabled={sessionRunning || specSelection.size === 0}
                title={
                  specSelection.size === 0
                    ? "Select a spec here, or single scenarios on their cards"
                    : `Start a code gen session in ${CODE_GEN_TARGET_LABEL[sessionTarget]} with ${selectionLabel}`
                }
              >
                {sessionRunning ? (
                  "Session running…"
                ) : (
                  <>
                    <Play size={12} aria-hidden="true" /> Start session
                    {specSelection.size > 0 ? ` (${specSelection.size})` : ""}
                  </>
                )}
              </button>
            </div>
            {/* What a session would run over, so a scenario checked on a card
                two clicks away is still visible from here. */}
            {selectionLabel && !sessionRunning && (
              <p className="session-notice">Selected: {selectionLabel}</p>
            )}
          </>
        )}
        {sessionNotice && <p className="session-notice">{sessionNotice}</p>}
        {loadError && <p className="error">{loadError}</p>}
        {/* The Features section head carries the filter: by status, by
            assignee. Active filters show as chips that clear on click. */}
        <div className="section-head">
          Features
          <span className="filter-anchor">
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
        </div>
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
        {/* The page tabs (specs/app/roadmap.feature.md, specs/app/tasks.feature
            .md): one folder's page list, with a "New page" / "New task" button
            where the Specs tab has its "New" buttons. */}
        {shownPageTabs
          .filter((tab) => tab.folder === shownTab)
          .map((tab) => (
          <div
            key={tab.folder}
            className="side-panel page-list"
            role="tabpanel"
            id={`side-panel-${tab.folder}`}
            aria-labelledby={`side-tab-${tab.folder}`}
          >
            <div className="sidebar-actions">
              <button onClick={() => void newPage(tab)}>+ New {tab.noun}</button>
            </div>
            <div className="page-rows">
            {/* Pages grouped by their subfolder under the folder, each with a
                ⋯ menu: Rename, Copy link, Delete. */}
            {pageGroups(pagesIn(tab.folder)).map(({ dir, pages }) => (
                <div key={dir || "."}>
                  {dir && <div className="page-group">{dir}</div>}
                  {pages.map((page) => (
                    <div key={page.fileName} className={`page-row${dir ? " nested" : ""}`}>
                      <a
                        href={pageLink(page.fileName)}
                        className={`page-entry${page.fileName === openPage?.fileName ? " active" : ""}`}
                        title={
                          page.assigned ? `${page.name} — assigned to ${page.assigned}` : page.name
                        }
                        aria-current={page.fileName === openPage?.fileName ? "page" : undefined}
                        onClick={(e) =>
                          spaClick(e, () => void showPage(page.fileName, { push: true }))
                        }
                      >
                        {page.name}
                      </a>
                      <span className="tree-row-menu">
                        <Tooltip label="More actions">
                          <button
                            type="button"
                            className="tree-menu-btn"
                            aria-label={`Menu for ${page.name}`}
                            aria-haspopup="menu"
                            aria-expanded={pageMenu === page.fileName}
                            onClick={() =>
                              setPageMenu((m) => (m === page.fileName ? null : page.fileName))
                            }
                          >
                            <Ellipsis size={14} aria-hidden="true" />
                          </button>
                        </Tooltip>
                        <Menu
                          open={pageMenu === page.fileName}
                          onClose={() => setPageMenu(null)}
                          label={`Menu for ${page.name}`}
                          className="tree-menu"
                          containerSelector=".tree-row-menu"
                          items={[
                            {
                              id: "rename",
                              label: "Rename",
                              icon: <Pencil size={13} />,
                              onSelect: () => void renamePage(page),
                            },
                            {
                              id: "copy",
                              label: "Copy link",
                              icon: <Link size={13} />,
                              onSelect: () => void copyLink(pageLink(page.fileName)),
                            },
                            {
                              id: "delete",
                              label: "Delete",
                              icon: <Trash2 size={13} />,
                              danger: true,
                              onSelect: () => void removePage(page),
                            },
                          ]}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            {pagesIn(tab.folder).length === 0 && <p className="empty">{tab.empty}</p>}
            </div>
          </div>
          ))}
        {/* specs/user-info-settings.spec.md: the lower left corner shows the
            current user; its menu holds User info and Settings. */}
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
      <section className="editor" aria-busy={featureLoading || undefined}>
        {/* A render error in one view shows a note with a way back, never a
            blank window; the key follows the page so navigating resets it. */}
        <ErrorBoundary key={selected ?? openPage?.fileName ?? "home"}>
        {editing && selected && feature ? (
          /* specs/editor/spec-editor.feature.md "Spec editor pane": the
             scenario editor takes the feature pane's slot — the sidebar stays
             beside it — with a bar on top and one scrolling column below. */
          <div className="scenario-pane">
            <div className="editor-bar scenario-pane-bar page-header">
              <div className="scenario-pane-title">
                {/* The trail is the way back: the feature crumb, like ESC,
                    leaves the scenario in its autosaved state and lands on
                    its card. The last crumb is the scenario name itself
                    (specs/ui.spec.md "Scenario editor") — editable unless
                    published. */}
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
                  tail={
                    editingPublished ? (
                      <h2 className="scenario-pane-heading">{editing.scenario.name}</h2>
                    ) : (
                      <input
                        className="scenario-pane-name"
                        // While this field has the caret autosave stands down,
                        // so the name is saved once, whole
                        // (specs/editor-autosave.feature.md).
                        ref={nameFieldRef}
                        value={editing.scenario.name}
                        placeholder="Scenario name"
                        aria-label="Scenario name"
                        autoFocus
                        spellCheck={false}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            scenario: { ...editing.scenario, name: e.target.value },
                          })
                        }
                      />
                    )
                  }
                />
                {/* The version is assigned by the app, never typed: a new
                    scenario takes the next version for its name
                    (specs/ui.spec.md). The status rides along as a badge: a
                    scenario starts as a draft — persisted by autosave, kept
                    out of the .feature.md — until Propose or Publish advances
                    it (specs/editor/spec-editor.feature.md). */}
                <p className="version-field">
                  Version <span className="version">v{draftVersion}</span>
                  <span className="status-field">
                    <StatusIcon status={editing.scenario.status} size={14} />
                    {editing.scenario.status}
                  </span>
                </p>
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
                                value={testEditDraft}
                                aria-label="Test link (GitHub url)"
                                spellCheck={false}
                                autoFocus
                                onChange={(e) => setTestEditDraft(e.target.value)}
                                // ESC backs out of the row, not out of the
                                // whole editor pane (specs/ui.spec.md).
                                onKeyDown={(e) => {
                                  if (e.key !== "Escape") return;
                                  e.stopPropagation();
                                  setTestEdit(null);
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
                                onClick={() => setTestEdit(null)}
                              >
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <>
                              <a href={t} target="_blank" rel="noreferrer" title={t}>
                                {testLinkLabel(t)}
                              </a>
                              <button
                                type="button"
                                className="link"
                                title={`Edit ${t}`}
                                aria-label={`Edit ${t}`}
                                onClick={() => startTestEdit(i)}
                              >
                                <Pencil size={12} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="link"
                                title={`Remove ${t}`}
                                aria-label={`Remove ${t}`}
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
                      placeholder="https://github.com/owner/repo/blob/main/…/MyTest.java"
                      aria-label="Test link (GitHub url)"
                      spellCheck={false}
                      onChange={(e) => setTestDraft(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="link"
                      disabled={!canSetTestLink(editing.scenario.tests, null, testDraft)}
                    >
                      Add
                    </button>
                  </form>
                  {testsError && <p className="error">{testsError}</p>}
                </div>
              )}
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
                items={[repoCrumb, ...folderCrumbs(selected)]}
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
                              label: "Start code-gen session",
                              icon: <Play size={13} />,
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
            </div>
            {descOpen && descEdit ? (
              /* specs/editor/feature-editor.feature.md "Edit feature
                 descrition": the description pane becomes the editor, sized
                 like the rendered pane so the scenario list stays in view. */
              <div className="feature-desc-editor">
                <MarkdownEditor
                  value={descEdit.text}
                  onChange={(text) => setDescEdit({ file: descEdit.file, text })}
                  placeholder="Describe this feature — any markdown. Saved automatically."
                />
                <span className="readme-hint">
                  Saved automatically every {autosaveSeconds} seconds; the next sync pushes it.
                  Done shows it rendered.
                </span>
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
                          aria-label={`Select scenario ${s.name} for a code gen session`}
                          title="Include this scenario in a code gen session"
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
              <button
                className="add-spec"
                onClick={() =>
                  setEditing({
                    index: null,
                    isNew: true,
                    scenario: {
                      name: "",
                      version: 1,
                      // A new scenario starts as a draft: autosave
                      // (specs/editor-autosave.feature.md) writes the editor
                      // out every few seconds, and a draft stays in the
                      // document. Proposing it — into the .feature.md — takes
                      // the editor's Propose button, an explicit act.
                      status: "draft",
                      body: "",
                      tests: [],
                    },
                  })
                }
              >
                + Add Scenario
              </button>
            </div>
          </>
        ) : selected && !feature && featureLoading ? (
          /* A feature opened by deep link, still on its way. */
          <PageSkeleton cards={3} />
        ) : openPage && openPageText === null ? (
          <PageSkeleton cards={1} />
        ) : openPage && openPageText !== null ? (
          /* A roadmap page (specs/app/roadmap.feature.md) or a task
             (specs/app/tasks.feature.md): a regular markdown file, edited and
             autosaved like the README — with the "Assigned" dropdown a feature
             has, when assignments are on. Assigning is what makes a task a
             task, so the dropdown is the point of the tab. */
          <>
            <header className="editor-bar page-header">
              <Breadcrumbs
                items={[repoCrumb, { label: pageTabOf(openPage.fileName).title }]}
                tail={
                  <span className="crumb current plain">
                    {openPage.name || openPage.fileName}
                  </span>
                }
              />
              <div className="editor-actions page-actions">
                <SaveIndicator
                  saving={saving}
                  savedAt={savedAt}
                  dirty={openPageText !== openPageSaved.current}
                />
                <span className="readme-hint">
                  {`Autosaves every ${autosaveSeconds}s; the next sync pushes it.`}
                </span>
              </div>
            </header>
            {assignments && (
              <div className="props">
                <span className="chip-anchor page-assignee-anchor">
                  <button
                    type="button"
                    className={`chip${openPage.assigned ? "" : " muted"}`}
                    aria-haspopup="menu"
                    aria-expanded={pageAssigneeMenuOpen}
                    aria-label={`Assigned: ${openPage.assigned ?? "nobody"}`}
                    disabled={pageAssignedSaving}
                    onClick={() => setPageAssigneeMenuOpen((o) => !o)}
                  >
                    {openPage.assigned ? (
                      <span className="avatar chip-avatar" aria-hidden="true">
                        {initialsOf(openPage.assigned)}
                      </span>
                    ) : (
                      <UserRound size={14} aria-hidden="true" />
                    )}
                    {openPage.assigned ?? "Unassigned"}
                  </button>
                  <Menu
                    open={pageAssigneeMenuOpen}
                    onClose={() => setPageAssigneeMenuOpen(false)}
                    label="Assigned member"
                    className="chip-menu"
                    containerSelector=".page-assignee-anchor"
                    items={[
                      {
                        id: "",
                        label: "Unassigned",
                        checked: !openPage.assigned,
                        onSelect: () => void savePageAssigned(""),
                      },
                      ...pageAssignableMembers().map((m) => ({
                        id: m.name,
                        label: m.name,
                        checked: openPage.assigned === m.name,
                        icon: (
                          <span className="avatar chip-avatar" aria-hidden="true">
                            {initialsOf(m.name)}
                          </span>
                        ),
                        onSelect: () => void savePageAssigned(m.name),
                      })),
                    ]}
                  />
                </span>
              </div>
            )}
            <MarkdownEditor
              value={openPageText}
              onChange={setOpenPageText}
              highlight={pageTerms ?? undefined}
              placeholder={`Write this ${pageTabOf(openPage.fileName).noun} in Markdown…`}
            />
          </>
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
      {settingsOpen && (
        <div className="dialog-backdrop" onClick={() => setSettingsOpen(false)}>
          <div
            className="dialog settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            ref={settingsTrapRef}
            onClick={(e) => e.stopPropagation()}
          >
            {/* macOS-style: every control saves itself the moment it changes,
                so there is no Save button — the ✕, ESC or a click outside
                closes. The header sticks so the ✕ stays reachable while the
                dialog scrolls. */}
            <div className="settings-header">
              <h3>Settings</h3>
              <button
                className="settings-close"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <section className="settings-group">
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
                  autoFocus
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
            </section>
            {/* Demo mode has nothing to sync with: the whole autosync/live
                sync group hides — the server refuses the changes anyway. */}
            {!demo && (
            <section className="settings-group">
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
            </section>
            )}
            <section className="settings-group">
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
            </section>
            <section className="settings-group">
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
              {/* The roadmap folder (specs/app/roadmap.feature.md): opt-in
                  — the switch is what controls the folder's visibility, and
                  turning it on creates the folder if the data folder has
                  none. */}
              <label className="settings-row">
                <span className="settings-row-label">
                  Roadmap folder
                  <span className="settings-row-hint">
                    {settingsRoadmapDraft
                      ? "The data folder's roadmap folder — markdown pages, listed above the feature folders. It is created if it isn't there yet."
                      : "The roadmap folder is not shown; nothing in it is touched."}
                  </span>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={settingsRoadmapDraft}
                    onChange={(e) => void togglePageFolder(PAGE_TABS[0]!, e.target.checked)}
                  />
                  <span className="switch-track" aria-hidden="true" />
                </span>
              </label>
              {/* The tasks folder (specs/app/tasks.feature.md): the roadmap
                  switch's twin — the folder's markdown pages become a Tasks
                  tab, each assignable to a project member. */}
              <label className="settings-row">
                <span className="settings-row-label">
                  Tasks
                  <span className="settings-row-hint">
                    {settingsTasksDraft
                      ? "The data folder's tasks folder — a markdown page per task, assignable to a project member, on their own sidebar tab. It is created if it isn't there yet."
                      : "The tasks folder is not shown; nothing in it is touched."}
                  </span>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={settingsTasksDraft}
                    onChange={(e) => void togglePageFolder(PAGE_TABS[1]!, e.target.checked)}
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
              {/* Git engine (specs/git-operations.spec.md): which one carries
                  the operations out and who supplies GitHub credentials.
                  Hidden in demo mode along with the sign-in — the demo
                  dataset never syncs with GitHub. */}
              {!demo && (
                <>
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
                        then reopen this dialog.
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
                </>
              )}
            </section>
            <p className="hint settings-footnote">
              Changes are saved to .specdriven/settings.json as you make them.
            </p>
            <p className="hint settings-footnote">
              <kbd>esc</kbd> to exit
            </p>
            {settingsError && <p className="error settings-error">{settingsError}</p>}
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
      <Toaster />
    </main>
  );
}

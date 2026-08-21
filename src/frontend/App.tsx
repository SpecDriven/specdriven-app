import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import {
  parseFeature,
  serializeFeature,
  slugify,
  sortScenarios,
  titleFromFileName,
} from "../server/parser";
import type { Feature, Scenario, ScenarioPick } from "../server/parser";
import type { FeatureListing } from "../server/features";
import type { SearchResultItem } from "../server/search";
import type { CurrentUser } from "../server/user";
import { Logo } from "./Logo";
import { SearchIcon } from "./SearchIcon";
import { MarkdownEditor } from "./MarkdownEditor";
import { useModalPrompts } from "./ModalPrompts";
import { renderMarkdown } from "./markdown";
import { ScenarioTable } from "./ScenarioTable";
import {
  desktopLink,
  featurePath,
  parseRoute,
  repoDisplayName,
  resolveScenario,
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
  /** Set when the conflicted publish targeted a single scenario. */
  scenario?: { name: string; version: number };
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

/**
 * index === null means a new scenario being added; every save — autosave
 * included — points it at the entry it wrote, so the next save rewrites that
 * entry instead of appending a second one.
 */
export interface EditState {
  index: number | null;
  scenario: Scenario;
  /**
   * True while this dialog is creating a scenario, which it stays even after
   * autosave (specs/editor-autosave.feature.md) has put the scenario in the
   * feature and given `index` a value. The dialog keeps its new-scenario
   * behavior for as long as it is open: retyping the name re-derives the
   * version, and the Draft checkbox stays unlocked.
   */
  isNew?: boolean;
}

/**
 * Parse a feature file with its name resolved the way the page shows it — the
 * `# <name>` heading, or the file stem when the heading is missing
 * (specs/ui.spec.md "Main page"). Resolving it here and not only at render
 * time matters: every save serializes this object back to the file, and a
 * blank name would write a nameless `# ` heading over the real one.
 */
function parseFeatureFile(content: string, fileName: string): Feature {
  const parsed = parseFeature(content);
  return parsed.name ? parsed : { ...parsed, name: titleFromFileName(fileName) };
}

/**
 * What autosave (specs/editor-autosave.feature.md) compares to decide whether
 * the editor is holding anything new: everything a save would write, under
 * the version the dialog will save it as rather than the one on the object.
 */
export function scenarioSignature(s: Scenario, version: number): string {
  return JSON.stringify([s.name, version, s.status, s.body, s.tests]);
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
}

export function App() {
  const [dataRepo, setDataRepo] = useState<string | null>(null);
  const [needsRepo, setNeedsRepo] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [settingRepo, setSettingRepo] = useState(false);
  // Whether the runtime offers a native folder chooser (specs/app-start.spec.md).
  const [canChooseFolder, setCanChooseFolder] = useState(false);
  const repoInputRef = useRef<HTMLInputElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [features, setFeatures] = useState<FeatureListing[]>([]);
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
  // that runs the Claude CLI. Per file the selection is the whole spec
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
  const [treeMenuFile, setTreeMenuFile] = useState(false);
  /** Folder path the drag is hovering over ("" = top level). */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Full-text search (specs/search.spec.md): while the query is non-empty
  // the sidebar tree is replaced by ranked results.
  const [query, setQuery] = useState("");
  /** null until a search for the current session has completed. */
  const [searchResults, setSearchResults] = useState<SearchResultItem[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** Result row the ↑/↓ highlight is on. */
  const [activeResult, setActiveResult] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [feature, setFeature] = useState<Feature | null>(null);
  /** Draft for the inline file-name editor; null while not editing. */
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState<number | null>(null);
  const scenarioRefs = useRef<(HTMLElement | null)[]>([]);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  // Editor autosave (specs/editor-autosave.feature.md): the signature of what
  // the open dialog last had saved, and whether a tick is still saving. Refs,
  // because a tick reads them between renders and must not cause one.
  const autosaved = useRef<string | null>(null);
  const autosaveInFlight = useRef(false);
  /** Close, for the handlers that close the dialog from outside the render
      that defines it (ESC). Kept in a ref so they always run the current one. */
  const closeEditorRef = useRef<() => void>(() => {});
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
  const [status, setStatus] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [syncing, setSyncing] = useState(false);
  /** "all", a scenario key (`name@vN`), or null while no publish is running. */
  const [publishing, setPublishing] = useState<string | null>(null);
  const [reloadSeconds, setReloadSeconds] = useState(60);
  const [previewLines, setPreviewLines] = useState(8);
  /** How often the open editor saves itself (specs/editor-autosave.feature.md). */
  const [autosaveSeconds, setAutosaveSeconds] = useState(DEFAULT_AUTOSAVE_SECONDS);
  // Test links (specs/traceability.spec.md): the table of automated-test
  // links at the end of each scenario card is optional; default ON.
  const [showTestLinks, setShowTestLinks] = useState(true);
  /** Code gen sessions offered at all (specs/agents/claude.spec.md). */
  const [codeGen, setCodeGen] = useState(true);
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
  const [settingsCodeGenDraft, setSettingsCodeGenDraft] = useState(true);
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
  const { modal, modalOpen, prompt, confirm } = useModalPrompts();

  const loadFeatures = useCallback(async () => {
    const res = await fetch("/api/features");
    const data = await res.json();
    if (res.ok) {
      setFeatures(data.features);
      setFolders(data.folders ?? []);
      setLoadError(null);
    } else {
      setLoadError(data.error ?? "Could not load features");
    }
  }, []);

  useEffect(() => {
    (async () => {
      const state = await (await fetch("/api/state")).json();
      setDataRepo(state.dataRepo);
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
      if (typeof state.codeGen === "boolean") {
        setCodeGen(state.codeGen);
      }
      setSyncServerUrl(typeof state.syncServerUrl === "string" ? state.syncServerUrl : null);
      setCanChooseFolder(Boolean(state.canChooseFolder));
      setGitEngineState(state.gitEngine ?? null);
      setGitEngineEffective(state.gitEngineEffective ?? "cli");
      setCliGitAvailable(Boolean(state.cliGitAvailable));
      setGh(state.gh ?? null);
      setAuth(state.auth ?? null);
      if (state.user) setUser(state.user);
      if (!state.needsDataRepo) {
        await loadFeatures();
        // Deep link (specs/navigation.spec.md): the entry url picks the view.
        await openFromLocation();
      }
      setLoading(false);
    })();
  }, [loadFeatures]);

  // Mirror the server's cron reload (specs/crud-feature.spec.md): refresh the
  // feature list on the same cadence so pulled changes show up, without
  // clobbering an in-progress edit or conflict resolution.
  useEffect(() => {
    if (loading || needsRepo || reloadSeconds <= 0) return;
    const id = setInterval(() => {
      void loadFeatures();
      if (selected && !dirty && !editing && !conflict) void openFeature(selected);
    }, reloadSeconds * 1000);
    return () => clearInterval(id);
  }, [loading, needsRepo, reloadSeconds, selected, dirty, editing, conflict, loadFeatures]);

  // specs/ui.spec.md "Select scenarios via up and down keys": arrow keys move a
  // highlight through the scenario cards, Enter opens the highlighted one in
  // the dialog. Inert while a dialog is open or while typing in a field.
  useEffect(() => {
    if (
      !feature ||
      feature.scenarios.length === 0 ||
      editing ||
      settingsOpen ||
      userInfoOpen ||
      modalOpen
    )
      return;
    const count = feature.scenarios.length;
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      )
        return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        // Steal focus from a clicked button (e.g. the feature just opened in
        // the sidebar) so a following Enter edits the highlighted scenario
        // instead of re-activating that button.
        if (t instanceof HTMLElement) t.blur();
        setSelectedScenario((i) => {
          if (e.key === "ArrowDown") return i === null ? 0 : Math.min(i + 1, count - 1);
          return i === null ? count - 1 : Math.max(i - 1, 0);
        });
      } else if (e.key === "Enter" && selectedScenario !== null) {
        // A focused button keeps its native Enter activation.
        if (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement) return;
        const s = feature.scenarios[selectedScenario];
        if (s) setEditing({ index: selectedScenario, scenario: { ...s } });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [feature, editing, settingsOpen, userInfoOpen, modalOpen, selectedScenario]);

  // The dialog's "Add test link" field starts empty each time it opens, with
  // no row left open for ✎ editing (specs/traceability.spec.md).
  const editingOpen = editing !== null;
  useEffect(() => {
    setTestDraft("");
    setTestEdit(null);
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

  // A "Save was blocked" message stops applying the moment the tests widgets
  // change — typing, adding, or opening/closing an ✎ row.
  useEffect(() => {
    setTestsError(null);
  }, [editingOpen, testDraft, testEditDraft, testEdit]);

  // specs/editor/spec-editor.feature.md: ESC returns to the scenario screen,
  // leaving the scenario in its autosaved state — same as the close widget —
  // and it works while a dialog field has focus.
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeEditorRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  // specs/ui.spec.md "Settings": ESC closes the settings dialog — every
  // change is already saved — and it works while a dialog field has focus.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);

  // specs/ui.spec.md "Dialogs": ESC closes the merge conflict dialog. The
  // merge itself lives in the repo (specs/git-operations.spec.md), so nothing
  // is lost — the note below says Publish brings the choices back.
  useEffect(() => {
    if (!conflict) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || resolving) return;
      e.preventDefault();
      dismissConflict();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [conflict, resolving]);

  // specs/user-info-settings.spec.md: ESC or a click anywhere else closes
  // the user menu.
  useEffect(() => {
    if (!userMenuOpen) return;
    const onDown = (e: Event) => {
      if (!(e.target instanceof Element) || !e.target.closest(".user-corner"))
        setUserMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setUserMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [userMenuOpen]);

  // specs/ui.spec.md "Feature entry menu": ESC or a click anywhere else
  // closes the entry's drop down menu (same behavior as the user menu).
  useEffect(() => {
    if (treeMenu === null) return;
    const close = () => {
      setTreeMenu(null);
      setTreeMenuFile(false);
    };
    const onDown = (e: Event) => {
      if (!(e.target instanceof Element) || !e.target.closest(".tree-row-menu")) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [treeMenu]);

  // specs/folders.spec.md: ESC deselects the folder, moving the insertion
  // point back to the tree root so "+ New folder" adds a top-level folder.
  // Inert while a dialog is open or while typing (ESC cancels those instead).
  useEffect(() => {
    if (
      selectedFolder === null ||
      editing ||
      settingsOpen ||
      userMenuOpen ||
      userInfoOpen ||
      treeMenu !== null
    )
      return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      )
        return;
      e.preventDefault();
      setSelectedFolder(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedFolder, editing, settingsOpen, userMenuOpen, userInfoOpen, treeMenu]);

  // Search as the user types, debounced (specs/search.spec.md); the
  // AbortController keeps a stale response from overwriting a newer query.
  useEffect(() => {
    const q = query.trim();
    setActiveResult(0);
    if (!q) {
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (res.ok) {
          setSearchResults(data.results);
          setSearchError(null);
        } else {
          setSearchResults([]);
          setSearchError(data.error ?? "Search failed");
        }
      } catch {
        // Aborted by a newer keystroke or unmount; anything else (server
        // gone mid-typing) leaves the previous results standing.
      }
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // specs/search.spec.md: "/" and Cmd/Ctrl+F focus the search field from
  // anywhere — except while a dialog is open or typing in another field.
  useEffect(() => {
    if (editing || settingsOpen || userInfoOpen || modalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey;
      const find =
        e.key.toLowerCase() === "f" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
      if (!slash && !find) return;
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      )
        return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, settingsOpen, userInfoOpen, modalOpen]);

  // Keep the ↑/↓ highlight visible while it walks the result list.
  useEffect(() => {
    document.querySelector(".search-result.active")?.scrollIntoView({ block: "nearest" });
  }, [activeResult]);

  // specs/ui.spec.md "Dialogs": Tab stays inside the foreground dialog.
  const settingsTrapRef = useFocusTrap(settingsOpen);
  const editingTrapRef = useFocusTrap(editing !== null);
  const userInfoTrapRef = useFocusTrap(userInfoOpen);
  const conflictTrapRef = useFocusTrap(conflict !== null);

  useEffect(() => {
    if (selectedScenario !== null)
      scenarioRefs.current[selectedScenario]?.scrollIntoView({ block: "nearest" });
  }, [selectedScenario]);

  // Canonical url (specs/navigation.spec.md "Resolution rules"): the address
  // bar always shows what is actually selected. replaceState so selection
  // moves don't spam history — deliberate feature switches push in openFeature.
  useEffect(() => {
    if (loading || needsRepo) return;
    const s = selectedScenario !== null ? feature?.scenarios[selectedScenario] : undefined;
    const url = selected ? (s ? scenarioPath(selected, s) : featurePath(selected)) : "/";
    if (location.pathname !== url) history.replaceState(null, "", url);
  }, [loading, needsRepo, selected, feature, selectedScenario]);

  // Window title follows the selection (specs/navigation.spec.md) — chat and
  // email link previews show it.
  useEffect(() => {
    const s =
      feature && selectedScenario !== null ? feature.scenarios[selectedScenario] : undefined;
    const name = feature && selected ? feature.name || titleFromFileName(selected) : "";
    document.title =
      !selected || !feature
        ? "SpecDriven"
        : s
          ? `SpecDriven — ${name} · ${s.name} v${s.version}`
          : `SpecDriven — ${name}`;
  }, [selected, feature, selectedScenario]);

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
        setNeedsRepo(false);
        await loadFeatures();
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
    const next = input?.trim();
    if (!next || next === dataRepo) return;
    setSettingRepo(true);
    try {
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataRepo: next }),
      });
      const state = await res.json();
      if (res.ok) {
        setDataRepo(state.dataRepo);
        setSelected(null);
        setFeature(null);
        setSelectedScenario(null);
        setStatus("");
        await loadFeatures();
      } else {
        setStatus(state.error ?? "Could not use this directory");
      }
    } finally {
      setSettingRepo(false);
    }
  };

  const openFeature = async (file: string, opts: OpenOptions = {}) => {
    const res = await fetch(`/api/features/${encodeURIComponent(file)}`);
    if (res.ok) {
      const data = await res.json();
      const parsed = parseFeatureFile(data.content, file);
      setSelected(file);
      setFeature(parsed);
      let missingScenario: string | null = null;
      if (opts.scenario !== undefined) {
        // Deep link (specs/navigation.spec.md): resolve slug (+ version) to a
        // card; a miss opens the feature with no selection and a note.
        const idx = opts.scenario === null ? null : resolveScenario(parsed.scenarios, opts.scenario);
        if (opts.scenario !== null && idx === null) missingScenario = opts.scenario.slug;
        setSelectedScenario(idx);
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
      setEditing(null);
      setRenameDraft(null);
      setConflict(null);
      setStatus(
        missingScenario
          ? `Scenario "${missingScenario}" not found — it may have been renamed or deleted.`
          : "",
      );
    } else {
      // The file is gone — deleted, renamed by the `.feature.md` migration, or
      // a stale deep link. Drop a stale selection rather than re-fetching it
      // on every reload tick; a link or click that misses leaves a note.
      if (file === selected) {
        setSelected(null);
        setFeature(null);
        setSelectedScenario(null);
        setStatus("");
      }
      if (opts.push || opts.scenario !== undefined) {
        setStatus(`Feature "${file}" not found — the link may be stale.`);
      }
      await loadFeatures();
    }
  };

  /** Derive the view from a url (initial load, popstate, after repo setup). */
  const openFromLocation = async (pathname = location.pathname) => {
    const route = parseRoute(pathname);
    if (route.feature) {
      await openFeature(route.feature, { scenario: route.scenario ?? null });
    } else {
      setSelected(null);
      setFeature(null);
      setSelectedScenario(null);
      setStatus("");
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

  const createFeature = async () => {
    const name = await prompt({
      title: "New feature",
      hint: "Use folder/name to create inside a folder.",
      placeholder: "billing/Basic Quote",
      confirmLabel: "Create feature",
    });
    if (!name) return;
    const res = await fetch("/api/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (res.ok) {
      await loadFeatures();
      await openFeature(data.fileName, { push: true });
    } else {
      setStatus(data.error);
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

  // Code gen session (specs/agents/claude.spec.md): with specs or single
  // scenarios selected, "Start session" asks for a name, then the server
  // builds a prompt from the selection and passes it to the Claude CLI to
  // execute and exit. An error code lands in the error box.
  const startSession = async () => {
    const files = sessionFiles();
    if (files.length === 0 || sessionRunning) return;
    const name = await prompt({
      title: "Name the session",
      hint: `Runs Claude over ${describeSelection(files)}.`,
      placeholder: "e.g. implement billing quotes",
      confirmLabel: "Start session",
    });
    if (name === null || !name.trim()) return;
    const sessionName = name.trim();
    setSessionRunning(true);
    setSessionNotice(`Session "${sessionName}" running…`);
    try {
      const res = await fetch("/api/agent/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: sessionName, files }),
      });
      const data = await res.json();
      if (res.ok) {
        setSessionNotice(`Session "${sessionName}" finished.`);
        setSpecSelection(new Map());
        // The session may have edited specs — show what it left behind.
        await loadFeatures();
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
      setStatus(data.error ?? "Could not create the folder");
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
    } else {
      setStatus(data.error ?? "Could not delete the folder");
    }
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
        setStatus(`Moved to ${folder || "the top level"} — ${data.message}.`);
      }
    } else {
      setStatus(data.error ?? "Move failed");
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
        setStatus(`Renamed to "${data.name}" — ${data.message}.`);
      } else {
        setStatus(data.error ?? "Rename failed");
      }
    } catch {
      setStatus("Rename failed — is the server running?");
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
        setStatus(`Renamed file to ${fileStem(data.fileName)} — ${data.message}.`);
      }
    } else {
      setStatus(data.error ?? "Rename failed");
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
        setSelected(null);
        setFeature(null);
        setSelectedScenario(null);
      }
      await loadFeatures();
      setStatus(`Deleted "${f.name}" — ${data.message}.`);
    } else {
      setStatus(data.error ?? "Delete failed");
    }
  };

  // Publish buttons (specs/ui.spec.md "Main page"): same style and behavior as
  // Sync — disabled with a progress label while running, no "Published" status
  // line at the bottom of the page. Without a target every scenario is
  // published (the upper-left "Publish All"); with one, only that scenario
  // (specs/crud-feature.spec.md "publish each scenario individually").
  // `over` carries content the state hasn't caught up with yet: the dialog's
  // Publish saves its scenario into the feature and publishes in one motion.
  const publish = async (scenario?: { name: string; version: number }, over?: Feature) => {
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
        setStatus("Merge conflict — choose a resolution below.");
      } else if (res.ok) {
        await openFeature(selected);
      } else {
        setStatus(data.error ?? "Publish failed");
      }
    } catch {
      setStatus("Publish failed — is the server running?");
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
        setStatus(data.error ?? "Sync failed");
        return;
      }
      await loadFeatures();
      if (selected && !dirty && !editing && !conflict) await openFeature(selected);
    } catch {
      setStatus("Sync failed — is the server running?");
    } finally {
      setSyncing(false);
    }
  };

  const resolveWith = async (which: "ours" | "theirs" | "draft", resolved: string) => {
    if (!selected || resolving) return;
    setResolving(which);
    setStatus("Publishing resolution…");
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: resolved,
          resolveConflict: true,
          // Keep an individual publish scoped to its scenario through the
          // conflict resolution.
          scenario: conflict?.scenario,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // openFeature closes the dialog by clearing the conflict.
        await openFeature(selected);
      } else {
        setStatus(data.error ?? "Publish failed");
      }
    } catch {
      setStatus("Publish failed — is the server running?");
    } finally {
      setResolving(null);
    }
  };

  /** Close the conflict dialog without resolving. The unfinished merge stays
      in the repo, so Publish brings the same choices back. */
  const dismissConflict = () => {
    setConflict(null);
    setStatus("Merge conflict left unresolved — Publish again to pick a resolution.");
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
        setStatus("Could not copy the link to the clipboard.");
        return;
      }
    }
    setCopied(path);
    window.setTimeout(() => setCopied((p) => (p === path ? null : p)), 2000);
  };

  // specs/crud-feature.spec.md ("Scenario is automatically saved locally and
  // pushed to GitHub"): show 'Saved' on the top banner for 2 sec.
  const flashSaved = () => {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 2000);
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
   * Write the dialog's scenario into the feature and save the feature locally
   * (marked [proposed], so no data is lost); the server's reload cron commits
   * and pushes it. `close` false is the autosave path
   * (specs/editor-autosave.feature.md): the dialog stays open and follows its
   * scenario into the saved feature. Reports whether the save landed.
   */
  const commitScenario = async (
    tests: string[],
    close: boolean,
    // Propose (specs/editor/spec-editor.feature.md) is the explicit action
    // that advances the dialog's draft; every other save keeps the status.
    status?: Scenario["status"],
  ): Promise<boolean> => {
    if (!editing || !feature || !selected) return false;
    const s = { ...editing.scenario, status: status ?? editing.scenario.status, version: draftVersion, tests };
    // Where this scenario sits in the feature: the entry the dialog opened
    // on, or the one a previous autosave placed — never appended twice.
    const at = editing.index;
    const next: Feature = {
      ...feature,
      scenarios: sortScenarios(
        at === null
          ? [...feature.scenarios, s]
          : feature.scenarios.map((sc, i) => (i === at ? s : sc)),
      ),
    };
    setFeature(next);
    if (close) setEditing(null);
    const session = editorSession.current;
    const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: serializeFeature(next), save: true }),
    });
    const data = await res.json();
    if (res.ok) {
      const saved = parseFeatureFile(data.content, selected);
      setFeature(saved);
      setDirty(false);
      // A still-open dialog has to find its scenario again: the feature comes
      // back in canonical order, so a renamed scenario has moved. Not finding
      // it (the entry was dropped underneath us) leaves the dialog new, so
      // the next save re-adds the work rather than overwriting a neighbour.
      if (!close && session === editorSession.current) {
        const moved = saved.scenarios.findIndex(
          (sc) => sc.name === s.name && sc.version === s.version,
        );
        setEditing((prev) =>
          prev === null ? null : { ...prev, index: moved === -1 ? null : moved },
        );
      }
      // A published scenario's dialog can only have changed its test links
      // (specs/traceability.spec.md) — there is nothing left to publish.
      setStatus(
        s.status === "published"
          ? `Saved the test links of "${s.name}" v${s.version}.`
          : s.status === "draft"
            ? `Saved "${s.name}" v${s.version} as a draft — drafts stay out of the feature file.`
            : "Saved — publish scenarios from their cards, or press Publish All.",
      );
      flashSaved();
      return true;
    }
    setDirty(true);
    setStatus(data.error ?? "Save failed");
    return false;
  };

  /**
   * A url still sitting in the add field or an open ✎ row rides along with
   * any explicit save — it must never be silently dropped — and one that
   * can't join the list blocks the save instead (specs/traceability.spec.md).
   * Null means blocked, with the reason already on screen.
   */
  const pendingTests = (): string[] | null => {
    if (!editing) return null;
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

  /** Save a published scenario's test links — the only thing its dialog can
      change (specs/traceability.spec.md). */
  const saveScenario = async () => {
    const tests = pendingTests();
    if (tests === null) return;
    await commitScenario(tests, true);
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
      setStatus(`Proposed "${name}" v${version} — publish it from its card, or press Publish All.`);
    }
  };

  /**
   * Publish straight from the dialog (specs/editor/spec-editor.feature.md):
   * the dialog's scenario goes into the feature and that one scenario is
   * published — marked [published], committed and pushed, exactly like a
   * card's Publish. A merge conflict opens the usual resolution dialog.
   */
  const publishScenario = async () => {
    if (!editing || !feature || !selected) return;
    const tests = pendingTests();
    if (tests === null) return;
    const s = { ...editing.scenario, version: draftVersion, tests };
    const at = editing.index;
    const next: Feature = {
      ...feature,
      scenarios: sortScenarios(
        at === null
          ? [...feature.scenarios, s]
          : feature.scenarios.map((sc, i) => (i === at ? s : sc)),
      ),
    };
    setFeature(next);
    setEditing(null);
    await publish({ name: s.name, version: s.version }, next);
  };

  /**
   * One autosave tick (specs/editor-autosave.feature.md "Autosave Triggered at
   * Defined Interval"): save what the editor holds, unless it holds nothing
   * new. A url still being typed into the test-link fields stays out — those
   * join the scenario when the user adds them, or on an explicit Save.
   */
  const autosaveScenario = async () => {
    if (!editing || !feature || !selected) return;
    if (autosaveInFlight.current) return; // the previous tick is still saving
    if (deletingScenario.current) return; // a delete is being confirmed or sent
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
    setSettingsCodeGenDraft(codeGen);
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
    // Switched off, a selection left over from before must not linger as a
    // session waiting to be started.
    if (data.codeGen === false) setSpecSelection(new Map());
    setCodeGen(data.codeGen !== false);
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

  const toggleCodeGen = async (on: boolean) => {
    setSettingsCodeGenDraft(on);
    if (!(await patchSettings({ codeGen: on }))) setSettingsCodeGenDraft(!on);
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
   * Delete the dialog's scenario (specs/ui.spec.md "Scenario edit dialog"),
   * after a confirmation. Two removals, by what the scenario is: a [proposed]
   * one is saved out of the feature like any other edit, while a draft — which
   * the `.feature.md` never held, so leaving it out of a save would remove
   * nothing — is deleted from the Automerge document through its own route.
   * Either way it is local; the reload cron commits and pushes it.
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
    const ok = await confirm({
      title: "Delete scenario",
      body:
        saved.status === "draft"
          ? `Delete the draft "${name}" v${version}?`
          : `Delete "${name}" v${version}?`,
      confirmLabel: "Delete scenario",
    });
    if (!ok) {
      deletingScenario.current = false;
      return;
    }
    setEditing(null);
    await removeScenario(idx, saved, `Deleted scenario "${name}" v${version}.`);
  };

  /**
   * Take a scenario back out of the open feature, by what it is: a [proposed]
   * one is saved out of the feature like any other edit, while a draft — which
   * the `.feature.md` never held — is deleted from the Automerge document
   * through its own route. Local either way; the reload cron commits and
   * pushes it. `saved` is the entry as last saved, at `idx` in the feature.
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
    const res =
      saved.status === "draft"
        ? await fetch(`${url}/delete-draft`, {
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
      setFeature(parseFeatureFile(data.content, selected));
      setDirty(false);
      setStatus(done);
      flashSaved();
    } else {
      setDirty(true);
      setStatus(data.error ?? "Delete failed");
    }
  };

  /**
   * Close the scenario edit dialog (specs/editor/spec-editor.feature.md): ESC
   * and the close widget leave the scenario in its autosaved state — closing
   * discards nothing and reverts nothing; Delete is the way to take a draft
   * back out. One last save catches what was typed since the previous tick,
   * so the state left behind is the dialog's latest. Started before the dialog
   * state clears so it saves under this editor session; while a tick is still
   * in flight that tick's save is the autosaved state to leave.
   */
  const closeEditor = () => {
    if (
      editing &&
      editing.scenario.name.trim() && // no name, nothing to be saved under
      !autosaveInFlight.current &&
      !deletingScenario.current &&
      scenarioSignature(editing.scenario, draftVersion) !== autosaved.current
    ) {
      void commitScenario(editing.scenario.tests, false);
    }
    setEditing(null);
  };

  // ESC closes the dialog the same way the close widget does, from a listener
  // bound while the dialog opened — it runs whichever close is current.
  useEffect(() => {
    closeEditorRef.current = closeEditor;
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
      // version of a published scenario on the user's behalf.
      scenario: { ...src, version: nextVersionFor(src.name), status: "draft" },
    });
  };

  const toggleFolder = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** Open a search hit exactly like its deep link (specs/search.spec.md). */
  const openResult = (r: SearchResultItem) => {
    setSelectedFolder(null);
    void openFeature(r.fileName, {
      push: true,
      scenario: r.scenario
        ? { slug: slugify(r.scenario.name), version: r.scenario.version }
        : null,
    });
  };

  const resultHref = (r: SearchResultItem) =>
    r.scenario ? scenarioPath(r.fileName, r.scenario) : featurePath(r.fileName);

  /** Snippet text with the matched terms wrapped in <mark>. */
  const markSnippet = (snippet: string, terms: string[]) => {
    const escaped = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (escaped.length === 0) return snippet;
    // Split on the terms with a capture group: odd indices are the matches.
    const parts = snippet.split(new RegExp(`(${escaped.join("|")})`, "gi"));
    return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
  };

  /** One sidebar entry per feature; the entry is the drag source. */
  const featureItem = (f: FeatureListing, depth: number) => {
    const entry = specSelection.get(f.fileName);
    return (
      <div key={f.fileName}>
        <div className="tree-row">
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
      {/* Drop down menu (specs/ui.spec.md "Feature entry menu"): File →
          Rename edits the underlying file name; Delete removes the file. */}
      <span className="tree-row-menu">
        <button
          type="button"
          className="tree-menu-btn"
          title={`Menu for ${f.fileName}`}
          aria-haspopup="menu"
          aria-expanded={treeMenu === f.fileName}
          onClick={() => {
            setTreeMenuFile(false);
            setTreeMenu((m) => (m === f.fileName ? null : f.fileName));
          }}
        >
          ⋯
        </button>
        {treeMenu === f.fileName && (
          <div className="tree-menu" role="menu" aria-label={`Menu for ${f.fileName}`}>
            <button
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={treeMenuFile}
              onClick={() => setTreeMenuFile((o) => !o)}
            >
              File {treeMenuFile ? "▾" : "▸"}
            </button>
            {treeMenuFile && (
              <div className="tree-submenu" role="menu" aria-label="File">
                <button
                  role="menuitem"
                  onClick={() => {
                    setTreeMenu(null);
                    setTreeMenuFile(false);
                    void renameFile(f.fileName);
                  }}
                >
                  Rename “{fileStem(f.fileName)}”
                </button>
              </div>
            )}
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                setTreeMenu(null);
                setTreeMenuFile(false);
                void removeFeature(f);
              }}
            >
              Delete
            </button>
          </div>
        )}
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
              aria-expanded={!collapsed.has(child.path)}
              onClick={() => {
                setSelectedFolder(child.path);
                toggleFolder(child.path);
              }}
            >
              <span className="twist">{collapsed.has(child.path) ? "▸" : "▾"}</span> {child.name}
            </button>
            <button
              type="button"
              className="folder-delete"
              title={`Delete folder ${child.path}`}
              onClick={() => void removeFolder(child.path)}
            >
              ✕
            </button>
          </div>
          {!collapsed.has(child.path) && renderTree(child, depth + 1)}
        </div>
      ))}
      {node.features.map((f) => featureItem(f, depth))}
    </>
  );

  if (loading) return <main className="centered">Loading…</main>;

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
  // "Scenario edit dialog") — not to published ones (immutable), and not to a
  // scenario that isn't part of the feature yet (index === null). A new one
  // autosave has already placed does have an index, and can be deleted.
  const editingDeletable = savedEntry !== null && savedEntry.status !== "published";
  const hasProposed = feature?.scenarios.some((s) => s.status === "proposed") ?? false;

  return (
    <main
      className={resizingSidebar ? "layout resizing" : "layout"}
      style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
    >
      {savedFlash && <div className="saved-banner">Saved</div>}
      <aside>
        <header>
          <h1>
            <Logo size={28} />
          </h1>
          {/* The data repo name sits beside the mark rather than under it, so
              the header costs a single row of vertical space. */}
          <div className="repo-row">
            <span className="repo-name" title={dataRepo ?? undefined}>
              {dataRepo && repoDisplayName(dataRepo)}
            </span>
            <button
              type="button"
              className="repo-edit"
              title="Change data directory"
              aria-label="Change data directory"
              disabled={settingRepo}
              onClick={() => void changeRepo()}
            >
              ✎
            </button>
          </div>
        </header>
        {/* Search field (specs/search.spec.md): top-left, under the header
            so the macOS drag region above it stays draggable. */}
        <div className="sidebar-search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="text"
            placeholder="Search specs"
            aria-label="Search specs"
            enterKeyHint="search"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                if (!searchResults || searchResults.length === 0) return;
                e.preventDefault();
                const max = searchResults.length - 1;
                setActiveResult((i) =>
                  e.key === "ArrowDown" ? Math.min(i + 1, max) : Math.max(i - 1, 0),
                );
              } else if (e.key === "Enter") {
                const r = searchResults?.[activeResult];
                if (r) openResult(r);
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              ✕
            </button>
          )}
        </div>
        <div className="sidebar-actions">
          <button onClick={createFolder}>+ New folder</button>
          <button onClick={createFeature}>+ New feature</button>
        </div>
        {/* Code gen session (specs/agents/claude.spec.md): check whole specs
            here or single scenarios on their cards, then Start session asks
            for a name and runs. The Settings switch takes it all away. */}
        {codeGen && (
          <>
            <div className="sidebar-actions">
              <button
                onClick={() => void startSession()}
                disabled={sessionRunning || specSelection.size === 0}
                title={
                  specSelection.size === 0
                    ? "Select a spec here, or single scenarios on their cards"
                    : `Start a code gen session with ${selectionLabel}`
                }
              >
                {sessionRunning
                  ? "Session running…"
                  : `▶ Start session${specSelection.size > 0 ? ` (${specSelection.size})` : ""}`}
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
        {query.trim() ? (
          /* Ranked results take the tree's slot while a query is active
             (specs/search.spec.md); clearing the query restores the tree. */
          <div className="search-results" role="listbox" aria-label="Search results">
            {searchError && <p className="error">{searchError}</p>}
            {(searchResults ?? []).map((r, i) => (
              <a
                key={`${r.kind}:${r.fileName}:${r.scenario?.name ?? ""}@${r.scenario?.version ?? 0}`}
                href={resultHref(r)}
                role="option"
                aria-selected={i === activeResult}
                className={`search-result${i === activeResult ? " active" : ""}`}
                onClick={(e) => spaClick(e, () => openResult(r))}
                onMouseEnter={() => setActiveResult(i)}
              >
                <span className="search-result-title">
                  {r.featureName}
                  {r.scenario && (
                    <span className="crumb">
                      {" "}
                      › {r.scenario.name} v{r.scenario.version}
                    </span>
                  )}
                </span>
                {r.snippet && (
                  <span className="search-result-snippet">
                    {markSnippet(r.snippet, r.terms)}
                  </span>
                )}
              </a>
            ))}
            {searchResults !== null && !searchError && searchResults.length === 0 && (
              <p className="empty">No matches for "{query.trim()}"</p>
            )}
          </div>
        ) : (
          /* Folder tree (specs/folders.spec.md): folders are drop targets
             for drag-moving features; the tree background is the top level. */
          <div
            className={`tree${dragging !== null && dropTarget === "" ? " drop-target" : ""}`}
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
        {/* specs/user-info-settings.spec.md: the lower left corner shows the
            current user; its menu holds User info and Settings. */}
        <div className="user-corner">
          {userMenuOpen && (
            <div className="user-menu" role="menu" aria-label="User menu">
              <button
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  setUserInfoOpen(true);
                }}
              >
                User info
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  openSettings();
                }}
              >
                ⚙ Settings
              </button>
            </div>
          )}
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
          </button>
        </div>
      </aside>
      {/* Divider (specs/ui.spec.md "Sidebar resize"): drag to resize the
          left pane, double-click to restore the default width. */}
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
      <section className="editor">
        {selected && feature ? (
          <>
            <div className="editor-bar">
              {/* specs/ui.spec.md "Main page": the top of the page shows
                  "Feature: <name>", not the file name. The Edit link edits
                  this feature name (the file's `# <name>` heading), committed
                  and pushed on the server; the file name never changes. */}
              <div className="feature-title">
                {renameDraft === null ? (
                  <>
                    <h2>Feature: {feature.name || titleFromFileName(selected)}</h2>
                    <button
                      className="link"
                      onClick={() =>
                        setRenameDraft(feature.name || titleFromFileName(selected))
                      }
                    >
                      Edit
                    </button>
                    <button className="link" onClick={() => copyLink(featurePath(selected))}>
                      {copied === featurePath(selected) ? "Copied" : "Copy link"}
                    </button>
                  </>
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
                )}
              </div>
              <div className="editor-actions">
                <button className="secondary" onClick={syncNow} disabled={syncing}>
                  {syncing ? "Syncing…" : "Sync"}
                </button>
                {/* Publish All, right of Sync (specs/crud-feature.spec.md
                    "publish each scenario individually"): marks every scenario
                    published; individual scenarios publish from their cards. */}
                <button
                  className="secondary"
                  onClick={() => void publish()}
                  disabled={publishing !== null}
                >
                  {publishing === "all"
                    ? "Publishing…"
                    : dirty || hasProposed
                      ? "Publish All *"
                      : "Publish All"}
                </button>
              </div>
            </div>
            {feature.description && (
              <div className="feature-desc md-preview">
                {renderMarkdown(feature.description)}
              </div>
            )}
            {/* specs/ui.spec.md "Scenario List": each card renders its body as
                a Markdown preview, clamped to n lines (n set in Settings). */}
            <div
              className="scenarios"
              style={{ "--preview-lines": previewLines } as CSSProperties}
            >
              {feature.scenarios.map((s, i) => (
                <article
                  key={i}
                  ref={(el) => {
                    scenarioRefs.current[i] = el;
                  }}
                  className={`scenario-card${s.status === "published" ? " published" : ""}${
                    i === selectedScenario ? " selected" : ""
                  }`}
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
                      <a
                        href={scenarioPath(selected, s)}
                        onClick={(e) => spaClick(e, () => setSelectedScenario(i))}
                      >
                        {s.name}
                      </a>{" "}
                      <span className="version">v{s.version}</span>
                      {s.status === "published" && <span className="badge">published</span>}
                      {s.status === "proposed" && (
                        <span className="badge proposed">proposed</span>
                      )}
                      {s.status === "draft" && <span className="badge draft">draft</span>}
                    </span>
                    <span className="card-actions">
                      {/* Unpublished cards: Edit, Publish, Copy link — in that
                          order (specs/crud-feature.spec.md "publish each
                          scenario individually"). A published card opens the
                          same dialog: `Edit` while its test links are editable
                          (specs/traceability.spec.md), `View` when the setting
                          leaves nothing to change. */}
                      <button
                        className="link"
                        onClick={() => setEditing({ index: i, scenario: { ...s } })}
                      >
                        {s.status !== "published" || showTestLinks ? "Edit" : "View"}
                      </button>
                      {s.status !== "published" && (
                        <button
                          className="link"
                          disabled={publishing !== null}
                          onClick={() => void publish({ name: s.name, version: s.version })}
                        >
                          {publishing === scenarioKey(s) ? "Publishing…" : "Publish"}
                        </button>
                      )}
                      {s.status === "published" && (
                        <button className="link" onClick={() => newVersion(i)}>
                          New version
                        </button>
                      )}
                      <button
                        className="link"
                        onClick={() => copyLink(scenarioPath(selected, s))}
                      >
                        {copied === scenarioPath(selected, s) ? "Copied" : "Copy link"}
                      </button>
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
              ))}
              {feature.scenarios.length === 0 && <p className="empty">No scenarios yet.</p>}
            </div>
            <div>
              <button
                className="add-scenario"
                onClick={() =>
                  setEditing({
                    index: null,
                    isNew: true,
                    scenario: {
                      name: "",
                      version: 1,
                      // A new scenario starts as a draft: autosave
                      // (specs/editor-autosave.feature.md) writes the dialog
                      // out every few seconds, and a draft stays in the
                      // document. Proposing it — into the .feature.md — takes
                      // clearing the dialog's Draft checkbox, an explicit act.
                      status: "draft",
                      body: "",
                      tests: [],
                    },
                  })
                }
              >
                + Add scenario
              </button>
            </div>
            {status && <p className="status">{status}</p>}
          </>
        ) : (
          <>
            <p className="empty">Select a feature file or create a new one.</p>
            {/* A stale deep link lands here with a note (specs/navigation.spec.md). */}
            {status && <p className="status">{status}</p>}
          </>
        )}
      </section>
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
                ✕
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
            </section>
            <section className="settings-group">
              {/* Code gen (specs/agents/claude.spec.md): off takes the selection
                  checkboxes and Start session away, and the server refuses a
                  session, so no spec can reach the Claude CLI. */}
              <label className="settings-row">
                <span className="settings-row-label">
                  Code generation
                  <span className="settings-row-hint">
                    {settingsCodeGenDraft
                      ? "Specs and scenarios can be selected and handed to the Claude CLI, which implements them in the data repo."
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
              {/* Git engine (specs/git-operations.spec.md): which one carries
                  the operations out and who supplies GitHub credentials. */}
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
          <div className="dialog" ref={userInfoTrapRef} onClick={(e) => e.stopPropagation()}>
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
      {editing && (
        <div className="dialog-backdrop" onClick={() => closeEditor()}>
          {/* specs/ui.spec.md "Scenario edit dialog": the scenario name is the
              dialog title (an editable title unless published), the dialog is
              resizable, and the body is an embedded markdown editor. */}
          <div className="dialog scenario-dialog" ref={editingTrapRef} onClick={(e) => e.stopPropagation()}>
            {/* The close-editor widget (specs/editor/spec-editor.feature.md):
                like ESC, it leaves the scenario in its autosaved state. */}
            <button
              type="button"
              className="dialog-close"
              aria-label="Close editor"
              title="Close — the scenario keeps its autosaved state"
              onClick={() => closeEditor()}
            >
              ✕
            </button>
            {editingPublished ? (
              <h3 className="dialog-title">
                {editing.scenario.name} <span className="version">v{editing.scenario.version}</span>
                <span className="badge">published</span>
              </h3>
            ) : (
              <input
                className="dialog-title-input"
                value={editing.scenario.name}
                placeholder="Scenario name"
                aria-label="Scenario name"
                autoFocus
                onChange={(e) =>
                  setEditing({ ...editing, scenario: { ...editing.scenario, name: e.target.value } })
                }
              />
            )}
            {!editingPublished && (
              // The version is assigned by the app, never typed: a new scenario
              // takes the next version for its name (specs/ui.spec.md). The
              // status rides along as a badge: a scenario starts as a draft —
              // persisted by autosave, kept out of the .feature.md — until
              // Propose or Publish advances it
              // (specs/editor/spec-editor.feature.md).
              <p className="version-field">
                Version <span className="version">v{draftVersion}</span>
                <span className={`badge ${editing.scenario.status}`}>
                  {editing.scenario.status}
                </span>
              </p>
            )}
            <div className="body-field">
              <span className="field-label">Body</span>
              <MarkdownEditor
                value={editing.scenario.body}
                readOnly={editingPublished}
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
                              // whole dialog (specs/ui.spec.md).
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
                              onClick={() => startTestEdit(i)}
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              className="link"
                              title={`Remove ${t}`}
                              onClick={() => removeTest(i)}
                            >
                              ✕
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
            <div className="dialog-actions">
              {/* Proposed scenarios and drafts can be deleted
                  (specs/editor/spec-editor.feature.md) — confirmed first, then
                  saved out of the feature or removed from the document. Kept
                  apart from Propose/Publish on the far left. */}
              {editingDeletable && (
                <button className="danger" onClick={() => void deleteScenario()}>
                  Delete
                </button>
              )}
              {/* The two ways forward (specs/editor/spec-editor.feature.md):
                  Propose moves the draft into the .feature.md as [proposed];
                  Publish takes it straight to [published], committed and
                  pushed. Closing without either keeps the autosaved draft. */}
              {!editingPublished && (
                <>
                  <button
                    className="secondary"
                    onClick={() => void proposeScenario()}
                    disabled={!editing.scenario.name.trim()}
                  >
                    Propose
                  </button>
                  <button
                    onClick={() => void publishScenario()}
                    disabled={!editing.scenario.name.trim() || publishing !== null}
                  >
                    Publish
                  </button>
                </>
              )}
              {/* A published scenario is read-only apart from its test links,
                  so it only gets a Save button while those are in play. */}
              {editingPublished && showTestLinks && (
                <button onClick={saveScenario}>Save test links</button>
              )}
            </div>
            {/* Like the Settings dialog, the way out is ESC (or the ✕): the
                scenario stays in its autosaved state
                (specs/editor/spec-editor.feature.md). */}
            <p className="hint dialog-footnote">
              <kbd>esc</kbd> to exit
            </p>
          </div>
        </div>
      )}
      {/* Error box (specs/agents/claude.spec.md): what the Claude CLI said
          when it exited with an error code. */}
      {sessionError && (
        <div className="dialog-backdrop" onClick={() => setSessionError(null)}>
          <div
            className="dialog"
            role="alertdialog"
            aria-label="Code gen session failed"
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
      {/* Last, so a stacked prompt/confirm renders above any open dialog. */}
      {modal}
    </main>
  );
}

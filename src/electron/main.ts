// Electron entry (specs/app/desktop-app.feature.md): the desktop shell serves
// the built frontend and the shared server/api.ts routes over an internal
// app:// protocol — no localhost port is opened. In development
// (ELECTRON_DEV=1) the windows load the running Bun dev server instead, for
// HMR: the frontend is the dev server's, and the API calls its pages make
// are answered here all the same, each for its window's folder.

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeTheme,
  net,
  protocol,
  screen,
  session,
  shell,
} from "electron";
import { spawn } from "node:child_process";
import { constants, existsSync, rmSync } from "node:fs";
import { access, chmod, readFile, realpath, rename } from "node:fs/promises";
import inspector from "node:inspector";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyStartupState, handleApi } from "../server/api";
import {
  setWindowCloser,
  setWindowOpener,
  windowShowing,
  workingSessions,
  type WindowOpened,
} from "../server/windows";
import {
  closeWorkspace,
  currentWorkspace,
  detached,
  folderKey,
  folderOf,
  onWorkspaceChange,
  openWorkspace,
  runInWorkspace,
  settingsFolderWritten,
  workspaceById,
  workspaces,
  type PendingFolder,
  type Workspace,
  type WorkspaceFolder,
} from "../server/workspace";
import { specdrivenHome } from "../server/appSource";
import { FOLDER_TITLES, setFolderChooser } from "../server/folderChooser";
import { setActivator, setRelauncher, type ActivationResult } from "../server/relaunch";
import { run } from "../server/run";
import {
  HOME_SETTINGS_ENV,
  mergeRecentFolders,
  readState,
  recentCodeRepos,
  recentDataRepos,
  writeState,
  type RecentFolder,
} from "../server/state";
import { shutdown } from "../server/shutdown";
import { initTelemetry } from "../server/telemetry";
import { setTokenBackend } from "../server/tokenStore";
import { setConfluenceMcpLauncher, setConfluenceMcpTokensFile } from "../server/agentMcp";
import { setDesktopResources } from "../server/resourceUsage";
import { exportConfluenceTokens, onConfluenceTokensChanged, setConfluenceTokenBackend } from "../server/confluenceTokens";
import { setJiraTokenBackend } from "../server/jiraTokens";
import { setQtestTokenBackend } from "../server/qtestTokens";
import { setAhaTokenBackend } from "../server/ahaTokens";
import { LEGACY_SECRET_FILES, setSecretBackendFactory } from "../server/secrets";
import { appPagePath, DESKTOP_SCHEME } from "../frontend/route";
import { appMenuTemplate } from "./appMenu";
import { EXTRACT_SPECS_EVENT } from "../server/intentNames";
import { contextMenuTemplate } from "./contextMenu";
import { startInspector, devtoolsUrl } from "./debugger";
import { parseDesktopLink } from "./deepLink";
import { devServerUrl, isDevServerRequest, needsShell } from "./devFrontend";
import {
  createLinkRouter,
  linkPlace,
  navigationTarget,
  windowOpenTarget,
  type LinkWindow,
} from "./linkRouting";
import {
  loadWindowSession,
  planRestore,
  requestWindow,
  saveWindowSession,
  sessionFor,
  WINDOW_HEADER,
  windowUserAgent,
  type SavedWindow,
  type WindowSession,
} from "./windowSession";
import {
  createSecretSafeStorageBackend,
  createSiteTokenSafeStorageBackend,
  createSafeStorageBackend,
  safeStorageAvailable,
} from "./secureToken";
import { mimeType, shellHtml, staticFilePath } from "./static";
import { windowFolderName, windowTitle } from "./windowTitle";
import { bundleOf, handoverCommand, handoverEnv, planActivation, previousBundle, swapBundle } from "./updateActivation";
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  fitToDisplays,
  MIN_HEIGHT,
  MIN_WIDTH,
  type WindowState,
} from "./windowState";

const APP_ORIGIN = "app://specdriven";
/** The Updates page (src/frontend/UpdatesPage.tsx), where Check for Updates… goes. */
const UPDATES_PATH = appPagePath("updates");
const DEV_URL = devServerUrl(process.env);
/** Where the windows' pages come from: the app's own origin, and in development the dev server's. */
const APP_ORIGINS = DEV_URL ? [APP_ORIGIN, DEV_URL] : [APP_ORIGIN];

// One app-data anchor for the server modules (specs/app/desktop-app.feature.md
// "Data locations"): GitHub data repos are cloned under <userData>/repos.
// Settings are ~/.specdriven/settings.yaml only, shared with the web version
// (specs/ui/app-start.feature.md "Settings file"); a settings file left under
// <userData>/.specdriven is read only until the first save moves it home.
// The server modules read these lazily, so setting them at startup is early
// enough.
app.setName("SpecDriven");
const userData = app.getPath("userData");
process.env.SPECDRIVEN_ROOT = userData;
process.env[HOME_SETTINGS_ENV] = "1";
process.env.SPECDRIVEN_REPOS_DIR ||= join(userData, "repos");
// The tokens as the Confluence MCP server reads them (src/server/agentMcp
// .ts), written on a session's start and gone with the app: safeStorage
// decrypts in this process only.
const mcpTokensFile = join(userData, "confluence-tokens.mcp.json");

// OpenTelemetry (opt-in via the standard OTEL_* environment variables) must
// be up before the first sync or app:// API call so nothing escapes the
// pipeline.
initTelemetry();
// Quitting waits once for the app's work to end in order
// (src/server/shutdown.ts): the coding agent sessions — subprocesses, none
// may outlive the window that showed them — are ended and their records
// saved, the sync loop and the watchers stop, a git command still running is
// stopped, and the last telemetry is flushed. Every step there has a time
// limit, so the quit is held for a few seconds at most; the second quit,
// below, goes through. It is asked for from a later turn of the event loop:
// with nothing running the shutdown is over before this handler's event has
// been delivered, and Electron ignores a quit asked for while it still is —
// the app then stayed open, windowless, until it was killed.
let leaving = false;
app.on("will-quit", (event) => {
  rmSync(mcpTokensFile, { force: true });
  if (leaving) return;
  leaving = true;
  event.preventDefault();
  void shutdown().finally(() => setImmediate(() => app.quit()));
});

// A packaged macOS app launches with a minimal PATH; append the usual
// Homebrew locations so git and gh can be found there — every git operation
// needs the one, the default engine needs the other
// (specs/app/desktop-app.feature.md "Git") — ~/.local/bin, where the native
// Claude installer puts `claude` (specs/agents/agent-pane.feature.md),
// ~/.bun/bin, where install.sh puts the bun a self-fix rebuilds with
// (specs/app/self-healing.feature.md), and ~/.opencode/bin, where OpenCode's
// installer puts `opencode` — the agent plugins are installed, and offered in
// the pane, for the commands found on PATH
// (specs/agents/agent-plugins.feature.md).
if (process.platform === "darwin") {
  const parts = (process.env.PATH || "").split(":");
  for (const dir of [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    join(homedir(), ".local", "bin"),
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".opencode", "bin"),
  ]) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  process.env.PATH = parts.join(":");
}

// app:// must behave like a real origin — standard url semantics, fetch and
// history.pushState support — for the SPA and its relative /api calls.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// specdriven:// is the public face of the same paths
// (specs/ui/navigation.feature.md "links from outside the app"): registering it
// with the OS is what makes a link in chat, email or a browser launch this app.
// The packaged app declares it in its Info.plist too (package.json
// "build.protocols"); an unpackaged dev run has to point the OS at the electron
// binary plus this project.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DESKTOP_SCHEME, process.execPath, [resolve(process.argv[1]!)]);
  }
} else {
  app.setAsDefaultProtocolClient(DESKTOP_SCHEME);
}

// The built frontend sits next to the built main process: dist/renderer
// beside dist/electron, found from this module's own location rather than
// the app root — so the same bundle serves its own renderer whether it runs
// from inside app.asar, from the project in dev, or from the installed
// source a self-fix rebuilt it under (src/electron/boot.ts).
const rendererDir = fileURLToPath(new URL("../renderer/", import.meta.url));

// The application icon, dist/icon.png beside the bundles (build/icon.png,
// copied there by scripts/build-desktop.ts and scripts/dev-electron.ts).
// Packaged macOS and Windows apps carry theirs in the bundle and the
// executable; Linux window managers take the window's from here, and the
// dev run on macOS would otherwise show Electron's own in the dock.
const iconFile = fileURLToPath(new URL("../icon.png", import.meta.url));
const iconOption = process.platform === "linux" && existsSync(iconFile) ? { icon: iconFile } : {};

async function serveShell(): Promise<Response> {
  // Served for deep links too, so its asset urls must not depend on the
  // path (static.ts shellHtml).
  const shell = await readFile(join(rendererDir, "index.html"), "utf8");
  return new Response(shellHtml(shell), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * A development run's frontend (scripts/dev-electron.ts): the dev server's
 * own answer, hot reloading and all. A page url it has no route for — a
 * plugin's, of a folder the dev server does not have open — gets the shell,
 * as serveShell gives it in the packaged app.
 */
async function serveFromDevServer(req: Request): Promise<Response> {
  const res = await net.fetch(req, { bypassCustomProtocolHandlers: true });
  if (!needsShell({ method: req.method, accept: req.headers.get("accept") }, res.status)) return res;
  return net.fetch(`${DEV_URL}/`, { bypassCustomProtocolHandlers: true });
}

/**
 * The windows' request handler — app://, and in development the dev
 * server's address: API first, then bundled files, then the shell.
 */
async function serveApp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    // Whose request it is (src/electron/windowSession.ts): the API answers
    // for the folder open in that window. With several windows open a
    // request that names none of them is refused, never answered for a
    // folder its page may not be showing.
    const open = workspaces();
    const id = requestWindow(req.headers, open.map((w) => w.id));
    const workspace = id === null ? null : workspaceById(id);
    if (!workspace && open.length > 1 && url.pathname.startsWith("/api/")) {
      console.error(`[app://] ${url.pathname}: a request from no open window`);
      return Response.json({ error: "This request came from no open window" }, { status: 409 });
    }
    const api = await handleApi(req, workspace ? { workspace } : {});
    if (api) return api;
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (DEV_URL) return await serveFromDevServer(req);
    const filePath = staticFilePath(rendererDir, url.pathname);
    if (filePath) {
      const data = await readFile(filePath).catch(() => null);
      if (data) {
        return new Response(data, { headers: { "content-type": mimeType(filePath) } });
      }
    }
    // Deep links (specs/ui/navigation.feature.md): unknown paths serve the
    // shell.
    return await serveShell();
  } catch (e) {
    console.error(`[app://] ${url.pathname}: ${(e as Error).message}`);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** Anything that leaves the app opens in the default browser. */
function openInBrowser(url: string): void {
  void shell.openExternal(url);
}

// The windows (specs/app/multiple-windows.feature.md): each shows one
// folder, its workspace (src/server/workspace.ts), and comes back after a
// restart where it was left (src/electron/windowSession.ts).
interface AppWindow {
  win: BrowserWindow;
  /** The folder the window shows. */
  workspace: Workspace;
  /** The title its page last gave itself; the window's own names the folder too. */
  pageTitle: string;
  /** The user was asked about its working sessions and said to close it. */
  closeConfirmed: boolean;
}

const windows = new Map<number, AppWindow>();
/** The windows by use, the one used last at the end. */
const used: AppWindow[] = [];
/** The app is quitting: the windows closing now all come back at the next start. */
let quitting = false;
let nextWindowId = 1;

const sessionFile = join(userData, "window-state.json");
/** What the file holds: the windows to bring back, and each folder's place on screen. */
let windowSession: WindowSession = loadWindowSession(sessionFile) ?? { windows: [], bounds: {} };
/** The recent folders, for File → Open Recent and for links to a folder no window shows. */
let recentFolders: RecentFolder[] = [];

/** The window used last, or null when none is open. */
function frontWindow(): AppWindow | null {
  return used.at(-1) ?? null;
}

function windowOf(workspace: Workspace | null): AppWindow | null {
  if (!workspace) return null;
  return [...windows.values()].find((w) => w.workspace === workspace) ?? null;
}

function bringToFront(entry: AppWindow): void {
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.show();
  entry.win.focus();
}

function linkWindow(w: BrowserWindow): LinkWindow {
  return {
    isMinimized: () => w.isMinimized(),
    restore: () => w.restore(),
    focus: () => w.focus(),
    isLoading: () => w.webContents.isLoadingMainFrame(),
    afterLoad: (fn) => void w.webContents.once("did-finish-load", fn),
    run: (script) => void w.webContents.executeJavaScript(script),
  };
}

/** Where a link belongs among the windows open now (src/electron/linkRouting.ts). */
function placeOf(path: string) {
  const open = [...windows.values()].flatMap((w) =>
    w.workspace.folder.dataRepo && !w.workspace.folder.openCodeRepo
      ? [{ id: w.workspace.id, repo: w.workspace.folder.dataRepo }]
      : [],
  );
  return linkPlace(path, open, recentFolders.filter((f) => f.kind === "spec").map((f) => f.path));
}

/**
 * Deep links (specs/ui/navigation.feature.md "open a link from outside the
 * app"): shown in the window that has the link's folder open, or held as
 * the entry url of the window opened for them — for a folder no window
 * shows, or when no window is open at all.
 */
const links = createLinkRouter({
  window: (path) => {
    const place = path === null ? ({ kind: "front" } as const) : placeOf(path);
    if (place.kind === "folder") return null;
    const entry = place.kind === "window" ? windowOf(workspaceById(place.id)) : frontWindow();
    return entry && !entry.win.isDestroyed() ? linkWindow(entry.win) : null;
  },
  openWindow: (path) => {
    if (!app.isReady()) return;
    const place = placeOf(path);
    if (place.kind === "folder") openFolderWindow({ path: place.repo, kind: "spec" });
    // Running with every window closed (macOS): the one closed last comes back.
    else reopenLastWindow();
  },
});

// macOS delivers deep links here, both while the app runs and on a cold start
// — registered before whenReady so a launch-by-link isn't missed.
app.on("open-url", (event, url) => {
  event.preventDefault();
  const path = parseDesktopLink(url);
  if (path) links.open(path);
});

/**
 * Name a window after its folder and the page open in it
 * (src/electron/windowTitle.ts): what the Dock menu, the Window menu and
 * the task switcher list it by, where every page's own title starts with
 * the app's name.
 */
function retitle(entry: AppWindow): void {
  if (entry.win.isDestroyed()) return;
  entry.win.setTitle(windowTitle(entry.pageTitle, windowFolderName(entry.workspace.folder)));
}

/** A window's place on screen as it is saved. */
function placeOnScreen(w: BrowserWindow): WindowState {
  return { ...w.getNormalBounds(), maximized: w.isMaximized() };
}

/** The windows open now, as the session saves them. */
function openWindows(without?: AppWindow): SavedWindow[] {
  const front = [...used].reverse().find((w) => w !== without);
  return [...windows.values()]
    .filter((w) => w !== without && !w.win.isDestroyed())
    .map((w) => ({
      folder: w.workspace.folder,
      bounds: placeOnScreen(w.win),
      ...(w === front ? { focused: true } : {}),
    }));
}

/**
 * Save the windows to come back (src/electron/windowSession.ts). `without`
 * is a window being closed while others stay: it does not come back, though
 * its folder's place on screen is remembered.
 */
function saveSession(without?: AppWindow): void {
  const mirror = settingsFolderWritten() ?? windowSession.mirror;
  if (without && !without.win.isDestroyed()) {
    windowSession = sessionFor(windowSession, [{ folder: without.workspace.folder, bounds: placeOnScreen(without.win) }], mirror);
  }
  const open = openWindows(without);
  // A window closed while others stay is gone from the list even when the
  // ones that stay show no folder yet.
  if (without && open.length > 0 && open.every((w) => folderKey(w.folder) === "")) windowSession = { ...windowSession, windows: [] };
  windowSession = sessionFor(windowSession, open, mirror);
  saveWindowSession(sessionFile, windowSession);
}

/** A place for a new window that does not hide the one in front: a step down and to the right. */
function besideFront(): WindowState | null {
  const front = frontWindow();
  if (!front || front.win.isDestroyed()) return null;
  const at = front.win.getNormalBounds();
  return { x: at.x + 28, y: at.y + 28, width: at.width, height: at.height };
}

/**
 * `link: false` leaves a link held for a window still to open (the launch's
 * own, on a start that brings several windows back) to the window it is for.
 */
function createWindow(spec: { workspace: Workspace; bounds?: WindowState | null; link?: boolean }): AppWindow {
  // Geometry from where this folder's window was left, fitted to the
  // displays present now; null (first run, corrupt file, monitor gone)
  // means the centered default.
  const remembered = spec.bounds ?? windowSession.bounds[folderKey(spec.workspace.folder)] ?? null;
  const saved = fitToDisplays(
    remembered ?? besideFront(),
    screen.getAllDisplays().map((d) => d.workArea),
  );
  const win = new BrowserWindow({
    width: saved?.width ?? DEFAULT_WIDTH,
    height: saved?.height ?? DEFAULT_HEIGHT,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    ...iconOption,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // Matches the design system's --surface-1 so the window never flashes
    // white while the renderer loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1F1E1D" : "#F0EEE6",
    // specs/app/desktop-app.feature.md "Window": traffic lights sit inside the
    // sidebar header; it, the editor pane's header row and strips along the
    // window's edges are the drag regions (CSS app-region).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 21 } }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Spell check (specs/editor/common-editor.feature.md "Spell check"):
      // Chromium's checker, Electron's default, named so nobody wonders. The
      // OS checker on macOS; Hunspell on Windows and Linux, whose dictionary
      // for the OS language downloads on first use. Which fields it checks
      // is the renderer's call (src/frontend/spellCheckPref.ts).
      spellcheck: true,
    },
  });
  const entry: AppWindow = { win, workspace: spec.workspace, pageTitle: "", closeConfirmed: false };
  // Looked up by id from here on: `win.webContents` is gone once the window is.
  const contentsId = win.webContents.id;
  windows.set(contentsId, entry);
  used.push(entry);
  // The second of the two marks that say which window a request came from
  // (src/electron/windowSession.ts): requests made inside a worker carry it.
  win.webContents.setUserAgent(windowUserAgent(win.webContents.getUserAgent(), spec.workspace.id));

  // The right-click menu (src/electron/contextMenu.ts): suggestions for a
  // misspelt word and the edit verbs — Electron has no menu of its own, so
  // without this the underline led nowhere.
  win.webContents.on("context-menu", (_event, params) => {
    if (win.isDestroyed()) return;
    const wc = win.webContents;
    const template = contextMenuTemplate(params, {
      replaceMisspelling: (word) => wc.replaceMisspelling(word),
      addToDictionary: (word) => void wc.session.addWordToSpellCheckerDictionary(word),
    });
    if (template) Menu.buildFromTemplate(template).popup({ window: win });
  });

  // The page titles itself; the window takes that and puts its folder's
  // name first.
  win.on("page-title-updated", (event, title) => {
    event.preventDefault();
    entry.pageTitle = title;
    retitle(entry);
  });
  retitle(entry);

  if (saved?.maximized) win.maximize();

  // A window on screen is what an update's restart was for: the bundle it
  // renamed aside can go (src/electron/updateActivation.ts).
  win.webContents.once("did-finish-load", removePreviousBundle);

  win.on("focus", () => {
    const i = used.indexOf(entry);
    if (i >= 0) used.splice(i, 1);
    used.push(entry);
  });

  // Remember the geometry: debounced while a drag streams resize/move
  // events, then a final authoritative save on close (the window is still
  // alive there, unlike closed). getNormalBounds keeps the un-maximized
  // rect, so leaving a maximized session restores both the flag and the
  // size to return to. Fullscreen is deliberately not persisted.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!win.isDestroyed() && !quitting) saveSession();
    }, 400);
  };
  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("close", (event) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    // The quit saved every window as it stood (before-quit); from there on
    // the list is not touched, so all of them come back.
    if (quitting) return;
    const others = windows.size > 1;
    // Closing a window while others stay ends its folder's coding agent
    // sessions (specs/app/multiple-windows.feature.md "Closing and
    // restarting"): one still at work is asked about first.
    if (others && !entry.closeConfirmed) {
      const working = workingSessions(entry.workspace);
      if (working > 0) {
        event.preventDefault();
        void confirmClose(entry, working);
        return;
      }
    }
    // With others open this window does not come back; the last one does.
    saveSession(others ? entry : undefined);
  });

  win.on("closed", () => {
    windows.delete(contentsId);
    const i = used.indexOf(entry);
    if (i >= 0) used.splice(i, 1);
    if (quitting) return;
    // A window its own page closed (window.close()) never had `close`: the
    // list is brought up to date here too.
    saveSession();
    retire(entry.workspace);
  });

  // specs/app/desktop-app.feature.md "External links": target=_blank and plain
  // navigations away from the app both land in the default browser.
  // A specdriven:// link pasted into a spec body is one of ours: follow it
  // rather than handing the OS a link back to this same app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    links.follow(windowOpenTarget(url), openInBrowser);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const target = navigationTarget(url, APP_ORIGINS);
    if (target.kind === "inside") return;
    event.preventDefault();
    links.follow(target, openInBrowser);
  });

  // A link that arrived before the window existed becomes its entry url —
  // App.tsx resolves it on boot like any other deep link, flagged so it may
  // name its spec folder (linkEntry).
  const entryPath = spec.link === false ? "/" : links.takeEntry();
  void win.loadURL(DEV_URL ? `${DEV_URL}${entryPath}` : `${APP_ORIGIN}${entryPath}`);
  return entry;
}

/** Ask before closing a window whose folder has coding agent sessions at work. */
async function confirmClose(entry: AppWindow, working: number): Promise<void> {
  const { response } = await dialog.showMessageBox(entry.win, {
    type: "warning",
    message: working === 1 ? "A coding agent session is still working" : `${working} coding agent sessions are still working`,
    detail: "Closing this window ends the coding agent sessions of its folder.",
    buttons: ["Close Window", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0 || entry.win.isDestroyed()) return;
  entry.closeConfirmed = true;
  entry.win.close();
}

/**
 * A window is gone: its workspace closes, which ends what the app did for
 * its folder (src/server/api.ts). The last window to close first leaves its
 * folder in the settings file, so the app — still running on macOS, with no
 * window — goes on working for the folder it showed last, and that is the
 * folder a click on the Dock icon brings back.
 */
function retire(workspace: Workspace): void {
  if (windows.size > 0) {
    closeWorkspace(workspace.id);
    return;
  }
  void runInWorkspace(workspace, async () => writeState(await readState(userData), userData))
    .catch(() => {})
    .finally(() => closeWorkspace(workspace.id));
}

/** A window on a new workspace. */
function openWindowOn(folder: WorkspaceFolder, pending?: PendingFolder, bounds?: WindowState | null): AppWindow {
  return createWindow({ workspace: openWorkspace(`w${nextWindowId++}`, folder, pending), bounds });
}

/**
 * Open a folder in a window of its own, or bring the window that shows it
 * forward ("A folder is open in at most one window"). The new window's page
 * opens the folder as one picked by hand is opened (workspace.ts
 * PendingFolder); with no folder, the window asks for one.
 */
function openFolderWindow(folder?: PendingFolder): WindowOpened {
  if (folder) {
    const shown = windowOf(windowShowing(folder));
    if (shown) {
      bringToFront(shown);
      return "focused";
    }
  }
  openWindowOn({}, folder);
  saveSession();
  return "opened";
}

/** With no window open (macOS): the one closed last comes back, on its folder. */
function reopenLastWindow(): void {
  if (windows.size > 0) return;
  const last = windowSession.windows.find((w) => w.focused) ?? windowSession.windows[0];
  openWindowOn(last?.folder ?? {}, undefined, last?.bounds);
}

/** File → Open Folder…: ask for a folder, then open it in a window of its own. */
async function chooseFolderWindow(): Promise<void> {
  const front = frontWindow();
  const opts: Electron.OpenDialogOptions = {
    title: FOLDER_TITLES["data-repo"],
    properties: ["openDirectory", "createDirectory"],
  };
  const picked = front && !front.win.isDestroyed() ? await dialog.showOpenDialog(front.win, opts) : await dialog.showOpenDialog(opts);
  const path = picked.canceled ? null : picked.filePaths[0];
  if (path) openFolderWindow({ path });
}

/**
 * The application menu (src/electron/appMenu.ts): the standard roles plus
 * Check for Updates…, which shows the Updates page in the window — the
 * one deep links use. Development builds add a Debug menu that starts and
 * stops the main-process inspector (src/electron/debugger.ts); a packaged
 * app never opens a debug port.
 */
function installAppMenu(): void {
  const setRunning = (running: boolean) => {
    const stop = Menu.getApplicationMenu()?.getMenuItemById("debugger-stop");
    if (stop) stop.enabled = running;
  };
  const start = async () => {
    const url = startInspector(inspector);
    if (!url) {
      dialog.showErrorBox("Debugger", "Could not open an inspector port on 127.0.0.1.");
      return;
    }
    setRunning(true);
    const opts: Electron.MessageBoxOptions = {
      type: "info",
      title: "Debugger",
      message: `Main-process debugger listening on ${url}`,
      detail:
        "Attach from chrome://inspect, a VS Code \"node\" attach configuration, " +
        "or paste the DevTools url into Chrome. A paused breakpoint freezes this " +
        "window until you resume: the main process drives it.",
      buttons: ["Copy DevTools URL", "Copy WebSocket URL", "Close"],
      defaultId: 0,
      cancelId: 2,
    };
    const front = frontWindow();
    const { response } = front && !front.win.isDestroyed()
      ? await dialog.showMessageBox(front.win, opts)
      : await dialog.showMessageBox(opts);
    // Electron 44's clipboard returns a promise; nothing waits on it.
    if (response === 0) void clipboard.writeText(devtoolsUrl(url));
    if (response === 1) void clipboard.writeText(url);
  };
  const debug: Electron.MenuItemConstructorOptions[] = [
    // Starts the inspector, or shows the url of the one already
    // running (a launch with --inspect).
    { label: "Main-Process Debugger…", click: () => void start() },
    {
      id: "debugger-stop",
      label: "Stop Main-Process Debugger",
      enabled: Boolean(inspector.url()),
      click: () => {
        inspector.close();
        setRunning(false);
      },
    },
    { type: "separator" },
    { role: "toggleDevTools", label: "Toggle Window DevTools" },
  ];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate({
        platform: process.platform,
        onCheckForUpdates: () => links.open(UPDATES_PATH),
        // specs/app/multiple-windows.feature.md "Opening a window".
        file: {
          onNewWindow: () => void openFolderWindow(),
          onOpenFolder: () => void chooseFolderWindow(),
          recent: recentFolders.map((f) => ({
            label: f.kind === "code" ? `${f.path} — code repository` : f.path,
            onOpen: () => void openFolderWindow({ path: f.path, kind: f.kind }),
          })),
          // specs/app/extract-specs-from-code.feature.md: the dialog is the
          // page's own, so the window in front is told to open it — a new
          // window, which starts on the screen that offers it, when none is.
          onExtractSpecs: () => {
            const front = frontWindow();
            if (!front || front.win.isDestroyed()) return void openFolderWindow();
            front.win.focus();
            void front.win.webContents.executeJavaScript(`window.dispatchEvent(new Event(${JSON.stringify(EXTRACT_SPECS_EVENT)}))`);
          },
        },
        ...(app.isPackaged ? {} : { debug }),
      }),
    ),
  );
}

/**
 * Read the recent folders again and rebuild the menu around them: a folder
 * opened in any window joins File → Open Recent. Read as nobody's — the
 * list is the settings file's, the same for every window.
 */
async function refreshRecentFolders(): Promise<void> {
  try {
    const state = await detached(() => readState(userData));
    const list = mergeRecentFolders(state, recentDataRepos(state), recentCodeRepos(state));
    const same = list.length === recentFolders.length && list.every((f, i) => f.path === recentFolders[i]!.path && f.kind === recentFolders[i]!.kind);
    recentFolders = list;
    if (!same) installAppMenu();
  } catch {
    // The menu keeps the list it has.
  }
}

/** The install's app directory, ~/.specdriven/app, whose `current` link names the installed source. */
const installAppDir = join(specdrivenHome(process.env, homedir()), "app");

/**
 * Restarting into an installed newer version (src/electron/updateActivation.ts):
 * the plan, carried out — the bundle swapped on a Mac — then this instance
 * relaunched as the new executable once the route's answer is out.
 */
async function activateUpdate(newSourceDir: string): Promise<ActivationResult> {
  const plan = await planActivation({
    platform: process.platform,
    execPath: process.execPath,
    newSourceDir,
    appDir: installAppDir,
    fs: {
      realpath: (p) => realpath(p),
      writable: (dir) =>
        access(dir, constants.W_OK).then(
          () => true,
          () => false,
        ),
    },
  });
  if (plan.kind === "manual") return { restart: "manual", reason: plan.reason, path: plan.path };
  if (plan.kind === "hand-over") {
    const failure = await handOver(plan.appImage);
    // Nothing is waiting to start the new app: better to say so than to
    // quit into nothing, which is the bug this replaced (#446).
    if (failure) return { restart: "manual", reason: `The shell that would start the new app could not run here: ${failure}`, path: plan.appImage };
    // quit, not exit: will-quit still ends the agent sessions and flushes.
    setTimeout(() => app.quit(), RELAUNCH_DELAY_MS);
    return { restart: "relaunching" };
  }
  if (plan.kind === "swap-bundle") {
    await swapBundle(plan, {
      rename: (from, to) => rename(from, to),
      remove: removeBundle,
      copy: async (from, to) => {
        const result = await run("ditto", [from, to]);
        if (result.exitCode !== 0) throw new Error(`ditto failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      },
    });
  }
  app.relaunch({ execPath: plan.execPath, args: [] });
  // quit, not exit: will-quit still ends the agent sessions and flushes.
  setTimeout(() => app.quit(), RELAUNCH_DELAY_MS);
  return { restart: "relaunching" };
}

/**
 * Linux's restart (src/electron/updateActivation.ts): a detached `/bin/sh`
 * that outlives this app's AppImage mount, waiting for this process to go
 * and then starting the app at `execPath`. Detached (its own session) and
 * with a working directory of its own, so neither this process group nor
 * any directory that goes with the mount holds it back; the installer
 * already made the AppImage executable, and the chmod is for the case
 * where something left it unset.
 *
 * Returns why the shell could not be started, or null once it is running —
 * nothing may quit on the strength of a handover that never began.
 */
async function handOver(execPath: string): Promise<string | null> {
  let handover: ReturnType<typeof handoverCommand>;
  try {
    handover = handoverCommand(execPath, process.pid);
  } catch (e) {
    // Not a path the shell may be handed (it is not absolute).
    return (e as Error).message;
  }
  const { command, args } = handover;
  await chmod(execPath, 0o755).catch(() => {});
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    cwd: homedir(),
    env: handoverEnv(process.env),
  });
  const failure = await new Promise<string | null>((done) => {
    child.once("spawn", () => done(null));
    child.once("error", (e: Error) => done(e.message));
  });
  if (failure) return failure;
  child.unref();
  return null;
}

/** A beat after the restart route has answered, so the client hears it. */
const RELAUNCH_DELAY_MS = 300;

/**
 * Remove an .app bundle tree. Not `fs.rm({ recursive })`: inside Electron
 * the asar layer reports a valid `app.asar` as a directory, so Node's
 * recursive remove tries to `rmdir` it, reads the ENOTDIR as "already
 * gone", leaves the archive in place and then fails on its parent with
 * ENOTEMPTY — which is how a leftover `.previous` once blocked the next
 * update's swap. `rm -rf` in a child process sees the archive as the file
 * it is, and unlike `process.noAsar` it cannot disturb this process's own
 * module loads from its archive while the removal runs.
 */
async function removeBundle(path: string): Promise<void> {
  const result = await run("/bin/rm", ["-rf", path]);
  if (result.exitCode !== 0) throw new Error(`rm -rf ${path} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

/** The bundle an update renamed aside, removed once this launch has shown its window. */
function removePreviousBundle(): void {
  const bundle = bundleOf(process.execPath);
  if (!bundle) return;
  void removeBundle(previousBundle(bundle)).catch(() => {});
}

// One running app (specs/app/desktop-app.feature.md "Window",
// specs/app/multiple-windows.feature.md): a second launch focuses the window
// used last instead of starting another.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows and Linux deliver a deep link as an argument to the second
  // launch; macOS sends open-url to the running instance instead.
  app.on("second-instance", (_event, argv) => links.secondLaunch(argv));

  app.whenReady().then(async () => {
    // The renderer only ever loads local content; the one browser
    // permission it needs is writing "Copy link" urls to the clipboard.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, respond) => {
      respond(permission === "clipboard-sanitized-write");
    });
    protocol.handle("app", serveApp);
    // A development run: the dev server's address is answered here too —
    // its API calls by this process, as app:// ones are, and the rest by
    // the dev server. Its hot-reload socket is not a request and goes
    // straight there; so does http to any other host.
    if (DEV_URL) {
      protocol.handle("http", (req) =>
        isDevServerRequest(req.url, DEV_URL) ? serveApp(req) : net.fetch(req, { bypassCustomProtocolHandlers: true }),
      );
    }
    // The first of the two marks that say which window a request came from
    // (src/electron/windowSession.ts): the window's id, set where the
    // request leaves the window. Whatever a page put under that name is
    // replaced, and nothing but the app's own origins gets it.
    session.defaultSession.webRequest.onBeforeSendHeaders((details, done) => {
      const headers = { ...details.requestHeaders };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === WINDOW_HEADER) delete headers[name];
      }
      const id = details.webContentsId === undefined ? undefined : windows.get(details.webContentsId)?.workspace.id;
      if (id && APP_ORIGINS.some((origin) => details.url.startsWith(`${origin}/`))) headers[WINDOW_HEADER] = id;
      done({ requestHeaders: headers });
    });
    // GitHub, Confluence and Claude proxy token storage (specs/app/desktop-app.feature.md): OS-encrypted via
    // safeStorage; without a key store the server's 0600-file backend
    // stays in place. safeStorage needs the ready app, hence here.
    if (await safeStorageAvailable()) {
      setTokenBackend(createSafeStorageBackend(join(userData, "github-token.enc")));
      setConfluenceTokenBackend(createSiteTokenSafeStorageBackend(join(userData, "confluence-tokens.enc")));
      setJiraTokenBackend(createSiteTokenSafeStorageBackend(join(userData, "jira-tokens.enc")));
      setQtestTokenBackend(createSiteTokenSafeStorageBackend(join(userData, "qtest-tokens.enc")));
      setAhaTokenBackend(createSiteTokenSafeStorageBackend(join(userData, "aha-tokens.enc")));
      // The plugins' secret stores (src/server/secrets.ts), one encrypted
      // file each; a store from before them keeps its old file name.
      setSecretBackendFactory((name) => {
        const legacy = LEGACY_SECRET_FILES[name];
        const file = legacy ? join(userData, legacy.replace(/\.json$/, ".enc")) : join(userData, "secrets", `${name}.enc`);
        return createSecretSafeStorageBackend(file);
      });
    }
    // The Confluence MCP server for agent sessions (src/server/agentMcp.ts):
    // this bundle's copy run as node, reading the tokens from the file the
    // app writes while it runs — kept current as tokens come and go.
    setConfluenceMcpLauncher(() => ({
      command: process.execPath,
      args: [fileURLToPath(new URL("./mcp/confluence.js", import.meta.url))],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }));
    setConfluenceMcpTokensFile(() => exportConfluenceTokens(mcpTokensFile));
    // Resources (src/server/resourceUsage.ts): Electron's own figure for
    // each of its processes, where its app data lives, and its cache.
    setDesktopResources({
      userData,
      metrics: () =>
        app.getAppMetrics().map((m) => ({
          pid: m.pid,
          type: m.type,
          ...(m.name || m.serviceName ? { name: m.name || m.serviceName } : {}),
          // Electron reports kilobytes.
          bytes: m.memory.workingSetSize * 1024,
        })),
      clearBrowserCache: async () => {
        await session.defaultSession.clearCache();
        await session.defaultSession.clearCodeCaches({});
      },
    });
    onConfluenceTokensChanged(() => {
      if (existsSync(mcpTokensFile)) void exportConfluenceTokens(mcpTokensFile).catch(() => {});
    });
    // Data-directory picker (specs/ui/app-start.feature.md): replace the
    // server's osascript fallback with the native dialog, parented to the
    // window that asked for it — the route runs as that window's
    // (src/server/workspace.ts) — or to the one in front.
    setFolderChooser(async (title = FOLDER_TITLES["data-repo"]) => {
      const opts: Electron.OpenDialogOptions = {
        title,
        properties: ["openDirectory", "createDirectory"],
      };
      const asker = windowOf(currentWorkspace()) ?? frontWindow();
      const picked =
        asker && !asker.win.isDestroyed()
          ? await dialog.showOpenDialog(asker.win, opts)
          : await dialog.showOpenDialog(opts);
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    });
    // "Open in new window" in the folder dialog, and a folder picked that
    // another window shows (src/server/windows.ts): the routes ask here.
    setWindowOpener((folder) => openFolderWindow(folder));
    // Signing out in one window closes the others.
    setWindowCloser((except) => {
      for (const entry of [...windows.values()]) {
        if (entry.workspace === except || entry.win.isDestroyed()) continue;
        entry.closeConfirmed = true;
        entry.win.close();
      }
    });
    // A window changed folder: the list to bring back changes with it,
    // and the folder joins Open Recent.
    onWorkspaceChange((change, workspace) => {
      if (quitting) return;
      if (change === "folder") {
        saveSession();
        // The window is named after the folder it shows now.
        const entry = windowOf(workspace);
        if (entry) retitle(entry);
      }
      void refreshRecentFolders();
    });
    installAppMenu();
    if (!app.isPackaged && process.platform === "darwin" && existsSync(iconFile)) app.dock?.setIcon(iconFile);
    // A self-fix's "Rebuild & restart" (specs/app/self-healing.feature.md):
    // the next launch goes through the boot shim, which picks the bundle.
    // An AppImage cannot relaunch itself either (#446), so it hands over to
    // its own path the same way an update hands over to the new one.
    setRelauncher(async () => {
      const image = process.platform === "linux" ? process.env.APPIMAGE : undefined;
      // Electron's own relaunch everywhere else, and where the handover
      // could not be started it is still the only thing left to try.
      if (!image || (await handOver(image))) app.relaunch();
      // quit, not exit: will-quit still ends the agent sessions and flushes.
      app.quit();
    });
    // Check for Updates' "Restart now" (specs/app/app-updates.feature.md).
    setActivator(activateUpdate);
    // The windows the last run left open (src/electron/windowSession.ts),
    // each on its folder. Their workspaces are registered before the app's
    // start, which pulls every one's folder and mounts its plugins; the
    // windows themselves open once that is under way, as the one window
    // did.
    const settingsAtStart = folderOf(await detached(() => readState(userData)));
    const restored = planRestore(windowSession, settingsAtStart).map((saved) => ({
      saved,
      workspace: openWorkspace(`w${nextWindowId++}`, saved.folder),
    }));
    // The settings' folder as this start found it is the one to compare the
    // next start's against (windowSession.ts `mirror`).
    windowSession = { ...windowSession, mirror: settingsAtStart };
    await applyStartupState();
    await refreshRecentFolders();
    // Launched by a link on Windows or Linux; on macOS open-url already ran.
    links.holdLaunchLink(process.argv);
    // The window used last opens last, so it is the one in front.
    const front = restored.find((r) => r.saved.focused);
    // The launch's link goes to the window that shows its folder, else to
    // the one in front; a folder none of them shows gets a window of its own.
    const held = links.held();
    const place = held
      ? linkPlace(
          held,
          restored.flatMap((r) =>
            r.workspace.folder.dataRepo && !r.workspace.folder.openCodeRepo
              ? [{ id: r.workspace.id, repo: r.workspace.folder.dataRepo }]
              : [],
          ),
          recentFolders.filter((f) => f.kind === "spec").map((f) => f.path),
        )
      : null;
    const linked = place?.kind === "window" ? place.id : place?.kind === "front" ? front?.workspace.id : undefined;
    for (const { saved, workspace } of [...restored.filter((r) => r !== front), ...(front ? [front] : [])]) {
      createWindow({ workspace, bounds: saved.bounds, link: workspace.id === linked });
    }
    if (place?.kind === "folder") openFolderWindow({ path: place.repo, kind: "spec" });

    app.on("activate", () => {
      reopenLastWindow();
    });
  });

  // The quit: every window open now comes back at the next start, so the
  // list is saved here, as they stand, and left alone while they close.
  app.on("before-quit", () => {
    if (!quitting) saveSession();
    quitting = true;
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

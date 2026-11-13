// Electron entry (specs/app/desktop-app.feature.md): the desktop shell serves
// the built frontend and the shared server/api.ts routes over an internal
// app:// protocol — no localhost port is opened. In development
// (ELECTRON_DEV=1) it loads the running Bun dev server instead, for HMR.

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeTheme,
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
import { endAllChatSessions } from "../server/agentChat";
import { applyStartupState, handleApi } from "../server/api";
import { specdrivenHome } from "../server/appSource";
import { FOLDER_TITLES, setFolderChooser } from "../server/folderChooser";
import { setActivator, setRelauncher, type ActivationResult } from "../server/relaunch";
import { run } from "../server/run";
import { HOME_SETTINGS_ENV } from "../server/state";
import { initTelemetry, shutdownTelemetry, telemetryActive } from "../server/telemetry";
import { setTokenBackend } from "../server/tokenStore";
import { setConfluenceMcpLauncher, setConfluenceMcpTokensFile } from "../server/agentMcp";
import { exportConfluenceTokens, onConfluenceTokensChanged, setConfluenceTokenBackend } from "../server/confluenceTokens";
import { setJiraTokenBackend } from "../server/jiraTokens";
import { setQtestTokenBackend } from "../server/qtestTokens";
import { setAhaTokenBackend } from "../server/ahaTokens";
import { LEGACY_SECRET_FILES, setSecretBackendFactory } from "../server/secrets";
import { appPagePath, DESKTOP_SCHEME } from "../frontend/route";
import { appMenuTemplate } from "./appMenu";
import { contextMenuTemplate } from "./contextMenu";
import { startInspector, devtoolsUrl } from "./debugger";
import { parseDesktopLink } from "./deepLink";
import {
  createLinkRouter,
  navigationTarget,
  windowOpenTarget,
  type LinkWindow,
} from "./linkRouting";
import {
  createSecretSafeStorageBackend,
  createConfluenceSafeStorageBackend,
  createJiraSafeStorageBackend,
  createQtestSafeStorageBackend,
  createAhaSafeStorageBackend,
  createSafeStorageBackend,
  safeStorageAvailable,
} from "./secureToken";
import { mimeType, shellHtml, staticFilePath } from "./static";
import { bundleOf, handoverCommand, handoverEnv, planActivation, previousBundle, swapBundle } from "./updateActivation";
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  fitToDisplays,
  loadWindowState,
  MIN_HEIGHT,
  MIN_WIDTH,
  saveWindowState,
  type WindowState,
} from "./windowState";

const APP_ORIGIN = "app://specdriven";
/** The Updates page (src/frontend/UpdatesPage.tsx), where Check for Updates… goes. */
const UPDATES_PATH = appPagePath("updates");
const DEV_URL = process.env.ELECTRON_DEV
  ? `http://localhost:${process.env.PORT || 3000}`
  : null;

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
// pipeline. Quitting waits once for the final flush; with telemetry off both
// calls are no-ops and quit is untouched.
initTelemetry();
let telemetryFlushed = false;
app.on("will-quit", (event) => {
  // Coding agent sessions (src/server/agentChat.ts) are Claude subprocesses;
  // none may outlive the window that showed them.
  void endAllChatSessions();
  rmSync(mcpTokensFile, { force: true });
  if (telemetryFlushed || !telemetryActive()) return;
  telemetryFlushed = true;
  event.preventDefault();
  void shutdownTelemetry().finally(() => app.quit());
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

/** app:// request handler: API first, then bundled files, then the shell. */
async function serveApp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    const api = await handleApi(req);
    if (api) return api;
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
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

let win: BrowserWindow | null = null;

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

/**
 * Deep links (specs/ui/navigation.feature.md "open a link from outside the
 * app"): shown in the one window, or held as the entry url of the window
 * they open when there is none.
 */
const links = createLinkRouter({
  window: () => (win && !win.isDestroyed() ? linkWindow(win) : null),
  // Running with every window closed (macOS): nothing else will open one.
  openWindow: () => {
    if (app.isReady()) createWindow();
  },
});

// macOS delivers deep links here, both while the app runs and on a cold start
// — registered before whenReady so a launch-by-link isn't missed.
app.on("open-url", (event, url) => {
  event.preventDefault();
  const path = parseDesktopLink(url);
  if (path) links.open(path);
});

function createWindow(): void {
  // Geometry from the last run, fitted to the displays present now; null
  // (first run, corrupt file, monitor gone) means the centered default.
  const stateFile = join(userData, "window-state.json");
  const saved = fitToDisplays(
    loadWindowState(stateFile),
    screen.getAllDisplays().map((d) => d.workArea),
  );
  win = new BrowserWindow({
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

  // The right-click menu (src/electron/contextMenu.ts): suggestions for a
  // misspelt word and the edit verbs — Electron has no menu of its own, so
  // without this the underline led nowhere.
  win.webContents.on("context-menu", (_event, params) => {
    const wc = win?.webContents;
    if (!wc) return;
    const template = contextMenuTemplate(params, {
      replaceMisspelling: (word) => wc.replaceMisspelling(word),
      addToDictionary: (word) => void wc.session.addWordToSpellCheckerDictionary(word),
    });
    if (template && win) Menu.buildFromTemplate(template).popup({ window: win });
  });

  if (saved?.maximized) win.maximize();

  // A window on screen is what an update's restart was for: the bundle it
  // renamed aside can go (src/electron/updateActivation.ts).
  win.webContents.once("did-finish-load", removePreviousBundle);

  win.on("closed", () => {
    win = null;
  });

  // Remember the geometry: debounced while a drag streams resize/move
  // events, then a final authoritative save on close (the window is still
  // alive there, unlike closed). getNormalBounds keeps the un-maximized
  // rect, so leaving a maximized session restores both the flag and the
  // size to return to. Fullscreen is deliberately not persisted.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const currentState = (w: BrowserWindow): WindowState => ({
    ...w.getNormalBounds(),
    maximized: w.isMaximized(),
  });
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (win && !win.isDestroyed()) saveWindowState(stateFile, currentState(win));
    }, 400);
  };
  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("close", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (win && !win.isDestroyed()) saveWindowState(stateFile, currentState(win));
  });

  // specs/app/desktop-app.feature.md "External links": target=_blank and plain
  // navigations away from the app both land in the default browser.
  // A specdriven:// link pasted into a spec body is one of ours: follow it
  // in place rather than handing the OS a link back to this same window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    links.follow(windowOpenTarget(url), openInBrowser);
    return { action: "deny" };
  });
  const appOrigins = DEV_URL ? [APP_ORIGIN, DEV_URL] : [APP_ORIGIN];
  win.webContents.on("will-navigate", (event, url) => {
    const target = navigationTarget(url, appOrigins);
    if (target.kind === "inside") return;
    event.preventDefault();
    links.follow(target, openInBrowser);
  });

  // A link that arrived before the window existed becomes its entry url —
  // App.tsx resolves it on boot like any other deep link, flagged so it may
  // name its spec folder (linkEntry).
  const entryPath = links.takeEntry();
  void win.loadURL(DEV_URL ? `${DEV_URL}${entryPath}` : `${APP_ORIGIN}${entryPath}`);
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
    const { response } = win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, opts)
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
        ...(app.isPackaged ? {} : { debug }),
      }),
    ),
  );
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
    const failure = await handOver(plan.execPath);
    // Nothing is waiting to start the new app: better to say so than to
    // quit into nothing, which is the bug this replaced (#446).
    if (failure) return { restart: "manual", reason: `The shell that would start the new app could not run here: ${failure}`, path: plan.execPath };
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
  await chmod(execPath, 0o755).catch(() => {});
  const { command, args } = handoverCommand(execPath, process.pid);
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

// One main window (specs/app/desktop-app.feature.md "Window"): a second launch
// focuses the existing window.
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
    // GitHub, Confluence and Claude proxy token storage (specs/app/desktop-app.feature.md): OS-encrypted via
    // safeStorage; without a key store the server's 0600-file backend
    // stays in place. safeStorage needs the ready app, hence here.
    if (await safeStorageAvailable()) {
      setTokenBackend(createSafeStorageBackend(join(userData, "github-token.enc")));
      setConfluenceTokenBackend(createConfluenceSafeStorageBackend(join(userData, "confluence-tokens.enc")));
      setJiraTokenBackend(createJiraSafeStorageBackend(join(userData, "jira-tokens.enc")));
      setQtestTokenBackend(createQtestSafeStorageBackend(join(userData, "qtest-tokens.enc")));
      setAhaTokenBackend(createAhaSafeStorageBackend(join(userData, "aha-tokens.enc")));
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
    onConfluenceTokensChanged(() => {
      if (existsSync(mcpTokensFile)) void exportConfluenceTokens(mcpTokensFile).catch(() => {});
    });
    // Data-directory picker (specs/ui/app-start.feature.md): replace the
    // server's osascript fallback with the native dialog, parented to the
    // window.
    setFolderChooser(async (title = FOLDER_TITLES["data-repo"]) => {
      const opts: Electron.OpenDialogOptions = {
        title,
        properties: ["openDirectory", "createDirectory"],
      };
      const picked =
        win && !win.isDestroyed()
          ? await dialog.showOpenDialog(win, opts)
          : await dialog.showOpenDialog(opts);
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
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
    await applyStartupState();
    // Launched by a link on Windows or Linux; on macOS open-url already ran.
    links.holdLaunchLink(process.argv);
    createWindow();

    app.on("activate", () => {
      if (win === null) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

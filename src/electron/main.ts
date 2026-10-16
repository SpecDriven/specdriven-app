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
import { readFile } from "node:fs/promises";
import inspector from "node:inspector";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { endAllChatSessions } from "../server/agentChat";
import { applyStartupState, handleApi } from "../server/api";
import { FOLDER_TITLES, setFolderChooser } from "../server/folderChooser";
import { initTelemetry, shutdownTelemetry, telemetryActive } from "../server/telemetry";
import { setTokenBackend } from "../server/tokenStore";
import { setConfluenceTokenBackend } from "../server/confluenceTokens";
import { DESKTOP_SCHEME } from "../frontend/route";
import { startInspector, devtoolsUrl } from "./debugger";
import { parseDesktopLink } from "./deepLink";
import {
  createLinkRouter,
  navigationTarget,
  windowOpenTarget,
  type LinkWindow,
} from "./linkRouting";
import { createConfluenceSafeStorageBackend, createSafeStorageBackend, safeStorageAvailable } from "./secureToken";
import { mimeType, staticFilePath } from "./static";
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
const DEV_URL = process.env.ELECTRON_DEV
  ? `http://localhost:${process.env.PORT || 3000}`
  : null;

// One app-data anchor for the server modules (specs/app/desktop-app.feature.md
// "Data locations"): settings resolve from here (falling through to
// ~/.specdriven/settings.json, shared with the web version) and GitHub data
// repos are cloned under <userData>/repos. The server modules read these
// lazily, so setting them at startup is early enough.
app.setName("SpecDriven");
const userData = app.getPath("userData");
process.env.SPECDRIVEN_ROOT = userData;
process.env.SPECDRIVEN_REPOS_DIR ||= join(userData, "repos");

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
  if (telemetryFlushed || !telemetryActive()) return;
  telemetryFlushed = true;
  event.preventDefault();
  void shutdownTelemetry().finally(() => app.quit());
});

// A packaged macOS app launches with a minimal PATH; append the usual
// Homebrew locations so git and gh can be found there — every git operation
// needs the one, the default engine needs the other
// (specs/app/desktop-app.feature.md "Git") — and ~/.local/bin, where the native
// Claude installer puts `claude` (specs/agents/agent-pane.feature.md).
if (process.platform === "darwin") {
  const parts = (process.env.PATH || "").split(":");
  for (const dir of ["/usr/local/bin", "/opt/homebrew/bin", join(homedir(), ".local", "bin")]) {
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
// relative to the app root (the project in dev, app.asar when packaged).
const rendererDir = join(app.getAppPath(), "dist", "renderer");

async function serveShell(): Promise<Response> {
  const shellHtml = await readFile(join(rendererDir, "index.html"));
  return new Response(shellHtml, {
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
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // Matches the design system's --surface-1 so the window never flashes
    // white while the renderer loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1F1E1D" : "#F0EEE6",
    // specs/app/desktop-app.feature.md "Window": traffic lights sit inside the
    // sidebar header, which doubles as the drag region (CSS app-region).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 21 } }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (saved?.maximized) win.maximize();

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
 * Development builds only: Electron's default menu plus a Debug menu that
 * starts and stops the main-process inspector (src/electron/debugger.ts).
 * A packaged app keeps the default menu and never opens a debug port.
 */
function installDebugMenu(): void {
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
    if (response === 0) clipboard.writeText(devtoolsUrl(url));
    if (response === 1) clipboard.writeText(url);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        label: "Debug",
        submenu: [
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
        ],
      },
    ]),
  );
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
    // GitHub and Confluence token storage (specs/app/desktop-app.feature.md): OS-encrypted via
    // safeStorage; without a key store the server's 0600-file backend
    // stays in place. safeStorage needs the ready app, hence here.
    if (safeStorageAvailable()) {
      setTokenBackend(createSafeStorageBackend(join(userData, "github-token.enc")));
      setConfluenceTokenBackend(createConfluenceSafeStorageBackend(join(userData, "confluence-tokens.enc")));
    }
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
    if (!app.isPackaged) installDebugMenu();
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

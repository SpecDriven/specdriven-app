// Electron entry (specs/desktop-app.spec.md): the desktop shell serves the
// built frontend and the shared server/api.ts routes over an internal
// app:// protocol — no localhost port is opened. In development
// (ELECTRON_DEV=1) it loads the running Bun dev server instead, for HMR.

import { app, BrowserWindow, nativeTheme, protocol, session, shell } from "electron";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyStartupState, handleApi } from "../server/api";
import { setTokenBackend } from "../server/tokenStore";
import { DESKTOP_SCHEME } from "../frontend/route";
import { deepLinkFromArgv, parseDesktopLink } from "./deepLink";
import { createSafeStorageBackend, safeStorageAvailable } from "./secureToken";
import { mimeType, staticFilePath } from "./static";

const APP_ORIGIN = "app://specdriven";
const DEV_URL = process.env.ELECTRON_DEV
  ? `http://localhost:${process.env.PORT || 3000}`
  : null;

// One app-data anchor for the server modules (specs/desktop-app.spec.md
// "Data locations"): settings resolve from here (falling through to
// ~/.specdriven/settings.json, shared with the web version) and GitHub data
// repos are cloned under <userData>/repos. The server modules read these
// lazily, so setting them at startup is early enough.
app.setName("SpecDriven");
const userData = app.getPath("userData");
process.env.SPECDRIVEN_ROOT = userData;
process.env.SPECDRIVEN_REPOS_DIR ||= join(userData, "repos");

// A packaged macOS app launches with a minimal PATH; append the usual
// Homebrew locations so a non-system git can be found when the System git
// engine is selected or used as fallback (specs/desktop-app.spec.md "Git").
if (process.platform === "darwin") {
  const parts = (process.env.PATH || "").split(":");
  for (const dir of ["/usr/local/bin", "/opt/homebrew/bin"]) {
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

// specdriven:// is the public face of the same paths (specs/navigation.spec.md
// "links from outside the app"): registering it with the OS is what makes a
// link in chat, email or a browser launch this app. The packaged app declares
// it in its Info.plist too (package.json "build.protocols"); an unpackaged dev
// run has to point the OS at the electron binary plus this project.
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
    // Deep links (specs/navigation.spec.md): unknown paths serve the shell.
    return await serveShell();
  } catch (e) {
    console.error(`[app://] ${url.pathname}: ${(e as Error).message}`);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** Anything that leaves the app opens in the default browser. */
function openExternally(url: string): void {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

let win: BrowserWindow | null = null;
/** A deep link that arrived before there was a window to show it in. */
let pendingDeepLink: string | null = null;

/**
 * Show an app path that came from outside (specs/navigation.spec.md "open a
 * link from outside the app"). With a window up this is the same history jump
 * a sidebar click makes, so back returns to what was on screen; otherwise the
 * path is held and becomes the window's entry url.
 */
function openDeepLink(path: string): void {
  if (!win || win.isDestroyed()) {
    pendingDeepLink = path;
    // Running with every window closed (macOS): nothing else will open one.
    if (app.isReady()) createWindow();
    return;
  }
  const target = win;
  if (target.isMinimized()) target.restore();
  target.focus();
  const jump = () => {
    // JSON.stringify keeps a hostile url from breaking out of the string
    // literal; from there the renderer routes it like any other popstate.
    void target.webContents.executeJavaScript(
      `history.pushState(null, "", ${JSON.stringify(path)});` +
        `dispatchEvent(new PopStateEvent("popstate"));`,
    );
  };
  if (target.webContents.isLoadingMainFrame()) {
    target.webContents.once("did-finish-load", jump);
  } else {
    jump();
  }
}

// macOS delivers deep links here, both while the app runs and on a cold start
// — registered before whenReady so a launch-by-link isn't missed.
app.on("open-url", (event, url) => {
  event.preventDefault();
  const path = parseDesktopLink(url);
  if (path) openDeepLink(path);
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 500,
    // Matches the design system's --surface-1 so the window never flashes
    // white while the renderer loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1F1E1D" : "#F0EEE6",
    // specs/desktop-app.spec.md "Window": traffic lights sit inside the
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

  win.on("closed", () => {
    win = null;
  });

  // specs/desktop-app.spec.md "External links": target=_blank and plain
  // navigations away from the app both land in the default browser.
  // A specdriven:// link pasted into a spec body is one of ours: follow it
  // in place rather than handing the OS a link back to this same window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const deep = parseDesktopLink(url);
    if (deep) openDeepLink(deep);
    else openExternally(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const inside = url.startsWith(`${APP_ORIGIN}/`) || (DEV_URL && url.startsWith(DEV_URL));
    if (inside) return;
    event.preventDefault();
    const deep = parseDesktopLink(url);
    if (deep) openDeepLink(deep);
    else openExternally(url);
  });

  // A link that arrived before the window existed becomes its entry url —
  // App.tsx resolves it on boot like any other deep link.
  const entryPath = pendingDeepLink ?? "/";
  pendingDeepLink = null;
  void win.loadURL(DEV_URL ? `${DEV_URL}${entryPath}` : `${APP_ORIGIN}${entryPath}`);
}

// One main window (specs/desktop-app.spec.md "Window"): a second launch
// focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // Windows and Linux deliver a deep link as an argument to the second
    // launch; macOS sends open-url to the running instance instead.
    const path = deepLinkFromArgv(argv);
    if (path) {
      openDeepLink(path);
      return;
    }
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    // The renderer only ever loads local content; the one browser
    // permission it needs is writing "Copy link" urls to the clipboard.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, respond) => {
      respond(permission === "clipboard-sanitized-write");
    });
    protocol.handle("app", serveApp);
    // GitHub token storage (specs/desktop-app.spec.md): OS-encrypted via
    // safeStorage; without a key store the server's 0600-file backend
    // stays in place. safeStorage needs the ready app, hence here.
    if (safeStorageAvailable()) {
      setTokenBackend(createSafeStorageBackend(join(userData, "github-token.enc")));
    }
    await applyStartupState();
    // Launched by a link on Windows or Linux; on macOS open-url already ran.
    pendingDeepLink ??= deepLinkFromArgv(process.argv);
    createWindow();

    app.on("activate", () => {
      if (win === null) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

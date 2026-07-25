// Electron entry (specs/desktop-app.spec.md): the desktop shell serves the
// built frontend and the shared server/api.ts routes over an internal
// app:// protocol — no localhost port is opened. In development
// (ELECTRON_DEV=1) it loads the running Bun dev server instead, for HMR.

import { app, BrowserWindow, nativeTheme, protocol, session, shell } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyStartupState, handleApi } from "../server/api";
import { setTokenBackend } from "../server/tokenStore";
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const inside = url.startsWith(`${APP_ORIGIN}/`) || (DEV_URL && url.startsWith(DEV_URL));
    if (!inside) {
      event.preventDefault();
      openExternally(url);
    }
  });

  void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
}

// One main window (specs/desktop-app.spec.md "Window"): a second launch
// focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
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
    createWindow();

    app.on("activate", () => {
      if (win === null) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

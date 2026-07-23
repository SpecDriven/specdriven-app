// Bundled fonts (specs/ui.spec.md "Design system"): the desktop app must
// render identically offline, so no font CDN — the woff2 files ship with
// the bundle.
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/jetbrains-mono";

import { createRoot } from "react-dom/client";
import { App } from "./App";

// Under Electron (specs/desktop-app.spec.md "Window") the CSS makes room
// for the macOS traffic lights and marks the sidebar header as the drag
// region.
if (navigator.userAgent.includes("Electron")) {
  document.documentElement.dataset.desktop = navigator.userAgent.includes("Macintosh")
    ? "darwin"
    : "other";
}

createRoot(document.getElementById("root")!).render(<App />);

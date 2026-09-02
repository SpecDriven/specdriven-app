// Bundled fonts (specs/ui.spec.md "Design system"): the desktop app must
// render identically offline, so no font CDN — the woff2 files ship with
// the bundle.
import "@fontsource-variable/inter";
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

// On macOS the title bar is hidden, so besides the sidebar header the window
// edges double as drag regions: thin strips along all four borders let the
// window be moved by grabbing any edge (specs/desktop-app.spec.md "Window").
// They sit over the panes' padding, so no interactive element loses clicks.
if (document.documentElement.dataset.desktop === "darwin") {
  for (const edge of ["top", "right", "bottom", "left"]) {
    const strip = document.createElement("div");
    strip.className = "window-edge";
    strip.dataset.edge = edge;
    document.body.append(strip);
  }
}

createRoot(document.getElementById("root")!).render(<App />);

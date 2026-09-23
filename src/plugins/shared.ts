// What the host's build step and the browser's page global agree on
// (roadmap/plugin-architecture.md "One React"): which modules a plugin's
// browser half shares with the app instead of bundling, and the global the
// shims read them from. No imports, so both sides can take it.

/**
 * The modules a plugin's browser half shares with the app rather than
 * bundling. Icons are not among them on purpose: `lucide-react` bundles
 * tree-shaken per plugin — a few small components over the shared React —
 * which keeps the app from carrying every icon's name for the shim.
 */
export const SHARED_MODULES = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
] as const;

export type SharedModule = (typeof SHARED_MODULES)[number];

/** The page global the shims read from (src/plugins/client/sdk.ts). */
export const SDK_GLOBAL = "__specdriven";

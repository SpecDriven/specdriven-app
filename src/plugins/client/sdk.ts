// What the page publishes for plugin bundles (roadmap/plugin-architecture.md
// "One React"): the app's own React, ReactDOM and JSX runtime under
// `window.__specdriven.modules`, which the shims a plugin's browser half is
// built with (src/plugins/host/build.ts) re-export. One React on the page,
// so a plugin's components share the app's hooks, context and renderer.
// Published before the first render, ahead of any plugin import.

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import { version } from "../../../package.json";
import { SDK_GLOBAL, type SharedModule } from "../shared";

export interface PluginSdk {
  /** The app's version, for a plugin that wants to know. */
  version: string;
  /** The shared modules, by the specifier a plugin imports them under. */
  modules: Record<SharedModule, object>;
}

/** Put the shared modules on the page; idempotent. */
export function publishSdk(): PluginSdk {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[SDK_GLOBAL] as PluginSdk | undefined;
  if (existing) return existing;
  const sdk: PluginSdk = {
    version,
    modules: {
      react: React,
      "react-dom": ReactDOM,
      "react-dom/client": ReactDOMClient,
      "react/jsx-runtime": jsxRuntime,
      "react/jsx-dev-runtime": jsxDevRuntime,
    },
  };
  g[SDK_GLOBAL] = sdk;
  return sdk;
}

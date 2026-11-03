// Check for Updates' client store (specs/app/app-updates.feature.md): what
// GET /api/app-update says — the version running, whether an update can
// install here, the last check, and the install under way — kept at module
// level and read through useSyncExternalStore like the self-fix store
// (src/frontend/selfFix.ts). The pure helpers at the bottom — the headline
// and the controls for each state — take the snapshot, so they test
// without a DOM or a server.

import { useSyncExternalStore } from "react";
import type { ActivationResult } from "../server/relaunch";
import type { InstallState, UpdateCheck, UpdateIndex } from "../server/appUpdate";

export type { ActivationResult, InstallState, UpdateCheck, UpdateIndex };

export interface UpdateStore {
  /** The machine's state; null until GET /api/app-update has answered. */
  index: UpdateIndex | null;
  /** A check under way. */
  checking: boolean;
  /** Restart's answer, when the shell could not do it here. */
  manual: Extract<ActivationResult, { restart: "manual" }> | null;
  /** Restart under way: the app is about to quit. */
  restarting: boolean;
  error: string | null;
}

export const EMPTY_UPDATE: UpdateStore = { index: null, checking: false, manual: null, restarting: false, error: null };

let state: UpdateStore = EMPTY_UPDATE;
const listeners = new Set<() => void>();

function set(next: UpdateStore): void {
  state = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useAppUpdate(): UpdateStore {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function appUpdateState(): UpdateStore {
  return state;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return call<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** How often the page asks after an install under way, for its log. */
export const POLL_MS = 1000;

export const appUpdate = {
  subscribe,
  reset(): void {
    set(EMPTY_UPDATE);
  },
  /** The machine's state, the last check and the install under way. */
  async load(): Promise<UpdateIndex | null> {
    try {
      const index = await call<UpdateIndex>("/api/app-update");
      set({ ...state, index, error: null });
      return index;
    } catch (e) {
      set({ ...state, error: (e as Error).message });
      return null;
    }
  },
  /** Ask the releases page for the newest release. */
  async check(): Promise<UpdateCheck | null> {
    set({ ...state, checking: true, error: null, manual: null });
    try {
      const { check } = await post<{ check: UpdateCheck }>("/api/app-update/check");
      set({ ...state, checking: false, index: state.index ? { ...state.index, check } : state.index });
      return check;
    } catch (e) {
      set({ ...state, checking: false, error: (e as Error).message });
      return null;
    }
  },
  /** Start installing `version`; the server's words on refusal. */
  async install(version: string): Promise<boolean> {
    set({ ...state, error: null, manual: null });
    try {
      const { install } = await post<{ install: InstallState }>("/api/app-update/install", { version });
      set({ ...state, index: state.index ? { ...state.index, install } : state.index });
      return true;
    } catch (e) {
      set({ ...state, error: (e as Error).message });
      return false;
    }
  },
  /** Restart into the installed version; the shell says whether it could. */
  async restart(): Promise<ActivationResult | null> {
    set({ ...state, error: null, manual: null });
    try {
      const result = await post<ActivationResult>("/api/app-update/restart");
      if (result.restart === "manual") set({ ...state, manual: result });
      else set({ ...state, restarting: true });
      return result;
    } catch (e) {
      set({ ...state, error: (e as Error).message });
      return null;
    }
  },
};

// --- Pure helpers for the page -----------------------------------------------------------

export type UpdateStage =
  | { kind: "loading" }
  | { kind: "unchecked"; current: string }
  | { kind: "checking"; current: string }
  | { kind: "up-to-date"; current: string; checkedAt: string }
  | { kind: "available"; current: string; latest: string; url: string }
  | { kind: "installing"; version: string }
  | { kind: "ready"; version: string }
  | { kind: "failed"; version: string; error: string }
  | { kind: "restarting"; version: string };

/** Where the update stands, from the store: one stage, for one headline and one set of controls. */
export function updateStage(store: UpdateStore): UpdateStage {
  const { index } = store;
  if (!index) return { kind: "loading" };
  const { install, check } = index;
  if (store.restarting && install.version) return { kind: "restarting", version: install.version };
  if (install.phase === "installing" && install.version) return { kind: "installing", version: install.version };
  if (install.phase === "ready" && install.version) return { kind: "ready", version: install.version };
  if (install.phase === "failed" && install.version) return { kind: "failed", version: install.version, error: install.error ?? "The install failed" };
  if (store.checking) return { kind: "checking", current: index.current };
  if (!check) return { kind: "unchecked", current: index.current };
  if (check.newer) return { kind: "available", current: index.current, latest: check.latest, url: check.url };
  return { kind: "up-to-date", current: index.current, checkedAt: check.checkedAt };
}

/** The page's one-line summary of the stage. */
export function updateHeadline(stage: UpdateStage): string {
  switch (stage.kind) {
    case "loading":
      return "Loading…";
    case "unchecked":
      return `SpecDriven ${stage.current}`;
    case "checking":
      return `Checking for updates to SpecDriven ${stage.current}…`;
    case "up-to-date":
      return `SpecDriven ${stage.current} is up to date.`;
    case "available":
      return `SpecDriven ${stage.latest} is available. You are running ${stage.current}.`;
    case "installing":
      return `Installing SpecDriven ${stage.version}…`;
    case "ready":
      return `SpecDriven ${stage.version} is installed. Restart to use it.`;
    case "failed":
      return `SpecDriven ${stage.version} did not install.`;
    case "restarting":
      return `Restarting into SpecDriven ${stage.version}…`;
  }
}

export type UpdateControl = "check" | "install" | "restart" | "check-again";

/** Which buttons the stage offers, in order; the first is the main one. */
export function updateControls(stage: UpdateStage, canInstall: boolean): UpdateControl[] {
  switch (stage.kind) {
    case "loading":
    case "checking":
    case "installing":
    case "restarting":
      return [];
    case "unchecked":
    case "up-to-date":
      return ["check"];
    case "available":
      return canInstall ? ["install", "check-again"] : ["check-again"];
    case "ready":
      return ["restart"];
    case "failed":
      return canInstall ? ["install", "check-again"] : ["check-again"];
  }
}

/** The last lines of the installer's output, for the page. */
export function logTail(install: InstallState, lines = 12): string[] {
  return install.log.slice(-lines);
}

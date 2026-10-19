// Fix this app's client store (specs/app/self-healing.feature.md): what
// GET /api/self-fix says of the machine — whether a fix can start, and
// which bundle the desktop booted — plus each fix as the pane opens it.
// Module-level state read through useSyncExternalStore, like the issues
// store (src/frontend/issues.ts). The pure helpers at the bottom — titles,
// keys, the hints and banners — take the snapshot, so they test without a
// DOM or a server.

import { useSyncExternalStore } from "react";
import type { FixRecord, FixView, Preconditions, RestartPlan } from "../server/selfFix";
import { agentChat } from "./agentChat";
import { selfFixPath, type SelfFixRoute } from "../plugins/builtin/self-fix/route";
import { toast } from "./Toasts";

export type { FixRecord, FixView, Preconditions, RestartPlan };

export interface SelfFixIndex extends Preconditions {
  fixes: FixRecord[];
}

export interface SelfFixStore {
  /** The machine's state; null until GET /api/self-fix has answered. */
  index: SelfFixIndex | null;
  /** The fixes opened in the pane, by id. */
  views: Record<string, FixView>;
  /** Unified diffs fetched for Review changes, by id. */
  diffs: Record<string, string>;
  error: string | null;
}

export const EMPTY_SELF_FIX: SelfFixStore = { index: null, views: {}, diffs: {}, error: null };

let state: SelfFixStore = EMPTY_SELF_FIX;
const listeners = new Set<() => void>();

function set(next: SelfFixStore): void {
  state = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useSelfFix(): SelfFixStore {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function selfFixState(): SelfFixStore {
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

function withView(view: FixView): void {
  const fixes = state.index
    ? state.index.fixes.some((f) => f.id === view.fix.id)
      ? state.index.fixes.map((f) => (f.id === view.fix.id ? view.fix : f))
      : [view.fix, ...state.index.fixes]
    : null;
  set({
    ...state,
    views: { ...state.views, [view.fix.id]: view },
    ...(state.index && fixes ? { index: { ...state.index, fixes } } : {}),
  });
}

export const selfFix = {
  subscribe,
  reset(): void {
    set(EMPTY_SELF_FIX);
  },
  /** The machine's state and the list of fixes. */
  async load(): Promise<void> {
    try {
      const index = await call<SelfFixIndex>("/api/self-fix");
      set({ ...state, index, error: null });
    } catch (e) {
      set({ ...state, error: (e as Error).message });
    }
  },
  /** A new, empty fix record, to hang screenshots on. */
  async create(): Promise<string> {
    const { fix } = await post<{ fix: FixRecord }>("/api/self-fix");
    return fix.id;
  },
  async upload(id: string, file: File): Promise<string> {
    const form = new FormData();
    form.append("file", file, file.name);
    const { name } = await call<{ name: string }>(`/api/self-fix/${id}/screenshots`, { method: "POST", body: form });
    return name;
  },
  /** Start the agent on the fix and show its session in the agent pane. */
  async start(id: string, description: string): Promise<FixRecord> {
    const { fix, session } = await post<{ fix: FixRecord; session: { id: string } }>(`/api/self-fix/${id}/start`, {
      description,
    });
    agentChat.setActive(session.id);
    agentChat.openPane();
    await selfFix.refresh(id);
    return fix;
  },
  async refresh(id: string): Promise<FixView | null> {
    try {
      const view = await call<FixView>(`/api/self-fix/${id}`);
      withView(view);
      return view;
    } catch (e) {
      set({ ...state, error: (e as Error).message });
      return null;
    }
  },
  async diff(id: string): Promise<string> {
    const { diff } = await call<{ diff: string }>(`/api/self-fix/${id}/diff`);
    set({ ...state, diffs: { ...state.diffs, [id]: diff } });
    return diff;
  },
  /** Rebuild the bundles from the fixed source; the server's words on failure. */
  async build(id: string): Promise<boolean> {
    try {
      await post(`/api/self-fix/${id}/build`);
      await selfFix.refresh(id);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      await selfFix.refresh(id);
      return false;
    }
  },
  async restart(id: string): Promise<RestartPlan | null> {
    try {
      const plan = await post<RestartPlan>(`/api/self-fix/${id}/restart`);
      if (plan.restart === "manual") toast.info(`Restart the app to use the fix: ${plan.command}`);
      else toast.info("Restarting…");
      await selfFix.refresh(id);
      return plan;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    }
  },
  async revert(id: string): Promise<RestartPlan | null> {
    try {
      const plan = await post<RestartPlan>(`/api/self-fix/${id}/revert`);
      if (plan.restart === "manual") toast.info(`The source is back as installed; restart the app: ${plan.command}`);
      else toast.info("Reverted; restarting…");
      await selfFix.refresh(id);
      return plan;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    }
  },
};

// --- Pure helpers -----------------------------------------------------------------------

/** The React key for a view. */
export function selfFixKey(view: SelfFixRoute): string {
  return selfFixPath(view);
}

/** The first line of the user's words, for titles and rows. */
export function fixLabel(fix: FixRecord): string {
  const line = fix.description.split("\n")[0]?.trim() ?? "";
  return line ? line.slice(0, 80) : "New fix";
}

export function selfFixTitle(view: SelfFixRoute, store: SelfFixStore = state): string {
  if (view.kind === "new") return "Fix this app";
  const fix = store.views[view.id]?.fix ?? store.index?.fixes.find((f) => f.id === view.id);
  return fix ? `Fix: ${fixLabel(fix)}` : "Fix this app";
}

export interface Hint {
  text: string;
  /** The Settings page holds the remedy. */
  settings?: boolean;
  /** A fix cannot start until this is sorted. */
  blocking: boolean;
}

/** What stands in the way of a fix on this machine, in the order to fix it. */
export function preconditionHints(index: Preconditions): Hint[] {
  const hints: Hint[] = [];
  if (!index.codeGen) hints.push({ text: "Code generation is switched off in Settings.", settings: true, blocking: true });
  if (!index.claude) hints.push({ text: "The `claude` command is not on PATH; install Claude Code first.", blocking: true });
  if (!index.git) hints.push({ text: "git is not on PATH; it keeps the fix reviewable and revertible.", blocking: true });
  if (!index.source) {
    hints.push({ text: "The app's source was not found. Run the installer again, or set SPECDRIVEN_APP_SOURCE.", blocking: true });
  } else if (!index.source.match) {
    hints.push({ text: `The installed source is version ${index.source.version}, not the version running. Run the installer again.`, blocking: true });
  }
  if (!index.bun) hints.push({ text: "bun is not installed, so the fix can be made but not rebuilt into the app.", blocking: false });
  if (index.runtime === "desktop" && index.boot.source === "none") {
    hints.push({ text: "This desktop build predates self-fixing: a rebuilt fix cannot be loaded until the app is reinstalled.", blocking: false });
  }
  if (index.runtime === "web") {
    hints.push({ text: "The web server cannot restart itself: after a rebuild, run `bun run start` again.", blocking: false });
  }
  return hints;
}

/** The line the pane shows about the bundle the desktop booted, or null for the plain case. */
export function bootBanner(boot: Preconditions["boot"], fixes: FixRecord[] = []): string | null {
  const named = boot.fixId ? (fixes.find((f) => f.id === boot.fixId) ?? null) : null;
  const label = named ? `"${fixLabel(named)}"` : boot.fixId ? `fix ${boot.fixId.slice(0, 8)}` : "a fix";
  switch (boot.source) {
    case "patch":
      return `Running the rebuilt app with ${label}.`;
    case "asar":
      switch (boot.reason) {
        case "crash-loop":
          return `The rebuilt app with ${label} failed to start twice; this is the shipped build. Revert the fix, or ask the agent again.`;
        case "load-error":
          return `The rebuilt app with ${label} could not be loaded; this is the shipped build. Revert the fix, or ask the agent again.`;
        case "version-mismatch":
          return `A rebuilt ${label} was made for another version of the app and is ignored.`;
        default:
          return null;
      }
    default:
      return null;
  }
}

/** Which controls a fix offers, from its record and the machine. */
export function fixControls(view: FixView): { build: boolean; restart: boolean; revert: boolean } {
  const { fix, diff } = view;
  const changed = (diff?.files.length ?? 0) > 0;
  return {
    build: (fix.status === "running" || fix.status === "built" || fix.status === "applied") && changed,
    restart: fix.status === "built" || fix.status === "applied",
    revert: fix.status !== "draft" && fix.status !== "reverted",
  };
}

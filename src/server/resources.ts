// The Resources routes (specs/app/resource-usage.feature.md): memory and disk
// measured by src/server/resourceUsage.ts, for the places this app keeps
// things in, and the cleanups. Refused in the hosted app — its workers share
// a container — and in the demo, which hides Observability.

import { listChatSessions } from "./agentChat";
import { isDemoMode } from "./demoMode";
import { HOSTED_REFUSAL, isHostedMode } from "./hostedMode";
import { bodyOf, json, type Handler } from "./http";
import { getAppRoot } from "./paths";
import { dataRepoDir } from "./repo";
import { specdrivenHome } from "../plugins/host/sources";
import {
  checkCleanup,
  cleanUp,
  CleanupError,
  diskSnapshot,
  memorySnapshot,
  type ResourcePlaces,
} from "./resourceUsage";
import { codeRepoMode, specsOpen } from "./settingsModel";
import { readState, settingsDirectory } from "./state";
import { logSource } from "./telemetry";

/** Where the app keeps things now: the open folder is this window's. */
export async function resourcePlaces(): Promise<ResourcePlaces> {
  const root = getAppRoot();
  const state = await readState(root);
  const openFolder = codeRepoMode(state)
    ? { path: state.openCodeRepo!, kind: "code" as const }
    : specsOpen(state)
      ? { path: dataRepoDir(state.dataRepo!, root), kind: "spec" as const }
      : null;
  const logs = logSource();
  const liveWorktrees = new Set(
    listChatSessions()
      .filter((s) => s.worktree && s.status !== "ended" && s.status !== "error")
      .map((s) => s.worktree!.path),
  );
  return {
    home: specdrivenHome(),
    settingsDir: await settingsDirectory(root),
    openFolder,
    logFiles: logs.kind === "file" ? logs.files : null,
    liveWorktrees,
  };
}

const guarded =
  (handler: Handler): Handler =>
  (req, params) =>
    isHostedMode()
      ? json({ error: HOSTED_REFUSAL }, 403)
      : isDemoMode()
        ? json({ error: "Resources are not shown in the demo" }, 403)
        : handler(req, params);

export const getResourceMemory: Handler = guarded(async () => json(await memorySnapshot()));

export const getResourceDisk: Handler = guarded(async (req) => {
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  return json(await diskSnapshot(resourcePlaces, refresh));
});

export const postResourceCleanup: Handler = guarded(async (req) => {
  let body: Record<string, unknown>;
  try {
    body = await bodyOf(req);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  const request = checkCleanup(body);
  if (typeof request === "string") return json({ error: request }, 400);
  try {
    return json(await cleanUp(await resourcePlaces(), request));
  } catch (e) {
    if (e instanceof CleanupError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
});

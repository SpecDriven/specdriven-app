// The volume's layout (docs/deployment-railway.md "Isolation between
// users"). /data is root's and passable, not listable (0711). In it:
//
//   gateway/   the gateway's own: app.db and the datastore's clone. Where
//              the gateway is a process apart from the root spawner
//              (spawner.ts) it belongs to the gateway's uid, 0700 — the
//              gateway is not root and writes nowhere else.
//   users/     each person's folders, made by the spawner (spawner.ts).
//
// Before the gateway had a folder of its own, app.db and the datastore lay
// in /data itself, root's. They are moved in once, and handed over.

import { chmod, lchown, lstat, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { SYSTEM_PATH, systemTool } from "./limits";
import { folder } from "./spawner";

/** The gateway's folder on the volume. */
export function stateDirOf(dataDir: string): string {
  return join(dataDir, "gateway");
}

/** What lay in /data itself before the gateway had a folder. */
const LEGACY = ["app.db", "app.db-wal", "app.db-shm", "datastore"];

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/**
 * Make the gateway's folder and bring an older volume in line. `owner` is
 * the gateway's uid where root prepares the volume for it; null where one
 * process is both and the folder is simply its own.
 */
export async function prepareVolume(dataDir: string, owner: number | null): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o711 });
  const state = stateDirOf(dataDir);
  const info = await folder(state, 0o700);
  // Root writes here only while the folder is still root's: once handed
  // over it is the gateway's to arrange, and root stays out of it.
  if (owner !== null && info.uid === owner) return state;
  if (owner !== null && info.uid !== 0) throw new Error(`${state} belongs to uid ${info.uid}, not to the gateway's ${owner}`);

  for (const name of LEGACY) {
    const from = join(dataDir, name);
    const to = join(state, name);
    if ((await exists(from)) && !(await exists(to))) await rename(from, to);
  }
  if (owner === null) return state;

  // What is inside first and the folder last, so a start cut short here is
  // picked up again by the next one.
  for (const name of await readdir(state)) {
    const chown = Bun.spawn([systemTool("chown") ?? "chown", "-R", "-h", `${owner}:${owner}`, join(state, name)], {
      env: { PATH: SYSTEM_PATH },
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await chown.exited) !== 0) throw new Error(`chown of ${name} failed: ${await new Response(chown.stderr).text()}`);
  }
  await chmod(dataDir, 0o711);
  await lchown(state, owner, owner);
  return state;
}

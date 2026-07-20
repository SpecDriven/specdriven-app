import type { BunRequest } from "bun";
import index from "./index.html";
import {
  readState,
  writeState,
  needsDataRepo,
  normalizeScenarioPreviewLines,
} from "./server/state";
import type { SpecDrivenState } from "./server/state";
import { dataRepoDir, resolveDataRepo } from "./server/repo";
import { isRepoRoot } from "./server/git";
import {
  discoverScheme,
  ghCliAvailable,
  normalizeGitScheme,
  setGitScheme,
} from "./server/scheme";
import type { GitScheme } from "./server/scheme";
import { getCurrentUser } from "./server/user";
import {
  listFeatures,
  listFolders,
  readFeature,
  createFeature,
  createFolder,
  deleteFolder,
  moveFeature,
  renameFeature,
  saveFeature,
  publishFeature,
  resolveFeatureConflict,
} from "./server/features";
import { parseFeature } from "./server/parser";
import {
  createReloadScheduler,
  normalizeReloadSeconds,
  reloadData,
} from "./server/reload";

const ROOT = process.cwd();

// Cron data reload (specs/crud-feature.spec.md): git pull every n seconds,
// where n comes from the Settings dialog and is stored in .specdriven.
const reloader = createReloadScheduler(async () => {
  try {
    console.log(`[reload] ${await reloadData(ROOT)}`);
  } catch (e) {
    console.error(`[reload] ${(e as Error).message}`);
  }
});
readState(ROOT).then((state) => {
  reloader.set(normalizeReloadSeconds(state.reloadFrequencySeconds));
  // Git scheme (specs/git-operations.spec.md): apply the chosen scheme to
  // every git command; unset means auto-discover by probing on first use.
  setGitScheme(normalizeGitScheme(state.gitScheme));
});

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Git-scheme fields for /api/state (specs/git-operations.spec.md): the
 * scheme chosen in Settings (null = auto-discover), plus the scheme
 * auto-discovery found by probing the existing clone. A GET never clones —
 * without a local clone the detected scheme is simply unknown.
 */
async function gitSchemeFields(state: SpecDrivenState) {
  const gitScheme = normalizeGitScheme(state.gitScheme);
  let detected: GitScheme | null = null;
  if (!gitScheme && !needsDataRepo(state)) {
    const dir = dataRepoDir(state.dataRepo!, ROOT);
    if (await isRepoRoot(dir)) detected = await discoverScheme(dir);
  }
  return { gitScheme, gitSchemeDetected: detected };
}

/**
 * Resolve the configured data repo (local path or GitHub url, cloned on first
 * use) and hand its local directory to the handler.
 */
function withDataDir<Req>(
  handler: (dir: string, req: Req) => Response | Promise<Response>,
): (req: Req) => Promise<Response> {
  return async (req) => {
    const state = await readState(ROOT);
    if (needsDataRepo(state)) return json({ error: "data repo not configured" }, 409);
    let dir: string;
    try {
      dir = await resolveDataRepo(state.dataRepo!, ROOT);
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
    return handler(dir, req);
  };
}

const server = Bun.serve({
  // 3000 unless PORT says otherwise — the compiled binary is a single file
  // someone may run alongside a dev server on the same machine.
  port: Number(process.env.PORT) || 3000,
  routes: {
    "/": index,

    // Deep links (specs/navigation.spec.md): every /features/... url serves
    // the app shell; the client resolves it against /api/features/:file.
    "/features": index,
    "/features/*": index,

    // App start (specs/app-start.spec.md): the client asks for state; if no
    // data repo is recorded, it prompts the user for one. The repo may be a
    // regular GitHub url (https://github.com/SpecDriven/data-insurance).
    "/api/state": {
      GET: async () => {
        const state = await readState(ROOT);
        return json({
          dataRepo: state.dataRepo ?? null,
          needsDataRepo: needsDataRepo(state),
          reloadFrequencySeconds: normalizeReloadSeconds(state.reloadFrequencySeconds),
          scenarioPreviewLines: normalizeScenarioPreviewLines(state.scenarioPreviewLines),
          ...(await gitSchemeFields(state)),
          // specs/user-info-settings.spec.md: the OS user by default, with
          // the git identity that authors data-repo commits.
          user: await getCurrentUser(),
        });
      },
      PUT: async (req) => {
        const body = (await req.json()) as {
          dataRepo?: string;
          reloadFrequencySeconds?: number;
          scenarioPreviewLines?: number;
          gitScheme?: string | null;
        };
        if (
          body.dataRepo === undefined &&
          body.reloadFrequencySeconds === undefined &&
          body.scenarioPreviewLines === undefined &&
          body.gitScheme === undefined
        ) {
          return json(
            {
              error:
                "dataRepo, reloadFrequencySeconds, scenarioPreviewLines or gitScheme is required",
            },
            400,
          );
        }
        const state = await readState(ROOT);
        // Git scheme (specs/git-operations.spec.md): https, ssh or gh;
        // "auto" clears the choice so the scheme is re-discovered by
        // probing. Applied before a dataRepo change so a first clone
        // already follows the new scheme.
        if (body.gitScheme !== undefined) {
          const scheme = normalizeGitScheme(body.gitScheme);
          if (scheme === null && body.gitScheme !== "auto" && body.gitScheme !== null) {
            return json({ error: "gitScheme must be https, ssh, gh or auto" }, 400);
          }
          if (scheme === "gh" && !ghCliAvailable()) {
            return json({ error: "the gh scheme needs the GitHub CLI (gh) installed" }, 400);
          }
          if (scheme) state.gitScheme = scheme;
          else delete state.gitScheme;
          setGitScheme(scheme);
        }
        if (body.dataRepo !== undefined) {
          const dataRepo = body.dataRepo.trim();
          if (!dataRepo) return json({ error: "dataRepo is required" }, 400);
          // Verify access before recording: a GitHub url is cloned on first use
          // (specs/crud-feature.spec.md: "user is verified to have access to the
          // data GH repo").
          try {
            await resolveDataRepo(dataRepo, ROOT);
          } catch (e) {
            return json({ error: (e as Error).message }, 400);
          }
          state.dataRepo = dataRepo;
        }
        if (body.reloadFrequencySeconds !== undefined) {
          const n = body.reloadFrequencySeconds;
          if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
            return json({ error: "reloadFrequencySeconds must be a number >= 0" }, 400);
          }
          state.reloadFrequencySeconds = Math.floor(n);
        }
        // Scenario-list preview length (specs/ui.spec.md "Scenario List").
        if (body.scenarioPreviewLines !== undefined) {
          const n = body.scenarioPreviewLines;
          if (typeof n !== "number" || !Number.isFinite(n) || n < 1) {
            return json({ error: "scenarioPreviewLines must be a number >= 1" }, 400);
          }
          state.scenarioPreviewLines = Math.floor(n);
        }
        await writeState(state, ROOT);
        reloader.set(normalizeReloadSeconds(state.reloadFrequencySeconds));
        return json({
          dataRepo: state.dataRepo ?? null,
          needsDataRepo: needsDataRepo(state),
          reloadFrequencySeconds: normalizeReloadSeconds(state.reloadFrequencySeconds),
          scenarioPreviewLines: normalizeScenarioPreviewLines(state.scenarioPreviewLines),
          ...(await gitSchemeFields(state)),
        });
      },
    },

    // Sync button (specs/ui.spec.md "Main page"): immediate data reload —
    // one reload tick on demand, same as the cron (pull + push saved).
    "/api/reload": {
      POST: async () => {
        try {
          const message = await reloadData(ROOT);
          console.log(`[reload] ${message}`);
          return json({ message });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      },
    },

    "/api/features": {
      GET: withDataDir(async (dir) =>
        json({ features: await listFeatures(dir), folders: await listFolders(dir) }),
      ),
      POST: withDataDir(async (dir, req: BunRequest<"/api/features">) => {
        const body = (await req.json()) as { name?: string };
        try {
          const fileName = await createFeature(dir, body.name ?? "");
          return json({ fileName }, 201);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }),
    },

    "/api/features/:file": {
      GET: withDataDir(async (dir, req: BunRequest<"/api/features/:file">) => {
        // A name readFeature refuses — a legacy `<slug>.feature` still held by
        // an open tab, or a traversal attempt — is "not found", not a 500.
        let content: string | null;
        try {
          content = await readFeature(dir, req.params.file);
        } catch {
          return json({ error: "not found" }, 404);
        }
        if (content === null) return json({ error: "not found" }, 404);
        return json({ fileName: req.params.file, content, parsed: parseFeature(content) });
      }),
      PUT: withDataDir(async (dir, req: BunRequest<"/api/features/:file">) => {
        const body = (await req.json()) as {
          content?: string;
          resolveConflict?: boolean;
          save?: boolean;
        };
        if (typeof body.content !== "string") return json({ error: "content is required" }, 400);
        try {
          // save: auto-save locally with [proposed] markers; the reload cron
          // commits and pushes (specs/crud-feature.spec.md).
          if (body.save) return json(await saveFeature(dir, req.params.file, body.content));
          const result = body.resolveConflict
            ? await resolveFeatureConflict(dir, req.params.file, body.content)
            : await publishFeature(dir, req.params.file, body.content);
          return json(result, result.status === "conflict" ? 409 : 200);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }),
    },

    // Folders (specs/folders.spec.md): directories in the data repo that
    // hold feature files. Creation is local (git doesn't track empty dirs);
    // deletion only removes empty folders.
    "/api/folders": {
      POST: withDataDir(async (dir, req: BunRequest<"/api/folders">) => {
        const body = (await req.json()) as { path?: string };
        try {
          return json({ path: await createFolder(dir, body.path ?? "") }, 201);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }),
    },

    "/api/folders/:path": {
      DELETE: withDataDir(async (dir, req: BunRequest<"/api/folders/:path">) => {
        try {
          await deleteFolder(dir, req.params.path);
          return json({ message: "folder deleted" });
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }),
    },

    // Drag-move between folders (specs/folders.spec.md): a `git mv` into
    // the target directory, committed and pushed like a rename.
    "/api/features/:file/move": {
      POST: withDataDir(async (dir, req: BunRequest<"/api/features/:file/move">) => {
        const body = (await req.json()) as { folder?: string };
        try {
          return json(await moveFeature(dir, req.params.file, body.folder ?? ""));
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }),
    },

    // specs/ui.spec.md "Main page": the Edit link renames the actual feature
    // file; the rename is committed and pushed to GitHub using `git mv`.
    "/api/features/:file/rename": {
      POST: withDataDir(async (dir, req: BunRequest<"/api/features/:file/rename">) => {
        const body = (await req.json()) as { fileName?: string };
        try {
          return json(await renameFeature(dir, req.params.file, body.fileName ?? ""));
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }),
    },
  },
  // `bun run build` compiles with --production, which inlines NODE_ENV here:
  // the binary serves the pre-bundled frontend with cache headers, no HMR.
  development:
    process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
});

console.log(`SpecDriven running at ${server.url}`);

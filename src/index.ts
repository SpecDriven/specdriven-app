import type { BunRequest } from "bun";
import index from "./index.html";
import { readState, writeState, needsDataRepo } from "./server/state";
import { resolveDataRepo } from "./server/repo";
import {
  listFeatures,
  readFeature,
  createFeature,
  saveFeature,
  resolveFeatureConflict,
} from "./server/features";
import { parseFeature } from "./server/parser";

const ROOT = process.cwd();

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
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
  port: 3000,
  routes: {
    "/": index,

    // App start (specs/app-start.spec.md): the client asks for state; if no
    // data repo is recorded, it prompts the user for one. The repo may be a
    // regular GitHub url (https://github.com/SpecDriven/data-insurance).
    "/api/state": {
      GET: async () => {
        const state = await readState(ROOT);
        return json({ dataRepo: state.dataRepo ?? null, needsDataRepo: needsDataRepo(state) });
      },
      PUT: async (req) => {
        const body = (await req.json()) as { dataRepo?: string };
        const dataRepo = body.dataRepo?.trim();
        if (!dataRepo) return json({ error: "dataRepo is required" }, 400);
        // Verify access before recording: a GitHub url is cloned on first use
        // (specs/crud-feature.spec.md: "user is verified to have access to the
        // data GH repo").
        try {
          await resolveDataRepo(dataRepo, ROOT);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
        const state = await readState(ROOT);
        state.dataRepo = dataRepo;
        await writeState(state, ROOT);
        return json({ dataRepo: state.dataRepo, needsDataRepo: false });
      },
    },

    "/api/features": {
      GET: withDataDir(async (dir) => json({ features: await listFeatures(dir) })),
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
        const content = await readFeature(dir, req.params.file);
        if (content === null) return json({ error: "not found" }, 404);
        return json({ fileName: req.params.file, content, parsed: parseFeature(content) });
      }),
      PUT: withDataDir(async (dir, req: BunRequest<"/api/features/:file">) => {
        const body = (await req.json()) as { content?: string; resolveConflict?: boolean };
        if (typeof body.content !== "string") return json({ error: "content is required" }, 400);
        try {
          const result = body.resolveConflict
            ? await resolveFeatureConflict(dir, req.params.file, body.content)
            : await saveFeature(dir, req.params.file, body.content);
          return json(result, result.status === "conflict" ? 409 : 200);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }),
    },
  },
  development: { hmr: true, console: true },
});

console.log(`SpecDriven running at ${server.url}`);

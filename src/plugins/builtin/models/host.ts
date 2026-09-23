// Event Models' host half (roadmap/support-event-modeling.md): the JSON
// files in the data repo's `models` folder, each drawn on the Models tab's
// canvas, on routes that exist only while the plugin is mounted — list,
// create, read, save, delete, plus an export of the schema's half for other
// tools and a slice's feature scaffold. The sync tick's drift pass for the
// folder is the plugin's too, so it runs only while the switch is on.
//
// What stays in the core: the switch creating the folder on the spot
// (api.ts putState), `scope=models` search, and the models a code gen
// session bundles (api.ts resolveSessionRequest) — each a core feature that
// reads the folder, not a part of the tab.

import type { Context, Plugin } from "../../kernel";
import type { DataAccess } from "../../host/services";
import { json, type Handler, type Params } from "../../../server/http";
import {
  createModel,
  deleteModel,
  ensureModelsFolder,
  exportModel,
  generateSliceFeature,
  importModelDrift,
  listModels,
  readModel,
  saveModel,
} from "../../../server/models";
import { serializeExport } from "../../../server/eventModel/serialize";
import { manifest } from "./manifest";

type DirHandler = (dir: string, req: Request, params: Params) => Response | Promise<Response>;

/** Against the data dir, with the module's errors as 400 answers — or, for
    a route that says so, 404 when the message says the thing is not there. */
const guarded =
  (data: DataAccess) =>
  (handler: DirHandler, { notFound = false }: { notFound?: boolean } = {}): Handler =>
    data.withDir(async (dir, req, params) => {
      try {
        return await handler(dir, req, params);
      } catch (e) {
        const message = (e as Error).message;
        return json({ error: message }, notFound && /not found/i.test(message) ? 404 : 400);
      }
    });

const plugin: Plugin<Context> = {
  name: manifest.id,
  inject: ["routes", "data", "sync"],
  apply(ctx) {
    const routes = ctx.need("routes");
    const on = guarded(ctx.need("data"));
    const add = (method: string, pattern: string, handler: DirHandler, opts?: { notFound?: boolean }) =>
      ctx.effect(() => routes.add(method, pattern, on(handler, opts)));

    add("GET", "/api/models", async (dir) => json({ models: await listModels(dir) }));

    add("POST", "/api/models", async (dir, req) => {
      const body = (await req.json().catch(() => null)) as { name?: unknown; model?: unknown } | null;
      if (typeof body?.name !== "string") return json({ error: "name is required" }, 400);
      return json({ fileName: await createModel(dir, body.name, body.model) }, 201);
    });

    add("GET", "/api/models/:file", async (dir, _req, params) => {
      const model = await readModel(dir, params.file ?? "");
      return model === null ? json({ error: "Model not found" }, 404) : json(model);
    });

    // The canvas's autosave: a local write through the model's document —
    // the reload cron commits and pushes it, like a saved scenario.
    add("PUT", "/api/models/:file", async (dir, req, params) => {
      const body = (await req.json().catch(() => null)) as { file?: unknown } | null;
      if (body?.file === null || typeof body?.file !== "object") {
        return json({ error: "file is required" }, 400);
      }
      return json(await saveModel(dir, params.file ?? "", body.file));
    });

    add("DELETE", "/api/models/:file", async (dir, _req, params) =>
      json(await deleteModel(dir, params.file ?? "")),
    );

    // The schema's half alone, as a download — what eventmodelers.ai and the
    // other tools that speak the published schema take.
    add("GET", "/api/models/:file/export", async (dir, _req, params) => {
      const model = await exportModel(dir, params.file ?? "");
      if (model === null) return json({ error: "Model not found" }, 404);
      const stem = (params.file ?? "").split("/").pop()!.replace(/\.model\.json$/, "");
      return new Response(serializeExport(model), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${stem}.eventmodel.json"`,
        },
      });
    });

    // The bridge to the specs (src/server/eventModel/feature.ts): a slice
    // scaffolds its feature file — one scenario per Given / When / Then — and
    // is linked to it. The body may name the feature (with a `/` for a
    // folder); the slice's title otherwise. The canvas opens the new feature.
    add("POST", "/api/models/:file/slices/:slice/feature", async (dir, req, params) => {
      const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name : undefined;
      return json(await generateSliceFeature(dir, params.file ?? "", params.slice ?? "", name), 201);
    }, { notFound: true });

    // The sync tick (src/server/reload.ts): the folder is made when the repo
    // has none, and the models' documents are kept in step with their JSON.
    ctx.effect(() =>
      ctx.need("sync").drift(async (dir) => {
        await ensureModelsFolder(dir);
        return importModelDrift(dir);
      }),
    );
  },
};

export default plugin;

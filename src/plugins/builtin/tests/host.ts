// The test management module's host half (specs/app/tests.feature.md): the
// module's cases, plans and executions, all in one Automerge document
// (src/server/testing.ts), on routes that exist only while the plugin is
// mounted — so "the server refuses the module's requests while the switch
// is off" needs no per-route check. One read returns the whole module; each
// write returns the entity it touched, for the client to merge in.

import type { Context, Plugin } from "../../kernel";
import type { DataAccess } from "../../host/services";
import { bodyOf, json, type Handler, type Params } from "../../../server/http";
import {
  NotFoundError,
  createCase,
  createPlan,
  deleteCase,
  deleteExecution,
  deletePlan,
  readTesting,
  setResult,
  startExecution,
  updateCase,
  updateExecution,
  updatePlan,
} from "../../../server/testing";
import { getCurrentUser } from "../../../server/user";
import { manifest } from "./manifest";

type DirHandler = (dir: string, req: Request, params: Params) => Response | Promise<Response>;

/** Against the data dir, with the module's errors as 404 / 400 answers. */
const guarded =
  (data: DataAccess) =>
  (handler: DirHandler): Handler =>
    data.withDir(async (dir, req, params) => {
      try {
        return await handler(dir, req, params);
      } catch (e) {
        const status = e instanceof NotFoundError ? 404 : 400;
        return json({ error: (e as Error).message }, status);
      }
    });

const plugin: Plugin<Context> = {
  name: manifest.id,
  inject: ["routes", "data"],
  apply(ctx) {
    const routes = ctx.need("routes");
    const on = guarded(ctx.need("data"));
    const add = (method: string, pattern: string, handler: DirHandler) =>
      ctx.effect(() => routes.add(method, pattern, on(handler)));

    add("GET", "/api/tests", async (dir) => json(await readTesting(dir)));

    add("POST", "/api/tests/cases", async (dir, req) =>
      json({ case: await createCase(dir, await bodyOf(req)) }, 201),
    );
    add("PUT", "/api/tests/cases/:id", async (dir, req, params) =>
      json({ case: await updateCase(dir, params.id ?? "", await bodyOf(req)) }),
    );
    add("DELETE", "/api/tests/cases/:id", async (dir, _req, params) => {
      await deleteCase(dir, params.id ?? "");
      return json({ ok: true });
    });

    add("POST", "/api/tests/plans", async (dir, req) =>
      json({ plan: await createPlan(dir, await bodyOf(req)) }, 201),
    );
    add("PUT", "/api/tests/plans/:id", async (dir, req, params) =>
      json({ plan: await updatePlan(dir, params.id ?? "", await bodyOf(req)) }),
    );
    add("DELETE", "/api/tests/plans/:id", async (dir, _req, params) => {
      await deletePlan(dir, params.id ?? "");
      return json({ ok: true });
    });

    add("POST", "/api/tests/plans/:id/executions", async (dir, req, params) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      return json({ execution: await startExecution(dir, params.id ?? "", body) }, 201);
    });
    add("PUT", "/api/tests/executions/:id", async (dir, req, params) =>
      json({ execution: await updateExecution(dir, params.id ?? "", await bodyOf(req)) }),
    );
    add("PUT", "/api/tests/executions/:id/results/:caseId", async (dir, req, params) => {
      const body = await bodyOf(req);
      // Who recorded it: the git author when known, else the signed-in login,
      // else the OS user (specs/user-info-settings.feature.md).
      const user = await getCurrentUser();
      const by = user.name ?? user.login ?? user.username;
      return json({
        execution: await setResult(dir, params.id ?? "", params.caseId ?? "", { ...body, by }),
      });
    });
    add("DELETE", "/api/tests/executions/:id", async (dir, _req, params) => {
      await deleteExecution(dir, params.id ?? "");
      return json({ ok: true });
    });
  },
};

export default plugin;

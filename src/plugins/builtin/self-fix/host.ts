// Fix this app's host half (specs/app/self-healing.feature.md): the routes
// that record a fix, take its screenshots, start the agent on the installed
// source, show the diff, rebuild and restart or revert (src/server/
// selfFix.ts). They exist only while the plugin is mounted, so a
// switched-off module answers 404. The demo and a hosted worker refuse
// every one of them: neither runs code on the machine it serves from.
//
// The data repo is read, not required: a fix must start even while no
// folder is open, since the bug may be what keeps one from opening. The
// session carries the data repo beside the source when there is one.

import type { Context, Plugin } from "../../kernel";
import { json, type Handler } from "../../../server/http";
import { isDemoMode } from "../../../server/demoMode";
import { HOSTED_REFUSAL, isHostedMode } from "../../../server/hostedMode";
import { selfFixHandlers } from "../../../server/selfFix";
import { manifest } from "./manifest";

export const DEMO_REFUSAL = "The demo cannot change itself";

/** Refused where the app must not run code on its host; otherwise the handler. */
const guarded =
  (handler: Handler): Handler =>
  (req, params) => {
    if (isHostedMode()) return json({ error: HOSTED_REFUSAL }, 403);
    if (isDemoMode()) return json({ error: DEMO_REFUSAL }, 403);
    return handler(req, params);
  };

const plugin: Plugin<Context> = {
  name: manifest.id,
  inject: ["routes", "data"],
  apply(ctx) {
    const routes = ctx.need("routes");
    const data = ctx.need("data");
    const h = selfFixHandlers({ dataDir: () => data.dir() });
    const add = (method: string, pattern: string, handler: Handler) =>
      ctx.effect(() => routes.add(method, pattern, guarded(handler)));

    add("GET", "/api/self-fix", h.index!);
    add("POST", "/api/self-fix", h.create!);
    add("GET", "/api/self-fix/:id", h.view!);
    add("GET", "/api/self-fix/:id/diff", h.diff!);
    add("POST", "/api/self-fix/:id/screenshots", h.screenshot!);
    add("POST", "/api/self-fix/:id/start", h.start!);
    add("POST", "/api/self-fix/:id/build", h.build!);
    add("POST", "/api/self-fix/:id/restart", h.restart!);
    add("POST", "/api/self-fix/:id/revert", h.revert!);
  },
};

export default plugin;

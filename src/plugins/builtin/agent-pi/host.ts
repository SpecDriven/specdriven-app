// The Pi agent plugin's host half: it registers the provider
// (src/plugins/builtin/agent-pi/provider.ts) on the agent registry for as
// long as the plugin is mounted; switching the plugin off takes its
// sessions down with it (src/server/agentChat.ts).

import type { Context, Plugin } from "../../kernel";
import type { HostConfig } from "../../host/loader";
import { manifest } from "./manifest";
import { piProvider } from "./provider";

const plugin: Plugin<Context, HostConfig> = {
  name: manifest.id,
  inject: ["agents"],
  apply(ctx) {
    const agents = ctx.need("agents");
    ctx.effect(() => agents.register(piProvider));
  },
};

export default plugin;

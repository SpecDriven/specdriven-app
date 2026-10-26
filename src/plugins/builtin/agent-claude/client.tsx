// The Claude agent plugin's browser half: its Settings section
// (specs/agents/agent-plugins.feature.md "The Settings page shows a
// plugin's section") — how the Claude the app starts signs in, the proxy
// and its timeout — registered between Workflow and Git, where the core's
// own Claude section used to sit. A local Claude only, so not in the demo
// or the hosted app.

import type { Context, Plugin } from "../../kernel";
import { CORE_SETTINGS_ORDER, type SettingsSectionProps } from "../../client/settings";
import { manifest } from "./manifest";
import { ClaudeSettings } from "./ui/ClaudeSettings";

/** Where the section sits: after Workflow (900), before Git (1000). */
export const CLAUDE_SETTINGS_ORDER = CORE_SETTINGS_ORDER.workflow + 50;

function ClaudeSection(_props: SettingsSectionProps) {
  return <ClaudeSettings />;
}

const plugin: Plugin<Context> = {
  name: manifest.id,
  inject: ["settings"],
  apply(ctx) {
    const settings = ctx.need("settings");
    ctx.effect(() =>
      settings.add({
        id: "claude",
        title: "Claude",
        hint: "How the Claude the app starts signs in: your Claude account, or an API proxy with a token kept on this device.",
        order: CLAUDE_SETTINGS_ORDER,
        when: ({ demo, hosted }) => !demo && !hosted,
        Component: ClaudeSection,
      }),
    );
  },
};

export default plugin;

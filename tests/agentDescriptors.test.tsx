// The pane's view of the agents (src/frontend/agentChat.ts, src/frontend/
// AgentPane.tsx; specs/agents/agent-plugins.feature.md): what /api/state
// says of each plugin's agent is all the client knows, a session whose
// plugin is gone renders through a fallback, and the empty state points at
// Settings → Plugins when nothing can start — or at the agent's own Settings
// section, where it can be set up.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentEmptyGuide, TranscriptRow, modeDescription, statusLabel } from "../src/frontend/AgentPane";
import {
  agentChat,
  agentChatState,
  agentLabel,
  agentPaneOffered,
  agentsFromState,
  describeAgent,
  hasModes,
  offersFromState,
  usableAgents,
} from "../src/frontend/agentChat";
import { byRank, fallbackDescriptor } from "../src/server/agentTypes";
import { CLAUDE_AGENT, CODEX_AGENT, PI_AGENT, agent, agentsWith } from "./fixtures/agents";

describe("agent descriptors on the client", () => {
  test("a session's agent is read off the descriptors, or a fallback when its plugin is gone", () => {
    const all = agentsWith("claude", "codex", "pi");
    expect(describeAgent("codex", all)).toBe(all[1]!);
    expect(agentLabel("pi", all)).toBe("Pi");
    const gone = describeAgent("gemini", all);
    expect(gone).toEqual(fallbackDescriptor("gemini"));
    expect(agentLabel("gemini", all)).toBe("Gemini");
    expect(hasModes(CLAUDE_AGENT)).toBe(true);
    expect(hasModes(PI_AGENT)).toBe(false);
    expect(hasModes(gone)).toBe(false);
    expect(statusLabel("starting", gone)).toBe("Starting Gemini…");
    expect(statusLabel("idle", gone)).toBe("Ready");
    expect(modeDescription("auto", CODEX_AGENT)).toBe("Codex handles permission decisions");
    expect(modeDescription("plan", CODEX_AGENT)).toBe("Create a plan before making changes");
  });

  test("only agents whose CLI is there are usable, in rank order", () => {
    const shuffled = [PI_AGENT, { ...CODEX_AGENT, available: false }, CLAUDE_AGENT, agent({ id: "zed", rank: 5 })];
    expect(usableAgents(shuffled).map((a) => a.id)).toEqual(["zed", "claude", "pi"]);
    expect([...shuffled].sort(byRank).map((a) => a.id)).toEqual(["zed", "claude", "codex", "pi"]);
    expect(usableAgents([]).length).toBe(0);
  });

  test("the state's agents list is what the pane reads, and nothing stands in for it", () => {
    const fromList = agentsFromState({ agents: [PI_AGENT, { nope: true }, CLAUDE_AGENT] });
    expect(fromList.map((a) => a.id)).toEqual(["pi", "claude"]);
    // The per-agent flags of the releases before the list are not read any more.
    const flagsOnly: Record<string, unknown> = { canRunAgentPane: true, canRunCodex: true };
    expect(agentsFromState(flagsOnly)).toEqual([]);
    expect(agentsFromState({})).toEqual([]);
    expect(offersFromState({ agentOffers: [{ plugin: "agent-gemini", marketplace: "specdriven", label: "Gemini", description: "", cli: "gemini", cliFound: true }, 3] })).toHaveLength(1);
    expect(offersFromState({})).toEqual([]);
  });

  test("an agent plugin that arrives while the window is open offers the pane", () => {
    // The re-read after a plugin is installed, updated or rebuilt (App.tsx
    // refreshPlugins) goes through applyState like the boot load does; it
    // once updated only the plugin rows, so the pane button stayed hidden
    // until a reload.
    agentChat.setAgents([], []);
    expect(agentPaneOffered()).toBe(false);
    const known = agentChat.applyState({ agents: [CODEX_AGENT, CLAUDE_AGENT], agentOffers: [] });
    expect(known.map((a) => a.id)).toEqual(["codex", "claude"]);
    expect(agentChatState().agents.map((a) => a.id)).toEqual(["claude", "codex"]);
    expect(agentPaneOffered()).toBe(true);
    // Gone again (switched off), with an installable one for a CLI that is
    // here: still offered, through the offer.
    agentChat.applyState({ agentOffers: [{ plugin: "agent-gemini", marketplace: "specdriven", label: "Gemini", description: "", cli: "gemini", cliFound: true }] });
    expect(agentChatState().agents).toEqual([]);
    expect(agentPaneOffered()).toBe(true);
    agentChat.applyState({});
    expect(agentPaneOffered()).toBe(false);
  });
});

describe("AgentEmptyGuide", () => {
  const offer = (cliFound: boolean) => ({
    plugin: "agent-gemini",
    marketplace: "specdriven",
    label: "Gemini",
    description: "Google's Gemini CLI",
    cli: "gemini",
    cliFound,
  });

  test("with no agent plugin and nothing to install, it says agents come as plugins", () => {
    const html = renderToStaticMarkup(<AgentEmptyGuide agents={[]} offers={[]} onOpenPlugins={() => {}} />);
    expect(html).toContain("Coding agents come as plugins");
    expect(html).toContain("Open Plugins");
    expect(html).toContain('data-guide="none"');
    // Without a way to the Plugins page there is no button to it.
    expect(renderToStaticMarkup(<AgentEmptyGuide agents={[]} offers={[]} />)).not.toContain("Open Plugins");
  });

  test("an installed plugin whose CLI is missing says so in the provider's words", () => {
    const html = renderToStaticMarkup(<AgentEmptyGuide agents={agentsWith()} offers={[]} onOpenPlugins={() => {}} />);
    expect(html).toContain("Claude CLI not found");
    expect(html).toContain("Codex CLI not found");
    expect(html).toContain("Pi CLI not found");
    expect(html).toContain('data-guide="offers"');
  });

  test("an agent with its own Settings section offers the way there, and only that agent", () => {
    const opened: string[] = [];
    const agentSettings = (id: string) => (id === "claude" ? () => opened.push(id) : undefined);
    const html = renderToStaticMarkup(
      <AgentEmptyGuide agents={agentsWith()} offers={[]} onOpenPlugins={() => {}} agentSettings={agentSettings} />,
    );
    expect(html).toContain("Set up Claude");
    expect(html).not.toContain("Set up Codex");
    expect(html).not.toContain("Set up Pi");
    expect(renderToStaticMarkup(<AgentEmptyGuide agents={agentsWith()} offers={[]} />)).not.toContain("Set up");
  });

  test("a turn that failed to sign in offers the agent's Settings section beside its hint", () => {
    const failed = {
      id: "r1",
      kind: "result" as const,
      isError: true,
      subtype: "success",
      text: "Not logged in · Please run /login",
      costUsd: null,
      durationMs: 1200,
      numTurns: 1,
      at: "2026-11-01T10:00:00Z",
    };
    const claude = { ...CLAUDE_AGENT, loginHint: { text: "Sign in with your email in Settings → Claude." } };
    const html = renderToStaticMarkup(<TranscriptRow item={failed} agent={claude} openSettings={() => {}} />);
    expect(html).toContain("Sign in with your email in Settings → Claude.");
    expect(html).toContain("Open Settings");
    expect(renderToStaticMarkup(<TranscriptRow item={failed} agent={claude} />)).not.toContain("Open Settings");
    // A turn that failed for another reason offers nothing.
    const other = renderToStaticMarkup(<TranscriptRow item={{ ...failed, text: "Rate limited" }} agent={claude} openSettings={() => {}} />);
    expect(other).not.toContain("Open Settings");
  });

  test("a marketplace offer is installable when its CLI is there, and names the CLI first when not", () => {
    const found = renderToStaticMarkup(<AgentEmptyGuide agents={[]} offers={[offer(true)]} onOpenPlugins={() => {}} />);
    expect(found).toContain("Install the Gemini agent plugin");
    const absent = renderToStaticMarkup(<AgentEmptyGuide agents={[]} offers={[offer(false)]} onOpenPlugins={() => {}} />);
    expect(absent).toContain("<code>gemini</code>");
    expect(absent).toContain("install that first");
    expect(absent).not.toContain("Install the Gemini agent plugin");
  });
});

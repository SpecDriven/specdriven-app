// The agent registry (src/plugins/host/agents.ts, specs/agents/agent-plugins
// .feature.md): what a plugin registers is what the pane offers — by rank,
// described, with the first available one as the default — and what it
// disposes is gone, live sessions included (tests/agentEngine.test.ts).

import { describe, expect, test } from "bun:test";
import { createAgentRegistry, describeProvider, fromPlugin } from "../src/plugins/host/agents";
import { fakeProvider } from "./helpers/fakeAgent";

describe("agent registry", () => {
  test("lists providers by rank and describes them for the client", () => {
    const registry = createAgentRegistry();
    const { provider: pi } = fakeProvider({ id: "pi", rank: 30, capabilities: { permissionModes: [] } });
    const { provider: claude } = fakeProvider({ id: "claude", rank: 10, cli: "claude" });
    const { provider: codex } = fakeProvider({ id: "codex", rank: 20 });
    registry.register(fromPlugin(pi, "agent-pi"));
    registry.register(claude);
    registry.register(codex);
    expect(registry.list().map((p) => p.id)).toEqual(["claude", "codex", "pi"]);
    const described = registry.describe();
    expect(described.map((d) => d.id)).toEqual(["claude", "codex", "pi"]);
    expect(described[0]).toMatchObject({ id: "claude", cli: "claude", available: true, plugin: "core", rank: 10 });
    // The plugin stamp names where a provider came from.
    expect(described[2]).toMatchObject({ id: "pi", plugin: "agent-pi" });
    expect(described[2]!.capabilities.permissionModes).toEqual([]);
    // Two providers of the same rank sort by id.
    const { provider: a } = fakeProvider({ id: "zeta" });
    const { provider: b } = fakeProvider({ id: "alpha" });
    registry.register(a);
    registry.register(b);
    expect(registry.list().map((p) => p.id)).toEqual(["claude", "codex", "pi", "alpha", "zeta"]);
    expect(describeProvider(b).rank).toBe(50);
  });

  test("the default is the lowest-ranked provider whose CLI is there", () => {
    const registry = createAgentRegistry();
    let claudeThere = false;
    registry.register(fakeProvider({ id: "claude", rank: 10, available: () => claudeThere }).provider);
    registry.register(fakeProvider({ id: "codex", rank: 20 }).provider);
    expect(registry.default()?.id).toBe("codex");
    claudeThere = true;
    expect(registry.default()?.id).toBe("claude");
    expect(registry.get("codex")?.id).toBe("codex");
    expect(registry.get("nope")).toBeUndefined();
    const empty = createAgentRegistry();
    expect(empty.default()).toBeUndefined();
    expect(empty.describe()).toEqual([]);
  });

  test("oneShot picks the preferred provider when it answers, else the first by rank that does", () => {
    const registry = createAgentRegistry();
    const answer = async () => ({ text: "1", isError: false });
    registry.register(fakeProvider({ id: "codex", rank: 20, oneShot: answer }).provider);
    registry.register(fakeProvider({ id: "claude", rank: 10, oneShot: answer, available: () => false }).provider);
    registry.register(fakeProvider({ id: "pi", rank: 30 }).provider);
    // Claude would be preferred, but its CLI is gone.
    expect(registry.oneShot("claude")?.id).toBe("codex");
    expect(registry.oneShot()?.id).toBe("codex");
    expect(registry.oneShot("pi")?.id).toBe("codex");
    const none = createAgentRegistry();
    none.register(fakeProvider({ id: "pi" }).provider);
    expect(none.oneShot()).toBeUndefined();
  });

  test("registering an id again replaces the provider, and a disposer removes only its own", () => {
    const registry = createAgentRegistry();
    const changes: string[] = [];
    const unsubscribe = registry.subscribe((c) => changes.push(`${c.type}:${c.id}`));
    const first = fakeProvider({ id: "claude", label: "First" }).provider;
    const second = fakeProvider({ id: "claude", label: "Second" }).provider;
    const disposeFirst = registry.register(first);
    registry.register(second);
    expect(registry.get("claude")?.label).toBe("Second");
    expect(registry.list()).toHaveLength(1);
    // The earlier registration's disposer no longer owns the id.
    disposeFirst();
    expect(registry.get("claude")?.label).toBe("Second");
    expect(changes).toEqual(["added:claude", "added:claude"]);
    const disposeSecond = registry.register(second);
    disposeSecond();
    expect(registry.get("claude")).toBeUndefined();
    expect(changes.at(-1)).toBe("removed:claude");
    unsubscribe();
    registry.register(first);
    expect(changes).toHaveLength(4);
    expect(() => registry.register({ ...first, id: "" })).toThrow();
  });

  test("a provider's sign-in change is a change for its id alone; an unknown id is nothing", () => {
    const registry = createAgentRegistry();
    const changes: string[] = [];
    registry.subscribe((c) => changes.push(`${c.type}:${c.id}`));
    registry.register(fakeProvider({ id: "claude" }).provider);
    registry.changed("claude");
    registry.changed("codex");
    expect(changes).toEqual(["added:claude", "changed:claude"]);
  });
});

test("an agent's sign-in change has every open page re-read the agents", async () => {
  // The pane reads the descriptors off /api/state: after the email sign-in
  // fetched Claude Code it kept saying "not set up" until a restart.
  const { handleApi } = await import("../src/server/api");
  const { agents } = await import("../src/plugins/host/agents");
  const res = (await handleApi(new Request("http://x/api/plugins/events")))!;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const next = async () => decoder.decode((await reader.read()).value);
  expect(await next()).toContain(": connected");
  const dispose = agents.register(fakeProvider({ id: "signin-test" }).provider);
  try {
    agents.changed("signin-test");
    expect(await next()).toBe(`data: {"type":"changed"}\n\n`);
  } finally {
    dispose();
    await reader.cancel();
  }
});

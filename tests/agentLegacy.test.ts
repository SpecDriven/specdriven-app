// What the app wrote before agents were providers (src/server/agentLegacy.ts,
// specs/agents/agent-plugins.feature.md "A session record from before agent
// plugins still opens"): the old pane names read as provider ids, anything
// else as written.

import { expect, test } from "bun:test";
import { LEGACY_CODE_GEN_TARGETS, LEGACY_RECORD_AGENTS, normalizeRecordAgent } from "../src/server/agentLegacy";
import { fallbackDescriptor } from "../src/server/agentTypes";

test("a session record's agent from before agent plugins reads as the provider id", () => {
  expect(normalizeRecordAgent("pane")).toBe("claude");
  expect(normalizeRecordAgent("pi-pane")).toBe("pi");
  expect(normalizeRecordAgent("codex-pane")).toBe("codex");
  // A desktop launch and a plugin's own id pass through.
  expect(normalizeRecordAgent("claude-code-desktop")).toBe("claude-code-desktop");
  expect(normalizeRecordAgent("gemini")).toBe("gemini");
  expect(normalizeRecordAgent("")).toBeNull();
  expect(normalizeRecordAgent(undefined)).toBeNull();
  expect(normalizeRecordAgent(3)).toBeNull();
  expect(LEGACY_RECORD_AGENTS).toEqual({ pane: "claude", "pi-pane": "pi", "codex-pane": "codex" });
  expect(LEGACY_CODE_GEN_TARGETS).toEqual({ pane: "claude" });
});

test("a record whose plugin is gone renders through a fallback with no modes and no Stop", () => {
  const gone = fallbackDescriptor("gemini");
  expect(gone).toMatchObject({ id: "gemini", label: "Gemini", available: false, plugin: "" });
  expect(gone.capabilities.permissionModes).toEqual([]);
  expect(gone.capabilities.canInterrupt).toBe(false);
  expect(gone.missingMessage).toContain("No agent plugin provides \"gemini\"");
  expect(fallbackDescriptor("").label).toBe("Agent");
});

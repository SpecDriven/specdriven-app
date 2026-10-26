// The Settings page's extension point (src/plugins/client/settings.ts,
// specs/agents/agent-plugins.feature.md "The Settings page shows a plugin's
// section"): a plugin's browser half registers a section with an order,
// and it lands between the core sections its order puts it between, only
// where its `when` allows; the Claude agent plugin's section is one.

import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Context } from "../src/plugins/kernel";
import { Registry } from "../src/plugins/client/tabs";
import {
  CORE_SETTINGS_ORDER,
  sectionsAfter,
  sectionsBeforeAll,
  settingsSections,
  visibleSettingsSections,
  type SettingsSection,
} from "../src/plugins/client/settings";
import agentClaude, { CLAUDE_SETTINGS_ORDER } from "../src/plugins/builtin/agent-claude/client";
import { syncClientPlugins } from "../src/plugins/client/loader";

const section = (id: string, order: number, when?: SettingsSection["when"]): SettingsSection => ({
  id,
  title: id.toUpperCase(),
  order,
  ...(when ? { when } : {}),
  Component: () => <p>{id}</p>,
});

afterEach(async () => {
  await syncClientPlugins([]);
});

describe("settings sections", () => {
  test("sit between the core sections their order puts them between, in order", () => {
    const registry = new Registry<SettingsSection>((s) => s.order);
    registry.add(section("late", 950));
    registry.add(section("early", 50));
    registry.add(section("mid", 350));
    registry.add(section("also-mid", 320));
    registry.add(section("on-git", CORE_SETTINGS_ORDER.git));
    registry.add(section("after-git", 1500));
    const all = registry.list();
    expect(all.map((s) => s.id)).toEqual(["early", "also-mid", "mid", "late", "on-git", "after-git"]);
    expect(sectionsBeforeAll(all).map((s) => s.id)).toEqual(["early"]);
    expect(sectionsAfter(all, "specs").map((s) => s.id)).toEqual(["also-mid", "mid"]);
    expect(sectionsAfter(all, "workflow").map((s) => s.id)).toEqual(["late"]);
    // One ordered exactly on a core section comes right after it.
    expect(sectionsAfter(all, "git").map((s) => s.id)).toEqual(["on-git", "after-git"]);
    expect(sectionsAfter(all, "general")).toEqual([]);
  });

  test("show only where their when allows", () => {
    const all = [section("local", 950, ({ demo, hosted }) => !demo && !hosted), section("always", 960)];
    expect(visibleSettingsSections(all, { demo: false, hosted: false }).map((s) => s.id)).toEqual(["local", "always"]);
    expect(visibleSettingsSections(all, { demo: true, hosted: false }).map((s) => s.id)).toEqual(["always"]);
    expect(visibleSettingsSections(all, { demo: false, hosted: true }).map((s) => s.id)).toEqual(["always"]);
  });

  test("the Claude agent plugin registers its section between Workflow and Git, for a local app only", async () => {
    const client = new Context();
    const registry = new Registry<SettingsSection>((s) => s.order);
    client.provide("settings", registry);
    const scope = client.plugin(agentClaude);
    await scope.ready;
    expect(scope.error).toBeUndefined();
    const [claude] = registry.list();
    expect(claude).toMatchObject({ id: "claude", title: "Claude", order: CLAUDE_SETTINGS_ORDER });
    expect(CLAUDE_SETTINGS_ORDER).toBeGreaterThan(CORE_SETTINGS_ORDER.workflow);
    expect(CLAUDE_SETTINGS_ORDER).toBeLessThan(CORE_SETTINGS_ORDER.git);
    expect(sectionsAfter(registry.list(), "workflow").map((s) => s.id)).toEqual(["claude"]);
    expect(claude!.when!({ demo: false, hosted: false })).toBe(true);
    expect(claude!.when!({ demo: true, hosted: false })).toBe(false);
    expect(claude!.when!({ demo: false, hosted: true })).toBe(false);
    // The section renders without the server: it says it is checking.
    const Section = claude!.Component;
    const html = renderToStaticMarkup(<Section settings={{}} patchSettings={async () => true} demo={false} hosted={false} />);
    expect(html).toContain("Checking how Claude signs in");
    await scope.dispose();
    expect(registry.list()).toEqual([]);
  });

  test("the browser loader mounts the plugin's section with the profile, and unmounts it", async () => {
    await syncClientPlugins([{ id: "agent-claude", enabled: true, active: true }]);
    expect(settingsSections.list().map((s) => s.id)).toEqual(["claude"]);
    await syncClientPlugins([]);
    expect(settingsSections.list()).toEqual([]);
  });
});

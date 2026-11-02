// The Settings page's extension point (src/plugins/client/settings.ts,
// specs/agents/agent-plugins.feature.md "The Settings page shows a plugin's
// section"): a plugin's browser half registers a section with an order,
// and it lands between the core sections its order puts it between, only
// where its `when` allows; the Claude agent plugin's section is one
// (plugins/agent-claude in the SpecDriven/plugins repository).

import { describe, expect, test } from "bun:test";
import { Registry } from "../src/plugins/client/tabs";
import {
  CORE_SETTINGS_ORDER,
  sectionsAfter,
  sectionsBeforeAll,
  visibleSettingsSections,
  type SettingsSection,
} from "../src/plugins/client/settings";

const section = (id: string, order: number, when?: SettingsSection["when"]): SettingsSection => ({
  id,
  title: id.toUpperCase(),
  order,
  ...(when ? { when } : {}),
  Component: () => <p>{id}</p>,
});

describe("settings sections", () => {
  test("sit between the core sections their order puts them between, in order", () => {
    const registry = new Registry<SettingsSection>((s) => s.order);
    registry.add(section("late", 920));
    registry.add(section("on-agents", CORE_SETTINGS_ORDER.agents));
    registry.add(section("early", 50));
    registry.add(section("mid", 350));
    registry.add(section("also-mid", 320));
    registry.add(section("on-git", CORE_SETTINGS_ORDER.git));
    registry.add(section("after-git", 1500));
    const all = registry.list();
    expect(all.map((s) => s.id)).toEqual(["early", "also-mid", "mid", "late", "on-agents", "on-git", "after-git"]);
    expect(sectionsBeforeAll(all).map((s) => s.id)).toEqual(["early"]);
    expect(sectionsAfter(all, "specs").map((s) => s.id)).toEqual(["also-mid", "mid"]);
    expect(sectionsAfter(all, "workflow").map((s) => s.id)).toEqual(["late"]);
    // An agent plugin's section (Claude, at 950) follows AI agents.
    expect(sectionsAfter(all, "agents").map((s) => s.id)).toEqual(["on-agents"]);
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
});

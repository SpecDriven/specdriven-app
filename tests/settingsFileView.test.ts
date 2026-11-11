// The settings file as people read it (specs/app/user-info-settings.feature.md
// "view the settings file"): src/frontend/settingsFileView.ts turns
// ~/.specdriven/settings.yaml into labelled sections instead of YAML.
import { describe, expect, test } from "bun:test";
import { humanizeKey, settingsFileSections, settingsFileText, tildePath, type SettingsSection } from "../src/frontend/settingsFileView";

const HOME = "/Users/ann";

const row = (sections: SettingsSection[], key: string) =>
  sections.flatMap((s) => s.rows.map((r) => ({ ...r, section: s.title }))).find((r) => r.key === key);

describe("settingsFileSections", () => {
  test("known keys land in their section under the Settings page's label, sections in the app's order", () => {
    const sections = settingsFileSections(
      { settingsVersion: 1, featureFlags: true, gitEngine: "gh", dataRepo: "/Users/ann/specs" },
      HOME,
    );
    expect(sections.map((s) => s.title)).toEqual(["Folders", "Git & GitHub", "Specs", "Other"]);
    expect(row(sections, "featureFlags")).toMatchObject({ section: "Specs", label: "Feature flags" });
    expect(row(sections, "settingsVersion")).toMatchObject({ section: "Other", label: "Settings format version" });
  });

  test("switches read On and Off, intervals in seconds, engines and accesses in words", () => {
    const sections = settingsFileSections(
      {
        showTestLinks: false,
        codeGen: true,
        reloadFrequencySeconds: 60,
        autosaveIntervalSeconds: 1,
        gitEngine: "gh",
        gitAccess: "token",
        codeGenTarget: "desktop",
        syncServerUrl: "",
      },
      HOME,
    );
    expect(row(sections, "showTestLinks")!.value).toEqual({ kind: "text", text: "Off" });
    expect(row(sections, "codeGen")!.value).toEqual({ kind: "text", text: "On" });
    expect(row(sections, "reloadFrequencySeconds")!.value).toEqual({ kind: "text", text: "60 seconds" });
    expect(row(sections, "autosaveIntervalSeconds")!.value).toEqual({ kind: "text", text: "1 second" });
    expect(row(sections, "gitEngine")!.value).toEqual({ kind: "text", text: "GitHub CLI" });
    expect(row(sections, "gitAccess")!.value).toEqual({ kind: "text", text: "Personal access token" });
    expect(row(sections, "codeGenTarget")!.value).toEqual({ kind: "text", text: "Claude Code Desktop" });
    expect(row(sections, "syncServerUrl")!.value).toEqual({ kind: "text", text: "Off" });
  });

  test("an autosync frequency of 0 reads Off", () => {
    const sections = settingsFileSections({ reloadFrequencySeconds: 0 }, HOME);
    expect(row(sections, "reloadFrequencySeconds")!.value).toEqual({ kind: "text", text: "Off" });
  });

  test("recent folders are a list of paths from ~ with their kind", () => {
    const sections = settingsFileSections(
      {
        recentFolders: [
          { path: "/Users/ann/dev/specs-insurance", kind: "spec" },
          { path: "/opt/code/bookshop", kind: "code" },
        ],
      },
      HOME,
    );
    expect(row(sections, "recentFolders")!.value).toEqual({
      kind: "list",
      items: ["~/dev/specs-insurance (specifications)", "/opt/code/bookshop (code repository)"],
    });
  });

  test("the plugin profile names each folder's enabled plugins on one line", () => {
    const sections = settingsFileSections(
      { plugins: { repos: { "/Users/ann/specs": { enabled: ["roadmap", "tasks"] } }, enabled: ["notebook"] } },
      HOME,
    );
    const profile = row(sections, "plugins")!.value;
    expect(profile.kind).toBe("rows");
    if (profile.kind !== "rows") return;
    const repos = profile.rows.find((r) => r.key === "repos")!;
    expect(repos.label).toBe("Enabled plugins by folder");
    expect(repos.value).toEqual({
      kind: "rows",
      rows: [{ key: "/Users/ann/specs", label: "~/specs", value: { kind: "text", text: "roadmap, tasks" } }],
    });
    expect(profile.rows.find((r) => r.key === "enabled")!.deprecated).toBe(true);
  });

  test("a key the app no longer reads is marked deprecated", () => {
    const sections = settingsFileSections({ useGhAccount: true, roadmap: false }, HOME);
    expect(row(sections, "useGhAccount")!.deprecated).toBe(true);
    expect(row(sections, "roadmap")!.deprecated).toBe(true);
  });

  test("an unknown key lands under Other with a readable label, nested objects as rows", () => {
    const sections = settingsFileSections({ someNewThing: { maxItems: 3, darkMode: true } }, HOME);
    expect(row(sections, "someNewThing")).toMatchObject({
      section: "Other",
      label: "Some new thing",
      value: {
        kind: "rows",
        rows: [
          { key: "maxItems", label: "Max items", value: { kind: "text", text: "3" } },
          { key: "darkMode", label: "Dark mode", value: { kind: "text", text: "On" } },
        ],
      },
    });
  });

  test("plugin settings keep each plugin's id as its label", () => {
    const sections = settingsFileSections({ pluginSettings: { "agent-claude": { effort: "high" } } }, HOME);
    expect(row(sections, "pluginSettings")!.value).toEqual({
      kind: "rows",
      rows: [
        {
          key: "agent-claude",
          label: "agent-claude",
          value: { kind: "rows", rows: [{ key: "effort", label: "Effort", value: { kind: "text", text: "high" } }] },
        },
      ],
    });
  });

  test("an empty file has no sections", () => {
    expect(settingsFileSections({}, HOME)).toEqual([]);
  });
});

describe("helpers", () => {
  test("tildePath writes paths under home from ~", () => {
    expect(tildePath("/Users/ann/.specdriven/settings.yaml", HOME)).toBe("~/.specdriven/settings.yaml");
    expect(tildePath("/Users/anna/x", HOME)).toBe("/Users/anna/x");
    expect(tildePath("/tmp/x", "")).toBe("/tmp/x");
  });

  test("humanizeKey turns camelCase into words", () => {
    expect(humanizeKey("reloadFrequencySeconds")).toBe("Reload frequency seconds");
    expect(humanizeKey("syncServerURLValue")).toBe("Sync server url value");
  });
});

describe("settingsFileText", () => {
  test("copies the view as plain text, sections as headings and nested rows indented", () => {
    const sections = settingsFileSections(
      {
        featureFlags: true,
        useGhAccount: false,
        recentFolders: [{ path: "/Users/ann/specs", kind: "spec" }],
        pluginSettings: { "agent-claude": { defaultEffort: "high" } },
      },
      HOME,
    );
    expect(settingsFileText("~/.specdriven/settings.yaml", sections)).toBe(
      [
        "Settings file: ~/.specdriven/settings.yaml",
        "",
        "Folders",
        "  Recent folders:",
        "    - ~/specs (specifications)",
        "",
        "Git & GitHub",
        "  Use the GitHub CLI's account (no longer used): Off",
        "",
        "Specs",
        "  Feature flags: On",
        "",
        "Plugins",
        "  Plugin settings:",
        "    agent-claude:",
        "      Default effort: high",
        "",
      ].join("\n"),
    );
  });
});

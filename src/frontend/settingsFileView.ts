// The settings file as people read it (specs/app/user-info-settings.feature.md
// "view the settings file"): ~/.specdriven/settings.json turned into labelled
// sections — On / Off, seconds, folder lists — instead of JSON. Pure, so the
// dialog (src/frontend/SettingsFileDialog.tsx) and its tests share it.

/** One value as shown: a line of text, a bullet list, or nested rows. */
export type SettingsValue =
  | { kind: "text"; text: string; muted?: boolean }
  | { kind: "list"; items: string[] }
  | { kind: "rows"; rows: SettingsRow[] };

export interface SettingsRow {
  key: string;
  label: string;
  value: SettingsValue;
  /** A key the app no longer reads; older files may still carry it. */
  deprecated?: boolean;
}

export interface SettingsSection {
  title: string;
  rows: SettingsRow[];
}

interface Known {
  section: string;
  label: string;
  deprecated?: boolean;
  format?: (value: unknown, home: string) => SettingsValue;
}

const SECTION_ORDER = [
  "Folders",
  "Git & GitHub",
  "Sync",
  "Specs",
  "Integrations",
  "Agents",
  "Plugins",
  "Logging",
  "Other",
];

const text = (t: string, muted = false): SettingsValue => (muted ? { kind: "text", text: t, muted } : { kind: "text", text: t });

/** A path under the home directory, written from `~`. */
export function tildePath(path: string, home: string): string {
  if (!home) return path;
  const h = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === h) return "~";
  return path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

/** `reloadFrequencySeconds` → "Reload frequency seconds". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

const seconds = (n: number) => (n === 1 ? "1 second" : `${n} seconds`);

function words(map: Record<string, string>) {
  return (value: unknown, home: string): SettingsValue =>
    typeof value === "string" && map[value] ? text(map[value]!) : formatValue(value, home);
}

function secondsValue(offWhenZero: boolean) {
  return (value: unknown, home: string): SettingsValue => {
    if (typeof value !== "number") return formatValue(value, home);
    if (offWhenZero && value === 0) return text("Off");
    return text(seconds(value));
  };
}

const offWhenEmpty = (value: unknown, home: string): SettingsValue =>
  value === "" ? text("Off") : formatValue(value, home);

function recentFolders(value: unknown, home: string): SettingsValue {
  if (!Array.isArray(value)) return formatValue(value, home);
  if (value.length === 0) return text("none", true);
  return {
    kind: "list",
    items: value.map((entry) => {
      if (entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
        const { path, kind } = entry as { path: string; kind?: unknown };
        const what = kind === "code" ? "code repository" : kind === "spec" ? "specifications" : null;
        return what ? `${tildePath(path, home)} (${what})` : tildePath(path, home);
      }
      return scalarText(entry, home);
    }),
  };
}

const PLUGIN_KEYS: Record<string, { label: string; deprecated?: boolean }> = {
  repos: { label: "Enabled plugins by folder" },
  enabled: { label: "Enabled plugins (no folder open)", deprecated: true },
  sources: { label: "Plugin folders" },
  trusted: { label: "Trusted data-repo plugin folders" },
  seen: { label: "Plugins already adopted" },
  marketplaces: { label: "Marketplaces" },
};

/** Plugin ids, short names, read best on one line. */
function inlineIds(value: unknown, home: string): SettingsValue {
  if (!Array.isArray(value)) return formatValue(value, home);
  if (value.length === 0) return text("none", true);
  return text(value.map((v) => scalarText(v, home)).join(", "));
}

function pluginProfile(value: unknown, home: string): SettingsValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return formatValue(value, home);
  const rows: SettingsRow[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const known = PLUGIN_KEYS[key];
    let shown: SettingsValue;
    if (key === "repos" && v && typeof v === "object" && !Array.isArray(v)) {
      shown = {
        kind: "rows",
        rows: Object.entries(v as Record<string, unknown>).map(([folder, entry]) => {
          const enabled = (entry as { enabled?: unknown } | null)?.enabled;
          return {
            key: folder,
            label: tildePath(folder, home),
            value: Array.isArray(enabled) ? inlineIds(enabled, home) : formatValue(entry, home),
          };
        }),
      };
      if (shown.rows.length === 0) shown = text("none", true);
    } else if (key === "sources" && Array.isArray(v)) {
      shown = listOf(
        v.map((s) => (s && typeof s === "object" && "path" in s ? (s as { path: unknown }).path : s)),
        home,
      );
    } else if (key === "marketplaces" && Array.isArray(v)) {
      shown = v.length
        ? {
            kind: "list",
            items: v.map((m) => {
              const { name, source } = (m ?? {}) as { name?: unknown; source?: unknown };
              return typeof name === "string" && typeof source === "string"
                ? `${name} — ${tildePath(source, home)}`
                : scalarText(m, home);
            }),
          }
        : text("none", true);
    } else if ((key === "enabled" || key === "seen") && Array.isArray(v)) {
      shown = inlineIds(v, home);
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string" && !x.includes("/"))) {
      // Any other list of plugin ids the profile grows (autoInstalled, …).
      shown = inlineIds(v, home);
    } else {
      shown = formatValue(v, home);
    }
    rows.push({
      key,
      label: known?.label ?? humanizeKey(key),
      value: shown,
      ...(known?.deprecated ? { deprecated: true } : {}),
    });
  }
  return rows.length ? { kind: "rows", rows } : text("none", true);
}

/** Nested rows keyed as written — plugin ids, log components. */
function rawKeyed(value: unknown, home: string): SettingsValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return formatValue(value, home);
  const rows = Object.entries(value as Record<string, unknown>).map(([key, v]) => ({
    key,
    label: key,
    value: formatValue(v, home),
  }));
  return rows.length ? { kind: "rows", rows } : text("none", true);
}

const LOG_LEVEL = words({ debug: "Debug", info: "Info", warn: "Warnings", error: "Errors" });

function logLevels(value: unknown, home: string): SettingsValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return formatValue(value, home);
  const rows = Object.entries(value as Record<string, unknown>).map(([key, v]) => ({
    key,
    label: key,
    value: LOG_LEVEL(v, home),
  }));
  return rows.length ? { kind: "rows", rows } : text("none", true);
}

function codeGenTarget(value: unknown, home: string): SettingsValue {
  if (typeof value !== "string") return formatValue(value, home);
  if (value === "desktop") return text("Claude Code Desktop");
  const name = { claude: "Claude Code", codex: "Codex" }[value] ?? value;
  return text(`${name} in the agent pane`);
}

const path = (value: unknown, home: string): SettingsValue =>
  typeof value === "string" && value ? text(tildePath(value, home)) : formatValue(value, home);

const DEPRECATED_MODULE = "Plugins";

/** Every key the app writes, in the order shown within its section. */
const KNOWN: Record<string, Known> = {
  dataRepo: { section: "Folders", label: "Specifications folder", format: path },
  openCodeRepo: { section: "Folders", label: "Open code repository", format: path },
  recentFolders: { section: "Folders", label: "Recent folders", format: recentFolders },
  recentDataRepos: { section: "Folders", label: "Recent specifications folders", deprecated: true },
  recentCodeRepos: { section: "Folders", label: "Recent code repositories", deprecated: true },
  recentFolderOpenedAt: { section: "Folders", label: "When folders were opened", deprecated: true },

  gitEngine: {
    section: "Git & GitHub",
    label: "Git engine",
    format: words({ gh: "GitHub CLI", cli: "System git", js: "Built-in JavaScript git" }),
  },
  gitAccess: {
    section: "Git & GitHub",
    label: "Git access",
    format: words({ token: "Personal access token", account: "GitHub account sign-in" }),
  },
  githubAccount: { section: "Git & GitHub", label: "GitHub account" },
  useGhAccount: { section: "Git & GitHub", label: "Use the GitHub CLI's account", deprecated: true },

  reloadFrequencySeconds: { section: "Sync", label: "Autosync frequency", format: secondsValue(true) },
  autosaveIntervalSeconds: { section: "Sync", label: "Autosave interval", format: secondsValue(false) },
  syncServerUrl: { section: "Sync", label: "Live sync server", format: offWhenEmpty },

  scenarioPreviewLines: { section: "Specs", label: "Scenario preview lines" },
  showTestLinks: { section: "Specs", label: "Show links to automated tests" },
  openTestsInIdea: { section: "Specs", label: "Open test links in IntelliJ IDEA" },
  featureFlags: { section: "Specs", label: "Feature flags" },
  scenarioPolarity: { section: "Specs", label: "Positive and negative scenarios" },
  deletePublished: { section: "Specs", label: "Delete or move published scenarios" },
  assignments: { section: "Specs", label: "Assign features to project members" },

  projectManagement: { section: "Integrations", label: "Project management" },
  projectManagementTool: { section: "Integrations", label: "Project management tool" },
  publishExternalLinks: { section: "Integrations", label: "Publish external links" },
  ahaLinks: { section: "Integrations", label: "Aha! links" },
  ahaImport: { section: "Integrations", label: "Import features from Aha!" },
  figmaLinks: { section: "Integrations", label: "Figma links" },
  qtestLinks: { section: "Integrations", label: "qTest test cases" },
  qtestParentUrl: { section: "Integrations", label: "Last qTest parent module" },
  jiraEnabled: { section: "Integrations", label: "Import issues from Jira" },
  confluenceEnabled: { section: "Integrations", label: "Publish pages to Confluence" },
  googleCalendar: { section: "Integrations", label: "Google Calendar" },

  codeGen: { section: "Agents", label: "Code generation" },
  codeGenTarget: { section: "Agents", label: "Start sessions in", format: codeGenTarget },
  ghostty: { section: "Agents", label: "Open worktrees in Ghostty" },

  plugins: { section: "Plugins", label: "Plugin profile", format: pluginProfile },
  pluginSettings: { section: "Plugins", label: "Plugin settings", format: rawKeyed },
  roadmap: { section: DEPRECATED_MODULE, label: "Roadmap", deprecated: true },
  tasks: { section: DEPRECATED_MODULE, label: "Tasks", deprecated: true },
  notebook: { section: DEPRECATED_MODULE, label: "Notebook", deprecated: true },
  models: { section: DEPRECATED_MODULE, label: "Models", deprecated: true },
  testing: { section: DEPRECATED_MODULE, label: "Testing", deprecated: true },
  issues: { section: DEPRECATED_MODULE, label: "Issues", deprecated: true },

  logLevel: { section: "Logging", label: "Log level", format: LOG_LEVEL },
  logLevels: { section: "Logging", label: "Log level by component", format: logLevels },

  settingsVersion: { section: "Other", label: "Settings format version" },
};

function scalarText(value: unknown, home: string): string {
  if (value === true) return "On";
  if (value === false) return "Off";
  if (value === null || value === undefined) return "not set";
  if (typeof value === "string") return value === "" ? "empty" : tildePath(value, home);
  if (typeof value === "number") return String(value);
  // A nested object inside a list: its fields on one line.
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${humanizeKey(k)}: ${scalarText(v, home)}`)
      .join(", ");
  }
  return String(value);
}

function listOf(items: unknown[], home: string): SettingsValue {
  if (items.length === 0) return text("none", true);
  return { kind: "list", items: items.map((i) => scalarText(i, home)) };
}

/** Any value, read generically: On / Off, lists, nested rows with readable labels. */
export function formatValue(value: unknown, home: string, key = ""): SettingsValue {
  if (value === null || value === undefined) return text("not set", true);
  if (value === "") return text("empty", true);
  if (typeof value === "number" && /Seconds$/.test(key)) return text(seconds(value));
  if (Array.isArray(value)) return listOf(value, home);
  if (typeof value === "object") {
    const rows = Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
      key: k,
      label: humanizeKey(k),
      value: formatValue(v, home, k),
    }));
    return rows.length ? { kind: "rows", rows } : text("none", true);
  }
  return text(scalarText(value, home));
}

/**
 * The settings file's keys, in sections: known keys under their own label in
 * the app's order, anything else under Other with its key made readable.
 * Only what the file holds is shown.
 */
export function settingsFileSections(settings: Record<string, unknown>, home = ""): SettingsSection[] {
  const bySection = new Map<string, SettingsRow[]>();
  const add = (section: string, row: SettingsRow) => {
    const rows = bySection.get(section) ?? [];
    rows.push(row);
    bySection.set(section, rows);
  };
  for (const [key, known] of Object.entries(KNOWN)) {
    if (!(key in settings)) continue;
    const value = settings[key];
    add(known.section, {
      key,
      label: known.label,
      value: known.format ? known.format(value, home) : formatValue(value, home, key),
      ...(known.deprecated ? { deprecated: true } : {}),
    });
  }
  for (const [key, value] of Object.entries(settings)) {
    if (key in KNOWN) continue;
    add("Other", { key, label: humanizeKey(key), value: formatValue(value, home, key) });
  }
  return SECTION_ORDER.filter((s) => bySection.has(s)).map((title) => ({ title, rows: bySection.get(title)! }));
}

function valueLines(value: SettingsValue, indent: string): string[] {
  if (value.kind === "text") return [value.text];
  if (value.kind === "list") return value.items.map((item) => `${indent}- ${item}`);
  return value.rows.flatMap((row) => rowLines(row, indent));
}

function rowLines(row: SettingsRow, indent: string): string[] {
  const label = row.deprecated ? `${row.label} (no longer used)` : row.label;
  if (row.value.kind === "text") return [`${indent}${label}: ${row.value.text}`];
  return [`${indent}${label}:`, ...valueLines(row.value, indent + "  ")];
}

/**
 * The view as plain text, for "Copy contents": the same labels and values,
 * one per line, sections as headings and nested rows indented.
 */
export function settingsFileText(path: string, sections: SettingsSection[]): string {
  const lines = [`Settings file: ${path}`];
  for (const section of sections) {
    lines.push("", section.title, ...section.rows.flatMap((row) => rowLines(row, "  ")));
  }
  return lines.join("\n") + "\n";
}

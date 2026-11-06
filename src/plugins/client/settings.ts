// The Settings page's extension point (specs/agents/agent-plugins
// .feature.md "The Settings page shows a plugin's section"): a plugin's
// browser half registers a section — a title, an order among the core's
// sections, what it renders — and App lists it in the page's navigation
// and body where its order puts it. The section gets the state payload and
// the page's patchSettings, and keeps what it changes under its own id
// (`pluginSettings`, src/plugins/host/pluginSettings.ts) or behind its own
// route.

import type { ComponentType, ReactNode } from "react";
import { Registry } from "./tabs";

export interface SettingsContext {
  /** Demo mode: no writes offered. */
  demo: boolean;
  /** The hosted app: no local machine to configure. */
  hosted: boolean;
}

export interface SettingsSectionProps extends SettingsContext {
  /** `GET /api/state`'s payload as it stands. */
  settings: Record<string, unknown>;
  /** `PUT /api/state` with a patch; false when it was refused (the page shows why). */
  patchSettings(patch: Record<string, unknown>): Promise<boolean>;
}

export interface SettingsSection {
  /** The section's id; the page's element is `settings-<id>`. */
  id: string;
  title: string;
  hint?: ReactNode;
  /** Where it sits among the core sections (CORE_SETTINGS_ORDER); ties by id. */
  order: number;
  /** Whether to show it at all; absent is always. */
  when?(ctx: SettingsContext): boolean;
  Component: ComponentType<SettingsSectionProps>;
}

/** The core sections' places, so a plugin's can go between any two. */
export const CORE_SETTINGS_ORDER = {
  general: 100,
  sync: 200,
  specs: 300,
  attributes: 400,
  project: 500,
  links: 600,
  qtest: 700,
  confluence: 800,
  workflow: 900,
  /** No core section of its own: the agent plugins' sections (Settings → Claude) sit on it. */
  agents: 950,
  git: 1000,
} as const;

export type CoreSettingsSection = keyof typeof CORE_SETTINGS_ORDER;

/** The registered sections, in order. */
export const settingsSections = new Registry<SettingsSection>((s) => s.order);

/** The sections shown for a context, in order. */
export function visibleSettingsSections(all: readonly SettingsSection[], ctx: SettingsContext): SettingsSection[] {
  return all.filter((s) => (s.when ? s.when(ctx) : true));
}

/**
 * The sections that go right after a core section: those ordered on or
 * past it and before the next core section — so one at 950 sits between
 * Workflow (900) and Git (1000), and one at exactly 1000 follows Git.
 */
export function sectionsAfter(
  all: readonly SettingsSection[],
  core: CoreSettingsSection,
): SettingsSection[] {
  const orders = Object.values(CORE_SETTINGS_ORDER) as number[];
  const lo = CORE_SETTINGS_ORDER[core];
  const next = Math.min(...orders.filter((o) => o > lo), Number.POSITIVE_INFINITY);
  return all.filter((s) => s.order >= lo && s.order < next);
}

/** The sections that come before the first core section. */
export function sectionsBeforeAll(all: readonly SettingsSection[]): SettingsSection[] {
  return all.filter((s) => s.order < CORE_SETTINGS_ORDER.general);
}

declare module "../kernel" {
  interface Services {
    settings: Registry<SettingsSection>;
  }
}

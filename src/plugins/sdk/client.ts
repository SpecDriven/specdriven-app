// What a plugin's browser half imports as `@specdriven/client`
// (roadmap/plugin-architecture.md "One React"): the app's own building
// blocks — the crumbs, menus, tooltips, toasts and skeletons its tabs are
// made of — so a plugin's tab looks and behaves like the core's, and the
// singletons behind them (the toast stack above all) are the page's one
// copy. Published on the page with React (src/plugins/client/sdk.ts) and
// reached through a shim the build points the specifier at. Types for the
// tab contract come along.

export { Breadcrumbs } from "../../frontend/Breadcrumbs";
export type { Crumb } from "../../frontend/Breadcrumbs";
export { Menu } from "../../frontend/Menu";
export type { MenuItem } from "../../frontend/Menu";
export { Tooltip } from "../../frontend/Tooltip";
export { SaveIndicator, toast } from "../../frontend/Toasts";
export type { ConfirmOptions, PromptOptions } from "../../frontend/ModalPrompts";
export { createPromiseQueue } from "../../frontend/promiseQueue";
export { PageSkeleton } from "../../frontend/Skeleton";
export { markText } from "../../frontend/highlight";
export { featurePath } from "../../frontend/route";
export { slugify } from "../../server/parser";
export type { Context, Disposer, Plugin } from "../kernel";
export type { PaletteHit, TabApp, TabPlugin } from "../client/tabs";
export { CORE_SETTINGS_ORDER } from "../client/settings";
export type { SettingsContext, SettingsSection, SettingsSectionProps } from "../client/settings";
export type { AgentDescriptor, AgentOffer } from "../../server/agentTypes";
export type { FeatureListing } from "../../server/features";
export type { ProjectMember } from "../../server/members";
export type { SearchResultItem } from "../../server/search";

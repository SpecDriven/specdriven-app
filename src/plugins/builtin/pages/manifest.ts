// The special folders (specs/app/roadmap.feature.md, specs/app/tasks.feature
// .md, specs/app/engineering-notebook.feature.md) as plugins: one per folder,
// each built from the pages plugin's factories. What both halves and both
// loaders know about them.

import type { PluginManifest } from "../../manifest";

export const roadmapManifest: PluginManifest = {
  id: "roadmap",
  api: "1",
  displayName: "Roadmap",
  description: "Markdown roadmap pages on their own tab",
  // Off unless turned on; `roadmap` was its switch before the profile.
  defaultEnabled: false,
  legacyKey: "roadmap",
  paths: ["/roadmap"],
};

export const tasksManifest: PluginManifest = {
  id: "tasks",
  api: "1",
  displayName: "Tasks",
  description: "Tasks to assign, tick off and put on the calendar",
  defaultEnabled: false,
  legacyKey: "tasks",
  paths: ["/tasks"],
};

export const notebookManifest: PluginManifest = {
  id: "notebook",
  api: "1",
  displayName: "Engineering notebook",
  description: "A shared, dated log of observations and decisions",
  // The one module that starts on: a profile that never named it has it.
  defaultEnabled: true,
  legacyKey: "notebook",
  paths: ["/notebook"],
};

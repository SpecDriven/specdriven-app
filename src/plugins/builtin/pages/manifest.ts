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
  // The historical settings key; off unless turned on.
  switch: { key: "roadmap", default: false },
  paths: ["/roadmap"],
};

export const tasksManifest: PluginManifest = {
  id: "tasks",
  api: "1",
  displayName: "Tasks",
  description: "Tasks to assign, tick off and put on the calendar",
  switch: { key: "tasks", default: false },
  paths: ["/tasks"],
};

export const notebookManifest: PluginManifest = {
  id: "notebook",
  api: "1",
  displayName: "Engineering notebook",
  description: "A shared, dated log of observations and decisions",
  // The one module that starts on: an absent key means on.
  switch: { key: "notebook", default: true },
  paths: ["/notebook"],
};

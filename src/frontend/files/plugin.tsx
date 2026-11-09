// The Files tab (specs/app/code-repo-mode.feature.md): what the navigation
// pane shows while a code repository is open, in place of the Specs tab.
// A core plugin, not a built-in one — it has no manifest and no switch in
// Settings → Plugins: the client loader mounts it for the open code
// repository and disposes it when a specifications folder opens
// (src/plugins/client/loader.ts). Being a plugin, it hears "data/leaving",
// so a folder switch lands what the editor holds first.

import { FolderTree } from "lucide-react";
import type { Context, Plugin } from "../../plugins/kernel";
import type { TabPlugin } from "../../plugins/client/tabs";
import { repoDisplayName } from "../route";
import { files } from "./filesStore";
import { FilesPane, readmeOf } from "./FilesPane";
import { FilesSidebar } from "./FilesSidebar";
import { baseName, FILES_HOME, filesKey, filesPath, parseFilesRoute, type FilesView } from "./route";

export const FILES_TAB = "files";

/** The tab's search: the loaded files whose name or path holds the query. */
export function searchFiles(query: string): { path: string; name: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: { path: string; name: string }[] = [];
  for (const listing of Object.values(files.getState().dirs)) {
    if ("error" in listing) continue;
    for (const e of listing.entries) {
      if (e.kind === "file" && e.path.toLowerCase().includes(q)) hits.push({ path: e.path, name: e.name });
    }
  }
  return hits.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 50);
}

export const filesTab: TabPlugin<FilesView> = {
  id: FILES_TAB,
  title: "Files",
  icon: FolderTree,
  order: 0,
  shortcut: "g f",
  // The tab bar turns the sidebar to the tree; a row opens a file.
  opensOnSelect: false,
  route: {
    match: parseFilesRoute,
    path: filesPath,
    key: filesKey,
    title: (view) => (view.path ? baseName(view.path) : repoDisplayName(files.getState().root ?? "Files")),
    home: FILES_HOME,
    // Home opens the repository's README.md when it has one; else the pane
    // asks for a file.
    resolve: (view) => {
      if (view.path !== null) return view;
      const readme = readmeOf(files.getState());
      return readme ? { path: readme } : view;
    },
  },
  Sidebar: ({ view, navigate }) => <FilesSidebar view={view} navigate={navigate} />,
  Pane: ({ view, app }) => (
    <FilesPane path={view.path} repoCrumb={app.repoCrumb} autosaveSeconds={app.autosaveSeconds} canOpenInIdea />
  ),
  palette: {
    group: "Files",
    search: (query) =>
      searchFiles(query).map((hit) => ({
        id: `files:${hit.path}`,
        label: hit.name,
        sub: hit.path,
        href: filesPath({ path: hit.path }),
        view: { path: hit.path },
      })),
  },
  recent: (view) => view.path,
  subscribe: files.subscribe,
};

interface FilesConfig {
  /** The open code repository's absolute path. */
  codeRepo: string;
}

export const filesPlugin: Plugin<Context, FilesConfig> = {
  name: FILES_TAB,
  inject: ["tabs"],
  Config: {
    parse: (raw) => ({ codeRepo: String((raw as Partial<FilesConfig> | undefined)?.codeRepo ?? "") }),
  },
  async apply(ctx, config) {
    // The tree's top folder before the tab shows, so a deep link that
    // follows the mount — and home's README — find it there.
    await files.configure(config.codeRepo);
    ctx.effect(() => ctx.need("tabs").add(filesTab as TabPlugin));
    ctx.effect(() => () => files.reset());
    // A folder switch: what the editor holds lands in this repository first.
    ctx.on("data/leaving", () => files.flush());
  },
};

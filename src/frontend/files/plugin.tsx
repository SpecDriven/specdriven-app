// The Files tab (specs/app/code-repo-mode.feature.md): what the navigation
// pane shows while a code repository is open, in place of the Specs tab.
// A core plugin, not a built-in one — it has no manifest and no switch in
// Settings → Plugins: the client loader mounts it for the open code
// repository and disposes it when a specifications folder opens
// (src/plugins/client/loader.ts). Being a plugin, it hears "data/leaving",
// so a folder switch lands what the editor holds first.

import type { ReactNode } from "react";
import { FolderTree } from "lucide-react";
import type { FileHit } from "../../server/codeSearch";
import type { Context, Plugin } from "../../plugins/kernel";
import type { TabPlugin } from "../../plugins/client/tabs";
import { repoDisplayName } from "../route";
import { files } from "./filesStore";
import { FilesPane, readmeOf } from "./FilesPane";
import { FilesSidebar } from "./FilesSidebar";
import { baseName, FILES_HOME, filesKey, filesPath, parseFilesRoute, type FilesView } from "./route";
import { fileSearch } from "./searchStore";

export const FILES_TAB = "files";

/**
 * The tab's search (specs/app/code-search.feature.md "Find a file by name"):
 * every file of the repository whose name or path holds the typed
 * characters in order, best first — asked of the server, which knows the
 * files in folders the tree has not opened.
 */
export async function findFiles(query: string, signal?: AbortSignal): Promise<FileHit[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetch(`/api/files/find?q=${encodeURIComponent(q)}`, { signal });
  const body = (await res.json().catch(() => null)) as { results?: FileHit[]; error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `Search failed (${res.status})`);
  return body?.results ?? [];
}

/** A path with the matched characters marked, run by run. */
export function markedPath(path: string, indexes: number[]): ReactNode {
  const hit = new Set(indexes);
  const out: ReactNode[] = [];
  for (let i = 0; i < path.length; ) {
    const on = hit.has(i);
    let end = i;
    while (end < path.length && hit.has(end) === on) end++;
    out.push(on ? <mark key={i}>{path.slice(i, end)}</mark> : path.slice(i, end));
    i = end;
  }
  return out;
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
    search: async (query, signal) =>
      (await findFiles(query, signal)).map((hit) => ({
        id: `files:${hit.path}`,
        label: hit.name,
        sub: markedPath(hit.path, hit.indexes),
        href: filesPath({ path: hit.path }),
        view: { path: hit.path },
      })),
  },
  // ⇧⌘F: the sidebar turns to the tab and its search field takes the focus.
  shortcuts: [{ id: "files-search", keys: "mod+shift+f", label: "Search in files", run: () => fileSearch.show() }],
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
    ctx.effect(() => () => fileSearch.reset());
    // A folder switch: what the editor holds lands in this repository first.
    ctx.on("data/leaving", () => files.flush());
  },
};

// The special folders' browser half (specs/app/roadmap.feature.md, specs/app
// /tasks.feature.md, specs/app/engineering-notebook.feature.md): one plugin
// per folder, built from the factory below over the folder's tab descriptor
// (src/frontend/pages/pages.ts) — its tab, its page list and editor, its `g`
// chord, the palette's search of its pages and, for the notebook, "New
// notebook entry", and its store's lifecycle. App.tsx knows none of this; it
// renders the registered tabs.

import { useSyncExternalStore, type ComponentProps } from "react";
import { NotebookPen } from "lucide-react";
import type { Context, Plugin } from "../../kernel";
import type { ClientConfig } from "../../client/loader";
import type { TabPlugin } from "../../client/tabs";
import { markText } from "../../../frontend/highlight";
import {
  PagePane,
  PagesSidebar,
  newPageFlow,
  type OpenPageHandle,
} from "../../../frontend/pages/PagesPane";
import {
  createPagesStore,
  pageSettings,
  type PageTab,
} from "../../../frontend/pages/pages";
import { titleFromFileName } from "../../../server/parser";
import type { SearchResultItem } from "../../../server/search";
import { pageLink, pagesPath, parsePageRoute, type PageRoute } from "./route";

export function pagesClient(folder: PageTab): Plugin<Context, ClientConfig | undefined> {
  const store = createPagesStore(folder.folder, { archive: folder.archivable });

  /**
   * Bumped on each reload tick so an open page re-reads its file — which it
   * does only while its editor holds nothing unsaved (PagesPane.tsx).
   */
  let reloadKey = 0;
  const reloadListeners = new Set<() => void>();
  const subscribeReload = (l: () => void) => {
    reloadListeners.add(l);
    return () => {
      reloadListeners.delete(l);
    };
  };
  const useReloadKey = () => useSyncExternalStore(subscribeReload, () => reloadKey, () => 0);

  /** The open page's editor, while the pane holds one of the folder's pages. */
  let open: OpenPageHandle | null = null;
  const bindOpen = (handle: OpenPageHandle | null) => {
    open = handle;
  };

  /** The first page the tab lists — the notebook's newest entry — or none. */
  const first = (): PageRoute | null => {
    const listed = store.state().pages[0];
    return listed ? { fileName: listed.fileName } : null;
  };

  // A project's page goes by its project's name, not by `project.md`.
  const nameOf = (fileName: string): string =>
    store.state().pages.find((p) => p.fileName === fileName)?.name ??
    store.state().projects.find((p) => p.fileName === fileName)?.name ??
    titleFromFileName(fileName.replace(/\.md$/, ""));

  function Pane({ view, app, navigate }: ComponentProps<TabPlugin<PageRoute>["Pane"]>) {
    const key = useReloadKey();
    const fileName = view.fileName ?? first()?.fileName;
    if (!fileName) return null;
    return (
      // Keyed by the file, so another page starts a fresh editor.
      <PagePane
        key={fileName}
        tab={folder}
        store={store}
        fileName={fileName}
        terms={view.terms ?? null}
        app={app}
        reloadKey={key}
        navigate={navigate}
        onHandle={bindOpen}
      />
    );
  }

  const tab: TabPlugin<PageRoute> = {
    id: folder.folder,
    title: folder.title,
    icon: folder.icon,
    order: folder.order,
    shortcut: folder.shortcut,
    // The tab bar only turns the sidebar to the list (specs/app/roadmap
    // .feature.md "The roadmap is a sidebar tab"); a page opens from a row,
    // the rail, the chord or a link.
    opensOnSelect: false,
    route: {
      match: (pathname) => parsePageRoute(folder.folder, pathname),
      path: (view) => pagesPath(folder.folder, view),
      key: (view) => view.fileName ?? folder.folder,
      title: (view) => (view.fileName ? nameOf(view.fileName) : folder.title),
      home: { fileName: null },
      // The bare folder opens the first page it lists; an empty folder has
      // nothing to open, so its link goes home and the rail has no icon for
      // it (specs/app/tasks.feature.md "A bare folder url opens that tab").
      resolve: (view) => (view.fileName ? view : first()),
    },
    Sidebar: ({ view, app, navigate }) => (
      <PagesSidebar
        tab={folder}
        store={store}
        active={view?.fileName ?? null}
        app={app}
        navigate={navigate}
        openPage={() => open}
      />
    ),
    Pane,
    palette: {
      group: folder.title,
      // A page tab searches its own folder's pages (src/server/search.ts);
      // a hit opens the page with its matched words marked.
      search: async (query, signal) => {
        const res = await fetch(
          `/api/search?scope=${folder.folder}&q=${encodeURIComponent(query)}`,
          { signal },
        );
        const data = (await res.json()) as { results?: SearchResultItem[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Search failed");
        return (data.results ?? []).map((r) => ({
          id: `${folder.folder}:${r.fileName}`,
          label: r.featureName,
          sub: r.snippet ? markText(r.snippet, r.terms) : undefined,
          href: pageLink(r.fileName),
          view: { fileName: r.fileName, terms: r.terms },
        }));
      },
      // "New notebook entry" (specs/app/engineering-notebook.feature.md "Search
      // and the command palette"): a palette command, since the tab's own
      // button is a tab away.
      commands: folder.dated
        ? ({ promptWithChoice, navigate }) => [
            {
              id: "action:new-notebook-entry",
              group: "Actions",
              label: "New notebook entry",
              text: "New notebook entry",
              icon: <NotebookPen size={14} />,
              run: () => void newPageFlow(folder, store, promptWithChoice, navigate),
            },
          ]
        : undefined,
    },
    // Remembered once the listing holds it — a stale link to a page that is
    // not there opens nothing, so there is nothing to go back to.
    recent: (view) =>
      store.state().pages.find((p) => p.fileName === view.fileName)?.name ?? null,
    subscribe: store.subscribe,
  };

  return {
    name: folder.folder,
    inject: ["tabs"],
    async apply(ctx, config) {
      if (config?.settings) pageSettings.apply(config.settings);
      ctx.effect(() => ctx.need("tabs").add(tab as TabPlugin));
      // Switched off, or the data folder gone: forget everything.
      ctx.effect(() => () => {
        store.reset();
        open = null;
      });
      // A data folder switch: the open page's last save lands in the folder
      // it was typed in, then the editor is sealed so no later save of its —
      // the unmount one above all — reaches the new folder.
      ctx.on("data/leaving", async () => {
        const leaving = open;
        if (!leaving) return;
        await leaving.flush();
        leaving.seal();
      });
      ctx.on("data/changed", async () => {
        store.reset();
        await store.load();
      });
      ctx.on("settings/changed", (state) => pageSettings.apply(state));
      // The reload tick: the list, and the open page.
      ctx.on("reload/tick", () => {
        void store.load();
        reloadKey += 1;
        for (const l of reloadListeners) l();
      });
      // The pages are there before any deep link that names the folder
      // resolves.
      await store.load();
    },
  };
}

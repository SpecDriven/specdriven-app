// Event Models' browser half (roadmap/support-event-modeling.md): the Models
// tab, its sidebar and canvas, the `g m` shortcut, the palette's search, the
// crumb a feature page carries back to a model whose slice links it, the
// model a code gen session bundles, and the store's lifecycle. The canvas
// (React Flow) loads lazily, so only who opens the tab pays for it. App.tsx
// knows none of this; it renders the registered tab.

import { lazy, Suspense, useSyncExternalStore, type ComponentProps } from "react";
import { Workflow } from "lucide-react";
import type { Context, Plugin } from "../../kernel";
import type { TabPlugin } from "../../client/tabs";
import { PageSkeleton } from "../../../frontend/Skeleton";
import { markText } from "../../../frontend/highlight";
import { models, modelsState, modelTitle } from "../../../frontend/eventModel/models";
import type { SearchResultItem } from "../../../server/search";
import { manifest } from "./manifest";
import { MODELS_FOLDER, modelLink, modelsPath, parseModelsRoute, type ModelsRoute } from "./route";

const ModelsPane = lazy(() =>
  import("../../../frontend/eventModel/ModelsPane").then((m) => ({ default: m.ModelsPane })),
);
const ModelsSidebar = lazy(() =>
  import("../../../frontend/eventModel/ModelsPane").then((m) => ({ default: m.ModelsSidebar })),
);

/**
 * Bumped on each reload tick so an open canvas re-reads its file — which it
 * does only while nothing on it is unsaved (ModelsPane.tsx).
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

/**
 * The open canvas's parting save. A data folder switch awaits it (the
 * "data/leaving" event): it lands what the canvas still holds in the folder
 * it was drawn in, then seals the pane so no later save of its — the unmount
 * one above all — reaches the new folder.
 */
let flushOpen: () => Promise<void> = async () => {};
const bindSave = (handle: { flush: () => Promise<void> } | null) => {
  flushOpen = handle?.flush ?? (async () => {});
};

/** The first model the tab lists, or none. */
const first = (): ModelsRoute | null => {
  const listed = modelsState().models[0];
  return listed ? { fileName: listed.fileName } : null;
};

function Pane({ view, app }: ComponentProps<TabPlugin<ModelsRoute>["Pane"]>) {
  const key = useReloadKey();
  const fileName = view.fileName ?? first()?.fileName;
  if (!fileName) return null;
  return (
    <Suspense fallback={<PageSkeleton cards={1} />}>
      {/* Keyed by the file, so switching models starts the canvas afresh. */}
      <ModelsPane
        key={fileName}
        fileName={fileName}
        features={app.features}
        members={app.members}
        assignments={app.assignments}
        repoCrumb={app.repoCrumb}
        reloadKey={key}
        prompt={app.prompt}
        confirm={app.confirm}
        onOpenFeature={app.openFeature}
        onFeatureCreated={app.featureCreated}
        onStartSession={app.startSession}
        onCopyLink={app.copyLink}
        copied={app.copied}
        onClosed={app.goHome}
        onSaveHandle={bindSave}
      />
    </Suspense>
  );
}

const tab: TabPlugin<ModelsRoute> = {
  id: manifest.id,
  title: "Models",
  icon: Workflow,
  order: 40,
  shortcut: "g m",
  route: {
    match: parseModelsRoute,
    path: modelsPath,
    key: (view) => view.fileName ?? MODELS_FOLDER,
    title: (view) => (view.fileName ? modelTitle(view.fileName, modelsState()) : "Models"),
    home: { fileName: null },
    // The bare folder opens the first model; an empty folder has nothing to
    // open, so its link goes home and the rail has no Models icon.
    resolve: (view) => (view.fileName ? view : first()),
  },
  Sidebar: ({ view, app, navigate }) => (
    <Suspense fallback={null}>
      <ModelsSidebar
        active={view?.fileName ?? null}
        prompt={app.prompt}
        confirm={app.confirm}
        onNavigate={(fileName, opts) => navigate({ fileName }, opts)}
        onCopyLink={app.copyLink}
        onClosed={app.goHome}
      />
    </Suspense>
  ),
  Pane,
  palette: {
    group: "Models",
    // The Models tab searches the models: one hit per model, by its name and
    // what is on its canvas (src/server/search.ts).
    search: async (query, signal) => {
      const res = await fetch(
        `/api/search?scope=${MODELS_FOLDER}&q=${encodeURIComponent(query)}`,
        { signal },
      );
      const data = (await res.json()) as { results?: SearchResultItem[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      return (data.results ?? []).map((r) => ({
        id: `models:${r.fileName}`,
        label: r.featureName,
        sub: r.snippet ? markText(r.snippet, r.terms) : undefined,
        href: modelLink(r.fileName),
        view: { fileName: r.fileName },
      }));
    },
  },
  // The way back to the model: a feature holding a slice's scenarios carries
  // a crumb naming the Event Model — and the slice, in the tooltip — that
  // opens its canvas. One per model linking the feature.
  featureCrumbs: (fileName) =>
    modelsState().models.flatMap((model) => {
      const links = model.links.filter((l) => l.feature === fileName);
      if (links.length === 0) return [];
      const slices = links.map((l) => `“${l.slice || "Untitled slice"}”`).join(", ");
      return [
        {
          label: (
            <span className="crumb-model">
              <Workflow size={12} aria-hidden="true" />
              {model.name}
            </span>
          ),
          title: `Open the Event Model “${model.name}” — slice ${slices}`,
          view: { fileName: model.fileName },
        },
      ];
    }),
  // The model open on the canvas goes into a code gen session's prompt after
  // the specs, and the specs its slices link come along whole. A model alone
  // is a session too (src/server/api.ts resolveSessionRequest).
  session: (view) =>
    view.fileName
      ? {
          models: [view.fileName],
          labels: [`the model “${modelTitle(view.fileName, modelsState())}”`],
        }
      : null,
  subscribe: models.subscribe,
};

const plugin: Plugin<Context> = {
  name: manifest.id,
  inject: ["tabs"],
  async apply(ctx) {
    ctx.effect(() => ctx.need("tabs").add(tab as TabPlugin));
    // Switched off, or the data folder gone: forget everything.
    ctx.effect(() => () => {
      models.reset();
      flushOpen = async () => {};
    });
    ctx.on("data/leaving", () => flushOpen());
    ctx.on("data/changed", async () => {
      models.reset();
      await models.load();
    });
    // The reload tick: the list, and the open canvas.
    ctx.on("reload/tick", () => {
      void models.load();
      reloadKey += 1;
      for (const l of reloadListeners) l();
    });
    // The models are there before any deep link that names one resolves.
    await models.load();
  },
};

export default plugin;

// The special folders' host half (specs/app/roadmap.feature.md, specs/app
// /tasks.feature.md, specs/app/engineering-notebook.feature.md): the markdown
// pages in the data repo's `roadmap`, `tasks` and `notebook` folders, each
// folder its own plugin built from the one factory below and parameterized
// by its PageFolder descriptor (src/server/pages.ts). The routes exist only
// while the folder's switch is on — list, create, read, save, delete, plus
// what makes a task a task (the estimate) and an entry an entry (its date,
// author, kind and supersession).
//
// What stays in the core: the switch creating the folder on the spot
// (api.ts putState), `scope=<folder>` search, and the notebook's drift pass
// (src/server/reload.ts), which runs whether the switch is on or off — the
// switch hides the tab, it must not strip a teammate's entries of their
// documents (specs/app/engineering-notebook.feature.md "Entries are shared
// through git").

import type { Context, Plugin } from "../../kernel";
import type { DataAccess } from "../../host/services";
import { json, type Handler, type Params } from "../../../server/http";
import {
  NOTEBOOK,
  TASKS,
  createPage,
  deletePage,
  ensurePageFolder,
  importPageDrift,
  listPages,
  readPage,
  renamePageFile,
  savePage,
  type PageFolder,
} from "../../../server/pages";
import {
  byNewest,
  createEntry,
  entryFileOf,
  relinkEntries,
  setEntryKind,
  setSupersedes,
  supersededBy,
} from "../../../server/notebook";
import { EstimateError, estimateMinutes } from "../../../server/estimate";
import { parsePage } from "../../../server/parser";
import { normalizeGoogleCalendar, readState } from "../../../server/state";
import { getAppRoot } from "../../../server/paths";
import { isDemoMode } from "../../../server/demoMode";

type DirHandler = (dir: string, req: Request, params: Params) => Response | Promise<Response>;

/** Against the data dir, with the module's errors as 400 answers. */
const guarded =
  (data: DataAccess) =>
  (handler: DirHandler): Handler =>
    data.withDir(async (dir, req, params) => {
      try {
        return await handler(dir, req, params);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    });

/** The request's JSON body, or null when it has none or is not JSON. */
const body = <T>(req: Request): Promise<T | null> => req.json().catch(() => null) as Promise<T | null>;

/**
 * Add a task to Google Calendar (specs/app/tasks.feature.md): one short turn
 * of the developer's `claude` CLI proposes how long the task takes
 * (src/server/estimate.ts); the person confirms it in the client, which
 * writes the estimate on the page and opens the prefilled event itself.
 * Closed while the Google Calendar switch is off. In demo mode the seam holds
 * the scripted agent, which has no number to give, so the route proposes one
 * of its own.
 */
const DEMO_ESTIMATE_MINUTES = 30;

const estimateTask: DirHandler = async (dir, _req, params) => {
  if (!normalizeGoogleCalendar((await readState(getAppRoot())).googleCalendar)) {
    return json({ error: "Google Calendar is switched off in Settings" }, 404);
  }
  const page = await readPage(dir, TASKS, params.file ?? "");
  if (page === null) return json({ error: "Task not found" }, 404);
  if (isDemoMode()) return json({ minutes: DEMO_ESTIMATE_MINUTES });
  try {
    return json({ minutes: await estimateMinutes(parsePage(page.content), dir) });
  } catch (e) {
    if (e instanceof EstimateError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 502);
  }
};

/**
 * One special folder as a plugin. The notebook's list and create differ —
 * its entries are listed newest first with the entries that replaced them,
 * and created with today's date and an author — and it adds the two
 * metadata edits its header offers; everything else is what any page does.
 */
export function pagesHost(kind: PageFolder): Plugin<Context> {
  const notebook = kind.folder === NOTEBOOK.folder;
  return {
    name: kind.folder,
    inject: ["routes", "data", "sync"],
    apply(ctx) {
      const routes = ctx.need("routes");
      const on = guarded(ctx.need("data"));
      const add = (method: string, pattern: string, handler: DirHandler) =>
        ctx.effect(() => routes.add(method, pattern, on(handler)));
      const base = `/api/${kind.folder}`;

      if (notebook) {
        // Newest first, and each superseded entry told which entry replaced
        // it — derived on every read, so a link removed by hand takes its
        // badge with it on the next sync.
        add("GET", base, async (dir) => {
          const entries = byNewest(await listPages(dir, NOTEBOOK));
          return json({ pages: entries, supersededBy: supersededBy(entries) });
        });
        add("POST", base, async (dir, req) => {
          const b = await body<{ name?: unknown; kind?: unknown }>(req);
          if (typeof b?.name !== "string") return json({ error: "name is required" }, 400);
          if (b.kind !== undefined && b.kind !== "Observation" && b.kind !== "Decision") {
            return json({ error: "kind must be Observation or Decision" }, 400);
          }
          return json({ fileName: await createEntry(dir, b.name, b.kind ?? "Observation") }, 201);
        });
        // The kind chip in an entry's header, and the "Supersedes…" picker
        // beside it. Both are local writes through the document, like any
        // page save.
        add("PUT", `${base}/:file/kind`, async (dir, req, params) => {
          const b = await body<{ kind?: unknown }>(req);
          if (b?.kind !== "Observation" && b?.kind !== "Decision") {
            return json({ error: "kind must be Observation or Decision" }, 400);
          }
          return json(await setEntryKind(dir, params.file ?? "", b.kind));
        });
        add("PUT", `${base}/:file/supersedes`, async (dir, req, params) => {
          const b = await body<{ title?: unknown; url?: unknown }>(req);
          // A null body — or one with no url — unpicks the link.
          const url = typeof b?.url === "string" ? b.url.trim() : "";
          if (!url) return json(await setSupersedes(dir, params.file ?? "", null));
          if (typeof b?.title !== "string" || !b.title.trim()) {
            return json({ error: "title is required" }, 400);
          }
          if (entryFileOf(url) === null) return json({ error: "url must name an entry" }, 400);
          return json(await setSupersedes(dir, params.file ?? "", { title: b.title.trim(), url }));
        });
      } else {
        add("GET", base, async (dir) => json({ pages: await listPages(dir, kind) }));
        add("POST", base, async (dir, req) => {
          const b = await body<{ name?: unknown }>(req);
          if (typeof b?.name !== "string") return json({ error: "name is required" }, 400);
          return json({ fileName: await createPage(dir, kind, b.name) }, 201);
        });
      }

      if (kind.folder === TASKS.folder) add("POST", `${base}/:file/estimate`, estimateTask);

      add("GET", `${base}/:file`, async (dir, _req, params) => {
        const page = await readPage(dir, kind, params.file ?? "");
        return page === null
          ? json({ error: `${kind.label[0]!.toUpperCase()}${kind.label.slice(1)} not found` }, 404)
          : json(page);
      });

      // The page editor's autosave: a local write through the page's
      // document — the reload cron commits and pushes it, like a saved
      // scenario. `base` is the text the editor edited, so what the page
      // gained since it was loaded is merged in rather than written over.
      add("PUT", `${base}/:file`, async (dir, req, params) => {
        const b = await body<{ content?: unknown; base?: unknown }>(req);
        if (typeof b?.content !== "string") return json({ error: "content is required" }, 400);
        const from = typeof b.base === "string" ? b.base : undefined;
        return json(await savePage(dir, kind, params.file ?? "", b.content, from));
      });

      // Renaming a page (specs/app/roadmap.feature.md): the `# heading` and
      // the file both, so the url follows the title — a `git mv`, committed
      // and pushed. The notebook passes relinkEntries, so the links naming an
      // entry follow it.
      add("POST", `${base}/:file/rename`, async (dir, req, params) => {
        const b = await body<{ name?: unknown }>(req);
        if (typeof b?.name !== "string") return json({ error: "name is required" }, 400);
        return json(
          await renamePageFile(dir, kind, params.file ?? "", b.name, notebook ? { relink: relinkEntries } : {}),
        );
      });

      // Deleting a page (specs/app/roadmap.feature.md): the markdown and its
      // document go, committed and pushed like a deleted feature.
      add("DELETE", `${base}/:file`, async (dir, _req, params) =>
        json(await deletePage(dir, kind, params.file ?? "")),
      );

      // The sync tick (src/server/reload.ts), scenario "Create roadmap folder
      // if necessary" and its twin for tasks: the folder is made when the
      // repo has none — the push commits everything in it like any other
      // saved change — and the pages' documents are kept in step with their
      // markdown. Not the notebook's: see the head of this file.
      if (!notebook) {
        ctx.effect(() =>
          ctx.need("sync").drift(async (dir) => {
            await ensurePageFolder(dir, kind);
            return importPageDrift(dir, kind);
          }),
        );
      }
    },
  };
}

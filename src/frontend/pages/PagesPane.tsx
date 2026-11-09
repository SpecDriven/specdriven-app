// A special folder's pane and sidebar (specs/app/roadmap.feature.md, specs
// /app/tasks.feature.md, specs/app/engineering-notebook.feature.md): the open
// page's markdown, edited and autosaved like the README, with the header its
// folder gives it — the "Assigned" chip a feature has, a task's Done button
// and calendar chip, a notebook entry's kind, supersession, author and date —
// and the folder's page list with its New button and per-row menu. Rendered
// by the pages plugin (src/plugins/builtin/pages/client.tsx); App.tsx knows
// none of it.

import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Ellipsis,
  Eye,
  FilePlus,
  FolderInput,
  Gavel,
  Link,
  ListFilter,
  ListPlus,
  Pencil,
  Trash2,
  UserRound,
} from "lucide-react";
import type { ArchivedListing, PageListing, ProjectListing } from "../../server/pages";
import type { ProjectMember } from "../../server/members";
import { parsePage, serializePage } from "../../server/parser";
import {
  formatEstimate,
  fromLocalInput,
  googleCalendarUrl,
  localInputValue,
  nextQuarterHour,
  parseEstimate,
} from "../../server/calendar";
import type { Navigate, PromptWithChoice, TabApp } from "../../plugins/client/tabs";
import { pageLink, type PageRoute } from "../../plugins/builtin/pages/route";
import { AddToCalendarForm, type EstimateProposal } from "../AddToCalendarForm";
import { Breadcrumbs } from "../Breadcrumbs";
import { MarkdownEditor } from "../MarkdownEditor";
import { Menu } from "../Menu";
import { NewFolderIcon } from "../ActionIcons";
import { Popover } from "../Popover";
import { PageSkeleton } from "../Skeleton";
import { SaveIndicator, toast } from "../Toasts";
import { pushHint, useSyncProblem } from "../syncProblem";
import { Tooltip } from "../Tooltip";
import { SectionAction, SidebarSection } from "../SidebarSection";
import { listKeyDown, useRevealActive } from "../sidebarList";
import { EntryKindGlyph, dayOf, entryGroups, entryKindOf } from "../notebook";
import { SidebarRow } from "../SidebarRow";
import { createPromiseQueue } from "../promiseQueue";
import { shareUrl } from "../shareLink";
import { cleanLine } from "../../server/text";
import {
  dropPlacement,
  isProjectPageOf,
  pageFolderOf,
  pageGroups,
  pageListingMetaEqual,
  pageListingOf,
  pageRowTitle,
  projectPageOf,
  stepPlacement,
  usePageSettings,
  usePages,
  type PageTab,
  type PagesStore,
} from "./pages";

/** Handle a link in-app on a plain click; modified clicks keep the browser's. */
function spaClick(e: MouseEvent, go: () => void) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go();
}

/** Two-letter initials for an assignee chip (App.tsx's twin). */
function initialsOf(name: string): string {
  return (
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .map((w) => w[0]!)
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

const capitalized = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;

/**
 * The open page, as the plugin and the sidebar reach it: land what its editor
 * holds, seal it so nothing it holds is written again (it is being deleted,
 * or the data folder is changing under it), or re-read it (it was renamed).
 */
export interface OpenPageHandle {
  fileName: string;
  flush(): Promise<void>;
  seal(): void;
  reload(): Promise<void>;
}

/**
 * The open page's editor. Keyed by the file name where it is rendered, so
 * another page starts afresh: its own autosave baseline, and a save of the
 * outgoing one unable to reach into it.
 */
export function PagePane({
  tab,
  store,
  fileName,
  terms,
  app,
  reloadKey,
  navigate,
  onHandle,
}: {
  tab: PageTab;
  store: PagesStore;
  fileName: string;
  /** A search hit's matched words, marked in the page (specs/search.feature.md). */
  terms: string[] | null;
  app: TabApp;
  /** Bumped on each reload tick: re-read the page unless an edit is waiting. */
  reloadKey: number;
  navigate: Navigate<PageRoute>;
  onHandle: (handle: OpenPageHandle | null) => void;
}) {
  const { pages: folderPages, supersededBy } = usePages(store);
  const { googleCalendar, canEstimate, readOnly } = usePageSettings();
  const syncProblem = useSyncProblem();
  const link = pageLink(fileName);
  /** The page's listing (name, assignment, …) and what its editor holds. */
  const [page, setPage] = useState<PageListing | null>(null);
  const pageRef = useRef<PageListing | null>(null);
  pageRef.current = page;
  const [text, setText] = useState<string | null>(null);
  const textRef = useRef<string | null>(null);
  textRef.current = text;
  /** What the last landed save put on disk. */
  const saved = useRef<string | null>(null);
  /** Bumped per load, so a save landing after a reload stamps nothing. */
  const session = useRef(0);
  /** Set once nothing this editor holds may be written any more. */
  const sealed = useRef(false);
  /**
   * Page writes go through one queue so an autosave tick and a Done /
   * Assigned PUT cannot land out of order — last-write-wins on the file
   * would drop the marker. `metaSaving` counts the Done / Assigned writes
   * queued and not yet finished: an autosave that captured the buffer
   * before the marker was applied skips rather than overwriting it.
   */
  const queue = useRef(createPromiseQueue());
  const metaSaving = useRef(0);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [assigneeMenuOpen, setAssigneeMenuOpen] = useState(false);
  const [assignedSaving, setAssignedSaving] = useState(false);
  const [doneSaving, setDoneSaving] = useState(false);
  /** A notebook entry's kind or supersession is on its way to the server. */
  const [entryKindSaving, setEntryKindSaving] = useState(false);
  const [entryKindMenuOpen, setEntryKindMenuOpen] = useState(false);
  const [entrySupersedesMenuOpen, setEntrySupersedesMenuOpen] = useState(false);
  /** A task's calendar chip (specs/app/tasks.feature.md): the popover, the
      estimate as typed, where it came from, and the start. */
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [estimateText, setEstimateText] = useState("");
  const [estimateProposal, setEstimateProposal] = useState<EstimateProposal>("manual");
  const [startLocal, setStartLocal] = useState("");
  const estimateAbort = useRef<AbortController | null>(null);

  /** Read the page into the editor, dropping what it held. */
  const load = async (): Promise<void> => {
    const res = await fetch(`/api/${tab.folder}/${encodeURIComponent(fileName)}`).catch(() => null);
    const data = (res ? await res.json().catch(() => ({})) : {}) as PageListing & {
      content?: string;
      error?: string;
    };
    if (sealed.current) return;
    if (!res?.ok || typeof data.content !== "string") {
      // Gone — deleted, renamed, or a stale deep link. A missing page says so
      // the way a missing feature does (specs/ui/navigation.feature.md "link to
      // a missing feature"); any other failure keeps the server's own message.
      sealed.current = true;
      toast.error(
        res?.status === 404
          ? `${capitalized(tab.noun)} "${fileName}" not found — the link may be stale.`
          : (data.error ?? `Could not open the ${tab.noun} "${fileName}"`),
      );
      void store.load();
      app.goHome();
      return;
    }
    session.current += 1;
    saved.current = data.content;
    textRef.current = data.content;
    setText(data.content);
    const listing = pageListingOf(data);
    setPage(listing);
    store.upsert(listing);
  };
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void loadRef.current();
  }, []);

  // The reload tick shows what a pull brought — unless the editor holds an
  // edit that has not landed yet.
  const firstKey = useRef(reloadKey);
  useEffect(() => {
    if (reloadKey === firstKey.current) return;
    if (textRef.current !== null && textRef.current === saved.current) void loadRef.current();
  }, [reloadKey]);

  /** One autosave tick — the README editor's twin. */
  const autosave = async () => {
    if (sealed.current) return;
    // A Done / Assigned write is already queued: wait for it rather than
    // racing, and do not enqueue a snapshot that predates the marker.
    if (metaSaving.current > 0) {
      await queue.current.idle();
      return;
    }
    const content = textRef.current;
    const at = session.current;
    if (content === null || pageRef.current === null || content === saved.current) return;
    await queue.current.run(async () => {
      if (sealed.current || metaSaving.current > 0 || content === saved.current) return;
      setSaving(true);
      try {
        const res = await fetch(`/api/${tab.folder}/${encodeURIComponent(fileName)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          // What this buffer was edited from, so the server keeps what the
          // page gained since (a disk edit, a sync) instead of writing over it.
          body: JSON.stringify({ content, base: saved.current }),
        });
        const data = (await res.json().catch(() => ({}))) as PageListing & { error?: string };
        if (!res.ok) {
          toast.error(`${fileName} not saved: ${data.error ?? res.statusText} — will retry.`);
          return;
        }
        if (at !== session.current) return;
        // What went out is what counts as saved: the file holds the
        // document's projection, which can be tidier than the buffer, and
        // taking that back would have every tick save the same text again.
        saved.current = content;
        setSavedAt(Date.now());
        // Only when the heading, assignment, or Done marker actually moved:
        // a new listing object on every tick would restart the timers
        // watching it.
        const listing = pageListingOf(data);
        setPage((open) => (open === null || pageListingMetaEqual(open, listing) ? open : listing));
        store.upsert(listing);
      } catch (e) {
        toast.error(`${fileName} not saved: ${(e as Error).message} — will retry.`);
      } finally {
        setSaving(false);
      }
    });
  };
  const tick = useRef(autosave);
  tick.current = autosave;

  // Ticks run while the page is loaded; leaving it saves what was typed since
  // the last one, so nothing written is lost to the navigation.
  const loaded = text !== null;
  useEffect(() => {
    if (!loaded) return;
    const id = setInterval(() => void tick.current(), app.autosaveSeconds * 1000);
    return () => {
      clearInterval(id);
      void tick.current();
    };
  }, [loaded, app.autosaveSeconds]);

  useEffect(() => {
    onHandle({
      fileName,
      flush: async () => {
        await tick.current();
        await queue.current.idle();
      },
      seal: () => {
        sealed.current = true;
        session.current += 1;
      },
      reload: () => loadRef.current(),
    });
    return () => onHandle(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Write the page's markdown back through its document — the path the
   * "Assigned" dropdown and the Done button share. What comes back replaces
   * what the editor holds, so the metadata line the server wrote shows
   * without a reload, and the sidebar reloads so the list agrees. Returns
   * whether it landed; the caller says what changed.
   */
  const saveMeta = async (next: string, whatFailed: string): Promise<boolean> => {
    if (pageRef.current === null || sealed.current) return false;
    const at = session.current;
    metaSaving.current += 1;
    try {
      return await queue.current.run(async () => {
        try {
          const res = await fetch(`/api/${tab.folder}/${encodeURIComponent(fileName)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: next, base: saved.current }),
          });
          const data = (await res.json().catch(() => ({}))) as PageListing & {
            content?: string;
            error?: string;
          };
          if (!res.ok || typeof data.content !== "string") {
            toast.error(data.error ?? `Could not save the ${whatFailed}`);
            return false;
          }
          // The write landed on the file it was aimed at. Reload the list so
          // a Done marker shows even when the pane has moved on.
          void store.load();
          if (at !== session.current) return true;
          saved.current = data.content;
          textRef.current = data.content;
          setText(data.content);
          setPage(pageListingOf(data));
          setSavedAt(Date.now());
          return true;
        } catch {
          toast.error(`Could not save the ${whatFailed} — is the server running?`);
          return false;
        }
      });
    } finally {
      metaSaving.current -= 1;
    }
  };

  /**
   * Assign the page to a project member, or to nobody — just like a feature
   * (src/server/members.ts). The name lands on the page's `**Assigned:**`
   * line, saved on the spot; the cron pushes it.
   */
  const saveAssigned = async (name: string) => {
    if (!page || text === null) return;
    const assigned = name.trim();
    if ((page.assigned ?? "") === assigned) return;
    const { assigned: previous, ...rest } = parsePage(text);
    const next = serializePage(assigned ? { ...rest, assigned } : rest);
    setAssignedSaving(true);
    try {
      if (await saveMeta(next, "assignment")) {
        toast.success(
          assigned ? `Assigned to ${assigned} — saved locally.` : "Assignment cleared — saved locally.",
          { action: { label: "Undo", run: () => void saveAssigned(previous ?? "") } },
        );
      }
    } finally {
      setAssignedSaving(false);
    }
  };

  /**
   * Tick the task off, or reopen it (specs/app/tasks.feature.md): the page's
   * `**Status:** Done` line, written the same way the assignment is, so the
   * sidebar strikes the task through on the next listing.
   */
  const saveDone = async (done: boolean) => {
    if (!page || text === null) return;
    if ((page.done ?? false) === done) return;
    const { done: _was, ...rest } = parsePage(text);
    const next = serializePage(done ? { ...rest, done: true } : rest);
    setDoneSaving(true);
    try {
      if (await saveMeta(next, "status")) {
        toast.success(done ? "Marked done — saved locally." : "Reopened — saved locally.", {
          action: { label: "Undo", run: () => void saveDone(!done) },
        });
      }
    } finally {
      setDoneSaving(false);
    }
  };

  /**
   * Write the task's estimate (specs/app/tasks.feature.md "Add task to
   * Google Calendar"): the page's `**Estimate:** 1h 30m` line, written the
   * same way the assignment and the Done marker are, so the chip and the
   * next visit to the calendar start from it.
   */
  const saveEstimate = async (minutes: number) => {
    if (!page || text === null) return;
    if ((page.estimate ?? 0) === minutes) return;
    const { estimate: _was, ...rest } = parsePage(text);
    const next = serializePage({ ...rest, estimate: minutes });
    if (await saveMeta(next, "estimate")) {
      toast.success(`Estimated at ${formatEstimate(minutes)} — saved locally.`);
    }
  };

  /**
   * Open the calendar chip's form: the estimate already on the task, else
   * one proposed by Claude when the CLI is there, else an empty field with
   * the presets; and the next quarter hour as the start.
   */
  const openCalendar = () => {
    if (!page) return;
    estimateAbort.current?.abort();
    setStartLocal(localInputValue(nextQuarterHour(new Date())));
    setCalendarOpen(true);
    if (page.estimate) {
      setEstimateText(formatEstimate(page.estimate));
      setEstimateProposal("stored");
      return;
    }
    setEstimateText("");
    if (!canEstimate) {
      setEstimateProposal("manual");
      return;
    }
    setEstimateProposal("loading");
    const abort = new AbortController();
    estimateAbort.current = abort;
    void (async () => {
      try {
        const res = await fetch(`/api/tasks/${encodeURIComponent(page.fileName)}/estimate`, {
          method: "POST",
          signal: abort.signal,
        });
        const data = (await res.json().catch(() => ({}))) as { minutes?: unknown; error?: string };
        if (abort.signal.aborted) return;
        if (res.ok && typeof data.minutes === "number") {
          setEstimateText(formatEstimate(data.minutes));
          setEstimateProposal("claude");
          return;
        }
        if (data.error) toast.error(data.error);
        setEstimateProposal("manual");
      } catch (e) {
        if (abort.signal.aborted) return;
        toast.error(`Could not ask Claude for an estimate: ${(e as Error).message}`);
        setEstimateProposal("manual");
      }
    })();
  };

  const closeCalendar = () => {
    estimateAbort.current?.abort();
    estimateAbort.current = null;
    setCalendarOpen(false);
  };

  // The Google Calendar switch turned off takes the open form with it.
  useEffect(() => {
    if (!googleCalendar) closeCalendar();
  }, [googleCalendar]);
  useEffect(() => () => estimateAbort.current?.abort(), []);

  /** The link was followed: keep the estimate on the task, and close. */
  const submitCalendar = () => {
    const minutes = parseEstimate(estimateText);
    if (minutes !== null) void saveEstimate(minutes);
    closeCalendar();
  };

  /** The prefilled event for the task, or null until the form makes one. */
  const calendarUrl = (): string | null => {
    if (!page || text === null) return null;
    const minutes = parseEstimate(estimateText);
    const start = fromLocalInput(startLocal);
    if (minutes === null || start === null) return null;
    const shared = shareUrl(link);
    const body = parsePage(text).body.trim();
    const excerpt = body.length > 300 ? `${body.slice(0, 300)}…` : body;
    return googleCalendarUrl({
      title: page.name,
      start,
      minutes,
      details: excerpt ? `${excerpt}\n\n${shared}` : shared,
    });
  };

  /**
   * An entry's kind chip (specs/app/engineering-notebook.feature.md): the
   * header changes it, never a hand edit of the metadata line. Saved through
   * the page's document like the Done marker, so the editor's text and the
   * sidebar row follow.
   */
  const saveEntryKind = async (kind: "Observation" | "Decision") => {
    if (!page || text === null) return;
    if (entryKindOf(page) === kind) return;
    setEntryKindSaving(true);
    try {
      const next = serializePage({ ...parsePage(text), kind });
      if (await saveMeta(next, "kind")) {
        toast.success(`Now a${kind === "Observation" ? "n observation" : " decision"} — saved locally.`);
      }
    } finally {
      setEntryKindSaving(false);
    }
  };

  /**
   * "Supersedes…": point this decision at the one it replaces, or unpick it.
   * The earlier entry is never touched — the badge on it is derived from this
   * link, so removing the link removes the badge.
   */
  const saveEntrySupersedes = async (earlier: PageListing | null) => {
    if (!page || text === null) return;
    setEntryKindSaving(true);
    try {
      const { supersedes: _was, ...rest } = parsePage(text);
      const next = serializePage(
        earlier ? { ...rest, supersedes: { title: earlier.name, url: pageLink(earlier.fileName) } } : rest,
      );
      if (await saveMeta(next, "supersedes link")) {
        toast.success(
          earlier ? `Supersedes ${earlier.name} — saved locally.` : "Supersedes cleared — saved locally.",
        );
      }
    } finally {
      setEntryKindSaving(false);
    }
  };

  if (page === null || text === null) return <PageSkeleton cards={1} />;

  /**
   * The members the "Assigned" dropdown offers — the project's, plus whoever
   * the page is assigned to when that name is no longer on the list.
   */
  const assignable: ProjectMember[] =
    !page.assigned || app.members.some((m) => m.name === page.assigned)
      ? app.members
      : [...app.members, { name: page.assigned }];
  /**
   * The decisions the entry may say it supersedes: the earlier ones — an
   * entry cannot supersede itself, and replacing something written later
   * would read backwards. Same-day decisions count as earlier, since the date
   * is all the order there is.
   */
  const supersedable = folderPages.filter(
    (entry) =>
      entry.fileName !== page.fileName &&
      entry.kind === "Decision" &&
      (entry.date ?? "") <= (page.date ?? ""),
  );
  const replacedBy = supersededBy[page.fileName];
  const kind = entryKindOf(page);
  /**
   * A project's own page (specs/app/tasks.feature.md "Projects group
   * tasks"): assigned like a task, but never ticked off or put on the
   * calendar — its tasks are, and the header counts them instead.
   */
  const project = isProjectPageOf(tab, page.fileName);
  const projectTasks = project
    ? folderPages.filter((p) => pageFolderOf(p.fileName) === pageFolderOf(page.fileName))
    : [];

  return (
    <>
      {/* A roadmap page, a task or a notebook entry: a regular markdown file,
          edited and autosaved like the README — with the "Assigned" dropdown
          a feature has, when assignments are on. Assigning is what makes a
          task a task, so the dropdown is the point of the tab. */}
      <header className="editor-bar page-header">
        <Breadcrumbs
          items={[app.repoCrumb, { label: tab.title }]}
          tail={<span className="crumb current plain">{page.name || page.fileName}</span>}
        />
        <div className="editor-actions page-actions">
          <SaveIndicator saving={saving} savedAt={savedAt} dirty={text !== saved.current} />
          {/* The same "Copy link" the feature name carries
              (specs/ui/navigation.feature.md "share a link"), for the page's
              own url (specs/app/tasks.feature.md). */}
          <Tooltip label={app.copied === link ? "Copied" : "Copy link"} keys="mod+shift+c">
            <button
              type="button"
              className="ibtn"
              aria-label="Copy link"
              onClick={() => app.copyLink(link)}
            >
              {app.copied === link ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <Link size={15} aria-hidden="true" />
              )}
            </button>
          </Tooltip>
          {!readOnly && (
            <span className={syncProblem !== null ? "readme-hint sync-failing" : "readme-hint"}>
              {`Autosaves every ${app.autosaveSeconds}s; ${pushHint(syncProblem)}`}
            </span>
          )}
        </div>
      </header>
      {!readOnly && (app.assignments || tab.done || tab.dated) && (
        <div className="props">
          {project && (
            <span className="chip muted project-progress">
              <CheckCircle2 size={14} aria-hidden="true" />
              {projectTasks.length === 0
                ? "No tasks yet"
                : `${projectTasks.filter((p) => p.done).length} of ${projectTasks.length} ${
                    projectTasks.length === 1 ? "task" : "tasks"
                  } done`}
            </span>
          )}
          {/* A notebook entry's header
              (specs/app/engineering-notebook.feature.md): the kind chip that
              changes it, the decision it supersedes, and the author and date
              the app set — shown, never edited. */}
          {tab.dated && (
            <>
              <span className="chip-anchor entry-kind-anchor">
                <button
                  type="button"
                  className={`chip entry-kind-chip entry-kind-${kind.toLowerCase()}`}
                  aria-haspopup="menu"
                  aria-expanded={entryKindMenuOpen}
                  aria-label={`Kind: ${kind}`}
                  disabled={entryKindSaving}
                  onClick={() => setEntryKindMenuOpen((o) => !o)}
                >
                  {kind === "Decision" ? (
                    <Gavel size={14} aria-hidden="true" />
                  ) : (
                    <Eye size={14} aria-hidden="true" />
                  )}
                  {kind}
                </button>
                <Menu
                  open={entryKindMenuOpen}
                  onClose={() => setEntryKindMenuOpen(false)}
                  label="Entry kind"
                  className="chip-menu"
                  containerSelector=".entry-kind-anchor"
                  items={(["Observation", "Decision"] as const).map((k) => ({
                    id: k,
                    label: k,
                    checked: kind === k,
                    icon: k === "Decision" ? <Gavel size={13} /> : <Eye size={13} />,
                    onSelect: () => void saveEntryKind(k),
                  }))}
                />
              </span>
              {/* "Supersedes…": a decision may replace an earlier one. Only
                  decisions offer it — an observation replaces nothing. */}
              {kind === "Decision" && (
                <span className="chip-anchor entry-supersedes-anchor">
                  <button
                    type="button"
                    className={`chip${page.supersedes ? "" : " muted"}`}
                    aria-haspopup="menu"
                    aria-expanded={entrySupersedesMenuOpen}
                    aria-label={`Supersedes: ${page.supersedes?.title ?? "nothing"}`}
                    disabled={entryKindSaving}
                    onClick={() => setEntrySupersedesMenuOpen((o) => !o)}
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                    {page.supersedes ? `Supersedes ${page.supersedes.title}` : "Supersedes…"}
                  </button>
                  <Menu
                    open={entrySupersedesMenuOpen}
                    onClose={() => setEntrySupersedesMenuOpen(false)}
                    label="Supersedes"
                    className="chip-menu"
                    containerSelector=".entry-supersedes-anchor"
                    items={[
                      {
                        id: "",
                        label: "Nothing",
                        checked: !page.supersedes,
                        onSelect: () => void saveEntrySupersedes(null),
                      },
                      ...supersedable.map((entry) => ({
                        id: entry.fileName,
                        label: entry.name,
                        checked: page.supersedes?.url === pageLink(entry.fileName),
                        icon: <Gavel size={13} />,
                        onSelect: () => void saveEntrySupersedes(entry),
                      })),
                    ]}
                  />
                </span>
              )}
              {/* Who signed it and when — set by the app at creation. */}
              {page.author && (
                <span className="chip muted entry-author-chip">
                  <span className="avatar chip-avatar" aria-hidden="true">
                    {initialsOf(page.author)}
                  </span>
                  {page.author}
                </span>
              )}
              {page.date && <span className="chip muted entry-date-chip">{page.date}</span>}
              {/* The badge an entry wears once a later decision replaced it —
                  derived from that entry's link, not stored here. */}
              {replacedBy && (
                <a
                  className="chip entry-superseded-chip"
                  href={pageLink(replacedBy.fileName)}
                  onClick={(e) =>
                    spaClick(e, () => navigate({ fileName: replacedBy.fileName }, { push: true }))
                  }
                >
                  Superseded by {replacedBy.name}
                </a>
              )}
            </>
          )}
          {/* The Done button (specs/app/tasks.feature.md): a task is finished
              or it is not, and the chip says which. Tasks only — a roadmap
              page is never ticked off. */}
          {tab.done && !project && (
            <button
              type="button"
              className={`chip page-done${page.done ? " is-done" : " muted"}`}
              aria-pressed={page.done === true}
              disabled={doneSaving}
              onClick={() => void saveDone(!page.done)}
            >
              {page.done ? (
                <CheckCircle2 size={14} aria-hidden="true" />
              ) : (
                <Circle size={14} aria-hidden="true" />
              )}
              {page.done ? "Done" : "Mark done"}
            </button>
          )}
          {/* The calendar chip (specs/app/tasks.feature.md "Add task to
              Google Calendar"): the task's estimate, or the invitation to
              make one and put the task on the calendar. Tasks only, and only
              with the Google Calendar switch on. */}
          {tab.calendar && googleCalendar && !project && (
            <span className="chip-anchor calendar-anchor">
              <button
                type="button"
                className={`chip page-estimate${page.estimate ? " has-estimate" : " muted"}`}
                aria-haspopup="dialog"
                aria-expanded={calendarOpen}
                onClick={() => (calendarOpen ? closeCalendar() : openCalendar())}
              >
                <CalendarPlus size={14} aria-hidden="true" />
                {page.estimate ? formatEstimate(page.estimate) : "Add to calendar"}
              </button>
              <Popover
                open={calendarOpen}
                onClose={closeCalendar}
                label="Add this task to Google Calendar"
                className="chip-popover"
                containerSelector=".calendar-anchor"
              >
                {calendarOpen && (
                  <AddToCalendarForm
                    estimateText={estimateText}
                    onEstimateChange={setEstimateText}
                    startLocal={startLocal}
                    onStartChange={setStartLocal}
                    proposal={estimateProposal}
                    url={calendarUrl()}
                    onSubmit={submitCalendar}
                    onCancel={closeCalendar}
                  />
                )}
              </Popover>
            </span>
          )}
          {app.assignments && !tab.dated && (
            <span className="chip-anchor page-assignee-anchor">
              <button
                type="button"
                className={`chip${page.assigned ? "" : " muted"}`}
                aria-haspopup="menu"
                aria-expanded={assigneeMenuOpen}
                aria-label={`Assigned: ${page.assigned ?? "nobody"}`}
                disabled={assignedSaving}
                onClick={() => setAssigneeMenuOpen((o) => !o)}
              >
                {page.assigned ? (
                  <span className="avatar chip-avatar" aria-hidden="true">
                    {initialsOf(page.assigned)}
                  </span>
                ) : (
                  <UserRound size={14} aria-hidden="true" />
                )}
                {page.assigned ?? "Unassigned"}
              </button>
              <Menu
                open={assigneeMenuOpen}
                onClose={() => setAssigneeMenuOpen(false)}
                label="Assigned member"
                className="chip-menu"
                containerSelector=".page-assignee-anchor"
                items={[
                  {
                    id: "",
                    label: "Unassigned",
                    checked: !page.assigned,
                    onSelect: () => void saveAssigned(""),
                  },
                  ...assignable.map((m) => ({
                    id: m.name,
                    label: m.name,
                    checked: page.assigned === m.name,
                    icon: (
                      <span className="avatar chip-avatar" aria-hidden="true">
                        {initialsOf(m.name)}
                      </span>
                    ),
                    onSelect: () => void saveAssigned(m.name),
                  })),
                ]}
              />
            </span>
          )}
        </div>
      )}
      <MarkdownEditor
        value={text}
        onChange={setText}
        highlight={terms ?? undefined}
        // The read-only site shows the page rendered, its source a tab away.
        readOnly={readOnly}
        placeholder={project ? "Describe this project in Markdown…" : `Write this ${tab.noun} in Markdown…`}
      />
    </>
  );
}

/**
 * "+ New page" / "+ New task" / "New entry": a markdown file in the tab's
 * folder, opened right away. Shared by the tab's button and the palette's
 * "New notebook entry".
 */
export async function newPageFlow(
  tab: PageTab,
  store: PagesStore,
  promptWithChoice: PromptWithChoice,
  navigate: Navigate<PageRoute>,
  /** The subfolder under the tab's folder to create it in — a folder's
      "New task here" — or the top level. */
  inFolder = "",
): Promise<void> {
  // A notebook entry is an observation or a decision
  // (specs/app/engineering-notebook.feature.md), so its dialog asks which
  // before it asks anything else; the folder is flat, so it says nothing
  // about subfolders. Every other page tab keeps the plain name prompt.
  const result = await promptWithChoice({
    title: tab.dated ? "New entry" : inFolder ? `New ${tab.noun} in “${inFolder}”` : `New ${tab.noun}`,
    hint: tab.dated
      ? "Today's date goes in front of the file name, so the notebook reads in order."
      : inFolder
        ? undefined
        : `Use folder/name to create inside a subfolder of ${tab.folder}.`,
    placeholder: tab.dated
      ? "A spec change lands before the code"
      : tab.folder === "tasks"
        ? "Ship v2"
        : "Pricing",
    confirmLabel: tab.dated ? "Create entry" : `Create ${tab.noun}`,
    ...(tab.dated
      ? {
          choicesLabel: "Kind",
          choices: [
            {
              label: "Observation",
              value: "Observation",
              hint: "Something you noticed about the way you work.",
            },
            {
              label: "Decision",
              value: "Decision",
              hint: "Something you have decided to do about it.",
            },
          ],
        }
      : {}),
  });
  const input = cleanLine(result?.text ?? "");
  if (!input) return;
  const res = await fetch(`/api/${tab.folder}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: inFolder ? `${inFolder}/${input}` : input,
      ...(result?.choice ? { kind: result.choice } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { fileName?: string; error?: string };
  if (!res.ok || !data.fileName) {
    toast.error(data.error ?? `Could not create the ${tab.noun}`);
    return;
  }
  await store.load();
  navigate({ fileName: data.fileName }, { push: true });
}

/**
 * The tab's sidebar: a New button where the Specs tab has its New buttons,
 * then the pages grouped by their subfolder under the folder — the
 * notebook's entries by the month they were written in instead
 * (specs/app/engineering-notebook.feature.md) — each with a ⋯ menu: Rename,
 * Copy link, Delete, and Archive where the tab's pages are archived, which
 * then lists them under a collapsed Archived head at the foot of the list
 * (specs/app/roadmap.feature.md "Archive a roadmap page"). An ordered tab — the tasks (specs/app/tasks.feature.md
 * "Reorder tasks by dragging", "Task folder menu") and the roadmap
 * (specs/app/roadmap.feature.md "Reorder roadmap pages") — also lets a row be
 * dragged into place, adds Move up, Move down and Move to folder… to its
 * menu, and gives each subfolder the ⋯ menu a Specs folder has: New task
 * here, New folder here, Rename, Delete. The tasks' subfolders are projects
 * (specs/app/tasks.feature.md "Projects group tasks"): each header shows the
 * project's name and owner and opens the project's page.
 */
export function PagesSidebar({
  tab,
  store,
  active,
  app,
  navigate,
  openPage,
}: {
  tab: PageTab;
  store: PagesStore;
  /** The page open in the pane, if it is one of this tab's. */
  active: string | null;
  app: TabApp;
  navigate: Navigate<PageRoute>;
  /** The open page's editor, if the pane holds one of this tab's pages. */
  openPage: () => OpenPageHandle | null;
}) {
  const { pages, supersededBy, folders, projects, archived } = usePages(store);
  const { readOnly } = usePageSettings();
  /** A row's ⋯ menu (file name, or `folder:<path>` for a folder's), if open. */
  const [menu, setMenu] = useState<string | null>(null);
  /** The page being dragged, if any — an ordered tab's only. */
  const [dragging, setDragging] = useState<string | null>(null);
  /** The list: the open row is revealed in it, and keys walk its rows. */
  const listRef = useRef<HTMLDivElement>(null);
  useRevealActive(listRef, active);
  /** Tasks (specs/app/tasks.feature.md): all of them, the open ones, or the done. */
  const [taskFilter, setTaskFilter] = useState<"all" | "open" | "done">("all");
  const [filterOpen, setFilterOpen] = useState(false);
  /** Where it would land: on the edge of a row, or into a folder's top. */
  const [dropAt, setDropAt] = useState<
    { row: string; after: boolean } | { folder: string } | null
  >(null);
  const ordered = Boolean(tab.ordered);
  const groups = tab.dated ? entryGroups(pages) : pageGroups(pages, ordered ? folders : []);
  const folderPath = (dir: string) => (dir ? `${tab.folder}/${dir}` : tab.folder);
  const folderMenuKey = (dir: string) => `folder:${dir}`;
  /** What a subfolder is called: a project, in the tasks. */
  const folderWord = tab.projects ? "project" : "folder";
  /** A subfolder's project — its name and owner — when the tab has projects. */
  const projectOf = (dir: string) =>
    tab.projects ? projects.find((p) => p.folder === folderPath(dir)) : undefined;
  /** What a subfolder's header and prompts call it. */
  const folderName = (dir: string) => projectOf(dir)?.name ?? dir;

  /**
   * Open a project's page — made first when the project has none yet, a
   * folder from before projects had pages.
   */
  const openProject = async (dir: string) => {
    const known = projectOf(dir)?.fileName;
    if (known) {
      navigate({ fileName: known }, { push: true });
      return;
    }
    const res = await fetch(`/api/${tab.folder}-folders/${encodeURIComponent(folderPath(dir))}/page`, {
      method: "POST",
    });
    const data = (await res.json().catch(() => ({}))) as { fileName?: string; error?: string };
    if (!res.ok || !data.fileName) {
      toast.error(data.error ?? "Could not open the project");
      return;
    }
    await store.load();
    navigate({ fileName: data.fileName }, { push: true });
  };

  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };

  /**
   * Rename a page: its `# heading` and its file both, so the url follows the
   * title (specs/app/roadmap.feature.md). The server owns both halves — a
   * `git mv` committed and pushed — so this is one round trip and the two can
   * never drift apart.
   */
  const renamePage = async (page: PageListing) => {
    const name = await app.prompt({
      title: `Rename ${tab.noun}`,
      initial: page.name,
      confirmLabel: "Rename",
    });
    if (!name || cleanLine(name) === page.name) return;
    // What the open editor holds lands first, so the rename carries it.
    const open = openPage();
    if (open?.fileName === page.fileName) await open.flush();
    const res = await fetch(`/api/${tab.folder}/${encodeURIComponent(page.fileName)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: cleanLine(name) }),
    });
    const data = (await res.json().catch(() => ({}))) as { fileName?: string; error?: string };
    if (!res.ok || !data.fileName) {
      toast.error(data.error ?? `Could not rename the ${tab.noun}`);
      return;
    }
    toast.success(`Renamed to “${name.trim()}”.`);
    await store.load();
    const still = openPage();
    if (still?.fileName !== page.fileName) return;
    // Re-open at the new file name — never push, or the retired url is left
    // behind for Back to land on; without push the url is rewritten in place.
    if (data.fileName === page.fileName) await still.reload();
    else navigate({ fileName: data.fileName });
  };

  /** Delete a page — committed and pushed right away, so it is confirmed first. */
  const removePage = async (page: PageListing) => {
    const ok = await app.confirm({
      title: `Delete ${tab.noun}`,
      body: `Delete “${page.name}”? This is committed and pushed right away.`,
      confirmLabel: `Delete ${tab.noun}`,
    });
    if (!ok) return;
    // The open page leaves without its parting save, which would write the
    // file back.
    const open = openPage();
    if (open?.fileName === page.fileName) {
      open.seal();
      app.goHome();
    }
    const res = await fetch(`/api/${tab.folder}/${encodeURIComponent(page.fileName)}`, {
      method: "DELETE",
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (!res.ok) {
      toast.error(data.error ?? `Could not delete the ${tab.noun}`);
      return;
    }
    toast.success(`Deleted “${page.name}”${data.message ? ` — ${data.message}` : ""}.`);
    await store.load();
  };

  /**
   * Archive a page (specs/app/roadmap.feature.md "Archive a roadmap page"):
   * out of the list and out of the data repo, its document kept — so no
   * confirmation, just an Undo, which restores it. The open page lands what
   * it holds first, so that is what is archived, then leaves without its
   * parting save, which would write the file back.
   */
  const archivePage = async (page: PageListing) => {
    const open = openPage();
    if (open?.fileName === page.fileName) {
      await open.flush();
      open.seal();
      app.goHome();
    }
    const res = await fetch(`/api/${tab.folder}/${encodeURIComponent(page.fileName)}/archive`, {
      method: "POST",
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (!res.ok) {
      toast.error(data.error ?? `Could not archive the ${tab.noun}`);
      return;
    }
    toast.success(`Archived “${page.name}”.`, {
      action: { label: "Undo", run: () => void restorePage(page) },
    });
    await store.load();
  };

  /** Restore an archived page to where it was, last in its folder. */
  const restorePage = async (page: { fileName: string; name: string }) => {
    const res = await fetch(`/api/${tab.folder}-archive/${encodeURIComponent(page.fileName)}/restore`, {
      method: "POST",
    });
    const data = (await res.json().catch(() => ({}))) as { fileName?: string; error?: string };
    if (!res.ok || !data.fileName) {
      toast.error(data.error ?? `Could not restore the ${tab.noun}`);
      return;
    }
    toast.success(`Restored “${page.name}”.`);
    await store.load();
  };

  /** Delete an archived page for good — its document is the only copy left. */
  const removeArchived = async (page: ArchivedListing) => {
    const ok = await app.confirm({
      title: `Delete archived ${tab.noun}`,
      body: `Delete “${page.name}” for good? Its archived copy is the only one left; this is committed and pushed right away.`,
      confirmLabel: `Delete ${tab.noun}`,
    });
    if (!ok) return;
    const res = await fetch(`/api/${tab.folder}-archive/${encodeURIComponent(page.fileName)}`, {
      method: "DELETE",
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (!res.ok) {
      toast.error(data.error ?? `Could not delete the ${tab.noun}`);
      return;
    }
    toast.success(`Deleted “${page.name}”${data.message ? ` — ${data.message}` : ""}.`);
    await store.load();
  };

  /**
   * Put a page in a folder before another of its pages, or last with null —
   * what a drop, Move up, Move down and Move to folder… all come to. Within
   * its folder only the order changes; into another the file moves, so the
   * open editor lands what it holds first and follows it to its new url.
   */
  const placePage = async (fileName: string, folder: string, before: string | null) => {
    const moving = pageFolderOf(fileName) !== folder;
    const open = openPage();
    if (moving && open?.fileName === fileName) await open.flush();
    const res = await fetch(`/api/${tab.folder}/${encodeURIComponent(fileName)}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder, before }),
    });
    const data = (await res.json().catch(() => ({}))) as { fileName?: string; error?: string };
    if (!res.ok || !data.fileName) {
      toast.error(data.error ?? `Could not move the ${tab.noun}`);
      return;
    }
    await store.load();
    if (moving && openPage()?.fileName === fileName) navigate({ fileName: data.fileName });
  };

  /** The pages of one folder — its own, not its subfolders' — in order. */
  const pagesIn = (folder: string) => pages.filter((p) => pageFolderOf(p.fileName) === folder);

  /** Drop the dragged page on a row's edge, or into a folder's top. */
  const dropOn = (target: { row: string; after: boolean } | { folder: string }) => {
    const dragged = dragging;
    endDrag();
    if (dragged === null) return;
    if ("folder" in target) {
      const group = pagesIn(target.folder);
      if (group[0]?.fileName === dragged) return;
      void placePage(dragged, target.folder, group.find((p) => p.fileName !== dragged)?.fileName ?? null);
      return;
    }
    const folder = pageFolderOf(target.row);
    const before = dropPlacement(pagesIn(folder), dragged, target.row, target.after);
    if (before !== undefined) void placePage(dragged, folder, before);
  };

  /** Move up / Move down: one step within the page's own folder. */
  const stepPage = (page: PageListing, step: -1 | 1) => {
    const folder = pageFolderOf(page.fileName);
    const before = stepPlacement(pagesIn(folder), page.fileName, step);
    if (before !== undefined) void placePage(page.fileName, folder, before);
  };

  /** Move to folder…: any other folder of the tab, the top level included. */
  const movePagePrompt = async (page: PageListing) => {
    const from = pageFolderOf(page.fileName);
    const options = [tab.folder, ...folders]
      .filter((f) => f !== from)
      .map((f) => ({
        value: f,
        label:
          f === tab.folder
            ? tab.projects
              ? `No project — top of ${tab.title}`
              : `Top of ${tab.title}`
            : folderName(f.slice(tab.folder.length + 1)),
      }));
    const to = await app.pick({
      title: `Move “${page.name}”`,
      hint: `To another ${folderWord} — a git mv, committed and pushed.`,
      placeholder: `Find a ${folderWord}…`,
      options,
      empty:
        options.length === 0 ? `There is no other ${folderWord} to move it to.` : `No ${folderWord} matches.`,
    });
    if (to === null) return;
    await placePage(page.fileName, to, null);
  };

  /** New folder: at the top level from the sidebar's button, else inside one. */
  const createFolderIn = async (dir: string) => {
    const input = await app.prompt({
      title: dir ? `New ${folderWord} in “${folderName(dir)}”` : `New ${folderWord}`,
      hint: dir ? undefined : "Use / for nesting.",
      confirmLabel: `Create ${folderWord}`,
    });
    if (!input) return;
    const res = await fetch(`/api/${tab.folder}-folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dir ? `${dir}/${input}` : input }),
    });
    const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
    if (!res.ok) {
      toast.error(data.error ?? `Could not create the ${folderWord}`);
      return;
    }
    await store.load();
  };

  /**
   * Rename a folder: it keeps its place, and its tasks' urls follow it. A
   * project's page takes the name as typed.
   */
  const renameFolder = async (dir: string) => {
    const path = folderPath(dir);
    const current = projectOf(dir)?.name ?? dir.split("/").pop()!;
    const name = await app.prompt({
      title: `Rename ${folderWord}`,
      hint: `The ${folderWord} keeps its place; its folder name is slugified like a file name.`,
      initial: current,
      confirmLabel: "Rename",
    });
    if (!name || cleanLine(name) === current) return;
    const open = openPage();
    const inside = open !== null && open.fileName.startsWith(`${path}/`);
    if (inside) await open.flush();
    const res = await fetch(`/api/${tab.folder}-folders/${encodeURIComponent(path)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: cleanLine(name) }),
    });
    const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
    if (!res.ok || !data.path) {
      toast.error(data.error ?? `Could not rename the ${folderWord}`);
      return;
    }
    await store.load();
    // The open project page shows its new heading.
    if (data.path === path) {
      if (inside) await openPage()?.reload();
      return;
    }
    toast.success(
      tab.projects
        ? `Renamed project to “${cleanLine(name)}”.`
        : `Renamed folder to ${data.path.split("/").pop()}.`,
    );
    const still = openPage();
    if (inside && still?.fileName.startsWith(`${path}/`)) {
      navigate({ fileName: `${data.path}${still.fileName.slice(path.length)}` });
    }
  };

  /** Delete a folder and the tasks in it, named in the confirmation. */
  const removeFolder = async (dir: string) => {
    const path = folderPath(dir);
    const count = pages.filter((p) => p.fileName.startsWith(`${path}/`)).length;
    const nouns = `${tab.noun}${count === 1 ? "" : "s"}`;
    const ok = await app.confirm({
      title: `Delete ${folderWord}`,
      body:
        count === 0
          ? `Delete the empty ${folderWord} “${folderName(dir)}”?`
          : `Delete “${folderName(dir)}” and the ${count} ${nouns} in it? They are removed from the repository, committed and pushed.`,
      confirmLabel: count === 0 ? `Delete ${folderWord}` : `Delete ${folderWord} and ${count} ${nouns}`,
    });
    if (!ok) return;
    const open = openPage();
    if (open?.fileName.startsWith(`${path}/`)) {
      open.seal();
      app.goHome();
    }
    const res = await fetch(`/api/${tab.folder}-folders/${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (!res.ok) {
      toast.error(data.error ?? `Could not delete the ${folderWord}`);
      return;
    }
    toast.success(`Deleted ${folderWord} “${folderName(dir)}”${data.message ? ` — ${data.message}` : ""}.`);
    await store.load();
  };

  return (
    <div
      className="side-panel page-list"
      role="tabpanel"
      id={`side-panel-${tab.folder}`}
      aria-labelledby={`side-tab-${tab.folder}`}
    >
      {/* The tab's head (src/frontend/SidebarSection.tsx): its name, the
          Tasks filter, and the "new" actions as icons — the read-only site
          (src/server/readOnlyMode.ts) creates nothing. A project holds
          tasks, so its icon comes first; a plain folder follows the page it
          would hold. */}
      <SidebarSection
        label={tab.title}
        filter={
          tab.done && (
            <>
              <Tooltip label="Filter tasks">
                <button
                  type="button"
                  className={`chip${taskFilter !== "all" ? " on" : ""}`}
                  aria-label="Filter tasks"
                  aria-haspopup="menu"
                  aria-expanded={filterOpen}
                  onClick={() => setFilterOpen((o) => !o)}
                >
                  <ListFilter size={12} aria-hidden="true" />{" "}
                  {taskFilter === "all" ? "Filter" : taskFilter === "open" ? "Open" : "Done"}
                </button>
              </Tooltip>
              <Menu
                open={filterOpen}
                onClose={() => setFilterOpen(false)}
                label="Filter tasks"
                className="filter-menu"
                containerSelector=".filter-anchor"
                items={(["all", "open", "done"] as const).map((f) => ({
                  id: f,
                  label: f === "all" ? "All tasks" : f === "open" ? "Open" : "Done",
                  checked: taskFilter === f,
                  onSelect: () => setTaskFilter(f),
                }))}
              />
            </>
          )
        }
        actions={
          !readOnly && (
            <>
              {ordered && tab.projects && (
                <SectionAction label={`New ${folderWord}`} icon={<NewFolderIcon size={15} />} onClick={() => void createFolderIn("")} />
              )}
              <SectionAction
                label={`New ${tab.noun}`}
                keys="c"
                icon={tab.done ? <ListPlus size={15} /> : <FilePlus size={15} />}
                onClick={() => void newPageFlow(tab, store, app.promptWithChoice, navigate)}
              />
              {ordered && !tab.projects && (
                <SectionAction label={`New ${folderWord}`} icon={<NewFolderIcon size={15} />} onClick={() => void createFolderIn("")} />
              )}
            </>
          )
        }
      />
      <div
        className="page-rows"
        role="tree"
        aria-label={tab.title}
        ref={listRef}
        onKeyDown={(e) => listKeyDown(e, (key) => setMenu(() => key))}
      >
        {groups.map(({ dir, pages: group }) => {
          const visible =
            tab.done && taskFilter !== "all" ? group.filter((p) => (taskFilter === "done") === Boolean(p.done)) : group;
          return (
          <div key={dir || "."}>
            {dir && !ordered && <div className="page-group">{dir}</div>}
            {dir && ordered && (
              <div
                className={`page-group page-folder${
                  dropAt && "folder" in dropAt && dropAt.folder === folderPath(dir) ? " drop-target" : ""
                }`}
                data-folder={folderPath(dir)}
                onDragOver={(e) => {
                  if (dragging === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (!(dropAt && "folder" in dropAt && dropAt.folder === folderPath(dir))) {
                    setDropAt({ folder: folderPath(dir) });
                  }
                }}
                onDrop={(e) => {
                  if (dragging === null) return;
                  e.preventDefault();
                  dropOn({ folder: folderPath(dir) });
                }}
              >
                {tab.projects ? (
                  <ProjectHeader
                    project={projectOf(dir)}
                    dir={dir}
                    href={pageLink(projectPageOf(folderPath(dir)))}
                    active={active === projectPageOf(folderPath(dir))}
                    onOpen={() => void openProject(dir)}
                  />
                ) : (
                  <span className="page-folder-name">{dir}</span>
                )}
                {!readOnly && (
                <span className="tree-row-menu">
                  <Tooltip label="More actions">
                    <button
                      type="button"
                      className="tree-menu-btn"
                      aria-label={`Menu for ${folderWord} ${folderName(dir)}`}
                      aria-haspopup="menu"
                      aria-expanded={menu === folderMenuKey(dir)}
                      onClick={() =>
                        setMenu((m) => (m === folderMenuKey(dir) ? null : folderMenuKey(dir)))
                      }
                    >
                      <Ellipsis size={14} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Menu
                    open={menu === folderMenuKey(dir)}
                    onClose={() => setMenu(null)}
                    label={`Menu for ${folderWord} ${folderName(dir)}`}
                    className="tree-menu"
                    containerSelector=".tree-row-menu"
                    items={[
                      {
                        id: "new-page",
                        label: `New ${tab.noun} here`,
                        icon: <ListPlus size={13} />,
                        onSelect: () =>
                          void newPageFlow(tab, store, app.promptWithChoice, navigate, dir),
                      },
                      {
                        id: "new-folder",
                        label: `New ${folderWord} here`,
                        icon: <NewFolderIcon size={13} />,
                        onSelect: () => void createFolderIn(dir),
                      },
                      {
                        id: "rename",
                        label: "Rename",
                        icon: <Pencil size={13} />,
                        onSelect: () => void renameFolder(dir),
                      },
                      {
                        id: "delete",
                        label: "Delete",
                        icon: <Trash2 size={13} />,
                        danger: true,
                        onSelect: () => void removeFolder(dir),
                      },
                    ]}
                  />
                </span>
                )}
              </div>
            )}
            {visible.map((page, i) => {
              const replaced = tab.dated ? supersededBy[page.fileName] : undefined;
              const here = page.fileName === active;
              const edge =
                dropAt && "row" in dropAt && dropAt.row === page.fileName
                  ? dropAt.after
                    ? " drop-after"
                    : " drop-before"
                  : "";
              return (
                <SidebarRow
                  href={pageLink(page.fileName)}
                  active={here}
                  level={dir ? 2 : 1}
                  menuKey={page.fileName}
                  title={
                    replaced
                      ? `${pageRowTitle(page)} — superseded by ${replaced.name}`
                      : pageRowTitle(page)
                  }
                  className={`${dir && !tab.dated ? "nested" : ""}${replaced ? " superseded" : ""}${
                    page.done ? " done" : ""
                  }${edge}${dragging === page.fileName ? " dragging" : ""}`}
                  rowProps={{
                    onDragOver: ordered
                      ? (e) => {
                          if (dragging === null) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          const box = e.currentTarget.getBoundingClientRect();
                          const after = e.clientY > box.top + box.height / 2;
                          if (!(dropAt && "row" in dropAt && dropAt.row === page.fileName && dropAt.after === after)) {
                            setDropAt({ row: page.fileName, after });
                          }
                        }
                      : undefined,
                    onDrop: ordered
                      ? (e) => {
                          if (dragging === null) return;
                          e.preventDefault();
                          const box = e.currentTarget.getBoundingClientRect();
                          dropOn({ row: page.fileName, after: e.clientY > box.top + box.height / 2 });
                        }
                      : undefined,
                  }}
                  linkProps={{
                    draggable: ordered || undefined,
                    onDragStart: ordered
                      ? (e) => {
                          e.dataTransfer.setData("text/plain", pageLink(page.fileName));
                          e.dataTransfer.effectAllowed = "move";
                          setDragging(page.fileName);
                        }
                      : undefined,
                    onDragEnd: ordered ? endDrag : undefined,
                  }}
                  onOpen={(e) => spaClick(e, () => navigate({ fileName: page.fileName }, { push: true }))}
                  /* The slots (src/frontend/SidebarRow.tsx): a task's done mark
                     or an entry's kind leads; a page's assignee trails as the
                     avatar the cards use; an entry's author and day make its
                     second line. */
                  leading={
                    tab.done ? (
                      page.done ? (
                        <CheckCircle2 size={13} />
                      ) : (
                        <Circle size={13} />
                      )
                    ) : tab.dated ? (
                      <EntryKindGlyph kind={entryKindOf(page)} />
                    ) : undefined
                  }
                  label={page.name}
                  trailing={
                    !tab.dated && page.assigned ? (
                      <span className="avatar chip-avatar" title={`Assigned to ${page.assigned}`}>
                        {initialsOf(page.assigned)}
                      </span>
                    ) : undefined
                  }
                  meta={
                    tab.dated ? (
                      <>
                        {page.author && <span className="entry-author">{page.author}</span>}
                        {page.date && <span className="entry-day">{dayOf(page.date)}</span>}
                      </>
                    ) : undefined
                  }
                  menu={
                    readOnly
                      ? undefined
                      : {
                          label: `Menu for ${page.name}`,
                          open: menu === page.fileName,
                          onToggle: () => setMenu((m) => (m === page.fileName ? null : page.fileName)),
                          onClose: () => setMenu(null),
                          // One order for every sidebar ⋯ (specs/ui/ui.feature.md
                          // "Feature entry menu"): name, place, share, derive,
                          // delete.
                          items: [
                        {
                          id: "rename",
                          label: "Rename",
                          icon: <Pencil size={13} />,
                          onSelect: () => void renamePage(page),
                        },
                        ...(ordered
                          ? [
                              {
                                id: "move-up",
                                label: "Move up",
                                icon: <ArrowUp size={13} />,
                                disabled: i === 0,
                                onSelect: () => stepPage(page, -1),
                              },
                              {
                                id: "move-down",
                                label: "Move down",
                                icon: <ArrowDown size={13} />,
                                disabled: i === visible.length - 1,
                                onSelect: () => stepPage(page, 1),
                              },
                              {
                                id: "move",
                                label: `Move to ${folderWord}…`,
                                icon: <FolderInput size={13} />,
                                onSelect: () => void movePagePrompt(page),
                              },
                            ]
                          : []),
                        {
                          id: "copy",
                          label: "Copy link",
                          icon: <Link size={13} />,
                          onSelect: () => app.copyLink(pageLink(page.fileName)),
                        },
                        ...(tab.archivable
                          ? [
                              {
                                id: "archive",
                                label: "Archive",
                                icon: <Archive size={13} />,
                                onSelect: () => void archivePage(page),
                              },
                            ]
                          : []),
                        {
                          id: "delete",
                          label: "Delete",
                          icon: <Trash2 size={13} />,
                          danger: true,
                          onSelect: () => void removePage(page),
                        },
                          ],
                        }
                  }
                />
              );
            })}
          </div>
          );
        })}
        {pages.length === 0 && <p className="empty">{tab.empty}</p>}
        {tab.archivable && !readOnly && archived.length > 0 && (
          <ArchivedPages
            archived={archived}
            menu={menu}
            setMenu={setMenu}
            onRestore={(page) => void restorePage(page)}
            onDelete={(page) => void removeArchived(page)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The Archived head at the foot of the Roadmap list
 * (specs/app/roadmap.feature.md "Archive a roadmap page"): collapsed to its
 * count until opened, then the archived pages, most recently archived
 * first, each saying when and by whom, with a ⋯ menu of Restore and Delete.
 * An archived page has no file to open, so its row is not a link.
 */
function ArchivedPages({
  archived,
  menu,
  setMenu,
  onRestore,
  onDelete,
}: {
  archived: ArchivedListing[];
  /** The sidebar's open ⋯ menu — `archived:<file>` for one of these rows. */
  menu: string | null;
  setMenu: (update: (m: string | null) => string | null) => void;
  onRestore: (page: ArchivedListing) => void;
  onDelete: (page: ArchivedListing) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="page-archive">
      <button
        type="button"
        className="page-group page-archive-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight size={12} aria-hidden="true" className="page-archive-twist" />
        Archived
        <span className="page-archive-count">{archived.length}</span>
      </button>
      {open &&
        archived.map((page) => {
          const key = `archived:${page.fileName}`;
          const when = page.archivedAt.slice(0, 10);
          return (
            <div key={page.fileName} className="page-row archived-row">
              <span
                className="page-entry archived-entry"
                title={`${page.name} — archived ${when}${page.archivedBy ? ` by ${page.archivedBy}` : ""}`}
              >
                {page.name}
                <span className="archived-day">{when}</span>
              </span>
              <span className="tree-row-menu">
                <Tooltip label="More actions">
                  <button
                    type="button"
                    className="tree-menu-btn"
                    aria-label={`Menu for archived ${page.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menu === key}
                    onClick={() => setMenu((m) => (m === key ? null : key))}
                  >
                    <Ellipsis size={14} aria-hidden="true" />
                  </button>
                </Tooltip>
                <Menu
                  open={menu === key}
                  onClose={() => setMenu(() => null)}
                  label={`Menu for archived ${page.name}`}
                  className="tree-menu"
                  containerSelector=".tree-row-menu"
                  items={[
                    {
                      id: "restore",
                      label: "Restore",
                      icon: <ArchiveRestore size={13} />,
                      onSelect: () => onRestore(page),
                    },
                    {
                      id: "delete",
                      label: "Delete",
                      icon: <Trash2 size={13} />,
                      danger: true,
                      onSelect: () => onDelete(page),
                    },
                  ]}
                />
              </span>
            </div>
          );
        })}
    </div>
  );
}

/**
 * A project's header in the Tasks sidebar (specs/app/tasks.feature.md
 * "Projects group tasks"): its name, and its owner's initials when it is
 * assigned — a link to the project's page.
 */
function ProjectHeader({
  project,
  dir,
  href,
  active,
  onOpen,
}: {
  /** The project's listing — missing only before the first load lands. */
  project: ProjectListing | undefined;
  /** The folder under the tab's own, `website-relaunch`. */
  dir: string;
  href: string;
  /** Whether the project's page is the one open in the pane. */
  active: boolean;
  onOpen: () => void;
}) {
  const name = project?.name ?? dir;
  return (
    <a
      href={href}
      className={`page-folder-name project-name${active ? " active" : ""}`}
      title={project?.assigned ? `${name} — assigned to ${project.assigned}` : name}
      aria-current={active ? "page" : undefined}
      onClick={(e) => spaClick(e, onOpen)}
    >
      {name}
      {project?.assigned && (
        <span className="avatar chip-avatar project-owner" aria-label={`Assigned to ${project.assigned}`}>
          {initialsOf(project.assigned)}
        </span>
      )}
    </a>
  );
}

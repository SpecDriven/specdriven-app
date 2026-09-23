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
  ArrowDown,
  CalendarPlus,
  Check,
  CheckCircle2,
  Circle,
  Ellipsis,
  Eye,
  Gavel,
  Link,
  Pencil,
  Trash2,
  UserRound,
} from "lucide-react";
import type { PageListing } from "../../server/pages";
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
import { Popover } from "../Popover";
import { PageSkeleton } from "../Skeleton";
import { SaveIndicator, toast } from "../Toasts";
import { Tooltip } from "../Tooltip";
import { EntryKindChip, dayOf, entryGroups, entryKindOf } from "../notebook";
import { createPromiseQueue } from "../promiseQueue";
import { desktopLink } from "../route";
import {
  pageGroups,
  pageListingMetaEqual,
  pageListingOf,
  pageRowTitle,
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
  const { googleCalendar, canEstimate } = usePageSettings();
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
      // the way a missing feature does (specs/navigation.spec.md "link to a
      // missing feature"); any other failure keeps the server's own message.
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
          body: JSON.stringify({ content }),
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
            body: JSON.stringify({ content: next }),
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
    const shared = location.protocol === "app:" ? desktopLink(link) : location.origin + link;
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
              (specs/navigation.spec.md "share a link"), for the page's own
              url (specs/app/tasks.feature.md). */}
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
          <span className="readme-hint">
            {`Autosaves every ${app.autosaveSeconds}s; the next sync pushes it.`}
          </span>
        </div>
      </header>
      {(app.assignments || tab.done || tab.dated) && (
        <div className="props">
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
          {tab.done && (
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
          {tab.calendar && googleCalendar && (
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
        placeholder={`Write this ${tab.noun} in Markdown…`}
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
): Promise<void> {
  // A notebook entry is an observation or a decision
  // (specs/app/engineering-notebook.feature.md), so its dialog asks which
  // before it asks anything else; the folder is flat, so it says nothing
  // about subfolders. Every other page tab keeps the plain name prompt.
  const result = await promptWithChoice({
    title: tab.dated ? "New entry" : `New ${tab.noun}`,
    hint: tab.dated
      ? "Today's date goes in front of the file name, so the notebook reads in order."
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
  const input = result?.text;
  if (!input) return;
  const res = await fetch(`/api/${tab.folder}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: input, ...(result?.choice ? { kind: result.choice } : {}) }),
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
 * Copy link, Delete.
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
  const { pages, supersededBy } = usePages(store);
  /** A row's ⋯ menu (file name), if open. */
  const [menu, setMenu] = useState<string | null>(null);

  /** Rename a page (its `# heading`), saved through the page's document. */
  const renamePage = async (page: PageListing) => {
    const name = await app.prompt({
      title: `Rename ${tab.noun}`,
      initial: page.name,
      confirmLabel: "Rename",
    });
    if (!name || name.trim() === page.name) return;
    // What the open editor holds lands first, so the rename reads it.
    const open = openPage();
    if (open?.fileName === page.fileName) await open.flush();
    const url = `/api/${tab.folder}/${encodeURIComponent(page.fileName)}`;
    const res = await fetch(url);
    const data = (await res.json().catch(() => ({}))) as { content?: string; error?: string };
    if (!res.ok || typeof data.content !== "string") {
      toast.error(data.error ?? `Could not read the ${tab.noun}`);
      return;
    }
    const next = serializePage({ ...parsePage(data.content), name: name.trim() });
    const put = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: next }),
    });
    const saved = (await put.json().catch(() => ({}))) as { error?: string };
    if (!put.ok) {
      toast.error(saved.error ?? `Could not rename the ${tab.noun}`);
      return;
    }
    toast.success(`Renamed to “${name.trim()}” — saved locally.`);
    await store.load();
    const still = openPage();
    if (still?.fileName === page.fileName) await still.reload();
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

  return (
    <div
      className="side-panel page-list"
      role="tabpanel"
      id={`side-panel-${tab.folder}`}
      aria-labelledby={`side-tab-${tab.folder}`}
    >
      <div className="sidebar-actions">
        <button onClick={() => void newPageFlow(tab, store, app.promptWithChoice, navigate)}>
          + New {tab.noun}
        </button>
      </div>
      <div className="page-rows">
        {(tab.dated ? entryGroups : pageGroups)(pages).map(({ dir, pages: group }) => (
          <div key={dir || "."}>
            {dir && <div className="page-group">{dir}</div>}
            {group.map((page) => {
              const replaced = tab.dated ? supersededBy[page.fileName] : undefined;
              const here = page.fileName === active;
              return (
                <div
                  key={page.fileName}
                  className={`page-row${dir && !tab.dated ? " nested" : ""}${tab.dated ? " entry-row" : ""}${replaced ? " superseded" : ""}`}
                >
                  <a
                    href={pageLink(page.fileName)}
                    className={`page-entry${here ? " active" : ""}${page.done ? " done" : ""}`}
                    title={
                      replaced
                        ? `${pageRowTitle(page)} — superseded by ${replaced.name}`
                        : pageRowTitle(page)
                    }
                    aria-current={here ? "page" : undefined}
                    onClick={(e) =>
                      spaClick(e, () => navigate({ fileName: page.fileName }, { push: true }))
                    }
                  >
                    {page.name}
                    {/* An entry's row carries what makes it an entry: its
                        kind, who signed it and the day. */}
                    {tab.dated && (
                      <span className="entry-meta">
                        <EntryKindChip kind={entryKindOf(page)} />
                        {page.author && <span className="entry-author">{page.author}</span>}
                        {page.date && <span className="entry-day">{dayOf(page.date)}</span>}
                      </span>
                    )}
                  </a>
                  <span className="tree-row-menu">
                    <Tooltip label="More actions">
                      <button
                        type="button"
                        className="tree-menu-btn"
                        aria-label={`Menu for ${page.name}`}
                        aria-haspopup="menu"
                        aria-expanded={menu === page.fileName}
                        onClick={() => setMenu((m) => (m === page.fileName ? null : page.fileName))}
                      >
                        <Ellipsis size={14} aria-hidden="true" />
                      </button>
                    </Tooltip>
                    <Menu
                      open={menu === page.fileName}
                      onClose={() => setMenu(null)}
                      label={`Menu for ${page.name}`}
                      className="tree-menu"
                      containerSelector=".tree-row-menu"
                      items={[
                        {
                          id: "rename",
                          label: "Rename",
                          icon: <Pencil size={13} />,
                          onSelect: () => void renamePage(page),
                        },
                        {
                          id: "copy",
                          label: "Copy link",
                          icon: <Link size={13} />,
                          onSelect: () => app.copyLink(pageLink(page.fileName)),
                        },
                        {
                          id: "delete",
                          label: "Delete",
                          icon: <Trash2 size={13} />,
                          danger: true,
                          onSelect: () => void removePage(page),
                        },
                      ]}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {pages.length === 0 && <p className="empty">{tab.empty}</p>}
      </div>
    </div>
  );
}

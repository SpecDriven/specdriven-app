// The Files tab's sidebar (specs/app/code-repo-mode.feature.md "The
// navigation pane lists the repository's files"): the open code
// repository as a tree, folders first, each opened and closed in place,
// `.git` and what the repository ignores left out by the server. Rows are
// the sidebar's one row shape (src/frontend/SidebarRow.tsx), indented by
// depth; ↑/↓ walk them and →/← open and close a folder.

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDownToLine, ChevronDown, ChevronRight, File, Folder, FolderOpen, RefreshCw, Search } from "lucide-react";
import { toast } from "../Toasts";
import { SectionAction, SidebarSection } from "../SidebarSection";
import { SidebarRow } from "../SidebarRow";
import { listKeyDown, useRevealActive } from "../sidebarList";
import { files, pulledMessage, type FilesState, type FilesStore } from "./filesStore";
import { FilesSearchField, FilesSearchResults, spaClick, type Navigate } from "./FilesSearch";
import { fileSearch } from "./searchStore";
import { filesPath, FILES_HOME, type FilesView } from "./route";

/** The rows of one folder and, under each open folder, its own — depth first. */
export function treeRows(
  state: FilesState,
  active: string | null,
  store: Pick<FilesStore, "toggle">,
  navigate: Navigate,
  path = "",
  depth = 0,
): ReactNode[] {
  const listing = state.dirs[path];
  const indent = { paddingLeft: `${0.6 + depth * 0.9}rem` };
  if (!listing) {
    return path === "" ? [<p key="loading" className="empty">Loading…</p>] : [];
  }
  if ("error" in listing) {
    return [
      <p key={`error:${path}`} className="error empty" style={indent}>
        {listing.error}
      </p>,
    ];
  }
  if (path === "" && listing.entries.length === 0) return [<p key="empty" className="empty">No files</p>];
  const rows: ReactNode[] = [];
  for (const entry of listing.entries) {
    if (entry.kind === "dir") {
      const open = state.expanded.includes(entry.path);
      rows.push(
        <SidebarRow
          key={entry.path}
          href="#"
          active={false}
          level={depth + 1}
          title={entry.path}
          className="files-row files-dir"
          linkProps={{ style: indent, "aria-expanded": open, "data-dir": entry.path } as never}
          leading={
            <>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {open ? <FolderOpen size={14} /> : <Folder size={14} />}
            </>
          }
          label={entry.name}
          onOpen={(e) => {
            e.preventDefault();
            void store.toggle(entry.path);
          }}
        />,
      );
      if (open) rows.push(...treeRows(state, active, store, navigate, entry.path, depth + 1));
    } else {
      rows.push(
        <SidebarRow
          key={entry.path}
          href={filesPath({ path: entry.path })}
          active={entry.path === active}
          level={depth + 1}
          title={entry.link ? `${entry.path} (a link)` : entry.path}
          className="files-row files-file"
          linkProps={{ style: indent }}
          leading={
            <>
              <span className="files-twisty-spacer" />
              <File size={14} />
            </>
          }
          label={entry.name}
          onOpen={(e) => spaClick(e, () => navigate({ path: entry.path }, { push: true }))}
        />,
      );
    }
  }
  return rows;
}

/** →/← open and close the focused folder; everything else is the list's own keyboard. */
export function filesKeyDown(e: KeyboardEvent<HTMLElement>, store: Pick<FilesStore, "toggle" | "getState">): void {
  const t = e.target;
  if (t instanceof HTMLElement && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    const dir = t.dataset.dir;
    if (dir !== undefined) {
      const open = store.getState().expanded.includes(dir);
      if ((e.key === "ArrowRight") !== open) {
        e.preventDefault();
        void store.toggle(dir);
        return;
      }
    }
  }
  listKeyDown(e);
}

export function FilesSidebar({ view, navigate }: { view: FilesView | null; navigate: Navigate }) {
  const state = useSyncExternalStore(files.subscribe, files.getState, files.getState);
  const search = useSyncExternalStore(fileSearch.subscribe, fileSearch.getState, fileSearch.getState);
  const listRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const active = view?.path ?? state.open?.path ?? null;
  // The results take the tree's place while something is typed
  // (specs/app/code-search.feature.md "Find text in the repository").
  const searching = search.open && search.query !== "";
  useRevealActive(listRef, active);
  const [pulling, setPulling] = useState(false);
  // Git Pull (specs/app/code-repo-mode.feature.md "Git Pull from the
  // navigation pane"): the one pull the app makes in a code repository,
  // because the user asked for it.
  const pull = async () => {
    setPulling(true);
    try {
      const result = await files.pull();
      if (result.ok) toast.success(pulledMessage(result));
      else toast.error(result.message);
    } finally {
      setPulling(false);
    }
  };
  // Coming back to the window: an agent or the IDE may have added, removed
  // or changed files since.
  useEffect(() => {
    const onFocus = () => {
      void files.refresh();
      void files.recheck();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return (
    <div className="side-panel page-list files-panel" role="tabpanel" id="side-panel-files" aria-labelledby="side-tab-files">
      <SidebarSection
        label={
          <a href="/" className={view?.path === null ? "active" : undefined} onClick={(e) => spaClick(e, () => navigate(FILES_HOME, { push: true }))}>
            Files
          </a>
        }
        actions={
          <>
            <SectionAction
              label="Search in files"
              keys="mod+shift+f"
              icon={<Search size={14} />}
              className={search.open ? "active" : undefined}
              onClick={() => (search.open ? fileSearch.hide() : fileSearch.show())}
            />
            <SectionAction
              label={pulling ? "Pulling…" : "Git Pull"}
              icon={<ArrowDownToLine size={14} />}
              disabled={pulling}
              onClick={() => void pull()}
            />
            <SectionAction
              label="Refresh the file list"
              icon={<RefreshCw size={14} />}
              onClick={() => {
                void files.refresh();
                void files.recheck();
              }}
            />
          </>
        }
      >
        {search.open && (
          <FilesSearchField
            onDown={() => resultsRef.current?.querySelector<HTMLElement>("[role=treeitem]")?.focus()}
          />
        )}
      </SidebarSection>
      {searching ? (
        <FilesSearchResults active={active} navigate={navigate} listRef={resultsRef} />
      ) : (
        <div
          className="page-rows files-tree"
          role="tree"
          aria-label="Files"
          ref={listRef}
          onKeyDown={(e) => filesKeyDown(e, files)}
        >
          {treeRows(state, active, files, navigate)}
        </div>
      )}
    </div>
  );
}

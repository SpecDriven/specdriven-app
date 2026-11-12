// The Files tab's search (specs/app/code-search.feature.md "Find text in the
// repository", "A result opens the file at its line"): a field with three
// switches — match case, whole word, regular expression — over the results,
// which take the tree's place while there is something typed. Esc in the
// field, or the head's search button again, puts the search away. A file's row
// leads its matches; each match shows its line number and the line, the
// match marked. Rows are the sidebar's one row shape, so ↑/↓ walk them.

import { useEffect, useRef, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { CaseSensitive, File, Regex, Search, WholeWord } from "lucide-react";
import type { FileMatches, LineMatch } from "../../server/codeSearch";
import { SidebarRow } from "../SidebarRow";
import { listKeyDown } from "../sidebarList";
import { Tooltip } from "../Tooltip";
import { files, type FilesStore } from "./filesStore";
import { baseName, filesPath, type FilesView } from "./route";
import { fileSearch, searchStatus, type SearchStore, type SearchSwitch } from "./searchStore";

export type Navigate = (view: FilesView, opts?: { push?: boolean }) => void;

/** Handle a link in-app on a plain click; modified clicks keep the browser's. */
export function spaClick(e: MouseEvent, go: () => void) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go();
}

/** A result's line with its match marked. */
function markedLine(match: LineMatch): ReactNode {
  return (
    <>
      {match.text.slice(0, match.start)}
      <mark>{match.text.slice(match.start, match.end)}</mark>
      {match.text.slice(match.end)}
    </>
  );
}

/** The folders a file sits in, for the quiet text after its name. */
function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** The rows of the results: each file, then its matches. */
export function resultRows(
  found: FileMatches[],
  active: string | null,
  store: Pick<FilesStore, "goTo">,
  navigate: Navigate,
): ReactNode[] {
  const rows: ReactNode[] = [];
  const open = (path: string, match: LineMatch) => {
    store.goTo(path, match.line, match.col, match.length);
    navigate({ path }, { push: true });
  };
  for (const file of found) {
    const href = filesPath({ path: file.path });
    const folder = folderOf(file.path);
    rows.push(
      <SidebarRow
        key={file.path}
        href={href}
        active={file.path === active}
        level={1}
        title={file.path}
        className="files-row files-hit-file"
        leading={<File size={14} />}
        label={
          <>
            {baseName(file.path)}
            {folder && <span className="files-hit-folder"> {folder}</span>}
          </>
        }
        trailing={`${file.matches.length}${file.more ? "+" : ""}`}
        onOpen={(e) => spaClick(e, () => open(file.path, file.matches[0]!))}
      />,
    );
    for (const match of file.matches) {
      rows.push(
        <SidebarRow
          key={`${file.path}:${match.line}:${match.col}`}
          href={href}
          active={false}
          level={2}
          title={`${file.path}, line ${match.line}`}
          className="files-row files-hit"
          leading={<span className="files-hit-line">{match.line}</span>}
          label={markedLine(match)}
          onOpen={(e) => spaClick(e, () => open(file.path, match))}
        />,
      );
    }
  }
  return rows;
}

const SWITCHES: { which: SearchSwitch; label: string; icon: ReactNode }[] = [
  { which: "caseSensitive", label: "Match case", icon: <CaseSensitive size={14} /> },
  { which: "wholeWord", label: "Match whole words", icon: <WholeWord size={14} /> },
  { which: "regex", label: "Use a regular expression", icon: <Regex size={14} /> },
];

/** The field and its switches, under the section head. */
export function FilesSearchField({ store = fileSearch, onDown }: { store?: SearchStore; onDown?: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [state.focus]);
  const status = searchStatus(state);
  return (
    <div className="files-search">
      <div className="files-search-field">
        <Search size={12} aria-hidden="true" />
        <input
          ref={input}
          type="text"
          role="searchbox"
          aria-label="Search in files"
          placeholder="Search in files"
          spellCheck={false}
          autoComplete="off"
          value={state.query}
          onChange={(e) => store.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void store.run();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              store.hide();
            } else if (e.key === "ArrowDown" && onDown) {
              e.preventDefault();
              onDown();
            }
          }}
        />
        {SWITCHES.map(({ which, label, icon }) => (
          <Tooltip key={which} label={label}>
            <button
              type="button"
              className={`ibtn files-search-switch${state[which] ? " active" : ""}`}
              aria-label={label}
              aria-pressed={state[which]}
              onClick={() => store.toggle(which)}
            >
              {icon}
            </button>
          </Tooltip>
        ))}
      </div>
      {status && (
        <p className={`files-search-status${state.status === "error" ? " error" : ""}`} role="status">
          {status}
        </p>
      )}
    </div>
  );
}

/** The results, in the tree's place. */
export function FilesSearchResults({
  active,
  navigate,
  store = fileSearch,
  listRef,
}: {
  active: string | null;
  navigate: Navigate;
  store?: SearchStore;
  listRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return (
    <div className="page-rows files-tree files-results" role="tree" aria-label="Search results" ref={listRef} onKeyDown={listKeyDown}>
      {resultRows(state.files, active, files, navigate)}
    </div>
  );
}

// The plain text editor of the Files tab (specs/app/code-repo-mode.feature
// .md "A file opens in a plain text editor"): CodeMirror with line numbers,
// undo, Tab indenting and ⌘S — no Markdown toolbar, no styled spans, no
// link marks (src/frontend/SourceEditor.tsx is the Markdown one). A file in
// a language codeLanguage.ts knows is highlighted as that language; every
// other file is plain text. Vim's keys follow the Settings switch, as in the
// Markdown editor's Vim tab.

import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { languageOf, loadLanguage } from "./codeLanguage";
import type { GoTo } from "./filesStore";

type VimModule = typeof import("@replit/codemirror-vim");

/**
 * Show a place in the text (specs/app/code-search.feature.md "A result opens
 * the file at its line"): the match selected, its line in the middle of the
 * editor. A line past the end is the last line. The focus stays where it
 * is, so the result list keeps its arrow keys.
 */
function showPlace(view: EditorView, place: Pick<GoTo, "line" | "col" | "length">): void {
  const doc = view.state.doc;
  const line = doc.line(Math.max(1, Math.min(doc.lines, Math.floor(place.line) || 1)));
  const anchor = Math.min(line.from + Math.max(0, place.col - 1), line.to);
  const head = Math.min(anchor + Math.max(0, place.length), line.to);
  view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
}

/** The smallest change that turns `from` into `to`, so the caret keeps its place. */
function minimalChange(from: string, to: string) {
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;
  let end = 0;
  while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

export function CodeEditor({
  path,
  value,
  onChange,
  onSave,
  onCaretLine,
  goto = null,
  onWentTo,
  vim = false,
}: {
  /** The file's path: a new file is a new editor, with its own undo history. */
  path: string;
  value: string;
  onChange: (text: string) => void;
  /** ⌘S (Ctrl+S elsewhere). */
  onSave: () => void;
  /** The 1-based line the caret is on, as it moves. */
  onCaretLine?: (line: number) => void;
  /** A place to show: a search result's line. */
  goto?: GoTo | null;
  /** The editor showed it. */
  onWentTo?: (seq: number) => void;
  vim?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [vimModule, setVimModule] = useState<VimModule | null>(null);
  useEffect(() => {
    if (!vim || vimModule) return;
    let live = true;
    void import("@replit/codemirror-vim").then((m) => {
      if (live) setVimModule(m);
    });
    return () => {
      live = false;
    };
  }, [vim, vimModule]);
  const vimReady = vim ? vimModule : null;
  const latest = useRef({ onChange, onSave, onCaretLine, onWentTo, goto });
  latest.current = { onChange, onSave, onCaretLine, onWentTo, goto };
  // The last request answered: the editor's own start and the request's
  // arrival both look, and a request is answered once.
  const went = useRef(0);
  const go = (v: EditorView, place: GoTo) => {
    if (went.current === place.seq) return;
    went.current = place.seq;
    showPlace(v, place);
    latest.current.onWentTo?.(place.seq);
  };

  useEffect(() => {
    const parent = host.current;
    if (!parent || (vim && !vimReady)) return;
    // Empty until the file's grammar has loaded; the text shows meanwhile.
    const grammar = new Compartment();
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          // First, so Vim sees every key before the editing keymaps do.
          vimReady ? vimReady.vim({ status: true }) : [],
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          grammar.of([]),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                latest.current.onSave();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
            if (u.docChanged || u.selectionSet) {
              latest.current.onCaretLine?.(u.state.doc.lineAt(u.state.selection.main.head).number);
            }
          }),
        ],
      }),
    });
    view.current = v;
    // A place asked for before the file was here: a result in another file.
    if (latest.current.goto) go(v, latest.current.goto);
    const language = languageOf(path, value);
    parent.dataset.language = language ?? "text";
    if (language) {
      void loadLanguage(language, path).then((extension) => {
        // The editor may be gone by now: another file, or the pane closed.
        if (view.current === v) v.dispatch({ effects: grammar.reconfigure(extension) });
      });
    }
    return () => {
      v.destroy();
      view.current = null;
    };
    // The text is synced below; a new file or a Vim switch makes a new editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, vim, vimReady]);

  // Controlled value: the file read again from disk lands as the smallest change.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: minimalChange(current, value) });
  }, [value]);

  // A place asked for in the file already showing.
  const gotoSeq = goto?.seq;
  useEffect(() => {
    if (view.current && goto) go(view.current, goto);
    // The request is its `seq`; the object changes with every store update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoSeq]);

  if (vim && !vimReady) return <div className="md-source code-source md-vim-loading">Loading Vim…</div>;
  return (
    <div
      ref={host}
      className={`md-source code-source${vim ? " md-vim" : ""}`}
      data-path={path}
      // Esc is how Vim leaves insert mode: it stays in the editor.
      onKeyDown={(e) => {
        if (e.key === "Escape" && vim) e.stopPropagation();
      }}
    />
  );
}

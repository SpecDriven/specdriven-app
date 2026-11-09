// The plain text editor of the Files tab (specs/app/code-repo-mode.feature
// .md "A file opens in a plain text editor"): CodeMirror with line numbers,
// undo, Tab indenting and ⌘S — no Markdown toolbar, no styled spans, no
// link marks (src/frontend/SourceEditor.tsx is the Markdown one). A `.md`
// file gets Markdown's highlighting; every other file is plain text. Vim's
// keys follow the Settings switch, as in the Markdown editor's Vim tab.

import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

type VimModule = typeof import("@replit/codemirror-vim");

/** The smallest change that turns `from` into `to`, so the caret keeps its place. */
function minimalChange(from: string, to: string) {
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;
  let end = 0;
  while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

/** Whether a file gets Markdown's highlighting. */
export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export function CodeEditor({
  path,
  value,
  onChange,
  onSave,
  onCaretLine,
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
  const latest = useRef({ onChange, onSave, onCaretLine });
  latest.current = { onChange, onSave, onCaretLine };

  useEffect(() => {
    const parent = host.current;
    if (!parent || (vim && !vimReady)) return;
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
          isMarkdownFile(path) ? markdown() : [],
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

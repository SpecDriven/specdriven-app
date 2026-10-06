import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  keymap,
  placeholder as placeholderExt,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
import { autocompletion, closeCompletion, startCompletion } from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { atQuery, filterChoices } from "./entityFields";
import type { FieldChoice } from "./entityFields";
import { termsPattern } from "./highlight";
import { isOpenLinkClick, webLinkAt, webLinks } from "./weblinks";

// Vim mode (specs/ui.spec.md "Settings"): the Markdown editor's Vim tab is a
// CodeMirror 6 editor running the Replit vim extension — modal editing with
// Vim's keys, a status line showing the mode and taking `:` commands. It
// stands in for the Write tab's textarea: same value, same onChange, same
// toolbar, and the same shortcuts for bold, italic and links.

/**
 * What the toolbar needs from either pane: the text with the selection in
 * it, and a way to put the selection back after an edit.
 */
export interface TextSurface {
  focus(): void;
  get(): { text: string; start: number; end: number };
  select(start: number, end: number): void;
}

interface VimEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Search terms to mark in the text (specs/search.feature.md). */
  highlight?: string[] | null;
  /** Image files pasted into the editor (specs/images.spec.md). */
  onPasteFiles?: (files: File[]) => void;
  /** The formatting shortcuts (⌘B, ⌘I, ⌘K): the same handler the textarea uses. */
  onShortcut?: (e: ReactKeyboardEvent<HTMLElement> | KeyboardEvent) => void;
  /**
   * The caret moved — the textarea's onSelect, for a toolbar that acts on
   * what is under it (src/frontend/MarkdownEditor.tsx, the diagram button).
   */
  onCaretMove?: (offset: number) => void;
  /**
   * The entity fields Tab completes after an `@` in insert mode
   * (specs/editor/data-model-integration-in-editor.feature.md).
   */
  completions?: FieldChoice[];
  /**
   * A web link ⌘-clicked in the text (specs/editor/common-editor.feature.md
   * "web links are clickable"): the Write tab's gesture, here too.
   */
  onOpenLink?: (url: string) => void;
}

// Markdown syntax, in the app's own colours (index.css): headings and links
// take the accent, the marks around them recede.
const markdownStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700", color: "var(--accent-strong)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--text-2)" },
  { tag: tags.monospace, background: "var(--code-bg)", borderRadius: "2px" },
  { tag: tags.quote, color: "var(--text-2)" },
  { tag: tags.processingInstruction, color: "var(--text-3)" },
  { tag: tags.contentSeparator, color: "var(--text-3)" },
]);

/** Marks every occurrence of the terms in the visible text. */
function highlightTerms(terms: string[]) {
  const re = termsPattern(terms);
  const mark = Decoration.mark({ class: "md-vim-mark" });
  const build = (view: EditorView): DecorationSet => {
    if (!re) return Decoration.none;
    const ranges: { from: number; to: number }[] = [];
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m[0].length === 0) break;
        ranges.push({ from: from + m.index, to: from + m.index + m[0].length });
      }
    }
    return Decoration.set(ranges.map((r) => mark.range(r.from, r.to)));
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * Underlines the web links in the visible text, so a url reads as something
 * ⌘-click opens (specs/editor/common-editor.feature.md). Found line by line
 * with the finder the Write and Preview tabs use, so all three agree.
 */
const webLinkMarks = (() => {
  const mark = Decoration.mark({ class: "md-vim-link" });
  const build = (view: EditorView): DecorationSet => {
    const ranges: { from: number; to: number }[] = [];
    const { doc } = view.state;
    for (const { from, to } of view.visibleRanges) {
      for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
        const line = doc.line(n);
        for (const link of webLinks(line.text))
          ranges.push({ from: line.from + link.start, to: line.from + link.end });
      }
    }
    return Decoration.set(ranges.map((r) => mark.range(r.from, r.to)));
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
})();

/** The smallest replacement turning `from` into `to`, so the caret stays put. */
function minimalChange(from: string, to: string) {
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;
  let end = 0;
  while (
    end < from.length - start &&
    end < to.length - start &&
    from[from.length - 1 - end] === to[to.length - 1 - end]
  )
    end++;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

export const VimEditor = forwardRef<TextSurface, VimEditorProps>(function VimEditor(
  {
    value,
    onChange,
    placeholder,
    highlight,
    onPasteFiles,
    onShortcut,
    onCaretMove,
    completions,
    onOpenLink,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The callbacks change every render; the extensions read the latest ones.
  const latest = useRef({ onChange, onPasteFiles, onShortcut, onCaretMove, completions, onOpenLink });
  latest.current = { onChange, onPasteFiles, onShortcut, onCaretMove, completions, onOpenLink };
  const terms = highlight && highlight.length > 0 ? highlight : null;
  const termsKey = terms?.join(" ") ?? "";

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    get: () => {
      const v = view.current;
      if (!v) return { text: value, start: 0, end: 0 };
      const { from, to } = v.state.selection.main;
      return { text: v.state.doc.toString(), start: from, end: to };
    },
    select: (start, end) => {
      const v = view.current;
      if (!v) return;
      const len = v.state.doc.length;
      v.dispatch({
        selection: { anchor: Math.min(start, len), head: Math.min(end, len) },
        scrollIntoView: true,
      });
    },
  }));

  // Entity-field completion (specs/editor/data-model-integration-in-editor
  // .feature.md), in insert mode only: Tab at the end of an `@…` run opens
  // CodeMirror's completion list over the fields, which narrows as the
  // user types and takes Enter or the arrows. Any other Tab, and Tab in
  // normal mode, is left to whoever handles it next. Vim swallows the Esc
  // that leaves insert mode, but the cursor step it makes closes the list;
  // leaving at column 0 makes no step, so the update listener below
  // closes it then.
  const startFieldCompletion = (v: EditorView): boolean => {
    if (!getCM(v)?.state.vim?.insertMode) return false;
    const { from, to } = v.state.selection.main;
    if (from !== to || !latest.current.completions?.length) return false;
    const line = v.state.doc.lineAt(to);
    if (!atQuery(line.text, to - line.from)) return false;
    return startCompletion(v);
  };
  // The list is ranked here, not by CodeMirror's fuzzy matcher, so both
  // tabs agree: fields starting with what was typed come first. Each
  // keystroke asks again through `update` — the `@` run is short and the
  // list small, so a fresh answer costs nothing.
  const fieldResult = (state: EditorState, pos: number): CompletionResult | null => {
    const line = state.doc.lineAt(pos);
    const at = atQuery(line.text, pos - line.from);
    if (!at) return null;
    return {
      from: line.from + at.start,
      options: filterChoices(latest.current.completions ?? [], at.query).map((c) => ({
        label: c.label,
        detail: c.entity,
        info: c.file,
      })),
      filter: false,
      update: (_result, _from, _to, ctx) => fieldResult(ctx.state, ctx.pos),
    };
  };
  const fieldSource = (ctx: CompletionContext): CompletionResult | null =>
    fieldResult(ctx.state, ctx.pos);

  // One editor per set of search terms: the marks are baked into the
  // extensions, and a new set arrives only with a new hit, never by typing.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          // First, so Vim sees every key before the editing keymaps do.
          vim({ status: true }),
          // ⌘B, ⌘I, ⌘K — after vim, so Ctrl-b still pages back in normal mode.
          EditorView.domEventHandlers({
            keydown: (e) => {
              if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
              latest.current.onShortcut?.(e);
              return e.defaultPrevented;
            },
          }),
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(markdownStyle),
          placeholder ? placeholderExt(placeholder) : [],
          terms ? highlightTerms(terms) : [],
          webLinkMarks,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          // Nothing else binds Tab, and vim claims no key but Esc and a few
          // Ctrl chords in insert mode, so this is reached at default precedence.
          autocompletion({ override: [fieldSource], activateOnTyping: false, icons: false }),
          keymap.of([{ key: "Tab", run: startFieldCompletion }]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
            if (u.docChanged || u.selectionSet)
              latest.current.onCaretMove?.(u.state.selection.main.head);
            if (u.selectionSet && !u.docChanged && !getCM(u.view)?.state.vim?.insertMode)
              closeCompletion(u.view);
          }),
          EditorView.domEventHandlers({
            // ⌘-click on a web link opens it, before CodeMirror (or Vim)
            // takes the press as a caret move; a plain click still places
            // the caret, so the url can be edited.
            mousedown: (e, v) => {
              if (e.button !== 0 || !isOpenLinkClick(e)) return false;
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos === null) return false;
              const line = v.state.doc.lineAt(pos);
              const link = webLinkAt(line.text, pos - line.from);
              if (!link) return false;
              e.preventDefault();
              latest.current.onOpenLink?.(link.url);
              return true;
            },
            paste: (e) => {
              const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
                f.type.startsWith("image/"),
              );
              if (files.length === 0) return false; // plain text pastes as usual
              e.preventDefault();
              latest.current.onPasteFiles?.(files);
              return true;
            },
          }),
        ],
      }),
    });
    view.current = v;
    // Land on the first mark a third of the way down the pane, as the
    // Write and Preview tabs do (specs/search.feature.md).
    let frame = 0;
    if (terms) {
      const re = termsPattern(terms);
      const m = re?.exec(v.state.doc.toString());
      if (m) {
        frame = requestAnimationFrame(() => {
          v.dispatch({
            effects: EditorView.scrollIntoView(m.index, {
              y: "start",
              yMargin: v.scrollDOM.clientHeight / 3,
            }),
          });
        });
      }
    }
    return () => {
      cancelAnimationFrame(frame);
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termsKey, placeholder]);

  // Controlled value: an edit made elsewhere (the scenario table widget, the
  // toolbar) lands as the smallest change, so the caret keeps its place.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === value) return;
    v.dispatch({ changes: minimalChange(current, value) });
  }, [value]);

  return (
    <div
      ref={host}
      className="md-vim"
      // Esc is how Vim leaves insert mode, and a habit in normal mode too:
      // it stays in the editor rather than closing the dialog around it
      // (the app's Escape shortcut, src/frontend/App.tsx).
      onKeyDown={(e) => {
        if (e.key === "Escape") e.stopPropagation();
      }}
    />
  );
});

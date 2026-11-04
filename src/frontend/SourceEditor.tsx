import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  keymap,
  placeholder as placeholderExt,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { autocompletion, closeCompletion, startCompletion } from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { atQuery, filterChoices } from "./entityFields";
import type { FieldChoice } from "./entityFields";
import { termsPattern } from "./highlight";
import { styledSpans } from "./markdown";
import { spanStyleDeclarations } from "./markdownSyntax";
import { isOpenLinkClick, webLinkAt, webLinks } from "./weblinks";
import { spellCheckContentAttributes, useSpellCheck } from "./spellCheckPref";

// The Markdown editor's source pane (specs/editor/common-editor.feature.md):
// a CodeMirror 6 editor behind the Write tab and, with Vim mode on in
// Settings (specs/ui/ui.feature.md), the Vim tab — the same editor running
// the Replit vim extension, modal editing with Vim's keys and a status line
// showing the mode and taking `:` commands. Both hold the same value, call
// the same onChange, take the same toolbar and shortcuts, keep an undo
// history (⌘Z, ⇧⌘Z), and show colored and highlighted text as it will read
// rather than as the span tags that carry it.

/**
 * What the toolbar needs from the pane: the text with the selection in it,
 * a way to put the selection back after an edit, and the history.
 */
export interface TextSurface {
  focus(): void;
  get(): { text: string; start: number; end: number };
  select(start: number, end: number): void;
  undo(): void;
  redo(): void;
}

type VimModule = typeof import("@replit/codemirror-vim");

interface SourceEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Vim's keys, status line and modes (the Vim tab). */
  vim?: boolean;
  /** A published body's source: read, never edited. */
  readOnly?: boolean;
  placeholder?: string;
  /** Search terms to mark in the text (specs/search.feature.md). */
  highlight?: string[] | null;
  /** Image files pasted into the editor (specs/images.feature.md). */
  onPasteFiles?: (files: File[]) => void;
  /** The formatting shortcuts (⌘B, ⌘I, ⌘K), handled by the toolbar's owner. */
  onShortcut?: (e: ReactKeyboardEvent<HTMLElement> | KeyboardEvent) => void;
  /**
   * The caret moved — for a toolbar that acts on what is under it
   * (src/frontend/MarkdownEditor.tsx: the link, table and diagram buttons).
   */
  onCaretMove?: (offset: number) => void;
  /**
   * The entity fields Tab completes after an `@`
   * (specs/editor/data-model-integration-in-editor.feature.md).
   */
  completions?: FieldChoice[];
  /**
   * A web link ⌘-clicked in the text (specs/editor/common-editor.feature.md
   * "web links are clickable").
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
  const mark = Decoration.mark({ class: "md-source-mark" });
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
 * with the finder the Preview tab uses, so both agree.
 */
const webLinkMarks = (() => {
  const mark = Decoration.mark({ class: "md-source-link" });
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

/**
 * Colored and highlighted text (specs/editor/common-editor.feature.md "Font
 * color", "Highlight") reads as it will: the text between a styled span's
 * tags is painted in its color and highlight, and the tags themselves are
 * hidden. They show, receding, while the caret is at either end of the span
 * or in a tag — never while it is in the text, where revealing them would
 * shift the word under a click (a double-click would then select the tag
 * that moved in under it). A hidden tag is atomic: the caret steps over it,
 * from the text's edge to the span's, where the tags then show and can be
 * edited like any other markup.
 */
const styledText = (() => {
  const tag = Decoration.mark({ class: "md-source-tag" });
  const hidden = Decoration.replace({});
  const build = (view: EditorView): { decorations: DecorationSet; hidden: DecorationSet } => {
    const ranges: Range<Decoration>[] = [];
    const atomic: Range<Decoration>[] = [];
    const { doc } = view.state;
    const sel = view.state.selection.main;
    for (const { from, to } of view.visibleRanges) {
      for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
        const line = doc.line(n);
        for (const span of styledSpans(line.text)) {
          const start = line.from + span.start;
          const end = line.from + span.end;
          const inner = line.from + span.inner;
          const innerEnd = line.from + span.innerEnd;
          const reveal = sel.empty
            ? (sel.from >= start && sel.from < inner) || (sel.from > innerEnd && sel.from <= end)
            : (sel.from < inner && sel.to > start) || (sel.from < end && sel.to > innerEnd);
          const tags = reveal ? tag : hidden;
          ranges.push(tags.range(start, inner));
          const style = spanStyleDeclarations(span.style).join("; ");
          if (style && innerEnd > inner) {
            ranges.push(
              Decoration.mark({ class: "md-source-styled", attributes: { style } }).range(inner, innerEnd),
            );
          }
          ranges.push(tags.range(innerEnd, end));
          if (!reveal) atomic.push(hidden.range(start, inner), hidden.range(innerEnd, end));
        }
      }
    }
    return { decorations: Decoration.set(ranges, true), hidden: Decoration.set(atomic, true) };
  };
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      hidden: DecorationSet;
      constructor(view: EditorView) {
        ({ decorations: this.decorations, hidden: this.hidden } = build(view));
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet)
          ({ decorations: this.decorations, hidden: this.hidden } = build(u.view));
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin, EditorView.atomicRanges.of((view) => view.plugin(plugin)?.hidden ?? Decoration.none)];
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

export const SourceEditor = forwardRef<TextSurface, SourceEditorProps>(function SourceEditor(
  {
    value,
    onChange,
    vim = false,
    readOnly = false,
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
  // The vim extension is loaded the first time a Vim tab is shown, so a
  // bundler that splits can keep it out of the main bundle; the editor
  // itself is part of it, being the Write tab.
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
  // The callbacks change every render; the extensions read the latest ones.
  const latest = useRef({ onChange, onPasteFiles, onShortcut, onCaretMove, completions, onOpenLink, vimReady });
  latest.current = { onChange, onPasteFiles, onShortcut, onCaretMove, completions, onOpenLink, vimReady };
  const terms = highlight && highlight.length > 0 ? highlight : null;
  const termsKey = terms?.join(" ") ?? "";
  // Spell check (src/frontend/spellCheckPref.ts): CodeMirror turns the
  // browser's checker off on its editable element; the pane holds prose,
  // so it follows the Settings switch. A compartment, so a flip reaches an
  // editor that is already open.
  const spellCheck = useSpellCheck();
  const spellCheckConf = useRef(new Compartment());

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
    undo: () => {
      const v = view.current;
      if (!v) return;
      undo(v);
      v.focus();
    },
    redo: () => {
      const v = view.current;
      if (!v) return;
      redo(v);
      v.focus();
    },
  }));

  // Whether the user is typing text: always in the Write tab; in Vim's,
  // only in insert mode.
  const typing = (v: EditorView): boolean => {
    const m = latest.current.vimReady;
    return !m || !!m.getCM(v)?.state.vim?.insertMode;
  };

  // Entity-field completion (specs/editor/data-model-integration-in-editor
  // .feature.md): Tab at the end of an `@…` run opens CodeMirror's
  // completion list over the fields, which narrows as the user types and
  // takes Enter or the arrows. Any other Tab, and Tab in Vim's normal mode,
  // is left to whoever handles it next. Vim swallows the Esc that leaves
  // insert mode, but the cursor step it makes closes the list; leaving at
  // column 0 makes no step, so the update listener below closes it then.
  const startFieldCompletion = (v: EditorView): boolean => {
    if (!typing(v)) return false;
    const { from, to } = v.state.selection.main;
    if (from !== to || !latest.current.completions?.length) return false;
    const line = v.state.doc.lineAt(to);
    if (!atQuery(line.text, to - line.from)) return false;
    return startCompletion(v);
  };
  // The list is ranked here, not by CodeMirror's fuzzy matcher: fields
  // starting with what was typed come first. Each keystroke asks again
  // through `update` — the `@` run is short and the list small, so a fresh
  // answer costs nothing.
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
    if (!parent || (vim && !vimReady)) return;
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          // First, so Vim sees every key before the editing keymaps do.
          vimReady ? vimReady.vim({ status: true }) : [],
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
          readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
          spellCheckConf.current.of(
            EditorView.contentAttributes.of(spellCheckContentAttributes(spellCheck)),
          ),
          markdown(),
          syntaxHighlighting(markdownStyle),
          styledText,
          placeholder ? placeholderExt(placeholder) : [],
          terms ? highlightTerms(terms) : [],
          webLinkMarks,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          // Nothing else binds Tab, and vim claims no key but Esc and a few
          // Ctrl chords in insert mode, so this is reached at default precedence.
          readOnly
            ? []
            : [
                autocompletion({ override: [fieldSource], activateOnTyping: false, icons: false }),
                keymap.of([{ key: "Tab", run: startFieldCompletion }]),
              ],
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
            if (u.docChanged || u.selectionSet)
              latest.current.onCaretMove?.(u.state.selection.main.head);
            if (u.selectionSet && !u.docChanged && !typing(u.view)) closeCompletion(u.view);
          }),
          EditorView.domEventHandlers({
            // ⌘-click on a web link opens it. The press has already put the
            // caret where it landed, as a plain click does so the url can be
            // edited; the link is the one around it.
            click: (e, v) => {
              if (e.button !== 0 || !isOpenLinkClick(e)) return false;
              const { from, to } = v.state.selection.main;
              if (from !== to) return false;
              const line = v.state.doc.lineAt(to);
              const link = webLinkAt(line.text, to - line.from);
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
    // Preview tab does (specs/search.feature.md).
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
  }, [termsKey, placeholder, vim, vimReady, readOnly]);

  useEffect(() => {
    view.current?.dispatch({
      effects: spellCheckConf.current.reconfigure(
        EditorView.contentAttributes.of(spellCheckContentAttributes(spellCheck)),
      ),
    });
  }, [spellCheck]);

  // Controlled value: an edit made elsewhere (the scenario table widget, the
  // toolbar) lands as the smallest change, so the caret keeps its place —
  // and as one step in the history, so ⌘Z takes it back whole.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === value) return;
    v.dispatch({ changes: minimalChange(current, value) });
  }, [value]);

  if (vim && !vimReady) return <div className="md-source md-vim md-vim-loading">Loading Vim…</div>;
  return (
    <div
      ref={host}
      className={vim ? "md-source md-vim" : "md-source"}
      // Esc is how Vim leaves insert mode, and a habit in normal mode too;
      // in the Write tab it is what closes the completion list. Either way
      // it stays in the editor rather than closing the dialog around it
      // (the app's Escape shortcut, src/frontend/App.tsx).
      onKeyDown={(e) => {
        if (e.key === "Escape" && (vim || e.defaultPrevented)) e.stopPropagation();
      }}
    />
  );
});

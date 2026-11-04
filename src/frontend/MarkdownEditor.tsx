import { createPortal } from "react-dom";
import { Suspense, lazy, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ClipboardEvent, KeyboardEvent, MouseEvent, ReactElement, ReactNode, UIEvent } from "react";
import {
  AArrowDown,
  AArrowUp,
  Baseline,
  Bold,
  Code,
  ExternalLink,
  Heading,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  PencilRuler,
  Quote,
  SquarePen,
  Table,
} from "lucide-react";
import { Tooltip } from "./Tooltip";
import { Menu } from "./Menu";
import {
  imageAtOffset,
  imageRefs,
  insertImage,
  insertLink,
  renderMarkdown,
  setImageSrc,
  setColor,
  setImageWidth,
  TEXT_COLORS,
  toggleHeading,
  toggleInline,
  toggleLinePrefix,
} from "./markdown";
import type { Edit } from "./markdown";
import { diagramName, isDiagram, isExcalidrawFile } from "./excalidraw/diagram";
import type { ExcalidrawEdit } from "./excalidraw/ExcalidrawPane";
import { canMarkUp } from "./excalidraw/markup";
import type { MarkupResult } from "./excalidraw/MarkupPane";
import { markNodes, markText } from "./highlight";
import { TableEditContext } from "./MarkdownTable";
import { TableDialog } from "./TableDialog";
import { extractVars, findTables, insertTable, replaceTableBlock, tableAt, withVarColumns } from "./mdtable";
import type { TableBlock } from "./mdtable";
import { ImageSizingContext } from "./MarkdownImage";
import type { ImageSizing } from "./MarkdownImage";
import { useVimMode } from "./vimPref";
import { FONT_SCALES, applyFontScale, stepFontScale, useFontScale } from "./fontSizePref";
import { useSpellCheck } from "./spellCheckPref";
import { atQuery, entityFields, filterChoices, insertChoice, useEntityFields } from "./entityFields";
import type { FieldChoice } from "./entityFields";
import { anchorVisible, measureOffset, placePopup } from "./caretPosition";
import { useExcalidrawEnabled } from "./excalidrawPref";
import type { TextSurface } from "./VimEditor";
import { isOpenLinkClick, openWebLink, webLinkAt } from "./weblinks";

// CodeMirror and the vim extension are only mounted once a Vim tab is shown.
// Loaded lazily so a bundler that splits can keep them out of the main bundle
// (Bun's dev bundle inlines them; a server render shows the fallback).
const VimEditor = lazy(() => import("./VimEditor").then((m) => ({ default: m.VimEditor })));
// Excalidraw (specs/editor/excalidraw-support.feature.md) the same way: the
// pane, and the library with it, load the first time a diagram is drawn.
const ExcalidrawPane = lazy(() =>
  import("./excalidraw/ExcalidrawPane").then((m) => ({ default: m.ExcalidrawPane })),
);
// And the markup pane (specs/image-editor-markup.feature.md), which shares it.
const MarkupPane = lazy(() =>
  import("./excalidraw/MarkupPane").then((m) => ({ default: m.MarkupPane })),
);

/** POST the image to the data repo; resolves to the url for `![...](url)`. */
async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/images", { method: "POST", body: form });
  const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !body.path) throw new Error(body.error ?? "image upload failed");
  return body.path;
}

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Published scenarios are immutable: source is read-only, preview first. */
  readOnly?: boolean;
  placeholder?: string;
  /**
   * Words to mark in the text (specs/search.feature.md): the terms a search
   * hit matched on, when the editor was opened from that hit. Marked in the
   * source and in the preview, and the first one is scrolled into view.
   */
  highlight?: string[];
  /**
   * The tab the editor opens on. Write by default (Vim, with Vim mode on);
   * "preview" for text the user is more likely to read than rewrite — the
   * feature description opens rendered, and Write is a click away.
   */
  initialTab?: "write" | "preview";
  /**
   * The text's {var} variables each own a table column (specs/editor/
   * table-editor.feature.md "variable creates a column"): the scenario body,
   * where a variable names an example column. Elsewhere tables and text
   * are unrelated.
   */
  tableVariables?: boolean;
}

type Tab = "write" | "vim" | "preview";

/**
 * Embedded markdown editor for the scenario body
 * (specs/editor/spec-editor.feature.md "Spec editor pane"): a formatting
 * toolbar over a source textarea, with a rendered Preview tab — and, with Vim
 * mode on in Settings, a Vim tab editing the same text with Vim's keys
 * (src/frontend/VimEditor.tsx).
 */
export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  placeholder,
  highlight,
  initialTab,
  tableVariables = false,
}: MarkdownEditorProps) {
  const vimOn = useVimMode();
  const fontScale = useFontScale();
  // Spell check (src/frontend/spellCheckPref.ts): the Write tab holds prose.
  const spellCheck = useSpellCheck();
  const [tab, setTab] = useState<Tab>(
    readOnly || initialTab === "preview" ? "preview" : vimOn ? "vim" : "write",
  );
  // The Settings switch flipping while an editor is open moves it over; a
  // read-only body has nothing to edit, so it never shows the Vim tab.
  useEffect(() => {
    if (readOnly) return;
    if (vimOn && tab === "write") setTab("vim");
    if (!vimOn && tab === "vim") setTab("write");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vimOn, readOnly]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const vimRef = useRef<TextSurface>(null);
  const editing = tab === "write" || tab === "vim";
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Excalidraw (specs/editor/excalidraw-support.feature.md): with the Settings
  // switch on, a toolbar button opens the pane over this editor; its export
  // comes back as a file and goes through the image upload like a paste.
  // A diagram already in the text opens the same pane ("Edit Excalidraw
  // diagram") — from its button in the Preview tab, or from the toolbar with
  // the caret in its link — and its export replaces that image instead.
  // A `.excalidraw` file picked with the image button opens it too ("Import
  // Excalidraw file"), loaded with that file, to insert like a new drawing.
  const excalidrawOn = useExcalidrawEnabled();
  const [diagram, setDiagram] = useState<
    | { mode: "new"; file?: File }
    | { mode: "edit"; index: number; edit: ExcalidrawEdit }
    | null
  >(null);
  // Image markup (specs/image-editor-markup.feature.md), behind the same
  // switch: any other stored image opens in the markup pane — from its
  // button in the Preview tab, or from the toolbar with the caret in its
  // link — and the marked-up copy replaces it.
  const [markup, setMarkup] = useState<{ index: number; src: string; alt: string } | null>(null);
  // Where the caret is in the source, so the toolbar's diagram button knows
  // whether it is over a diagram's link. Only followed while the switch is
  // on: nothing else in the toolbar cares where the caret is.
  const [caret, setCaret] = useState(0);
  // The font color menu, opened from its toolbar button. The editor clips
  // what overflows it, so the menu floats over the page from where the
  // button is: under it, or over it where the window has no room below.
  const colorRef = useRef<HTMLSpanElement>(null);
  const [colorMenu, setColorMenu] = useState<{ top: number; right: number; above: boolean } | null>(
    null,
  );
  const toggleColorMenu = () => {
    if (colorMenu) {
      setColorMenu(null);
      return;
    }
    const r = colorRef.current?.getBoundingClientRect();
    if (!r) return;
    const above = r.bottom + 280 > window.innerHeight && r.top > 280;
    setColorMenu({ top: above ? r.top - 4 : r.bottom + 4, right: window.innerWidth - r.right, above });
  };
  // The table dialog (specs/editor/table-editor.feature.md): opened on the
  // table the caret is in, or on one in the preview, to rewrite it — or,
  // with the caret in ordinary text, on a blank grid to insert at the caret.
  const [table, setTable] = useState<{ mode: "new" } | { mode: "edit"; block: TableBlock } | null>(
    null,
  );

  // Entity-field completion (specs/editor/data-model-integration-in-editor
  // .feature.md): Tab at the end of an `@…` run opens a list of the code
  // repo's entity fields, filtered by whatever follows the `@` — typing
  // keeps going into the textarea, the list narrows. `complete` remembers
  // where the run started; the caret leaving it, a tab change, or focus
  // going elsewhere closes the list. The choices load when an editor
  // opens: a read-only body never completes, and never asks.
  const { fields } = useEntityFields();
  useEffect(() => {
    if (!readOnly) void entityFields.load();
  }, [readOnly]);
  const [complete, setComplete] = useState<{ start: number } | null>(null);
  const [completeIndex, setCompleteIndex] = useState(0);
  const run = complete && tab === "write" && !readOnly ? atQuery(value, caret) : null;
  const active = run && complete && run.start === complete.start ? run : null;
  const items = active ? filterChoices(fields, active.query) : [];
  const popup = active !== null && items.length > 0;
  const listId = useId();
  useEffect(() => setCompleteIndex(0), [active?.query]);
  useEffect(() => {
    setComplete(null);
    setColorMenu(null);
  }, [tab]);

  // The list opens next to the `@` it is completing, not in a corner: the
  // `@` is measured in the textarea (src/frontend/caretPosition.ts) and the
  // list placed under it, or above it where the pane has no room below.
  // Measured after layout, so the list's own size is known — until then it
  // stays hidden rather than showing for a frame where it does not belong.
  const listRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; flipped: boolean } | null>(null);
  // Measuring the `@` and placing the list over it. Held in a ref so the
  // scroll handler further down can ask for it again without the two going
  // out of step.
  const remeasure = useRef<() => void>(() => {});
  remeasure.current = () => {
    const ta = ref.current;
    const list = listRef.current;
    const start = complete?.start;
    if (!ta || !list || start === undefined) return;
    const anchor = measureOffset(ta, start);
    if (!anchor) return;
    const pane = { width: ta.clientWidth, height: ta.clientHeight };
    // Scrolled past the `@`, the list has nothing left to point at: it
    // closes rather than following the run off the edge of the pane.
    if (!anchorVisible(anchor, pane)) {
      setComplete(null);
      return;
    }
    setPlace(
      placePopup({
        anchor,
        pane,
        popup: { width: list.offsetWidth, height: list.offsetHeight },
      }),
    );
  };
  // Re-measured whenever the run, the text or the list's length changes —
  // the list narrows as the user types, so its height moves with it.
  const placeKey = popup ? `${complete?.start}:${active?.query}:${items.length}:${value}` : null;
  useLayoutEffect(() => {
    if (!popup) setPlace(null);
    else remeasure.current();
  }, [popup, placeKey]);

  // Search-term marks (specs/search.feature.md). A textarea cannot carry
  // markup, so a mirror of its text sits behind it — same font, padding and
  // wrapping, transparent ink — painting only the marks; the textarea over
  // it is made transparent so they show through. The mirror follows the
  // textarea's scroll and its client width (a scrollbar narrows the text).
  const marks = highlight && highlight.length > 0 ? highlight : null;
  const mirrorRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // Scrolling moves the marks' mirror with the text, and takes the open
  // field list along with the `@` it points at.
  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
    if (popup) remeasure.current();
  };
  useEffect(() => {
    const ta = ref.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      mirror.style.width = `${ta.clientWidth}px`;
      mirror.style.height = `${ta.clientHeight}px`;
      mirror.scrollTop = ta.scrollTop;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(ta);
    return () => ro.disconnect();
  }, [marks !== null, tab]);
  // Land on the first mark: a third of the way down the pane, so the lines
  // around it read too. Once per set of terms and tab, not on every keystroke.
  const marksKey = marks?.join(" ") ?? "";
  useEffect(() => {
    if (!marks) return;
    const pane = tab === "write" ? ref.current : previewRef.current;
    const marked = (tab === "write" ? mirrorRef.current : previewRef.current)?.querySelector("mark");
    if (!pane || !marked) return;
    const top =
      marked.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTop = Math.max(0, top - pane.clientHeight / 3);
    if (mirrorRef.current) mirrorRef.current.scrollTop = pane.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey, tab]);

  // The scenario table widget rewrites the body outside this textarea (e.g.
  // typing "{amount}" appends a table below the caret). A controlled textarea
  // would snap the caret to the end when the committed value differs from
  // what was typed — restore the position recorded at the last keystroke.
  const sel = useRef<{ start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    const ta = ref.current;
    const s = sel.current;
    if (!ta || !s || document.activeElement !== ta) return;
    if (ta.selectionStart !== s.start || ta.selectionEnd !== s.end)
      ta.setSelectionRange(s.start, s.end);
  }, [value]);

  // The pane being edited, seen the same way whichever it is: the toolbar
  // and shortcuts read the selection from it and put it back after an edit.
  const surface = (): TextSurface | null => {
    if (tab === "vim") return vimRef.current;
    const ta = ref.current;
    if (!ta) return null;
    return {
      focus: () => ta.focus(),
      get: () => ({ text: ta.value, start: ta.selectionStart, end: ta.selectionEnd }),
      select: (start, end) => ta.setSelectionRange(start, end),
    };
  };

  const apply = (edit: (text: string, start: number, end: number) => Edit) => {
    const s = surface();
    if (!s) return;
    const { text, start, end } = s.get();
    const r = edit(text, start, end);
    onChange(r.text);
    // Where the edit left the caret. setSelectionRange does not raise a
    // select event, so the toolbar is told here instead — otherwise it would
    // go on acting on whatever the caret was in before. The layout effect
    // above restores `sel` on commit: told the same place, it agrees with
    // the frame below instead of putting the old caret back for a frame.
    sel.current = { start: r.start, end: r.end };
    setCaret(r.start);
    // Restore focus and selection once React has committed the new value.
    requestAnimationFrame(() => {
      s.focus();
      s.select(r.start, r.end);
    });
  };

  // Images (specs/images.feature.md): pasted or picked files upload to the data
  // repo; each finished upload drops `![alt](/api/images/…)` at the caret.
  const addImages = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setUploadError(null);
    setUploading((n) => n + images.length);
    for (const file of images) {
      try {
        const url = await uploadImage(file);
        const alt = file.name.replace(/\.[^.]*$/, "") || "image";
        apply((t, s, e) => insertImage(t, s, e, alt, url));
      } catch (e) {
        setUploadError((e as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  // Image sizing (src/frontend/MarkdownImage.tsx): the handle on an image in
  // the Preview tab writes its width into the source, through onChange like
  // any other edit. One sizing object for the editor's life, reading the
  // latest text and callback through a ref. A double-click on an image
  // already at its natural size changes nothing, and says nothing.
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  // The edited diagram, uploaded like any other image but landing over the
  // one it was opened from rather than at the caret — so the diagram shown
  // in the text is the edited one (specs/editor/excalidraw-support.feature.md
  // "Edit Excalidraw diagram"). A marked-up image the same way, keeping its
  // alt — or, with its markup all gone, pointed back at its original, with
  // nothing to upload (specs/image-editor-markup.feature.md). The image is
  // found again by index at save time, against the text as it stands then.
  const replaceImage = async (index: number, image: File | string, alt: string) => {
    setUploadError(null);
    setUploading((n) => n + 1);
    try {
      const url = typeof image === "string" ? image : await uploadImage(image);
      const { value: text, onChange: change } = latest.current;
      const next = setImageSrc(text, index, url, alt);
      if (next !== text) change(next);
      // The link is a different length now; keep the caret inside it, so the
      // toolbar still offers to edit the diagram (or image) just saved.
      const saved = imageRefs(next.replaceAll("\r\n", "\n"))[index];
      if (saved) setCaret(saved.start);
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading((n) => n - 1);
    }
  };

  // Opening a diagram for editing: the image's own url and name, read from
  // the text as it stands. Through a ref, so the sizing object below stays
  // one for the editor's life while the text moves on.
  const openDiagram = useRef<(index: number) => void>(() => {});
  openDiagram.current = (index) => {
    const ref = imageRefs(latest.current.value.replaceAll("\r\n", "\n"))[index];
    if (!ref) return;
    setDiagram({ mode: "edit", index, edit: { url: ref.src, name: diagramName(ref.alt, ref.src) } });
  };
  // Opening an image for markup, the same way.
  const openMarkup = useRef<(index: number) => void>(() => {});
  openMarkup.current = (index) => {
    const ref = imageRefs(latest.current.value.replaceAll("\r\n", "\n"))[index];
    if (!ref) return;
    setMarkup({ index, src: ref.src, alt: ref.alt });
  };

  // The diagram the caret is in, if it is in one — what the toolbar's
  // diagram button acts on while editing the source (specs/editor/
  // excalidraw-support.feature.md "Edit Excalidraw diagram"). Off the switch
  // there is no such button, so the text is never parsed. Parsing is kept
  // off the caret's own path: the images only move when the text does, and
  // the caret moves on every keystroke.
  // A body with no diagram in it never reaches the parser: the word is in
  // every diagram link, in the alt an insert leaves or the file name, so a
  // substring test rules out the common case for the cost of a scan. The
  // same goes for an image to mark up, which is always a stored one.
  const mayHaveDiagram =
    excalidrawOn &&
    editing &&
    !readOnly &&
    (value.includes("excalidraw") || value.includes("/api/images/"));
  const refs = useMemo(
    () => (mayHaveDiagram ? imageRefs(value.replaceAll("\r\n", "\n")) : []),
    [mayHaveDiagram, value],
  );
  const caretImage = useMemo(
    () => (refs.length === 0 ? null : imageAtOffset(refs, caret)),
    [refs, caret],
  );
  const caretDiagram =
    caretImage && isDiagram(caretImage.ref.alt, caretImage.ref.src) ? caretImage : null;
  const caretMarkup =
    caretImage && canMarkUp(caretImage.ref.alt, caretImage.ref.src) ? caretImage : null;
  const sizing = useMemo<ImageSizing>(
    () => ({
      resize: (index, width) => {
        const { value: text, onChange: change } = latest.current;
        const next = setImageWidth(text, index, width);
        if (next !== text) change(next);
      },
      // Off with the Settings switch, so no diagram (or image) offers the control.
      ...(excalidrawOn
        ? {
            editDiagram: (index: number) => openDiagram.current(index),
            markUp: (index: number) => openMarkup.current(index),
          }
        : {}),
    }),
    [excalidrawOn],
  );

  // What the image button's picker brought: with Excalidraw on, a `.excalidraw`
  // file among them opens the pane on it (one drawing at a time — the pane
  // holds one); the rest upload as images. Off the switch the picker never
  // offers such files, and one picked anyway is not an image, so it is
  // passed over as any other file would be.
  const addPicked = (files: File[]) => {
    const scenes = excalidrawOn ? files.filter((f) => isExcalidrawFile(f.name)) : [];
    const scene = scenes[0];
    if (scene) {
      setUploadError(
        scenes.length > 1 ? `Importing ${scene.name}; one .excalidraw file at a time` : null,
      );
      setDiagram({ mode: "new", file: scene });
    }
    void addImages(files.filter((f) => f !== scene));
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return; // plain text pastes as usual
    e.preventDefault();
    void addImages(files);
  };

  // Picking a field replaces the `@…` run with it, through apply() like any
  // toolbar edit, so the caret lands after it and the toolbar hears.
  const pick = (choice: FieldChoice) => {
    const start = complete?.start;
    if (start === undefined) return;
    apply((t, _s, en) => insertChoice(t, start, en, choice));
    setComplete(null);
  };

  // Web links (specs/editor/common-editor.feature.md "web links are
  // clickable"): a plain click in the source places the caret, as it must
  // for the url to be edited at all, so ⌘-click (Ctrl-click off the Mac)
  // is what opens one — the gesture code editors use. The click has already
  // put the caret where it landed; the link is the one around it.
  const onSourceClick = (e: MouseEvent<HTMLTextAreaElement>) => {
    if (!isOpenLinkClick(e)) return;
    const ta = e.currentTarget;
    if (ta.selectionStart !== ta.selectionEnd) return;
    const link = webLinkAt(ta.value, ta.selectionStart);
    if (!link) return;
    e.preventDefault();
    openWebLink(link.url);
  };
  // The link the caret is in, for the toolbar's Open link button — the
  // same link a ⌘-click there would open, reachable without knowing the
  // gesture, and from the keyboard.
  const caretLink = useMemo(
    () => (editing && !readOnly ? webLinkAt(value.replaceAll("\r\n", "\n"), caret) : null),
    [editing, readOnly, value, caret],
  );

  // The table the caret is in, for the toolbar's table button: edit it, or
  // insert a new one anywhere else. Every table has a pipe, so a text
  // without one is never parsed.
  const tables = useMemo(
    () => (editing && !readOnly && value.includes("|") ? findTables(value) : []),
    [editing, readOnly, value],
  );
  const caretTable = useMemo(
    () => tables.find((t) => caret >= t.start && caret <= t.end) ?? null,
    [tables, caret],
  );
  // Each table in the editable preview carries an Edit button opening the
  // same dialog on it; the index counts the preview's tables, which are the
  // text's in order.
  const tableEditing = useMemo(
    () => ({
      editTable: (index: number) => {
        const block = findTables(latest.current.value)[index];
        if (block) setTable({ mode: "edit", block });
      },
    }),
    [],
  );
  // Apply from the dialog: a new table lands at the caret through apply(),
  // like any toolbar edit; an edited one goes over the block it was opened
  // on, found again in case the text moved under it. Each column a {var}
  // owns is locked in the dialog, and the grid opens with one for each.
  const tableVars = table && tableVariables ? extractVars(value) : [];
  const closeTable = () => setTable(null);
  const applyTable = (next: Parameters<typeof replaceTableBlock>[2]) => {
    const open = table;
    closeTable();
    if (!open) return;
    if (open.mode === "new") {
      if (next) apply((t, s, e) => insertTable(t, s, e, next));
      return;
    }
    const text = latest.current.value;
    const block = tableAt(text, open.block.start) ?? open.block;
    const r = replaceTableBlock(text, block, next);
    latest.current.onChange(r.text);
    if (editing) {
      sel.current = { start: r.start, end: r.end };
      setCaret(r.start);
    }
  };
  const tableWasOpen = useRef(false);
  useEffect(() => {
    if (tableWasOpen.current && !table && editing) surface()?.focus();
    tableWasOpen.current = table !== null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) => {
    if (tab === "write" && !readOnly) {
      if (popup) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const step = e.key === "ArrowDown" ? 1 : items.length - 1;
          setCompleteIndex((i) => (i + step) % items.length);
          return;
        }
        if (e.key === "Tab" || e.key === "Enter") {
          e.preventDefault();
          pick(items[completeIndex] ?? items[0]!);
          return;
        }
        if (e.key === "Escape") {
          // Closes the list, not the pane around it (the app's Escape shortcut).
          e.preventDefault();
          e.stopPropagation();
          setComplete(null);
          return;
        }
      } else if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        // Only at the end of an `@…` run, with something to offer: any
        // other Tab keeps moving focus on (specs/editor/spec-editor.feature.md).
        const ta = ref.current;
        const at =
          ta && ta.selectionStart === ta.selectionEnd ? atQuery(ta.value, ta.selectionStart) : null;
        if (ta && at && fields.length > 0) {
          e.preventDefault();
          setCaret(ta.selectionStart);
          setComplete({ start: at.start });
          return;
        }
      }
    }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "b") {
      e.preventDefault();
      apply((t, s, en) => toggleInline(t, s, en, "**"));
    } else if (k === "i") {
      e.preventDefault();
      apply((t, s, en) => toggleInline(t, s, en, "*"));
    } else if (k === "k") {
      e.preventDefault();
      apply(insertLink);
    }
  };

  // The toolbar (specs/ui/ui.feature.md "Design system"): icon buttons, each
  // with a tooltip naming the action and, where there is one, its shortcut.
  const size = 14;
  type Tool = {
    id?: string;
    icon: ReactElement;
    title: string;
    keys?: string;
    disabled?: boolean;
    run: () => void;
    /** A menu the button opens, rendered beside it while open. */
    menu?: ReactNode;
  };
  // Font size (specs/editor/common-editor.feature.md "Increase and decrease
  // font size"), next to the Heading button. It changes how the text reads,
  // not the text, so it is there on every tab — Preview and a read-only
  // body too — and every editor follows (src/frontend/fontSizePref.ts).
  // No shortcut: ⌘- and ⌘= already zoom the whole window.
  const percent = `${Math.round(fontScale * 100)}%`;
  const fontTools: Tool[] = [
    {
      // Keyed apart from the title, which carries the size: a button
      // re-keyed on every click would lose focus with it.
      id: "font-down",
      icon: <AArrowDown size={size} />,
      title: `Decrease font size (${percent})`,
      disabled: fontScale <= FONT_SCALES[0],
      run: () => applyFontScale(stepFontScale(fontScale, -1)),
    },
    {
      id: "font-up",
      icon: <AArrowUp size={size} />,
      title: `Increase font size (${percent})`,
      disabled: fontScale >= FONT_SCALES[FONT_SCALES.length - 1]!,
      run: () => applyFontScale(stepFontScale(fontScale, 1)),
    },
  ];
  const tools: Tool[] = [
    { icon: <Heading size={size} />, title: "Heading", run: () => apply((t, s, e) => toggleHeading(t, s, e)) },
    { icon: <Bold size={size} />, title: "Bold", keys: "⌘B", run: () => apply((t, s, e) => toggleInline(t, s, e, "**")) },
    // Font color (specs/editor/common-editor.feature.md "Font color"), next
    // to Bold: a menu of colors readable on the light and the dark theme,
    // and one to take the color off.
    {
      id: "color",
      icon: <Baseline size={size} />,
      title: "Font color",
      run: toggleColorMenu,
      menu:
        colorMenu &&
        createPortal(
          <div
            className={`md-color-pop${colorMenu.above ? " above" : ""}`}
            style={{ top: colorMenu.top, right: colorMenu.right }}
          >
            <Menu
              open
              onClose={() => setColorMenu(null)}
              label="Font color"
              className="md-color-menu"
              containerSelector=".md-color-tool"
              items={[
                ...TEXT_COLORS.map((c) => ({
                  id: c.id,
                  label: c.label,
                  icon: <span className="md-color-swatch" style={{ background: c.value }} />,
                  onSelect: () => apply((t, s, e) => setColor(t, s, e, c.value)),
                })),
                {
                  id: "default",
                  label: "Default color",
                  icon: <span className="md-color-swatch none" />,
                  onSelect: () => apply((t, s, e) => setColor(t, s, e, null)),
                },
              ]}
            />
          </div>,
          document.body,
        ),
    },
    { icon: <Italic size={size} />, title: "Italic", keys: "⌘I", run: () => apply((t, s, e) => toggleInline(t, s, e, "*")) },
    { icon: <Code size={size} />, title: "Inline code", run: () => apply((t, s, e) => toggleInline(t, s, e, "`")) },
    { icon: <Quote size={size} />, title: "Quote", run: () => apply((t, s, e) => toggleLinePrefix(t, s, e, () => "> ", /^> /)) },
    { icon: <List size={size} />, title: "Bullet list", run: () => apply((t, s, e) => toggleLinePrefix(t, s, e, () => "- ", /^[-*+] /)) },
    { icon: <ListOrdered size={size} />, title: "Numbered list", run: () => apply((t, s, e) => toggleLinePrefix(t, s, e, (i) => `${i + 1}. `, /^\d+[.)] /)) },
    { icon: <Link size={size} />, title: "Link", keys: "⌘K", run: () => apply(insertLink) },
    // One table button, doing whichever the caret asks for: with it inside a
    // table, that table; anywhere else, a new one at the caret.
    {
      icon: <Table size={size} />,
      title: caretTable ? "Edit table" : "Insert table",
      run: () => setTable(caretTable ? { mode: "edit", block: caretTable } : { mode: "new" }),
    },
    {
      icon: <Image size={size} />,
      title: excalidrawOn ? "Image or .excalidraw file (or paste an image)" : "Image (or paste one)",
      run: () => fileRef.current?.click(),
    },
    // One diagram button, doing whichever the caret asks for: with it inside
    // a diagram's link, that diagram; anywhere else, a new one. The tooltip
    // names which, so the button never surprises.
    ...(excalidrawOn
      ? [
          {
            icon: <PencilRuler size={size} />,
            title: caretDiagram
              ? `Edit diagram "${diagramName(caretDiagram.ref.alt, caretDiagram.ref.src)}"`
              : "Excalidraw diagram",
            run: () =>
              caretDiagram
                ? openDiagram.current(caretDiagram.index)
                : setDiagram({ mode: "new" }),
          },
        ]
      : []),
    // Only while the caret is in the link of an image that can be marked up.
    ...(caretMarkup
      ? [
          {
            icon: <SquarePen size={size} />,
            title: caretMarkup.ref.alt
              ? `Mark up image "${caretMarkup.ref.alt}"`
              : "Mark up image",
            run: () => openMarkup.current(caretMarkup.index),
          },
        ]
      : []),
    // Only while the caret is in a web link: there is nothing to open otherwise.
    ...(caretLink
      ? [
          {
            icon: <ExternalLink size={size} />,
            title: `Open ${caretLink.url}`,
            keys: "⌘-click",
            run: () => openWebLink(caretLink.url),
          },
        ]
      : []),
  ];

  // The pane closing gives focus back to the text — once React has taken the
  // pane down, so nothing of it (its own focus trap, the discard dialog's)
  // moves focus after this; on Insert, apply() then lands the caret after
  // the embedded link once the upload finishes. A diagram opened from the
  // Preview tab has no text pane to go back to, and leaves focus alone. The
  // markup pane closes the same way.
  const closeDiagram = () => setDiagram(null);
  const closeMarkup = () => setMarkup(null);
  const paneOpen = diagram !== null || markup !== null;
  const paneWasOpen = useRef(false);
  useEffect(() => {
    if (paneWasOpen.current && !paneOpen && editing) surface()?.focus();
    paneWasOpen.current = paneOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneOpen]);

  const preview = tab === "preview" ? renderMarkdown(value) : null;

  return (
    <div
      className="md-editor"
      style={fontScale === 1 ? undefined : ({ "--md-font-scale": fontScale } as CSSProperties)}
    >
      <div className="md-toolbar">
        <div className="md-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "write"}
            className={tab === "write" ? "active" : ""}
            onClick={() => setTab("write")}
          >
            {readOnly ? "Source" : "Write"}
          </button>
          {vimOn && !readOnly && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "vim"}
              className={tab === "vim" ? "active" : ""}
              onClick={() => setTab("vim")}
            >
              Vim
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            className={tab === "preview" ? "active" : ""}
            onClick={() => setTab("preview")}
          >
            Preview
          </button>
        </div>
        <div className="md-tools">
          {uploadError && <span className="md-upload-error">{uploadError}</span>}
          {uploading > 0 && <span className="md-upload-status">Uploading…</span>}
          {[...fontTools, ...(!readOnly && editing ? tools : [])].map((t) => {
            const button = (
              <Tooltip key={t.id ?? t.title} label={t.title} keys={t.keys}>
                <button
                  type="button"
                  aria-label={t.title}
                  aria-haspopup={t.menu !== undefined ? "menu" : undefined}
                  disabled={t.disabled}
                  onClick={t.run}
                >
                  {t.icon}
                </button>
              </Tooltip>
            );
            return t.menu !== undefined ? (
              <span key={t.id ?? t.title} ref={t.id === "color" ? colorRef : undefined} className={`md-${t.id}-tool`}>
                {button}
                {t.menu}
              </span>
            ) : (
              button
            );
          })}
        </div>
      </div>
      {!readOnly && (
        <input
          ref={fileRef}
          type="file"
          accept={excalidrawOn ? "image/*,.excalidraw" : "image/*"}
          multiple
          hidden
          onChange={(e) => {
            addPicked(Array.from(e.target.files ?? []));
            e.target.value = ""; // allow re-picking the same file
          }}
        />
      )}
      {table && !readOnly && (
        <TableDialog
          mode={table.mode}
          initial={withVarColumns(table.mode === "edit" ? table.block : null, tableVars)}
          locked={tableVars}
          onApply={applyTable}
          onCancel={closeTable}
        />
      )}
      {diagram && !readOnly && (
        <Suspense
          fallback={
            <div className="dialog-backdrop">
              <div className="dialog">Loading Excalidraw…</div>
            </div>
          }
        >
          <ExcalidrawPane
            edit={diagram.mode === "edit" ? diagram.edit : undefined}
            importFile={diagram.mode === "new" ? diagram.file : undefined}
            onCancel={closeDiagram}
            onInsert={(file) => {
              const target = diagram.mode === "edit" ? diagram.index : null;
              closeDiagram();
              // A new diagram lands at the caret; an edited one over the
              // image it came from.
              if (target === null) void addImages([file]);
              else void replaceImage(target, file, file.name.replace(/\.[^.]*$/, "") || "image");
            }}
          />
        </Suspense>
      )}
      {markup && !readOnly && (
        <Suspense
          fallback={
            <div className="dialog-backdrop">
              <div className="dialog">Loading Excalidraw…</div>
            </div>
          }
        >
          <MarkupPane
            src={markup.src}
            alt={markup.alt}
            onCancel={closeMarkup}
            onSave={(result: MarkupResult) => {
              const { index, alt } = markup;
              closeMarkup();
              void replaceImage(index, "file" in result ? result.file : result.url, alt);
            }}
          />
        </Suspense>
      )}
      {tab === "write" ? (
        <div className={`md-write${marks ? " highlighted" : ""}`}>
          {marks && (
            <div ref={mirrorRef} className="md-highlights" aria-hidden="true">
              {/* The trailing newline keeps a final empty line, as the textarea does. */}
              {markText(value, marks)}
              {"\n"}
            </div>
          )}
          <textarea
            ref={ref}
            className="md-textarea"
            value={value}
            readOnly={readOnly}
            placeholder={placeholder}
            spellCheck={spellCheck}
            onChange={(e) => {
              sel.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
              setCaret(e.target.selectionStart);
              onChange(e.target.value);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onClick={onSourceClick}
            onScroll={marks || popup ? onScroll : undefined}
            onKeyDown={readOnly ? undefined : onKeyDown}
            onPaste={readOnly ? undefined : onPaste}
            onBlur={() => setComplete(null)}
            aria-autocomplete={readOnly ? undefined : "list"}
            aria-controls={popup ? listId : undefined}
            aria-activedescendant={popup ? `${listId}-${completeIndex}` : undefined}
          />
          {popup && (
            <div
              ref={listRef}
              className="md-complete"
              role="listbox"
              id={listId}
              aria-label="Entity fields"
              data-flipped={place?.flipped ? "" : undefined}
              // Placed over the `@` once measured; hidden for the frame
              // before that, so it never shows where it does not belong.
              style={
                place
                  ? { left: place.left, top: place.top }
                  : { left: 0, top: 0, visibility: "hidden" }
              }
            >
              {items.map((c, i) => (
                <button
                  type="button"
                  key={c.label}
                  role="option"
                  id={`${listId}-${i}`}
                  aria-selected={i === completeIndex}
                  className="md-complete-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(c)}
                >
                  <span className="md-complete-name">{c.label}</span>
                  <span className="md-complete-desc">
                    {c.entity} · {c.file}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : tab === "vim" ? (
        <Suspense fallback={<div className="md-vim-loading">Loading Vim…</div>}>
          <VimEditor
            ref={vimRef}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            highlight={marks}
            onPasteFiles={(files) => void addImages(files)}
            onShortcut={onKeyDown}
            onCaretMove={setCaret}
            onOpenLink={openWebLink}
            completions={fields}
          />
        </Suspense>
      ) : (
        <div ref={previewRef} className="md-preview">
          {preview === null ? (
            <p className="md-empty">Nothing to preview.</p>
          ) : (
            // A published (read-only) body keeps its images as they are.
            <ImageSizingContext.Provider value={readOnly ? null : sizing}>
              <TableEditContext.Provider value={readOnly ? null : tableEditing}>
                {marks ? markNodes(preview, marks) : preview}
              </TableEditContext.Provider>
            </ImageSizingContext.Provider>
          )}
        </div>
      )}
    </div>
  );
}

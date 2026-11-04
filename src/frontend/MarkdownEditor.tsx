import { createPortal } from "react-dom";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode } from "react";
import {
  AArrowDown,
  AArrowUp,
  Baseline,
  Bold,
  Code,
  ExternalLink,
  Heading,
  Highlighter,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  PencilRuler,
  Quote,
  Redo2,
  SquarePen,
  Table,
  Undo2,
} from "lucide-react";
import { Tooltip } from "./Tooltip";
import { Menu } from "./Menu";
import {
  HIGHLIGHT_COLORS,
  imageAtOffset,
  imageRefs,
  insertImage,
  insertLink,
  renderMarkdown,
  setImageSrc,
  setColor,
  setHighlight,
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
import { markNodes } from "./highlight";
import { TableEditContext } from "./MarkdownTable";
import { TableDialog } from "./TableDialog";
import { extractVars, findTables, insertTable, replaceTableBlock, tableAt, withVarColumns } from "./mdtable";
import type { TableBlock } from "./mdtable";
import { ImageSizingContext } from "./MarkdownImage";
import type { ImageSizing } from "./MarkdownImage";
import { useVimMode } from "./vimPref";
import { FONT_SCALES, applyFontScale, stepFontScale, useFontScale } from "./fontSizePref";
import { entityFields, useEntityFields } from "./entityFields";
import { useExcalidrawEnabled } from "./excalidrawPref";
import { SourceEditor } from "./SourceEditor";
import type { TextSurface } from "./SourceEditor";
import { isOpenLinkClick, openWebLink, webLinkAt } from "./weblinks";

// Excalidraw (specs/editor/excalidraw-support.feature.md) is loaded lazily,
// so a bundler that splits can keep it out of the main bundle: the pane, and
// the library with it, load the first time a diagram is drawn (Bun's dev
// bundle inlines them; a server render shows the fallback).
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
 * toolbar over a source pane (src/frontend/SourceEditor.tsx), with a rendered
 * Preview tab — and, with Vim mode on in Settings, a Vim tab editing the same
 * text with Vim's keys.
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
  const editorRef = useRef<TextSurface>(null);
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
  // The font color and highlight menus, each opened from its toolbar
  // button, one at a time. The editor clips what overflows it, so a menu
  // floats over the page from where its button is: under it, or over it
  // where the window has no room below.
  type MenuKind = "color" | "highlight";
  const menuRefs = { color: useRef<HTMLSpanElement>(null), highlight: useRef<HTMLSpanElement>(null) };
  const [menu, setMenu] = useState<{ kind: MenuKind; top: number; right: number; above: boolean } | null>(
    null,
  );
  const toggleMenu = (kind: MenuKind) => {
    if (menu?.kind === kind) {
      setMenu(null);
      return;
    }
    const r = menuRefs[kind].current?.getBoundingClientRect();
    if (!r) return;
    const above = r.bottom + 280 > window.innerHeight && r.top > 280;
    setMenu({ kind, top: above ? r.top - 4 : r.bottom + 4, right: window.innerWidth - r.right, above });
  };
  // The table dialog (specs/editor/table-editor.feature.md): opened on the
  // table the caret is in, or on one in the preview, to rewrite it — or,
  // with the caret in ordinary text, on a blank grid to insert at the caret.
  const [table, setTable] = useState<{ mode: "new" } | { mode: "edit"; block: TableBlock } | null>(
    null,
  );

  // Entity-field completion (specs/editor/data-model-integration-in-editor
  // .feature.md): the code repo's entity fields, which the source pane
  // offers after an `@`. The choices load when an editor opens: a read-only
  // body never completes, and never asks.
  const { fields } = useEntityFields();
  useEffect(() => {
    if (!readOnly) void entityFields.load();
  }, [readOnly]);
  useEffect(() => setMenu(null), [tab]);

  // Search-term marks (specs/search.feature.md): the source pane paints its
  // own; the preview marks the rendered text and lands on the first mark a
  // third of the way down the pane, so the lines around it read too. Once
  // per set of terms and tab, not on every keystroke.
  const marks = highlight && highlight.length > 0 ? highlight : null;
  const previewRef = useRef<HTMLDivElement>(null);
  const marksKey = marks?.join(" ") ?? "";
  useEffect(() => {
    if (!marks || tab !== "preview") return;
    const pane = previewRef.current;
    const marked = pane?.querySelector("mark");
    if (!pane || !marked) return;
    const top =
      marked.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTop = Math.max(0, top - pane.clientHeight / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey, tab]);

  // The pane being edited: the toolbar and shortcuts read the selection
  // from it and put it back after an edit.
  const surface = (): TextSurface | null => editorRef.current;

  const apply = (edit: (text: string, start: number, end: number) => Edit) => {
    const s = surface();
    if (!s) return;
    const { text, start, end } = s.get();
    const r = edit(text, start, end);
    onChange(r.text);
    // Where the edit left the caret, so the toolbar acts on what is there
    // now rather than on whatever the caret was in before.
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

  // Web links (specs/editor/common-editor.feature.md "web links are
  // clickable"): a plain click in the source places the caret, as it must
  // for the url to be edited at all, so ⌘-click (Ctrl-click off the Mac)
  // is what opens one — the gesture code editors use (the source pane's).
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
      setCaret(r.start);
      requestAnimationFrame(() => surface()?.select(r.start, r.end));
    }
  };
  const tableWasOpen = useRef(false);
  useEffect(() => {
    if (tableWasOpen.current && !table && editing) surface()?.focus();
    tableWasOpen.current = table !== null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  // The formatting shortcuts, from either pane: ⌘B, ⌘I, ⌘K. Undo and redo
  // (⌘Z, ⇧⌘Z) are the pane's own.
  const onKeyDown = (e: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) => {
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
  // The font color and highlight menus (specs/editor/common-editor.feature.md
  // "Font color", "Highlight"): colors readable on the light and the dark
  // theme, and one to take the color or highlight off.
  const styleMenu = (
    kind: MenuKind,
    label: string,
    colors: { id: string; label: string; value: string }[],
    none: string,
    set: (text: string, start: number, end: number, color: string | null) => Edit,
  ) =>
    menu?.kind === kind &&
    createPortal(
      <div
        className={`md-color-pop${menu.above ? " above" : ""}`}
        style={{ top: menu.top, right: menu.right }}
      >
        <Menu
          open
          onClose={() => setMenu(null)}
          label={label}
          className="md-color-menu"
          containerSelector={`.md-${kind}-tool`}
          items={[
            ...colors.map((c) => ({
              id: c.id,
              label: c.label,
              icon: <span className="md-color-swatch" style={{ background: c.value }} />,
              onSelect: () => apply((t, s, e) => set(t, s, e, c.value)),
            })),
            {
              id: "default",
              label: none,
              icon: <span className="md-color-swatch none" />,
              onSelect: () => apply((t, s, e) => set(t, s, e, null)),
            },
          ]}
        />
      </div>,
      document.body,
    );
  // Undo and redo (specs/editor/common-editor.feature.md "Undo and redo"),
  // first: the pane's own history, reachable without knowing the keys.
  const historyTools: Tool[] = [
    { icon: <Undo2 size={size} />, title: "Undo", keys: "⌘Z", run: () => surface()?.undo() },
    { icon: <Redo2 size={size} />, title: "Redo", keys: "⇧⌘Z", run: () => surface()?.redo() },
  ];
  const tools: Tool[] = [
    { icon: <Heading size={size} />, title: "Heading", run: () => apply((t, s, e) => toggleHeading(t, s, e)) },
    { icon: <Bold size={size} />, title: "Bold", keys: "⌘B", run: () => apply((t, s, e) => toggleInline(t, s, e, "**")) },
    {
      id: "color",
      icon: <Baseline size={size} />,
      title: "Font color",
      run: () => toggleMenu("color"),
      menu: styleMenu("color", "Font color", TEXT_COLORS, "Default color", setColor),
    },
    {
      id: "highlight",
      icon: <Highlighter size={size} />,
      title: "Highlight",
      run: () => toggleMenu("highlight"),
      menu: styleMenu("highlight", "Highlight", HIGHLIGHT_COLORS, "No highlight", setHighlight),
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
          {[
            ...(!readOnly && editing ? historyTools : []),
            ...fontTools,
            ...(!readOnly && editing ? tools : []),
          ].map((t) => {
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
              <span
                key={t.id ?? t.title}
                ref={t.id === "color" || t.id === "highlight" ? menuRefs[t.id] : undefined}
                className={`md-${t.id}-tool`}
              >
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
      {tab !== "preview" ? (
        <SourceEditor
          ref={editorRef}
          vim={tab === "vim"}
          readOnly={readOnly}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          highlight={marks}
          onPasteFiles={readOnly ? undefined : (files) => void addImages(files)}
          onShortcut={readOnly ? undefined : onKeyDown}
          onCaretMove={setCaret}
          onOpenLink={openWebLink}
          completions={readOnly ? undefined : fields}
        />
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

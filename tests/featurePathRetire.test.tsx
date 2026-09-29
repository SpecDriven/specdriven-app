// Drag-move and File → Rename file `git mv` the open feature, then
// `openFeature` closes the scenario editor the way `<` does. That close
// captured `selected` from the render before the move, so its PUT named the
// retired path and `saveFeature` minted the old file again beside the moved
// one. The description editor's leaving tick did the same: its cleanup still
// holds the old `selected`. `moveTo` / `renameFile` therefore flush, then
// seal, before the POST — the same pair a page editor uses — so nothing can
// write the path git-mv is about to retire.
//
// These tests drive that sequence in the hook shape App uses, because the
// bug lives in the order of flush / git-mv / close, not in any one function.
// happy-dom is borrowed the way descriptionFolderSwitch.test.tsx does: take
// only the globals React touches, and give the originals back afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;

beforeAll(() => {
  happyWindow = new Window({ url: "http://localhost/" });
  const w = happyWindow as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (w[key] ?? w.window);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

import React, { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPromiseQueue } from "../src/frontend/promiseQueue";

const FILE_A = "specs/quote-policy.feature.md";
const FILE_B = "specs/billing/quote-policy.feature.md";

let landed: { file: string; text: string }[] = [];
let timeline: string[] = [];

function reset() {
  landed = [];
  timeline = [];
}

/**
 * The scenario + description editors' half of `App`: `selected` in the
 * close/tick closures, a seal that refuses further writes, and a move that
 * either git-mvs first (the bug) or flushes and seals first (the fix).
 */
function Editor({ flushOnMove }: { flushOnMove: boolean }) {
  const [selected, setSelected] = useState<string | null>(FILE_A);
  const [feature, setFeature] = useState<string | null>("featureA");
  const [editing, setEditing] = useState<{ text: string } | null>({ text: "scenario typed" });
  const [descEdit, setDescEdit] = useState<{ file: string; text: string } | null>({
    file: FILE_A,
    text: "description typed",
  });
  const descEditRef = useRef(descEdit);
  descEditRef.current = descEdit;
  const descSaved = useRef<string | null>("on disk");
  const descSaveQueue = useRef(createPromiseQueue());
  const sealed = useRef(false);
  const autosaved = useRef<string | null>("on disk");

  const put = async (file: string, text: string) => {
    timeline.push(`PUT ${file} start`);
    await new Promise((r) => setTimeout(r, 15));
    landed.push({ file, text });
    timeline.push(`PUT ${file} land`);
  };

  const commitScenario = async () => {
    if (sealed.current) return false;
    if (!editing || !feature || !selected) return false;
    await put(selected, editing.text);
    return true;
  };

  const closeEditor = (): Promise<boolean> | null => {
    if (sealed.current) {
      setEditing(null);
      return null;
    }
    let saving: Promise<boolean> | null = null;
    if (editing && editing.text !== autosaved.current) {
      saving = commitScenario();
    }
    setEditing(null);
    return saving;
  };

  const autosaveDescription = async () => {
    if (sealed.current) return;
    const edit = descEditRef.current;
    if (!edit || !feature || edit.file !== selected) return;
    if (edit.text === descSaved.current) return;
    const text = edit.text;
    await descSaveQueue.current.run(async () => {
      if (text === descSaved.current) return;
      await put(edit.file, text);
      descSaved.current = text;
    });
  };
  const descTick = useRef(autosaveDescription);
  useEffect(() => {
    descTick.current = autosaveDescription;
  });

  const descOpen = descEdit !== null && descEdit.file === selected;
  useEffect(() => {
    if (!descOpen) return;
    return () => {
      if (!sealed.current) void descTick.current();
    };
  }, [descOpen]);

  const editorRef = useRef({ close: closeEditor, flush: async () => {}, seal: () => {} });
  const flush = async () => {
    if (sealed.current) return;
    const leftover = closeEditor();
    if (leftover) await leftover;
    await descTick.current();
    await descSaveQueue.current.idle();
  };
  const seal = () => {
    sealed.current = true;
    setEditing(null);
    setDescEdit(null);
  };
  useEffect(() => {
    editorRef.current = { close: closeEditor, flush, seal };
  });

  const api = {
    async move() {
      if (flushOnMove) {
        await editorRef.current.flush();
        editorRef.current.seal();
      }
      timeline.push("POST /move");
      // openFeature: close using this render's selected, then switch.
      editorRef.current.close();
      setSelected(FILE_B);
      setFeature("featureB");
    },
    async remove() {
      if (flushOnMove) {
        editorRef.current.seal();
      }
      timeline.push("DELETE");
      editorRef.current.close();
      setSelected(null);
      setFeature(null);
    },
  };
  (globalThis as unknown as { __api: typeof api }).__api = api;
  return null;
}

async function mount(flushOnMove: boolean) {
  reset();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Editor flushOnMove={flushOnMove} />);
  });
  return {
    api: (globalThis as unknown as { __api: ReturnType<typeof Object> }).__api as {
      move: () => Promise<void>;
      remove: () => Promise<void>;
    },
    async settle() {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
    },
    unmount: () => root.unmount(),
  };
}

describe("moving a feature with unsaved editors", () => {
  test("flush then seal lands the edits on the current path before git-mv", async () => {
    const app = await mount(true);
    await act(async () => {
      await app.api.move();
    });
    await app.settle();

    expect(landed.map((w) => w.file)).toEqual([FILE_A, FILE_A]);
    expect(landed.map((w) => w.text)).toEqual(["scenario typed", "description typed"]);
    expect(timeline.indexOf("POST /move")).toBeGreaterThan(timeline.lastIndexOf(`PUT ${FILE_A} land`));
    expect(timeline.some((t) => t.startsWith(`PUT ${FILE_A}`) && timeline.indexOf(t) > timeline.indexOf("POST /move"))).toBe(
      false,
    );
  });

  test("without the seal the close after git-mv PUTs the retired path — the bug this fixes", async () => {
    const app = await mount(false);
    await act(async () => {
      await app.api.move();
    });
    await app.settle();

    expect(timeline.indexOf("POST /move")).toBeLessThan(timeline.indexOf(`PUT ${FILE_A} start`));
    expect(landed.some((w) => w.file === FILE_A)).toBe(true);
  });
});

describe("deleting a feature with unsaved editors", () => {
  test("seal without a flush so the parting save cannot recreate the file", async () => {
    const app = await mount(true);
    await act(async () => {
      await app.api.remove();
    });
    await app.settle();

    expect(landed).toEqual([]);
    expect(timeline).toEqual(["DELETE"]);
  });

  test("without the seal the close after DELETE writes the file back", async () => {
    const app = await mount(false);
    await act(async () => {
      await app.api.remove();
    });
    await app.settle();

    expect(landed.some((w) => w.file === FILE_A)).toBe(true);
  });
});

// Switching pages must land the buffer before replacing it (App.tsx
// `showPage`). The page editor's unmount tick never ran on a page-to-page
// move: `pageEditorOpen` stays true across the swap, so the cleanup that
// saves a page on the way to a feature does not fire. Anything typed since
// the last 6s autosave was dropped — the notebook made this the common
// path (a dated list you click through), and the same hole sits on
// roadmap pages and tasks.
//
// These tests drive the real control flow of `showPage` + `autosavePage`
// (capture the buffer, PUT through the page save queue, then replace the
// refs) because the bug is the missing flush, not React effect order. A
// test that only checks "a PUT went out" can pass on broken code if the
// GET of the next page happens to coincide with an interval tick; what
// matters is that the old file is written *before* the buffer becomes the
// new page, and that removing the flush drops the edit.

import { describe, expect, test } from "bun:test";
import { createPromiseQueue } from "../src/frontend/promiseQueue";

const PAGE_A = "notebook/2026-09-12-first.md";
const PAGE_B = "notebook/2026-09-13-second.md";

type Landed = { file: string; text: string };

function pageEditor(flushOnSwitch: boolean) {
  const queue = createPromiseQueue();
  let openFile: string | null = PAGE_A;
  let openText: string | null = "# First\n";
  let saved: string | null = "# First\n";
  const landed: Landed[] = [];
  const timeline: string[] = [];

  const tick = async () => {
    const content = openText;
    const file = openFile;
    if (content === null || file === null || content === saved) return;
    await queue.run(async () => {
      if (content === saved) return;
      timeline.push(`PUT ${file}`);
      landed.push({ file, text: content });
      saved = content;
    });
  };

  const showPage = async (fileName: string, incoming: string | (() => Promise<string>)) => {
    timeline.push(`GET ${fileName}`);
    const content = typeof incoming === "function" ? await incoming() : incoming;
    // App.tsx: the GET has already succeeded here. The flush is skipped
    // when this *is* the open page (the cron refresh).
    if (flushOnSwitch && openFile && openFile !== fileName) {
      await tick();
      await queue.idle();
    }
    timeline.push(`buffer ${fileName}`);
    saved = content;
    openText = content;
    openFile = fileName;
  };

  return {
    landed,
    timeline,
    type(text: string) {
      openText = text;
    },
    showPage,
    tick,
  };
}

describe("showPage flushes the open page before replacing the buffer", () => {
  test("an unsaved notebook entry lands in its own file before the next one opens", async () => {
    const editor = pageEditor(true);
    editor.type("# First\n\nTyped in A");
    await editor.showPage(PAGE_B, "# Second\n");
    expect(editor.landed).toEqual([{ file: PAGE_A, text: "# First\n\nTyped in A" }]);
    expect(editor.timeline).toEqual([`GET ${PAGE_B}`, `PUT ${PAGE_A}`, `buffer ${PAGE_B}`]);
  });

  test("without the flush the typed words are gone — the bug, pinned", async () => {
    const editor = pageEditor(false);
    editor.type("# First\n\nTyped in A");
    await editor.showPage(PAGE_B, "# Second\n");
    expect(editor.landed).toEqual([]);
    expect(editor.timeline).toEqual([`GET ${PAGE_B}`, `buffer ${PAGE_B}`]);
  });

  test("a cron refresh of the same page does not write", async () => {
    const editor = pageEditor(true);
    editor.type("# First\n");
    await editor.showPage(PAGE_A, "# First\n");
    expect(editor.landed).toEqual([]);
    expect(editor.timeline).toEqual([`GET ${PAGE_A}`, `buffer ${PAGE_A}`]);
  });

  test("keystrokes during the GET still ride with the flush", async () => {
    const editor = pageEditor(true);
    editor.type("# First\n\nstarted");
    const hold = Promise.withResolvers<string>();
    // Production showPage awaits the GET, then flushes. Type while that
    // GET is away: those words must still be in the buffer the flush
    // captures — which is why the flush sits *after* the fetch, not
    // before it.
    const opening = editor.showPage(PAGE_B, () => hold.promise);
    editor.type("# First\n\nstarted, then more");
    hold.resolve("# Second\n");
    await opening;
    expect(editor.landed).toEqual([{ file: PAGE_A, text: "# First\n\nstarted, then more" }]);
  });
});

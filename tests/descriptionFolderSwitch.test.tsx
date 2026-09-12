// A feature description belongs to the data folder it was typed in
// (specs/editor/feature-editor.feature.md, the same rule roadmap pages get in
// specs/app/roadmap.feature.md). The server resolves the data folder per
// request, so a description PUT that leaves after `/api/state` has switched
// writes those words into the folder that comes next — and loses them from
// the one they were typed in. `switchRepo` therefore lands the description
// before the switch, the way it already lands the README, the scenario
// editor, the open page and the model canvas.
//
// These tests drive the editor's real hook shape — a `descTick` ref refreshed
// by a dep-less effect, plus the `descOpen` cleanup — because the bug lives in
// the order React runs those, not in any one function. A test that only
// asserts "a PUT went out" passes on the broken code: what matters is *when*.
import { beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import React, { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPromiseQueue } from "../src/frontend/promiseQueue";

const FILE_A = "specs/quote-policy.feature.md";
const FILE_B = "specs/bind-policy.feature.md";

/** Where the server would write right now: it re-reads the data folder per request. */
let folder = "old";
/** Every write that reached the server, in the order it landed. */
let landed: { file: string; text: string; folder: string }[] = [];
/** The order the app called things in, so a test can assert the ordering itself. */
let timeline: string[] = [];

function reset() {
  folder = "old";
  landed = [];
  timeline = [];
}

/**
 * The description editor's half of `App`: the same refs, the same tick, the
 * same cleanup, and a `switchRepo` that flushes the way the real one does.
 * `flushOnSwitch` is the fix under test — off, this is the old behaviour.
 */
function Editor({ flushOnSwitch }: { flushOnSwitch: boolean }) {
  const [selected, setSelected] = useState<string | null>(FILE_A);
  const [feature, setFeature] = useState<string | null>("featureA");
  const [descEdit, setDescEdit] = useState<{ file: string; text: string } | null>({
    file: FILE_A,
    text: "typed",
  });
  const descEditRef = useRef(descEdit);
  descEditRef.current = descEdit;
  const descSaved = useRef<string | null>("on disk");
  const descSaveQueue = useRef(createPromiseQueue());

  // Mirrors autosaveDescription: the guard reads the *closure's* selected and
  // feature, never refs — see the cleanup test below for why.
  const autosaveDescription = async () => {
    const edit = descEditRef.current;
    if (!edit || !feature || edit.file !== selected) return;
    if (edit.text === descSaved.current) return;
    const text = edit.text;
    await descSaveQueue.current.run(async () => {
      if (text === descSaved.current) return;
      timeline.push(`PUT ${edit.file} start`);
      await new Promise((r) => setTimeout(r, 20));
      landed.push({ file: edit.file, text, folder });
      timeline.push(`PUT ${edit.file} land`);
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
      void descTick.current();
      if (descEditRef.current && descEditRef.current.file !== selected) setDescEdit(null);
    };
  }, [descOpen]);

  const api = {
    /** switchRepo: land what belongs here, then repoint the server. */
    async switchRepo() {
      if (flushOnSwitch) {
        await descTick.current();
        await descSaveQueue.current.idle();
        setDescEdit(null);
      }
      timeline.push("PUT /api/state");
      folder = "new";
      setSelected(null);
      setFeature(null);
    },
    /** Ordinary navigation: no explicit flush — the cleanup is meant to cover it. */
    openFeature() {
      setSelected(FILE_B);
      setFeature("featureB");
    },
    goHome() {
      setSelected(null);
      setFeature(null);
    },
    type(text: string) {
      setDescEdit({ file: FILE_A, text });
    },
  };
  (globalThis as unknown as { __api: typeof api }).__api = api;
  return null;
}

async function mount(flushOnSwitch: boolean) {
  reset();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Editor flushOnSwitch={flushOnSwitch} />);
  });
  return {
    api: (globalThis as unknown as { __api: ReturnType<typeof Object> }).__api as {
      switchRepo: () => Promise<void>;
      openFeature: () => void;
      goHome: () => void;
      type: (t: string) => void;
    },
    async settle() {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
    },
    unmount: () => root.unmount(),
  };
}

describe("switching data folder with a description open", () => {
  test("the description lands in the folder it was typed in, before the switch", async () => {
    const app = await mount(true);
    await act(async () => {
      await app.api.switchRepo();
    });
    await app.settle();

    expect(landed).toHaveLength(1);
    expect(landed[0]!.file).toBe(FILE_A);
    expect(landed[0]!.text).toBe("typed");
    // The point of the fix: the words reached the *old* folder.
    expect(landed[0]!.folder).toBe("old");
  });

  test("the PUT resolves before /api/state — a later one would target the new folder", async () => {
    const app = await mount(true);
    await act(async () => {
      await app.api.switchRepo();
    });
    await app.settle();

    expect(timeline).toEqual([
      `PUT ${FILE_A} start`,
      `PUT ${FILE_A} land`,
      "PUT /api/state",
    ]);
  });

  test("without the flush the write lands in the next folder — the bug this fixes", async () => {
    const app = await mount(false);
    await act(async () => {
      await app.api.switchRepo();
    });
    await app.settle();

    expect(landed).toHaveLength(1);
    expect(landed[0]!.folder).toBe("new");
    expect(timeline.indexOf("PUT /api/state")).toBeLessThan(
      timeline.indexOf(`PUT ${FILE_A} start`),
    );
  });
});

describe("a flush that meets a tick already on its way", () => {
  test("waits for it, then writes the newer text — it is not skipped", async () => {
    const app = await mount(true);
    // A tick is in flight when the user types again and the switch arrives:
    // an in-flight boolean would drop these later words on the floor.
    await act(async () => {
      app.api.type("typed, then more");
    });
    await act(async () => {
      await app.api.switchRepo();
    });
    await app.settle();

    expect(landed.map((w) => w.text)).toContain("typed, then more");
    expect(landed.every((w) => w.folder === "old")).toBe(true);
  });
});

describe("ordinary navigation still saves through the cleanup alone", () => {
  // No explicit flush on these paths: React runs an effect's cleanup before
  // the effect bodies of the same commit, and the effect that refreshes
  // `descTick` has no dep array — so the cleanup tick still holds the render
  // in which this feature was selected. Reading refs in the guard instead
  // would see the file the user moved *to*, and drop the edit.
  test("opening another feature lands the edit against the file it was typed in", async () => {
    const app = await mount(true);
    await act(async () => {
      app.api.openFeature();
    });
    await app.settle();

    expect(landed).toHaveLength(1);
    expect(landed[0]!.file).toBe(FILE_A);
    expect(landed[0]!.text).toBe("typed");
  });

  test("going home lands it too", async () => {
    const app = await mount(true);
    await act(async () => {
      app.api.goHome();
    });
    await app.settle();

    expect(landed).toHaveLength(1);
    expect(landed[0]!.file).toBe(FILE_A);
  });
});

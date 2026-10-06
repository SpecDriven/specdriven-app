// A README or scenario PUT that leaves after `/api/state` has switched
// writes those words into the folder that comes next — the server resolves
// the data folder per request (src/server/api.ts `withDataDir`). `switchRepo`
// therefore lands both editors before the switch, the way it already lands
// the feature description (tests/descriptionFolderSwitch.test.tsx).
//
// A boolean in-flight flag makes the flush a no-op while a tick is already
// away. These tests drive the real hook shape — a tick ref plus a promise
// queue — because the bug lives in that ordering. React needs a DOM to run
// effects, so this file borrows one the same way the description tests do.
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

const FILE = "specs/quote-policy.feature.md";

/** Where the server would write right now: it re-reads the data folder per request. */
let folder = "old";
let landed: { kind: "readme" | "scenario"; text: string; folder: string }[] = [];
let timeline: string[] = [];

function reset() {
  folder = "old";
  landed = [];
  timeline = [];
}

type Api = {
  switchRepo: () => Promise<void>;
  startTick: () => Promise<void>;
  type: (text: string) => void;
};

/**
 * The home README's half of `App`: the same tick, the same queue (or the old
 * boolean), and a `switchRepo` that flushes the way the real one does.
 */
function ReadmeEditor({ flushOnSwitch }: { flushOnSwitch: boolean }) {
  const [readme, setReadme] = useState("typed");
  const readmeText = useRef<string | null>(readme);
  readmeText.current = readme;
  const readmeSaved = useRef<string | null>("on disk");
  const readmeInFlight = useRef(false);
  const readmeSaveQueue = useRef(createPromiseQueue());

  const autosaveReadme = async () => {
    const content = readmeText.current;
    if (content === null || content === readmeSaved.current) return;
    if (!flushOnSwitch) {
      if (readmeInFlight.current) return;
      readmeInFlight.current = true;
      timeline.push("PUT /api/readme start");
      await new Promise((r) => setTimeout(r, 20));
      landed.push({ kind: "readme", text: content, folder });
      timeline.push("PUT /api/readme land");
      readmeSaved.current = content;
      readmeInFlight.current = false;
      return;
    }
    await readmeSaveQueue.current.run(async () => {
      const toWrite = readmeText.current;
      if (toWrite === null || toWrite === readmeSaved.current) return;
      timeline.push("PUT /api/readme start");
      await new Promise((r) => setTimeout(r, 20));
      landed.push({ kind: "readme", text: toWrite, folder });
      timeline.push("PUT /api/readme land");
      readmeSaved.current = toWrite;
    });
  };
  const readmeTick = useRef(autosaveReadme);
  useEffect(() => {
    readmeTick.current = autosaveReadme;
  });

  const api: Api = {
    async switchRepo() {
      await readmeTick.current();
      if (flushOnSwitch) await readmeSaveQueue.current.idle();
      readmeText.current = null;
      setReadme("");
      timeline.push("PUT /api/state");
      folder = "new";
    },
    startTick() {
      return autosaveReadme();
    },
    type(text) {
      setReadme(text);
    },
  };
  (globalThis as unknown as { __api: Api }).__api = api;
  return null;
}

/**
 * The scenario editor's half of `App`: `commitScenario` through a queue (or
 * the old boolean), `closeEditor` that used to skip while a tick was away,
 * and `switchRepo` waiting on `idle` the way the real one does now.
 */
function ScenarioEditor({ flushOnSwitch }: { flushOnSwitch: boolean }) {
  const [text, setText] = useState("typed");
  const textRef = useRef(text);
  textRef.current = text;
  const autosaved = useRef<string | null>("on disk");
  const autosaveInFlight = useRef(false);
  const scenarioSaveQueue = useRef(createPromiseQueue());

  const commitScenario = async (content: string) => {
    const write = async () => {
      timeline.push(`PUT ${FILE} start`);
      await new Promise((r) => setTimeout(r, 20));
      landed.push({ kind: "scenario", text: content, folder });
      timeline.push(`PUT ${FILE} land`);
      autosaved.current = content;
    };
    if (flushOnSwitch) return scenarioSaveQueue.current.run(write);
    return write();
  };

  const autosaveScenario = async () => {
    const content = textRef.current;
    if (content === autosaved.current) return;
    if (!flushOnSwitch) {
      if (autosaveInFlight.current) return;
      autosaveInFlight.current = true;
      await commitScenario(content);
      autosaveInFlight.current = false;
      return;
    }
    await commitScenario(content);
  };

  const closeEditor = (): Promise<boolean> | null => {
    const content = textRef.current;
    if (!flushOnSwitch && autosaveInFlight.current) return null;
    if (content === autosaved.current) return null;
    return commitScenario(content).then(() => true);
  };

  const api: Api = {
    async switchRepo() {
      await closeEditor();
      if (flushOnSwitch) await scenarioSaveQueue.current.idle();
      timeline.push("PUT /api/state");
      folder = "new";
    },
    startTick() {
      return autosaveScenario();
    },
    type(next) {
      setText(next);
    },
  };
  (globalThis as unknown as { __api: Api }).__api = api;
  return null;
}

async function mount(kind: "readme" | "scenario", flushOnSwitch: boolean) {
  reset();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const Editor = kind === "readme" ? ReadmeEditor : ScenarioEditor;
  await act(async () => {
    root.render(<Editor flushOnSwitch={flushOnSwitch} />);
  });
  return {
    api: (globalThis as unknown as { __api: Api }).__api,
    async settle() {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
    },
  };
}

async function beginTick(app: { api: Api }) {
  await act(async () => {
    void app.api.startTick();
    await new Promise((r) => setTimeout(r, 5));
  });
}

describe("switching data folder while a README tick is already away", () => {
  test("the PUT lands in the folder it was typed in, before the switch", async () => {
    const app = await mount("readme", true);
    await beginTick(app);
    await act(async () => {
      await app.api.switchRepo();
    });
    await app.settle();

    expect(landed).toHaveLength(1);
    expect(landed[0]!.kind).toBe("readme");
    expect(landed[0]!.text).toBe("typed");
    expect(landed[0]!.folder).toBe("old");
    expect(timeline).toEqual([
      "PUT /api/readme start",
      "PUT /api/readme land",
      "PUT /api/state",
    ]);
  });

  test("without the queue wait the write lands in the next folder — the bug this fixes", async () => {
    const app = await mount("readme", false);
    await beginTick(app);
    await act(async () => {
      await app.api.switchRepo();
    });
    await app.settle();

    expect(landed).toHaveLength(1);
    expect(landed[0]!.folder).toBe("new");
    expect(timeline.indexOf("PUT /api/state")).toBeLessThan(timeline.indexOf("PUT /api/readme land"));
  });

  test("a flush that meets a tick already on its way writes the newer text too", async () => {
    const app = await mount("readme", true);
    await beginTick(app);
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

describe("switching data folder while a scenario tick is already away", () => {
  test("the PUTs land in the folder they were typed in, before the switch", async () => {
    const app = await mount("scenario", true);
    await beginTick(app);
    await act(async () => {
      await app.api.switchRepo();
    });
    await app.settle();

    expect(landed.length).toBeGreaterThanOrEqual(1);
    expect(landed.every((w) => w.kind === "scenario")).toBe(true);
    expect(landed.every((w) => w.text === "typed")).toBe(true);
    expect(landed.every((w) => w.folder === "old")).toBe(true);
    expect(timeline[timeline.length - 1]).toBe("PUT /api/state");
    expect(timeline.indexOf(`PUT ${FILE} land`)).toBeLessThan(timeline.indexOf("PUT /api/state"));
  });

  test("without the queue wait closeEditor is a no-op and the write lands in the next folder", async () => {
    const app = await mount("scenario", false);
    await beginTick(app);
    await act(async () => {
      await app.api.switchRepo();
    });
    await app.settle();

    expect(landed).toHaveLength(1);
    expect(landed[0]!.folder).toBe("new");
    expect(timeline.indexOf("PUT /api/state")).toBeLessThan(timeline.indexOf(`PUT ${FILE} land`));
  });

  test("a flush that meets a tick already on its way writes the newer text too", async () => {
    const app = await mount("scenario", true);
    await beginTick(app);
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

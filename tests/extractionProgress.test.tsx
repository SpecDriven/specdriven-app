// specs/app/extract-specs-from-code.feature.md "Progress and cancel": the
// page's side of a drafting run — useExtraction asks how the open folder's
// run stands when the folder opens and again when one was just started,
// keeps asking while it is at work, tells the sidebar each time another
// feature was written, and passes Cancel, Retry and Dismiss on.
//
// React needs a DOM to run effects, so this file borrows one for the
// handful of globals React touches and gives the originals back — bun runs
// every test file in one process (see tests/descriptionFolderSwitch.test.tsx).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExtractionJob } from "../src/server/intentExtraction";
import { ExtractionProgress, useExtraction, type Extraction } from "../src/frontend/ExtractionProgress";

const job = (state: ExtractionJob["state"], done: number): ExtractionJob => ({
  id: "j1",
  dataDir: "/work/specs-shop",
  codeDir: "/work/shop",
  project: "shop",
  state,
  startedAt: "2026-11-21T00:00:00.000Z",
  folders: Array.from({ length: 2 }, (_, i) => ({
    folder: `f${i}`,
    name: `F${i}`,
    roots: [`f${i}`],
    notRead: 0,
    state: i < done ? ("done" as const) : ("pending" as const),
    batches: [
      i < done
        ? { label: "", files: [], state: "done" as const, fileName: `specs/f${i}/x.feature.md`, title: "X", scenarios: 1 }
        : { label: "", files: [], state: "pending" as const },
    ],
  })),
});

/** The requests the hook made, and what the server answers next. */
let asked: string[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { job: null, published: false } };
const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: Extraction | null = null;
let features = 0;

function Probe({ folder, kick }: { folder: string | null; kick: number }) {
  latest = useExtraction(folder, kick, () => {
    features++;
  });
  return null;
}

const render = async (folder: string | null, kick = 0) => {
  await act(async () => {
    root!.render(<Probe folder={folder} kick={kick} />);
  });
  // The request the effect started, and the state it sets.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
};

beforeEach(() => {
  asked = [];
  features = 0;
  latest = null;
  answer = { status: 200, body: { job: null, published: false } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${String(input)}${init?.body ? ` ${String(init.body)}` : ""}`);
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  globalThis.fetch = realFetch;
});

describe("useExtraction", () => {
  test("asks once when a folder opens, and not at all without one", async () => {
    await render(null);
    expect(asked).toEqual([]);
    expect(latest!.status).toBeNull();
    answer.body = { job: job("done", 2), published: true };
    await render("/work/specs-shop");
    expect(asked).toEqual(["GET /api/extract/draft"]);
    expect(latest!.status).toMatchObject({ published: true, job: { state: "done" } });
    // A run that is over is not asked about again.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(asked).toHaveLength(1);
  });

  test("asks again when a run was just started, and tells the sidebar of each feature written", async () => {
    await render("/work/specs-shop");
    expect(features).toBe(0);
    answer.body = { job: job("done", 1), published: false };
    await render("/work/specs-shop", 1);
    expect(asked).toHaveLength(2);
    expect(features).toBe(1);
    answer.body = { job: job("done", 2), published: false };
    await render("/work/specs-shop", 2);
    expect(features).toBe(2);
    // Nothing new written: nothing to reload.
    await render("/work/specs-shop", 3);
    expect(features).toBe(2);
  });

  test("another folder starts from nothing", async () => {
    answer.body = { job: job("done", 2), published: false };
    await render("/work/specs-shop");
    expect(latest!.status!.job).not.toBeNull();
    answer.body = { job: null, published: true };
    await render("/work/specs-other");
    expect(latest!.status).toEqual({ job: null, published: true });
    expect(asked).toHaveLength(2);
  });

  test("keeps asking while a run is at work, and stops when it is over", async () => {
    answer.body = { job: job("running", 0), published: false };
    await render("/work/specs-shop");
    expect(asked).toHaveLength(1);
    answer.body = { job: job("done", 2), published: false };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2150));
    });
    expect(asked).toHaveLength(2);
    expect(latest!.status!.job!.state).toBe("done");
    expect(features).toBe(1);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2150));
    });
    expect(asked).toHaveLength(2);
  }, 10_000);

  test("Cancel, Retry and Dismiss go to the server, and a refusal comes back in words", async () => {
    answer.body = { job: job("cancelled", 1), published: false };
    await render("/work/specs-shop");
    await act(async () => latest!.cancel());
    await act(async () => {
      expect(await latest!.retry("f1")).toBeNull();
    });
    await act(async () => {
      expect(await latest!.retry()).toBeNull();
    });
    answer = { status: 409, body: { error: "Nothing is left to draft" } };
    await act(async () => {
      expect(await latest!.retry()).toBe("Nothing is left to draft");
    });
    answer = { status: 200, body: { job: null, published: false } };
    await act(async () => latest!.dismiss());
    expect(asked.slice(1)).toEqual([
      "POST /api/extract/draft/cancel",
      'POST /api/extract/draft/retry {"folder":"f1"}',
      "POST /api/extract/draft/retry {}",
      "POST /api/extract/draft/retry {}",
      "DELETE /api/extract/draft",
    ]);
    expect(latest!.status!.job).toBeNull();
  });

  test("once published, the folder is published from then on", async () => {
    await render("/work/specs-shop");
    expect(latest!.status!.published).toBe(false);
    await act(async () => latest!.published());
    expect(latest!.status!.published).toBe(true);
  });
});

describe("linking tests from the pill", () => {
  const over = (j: ExtractionJob): Extraction => ({
    status: { job: j, published: true },
    cancel: async () => {},
    retry: async () => null,
    dismiss: async () => {},
    published: () => {},
  });
  const show = async (j: ExtractionJob, onLinkTests?: () => void) => {
    await act(async () => {
      root!.render(<ExtractionProgress extraction={over(j)} onOpenFeature={() => {}} onLinkTests={onLinkTests} onError={() => {}} />);
    });
    await act(async () => {
      host!.querySelector<HTMLButtonElement>(".extract-pill")!.click();
    });
    return [...host!.querySelectorAll("button")].find((b) => b.textContent === "Link tests…") ?? null;
  };

  test("a run that drafted without linking offers to link the tests once it is over", async () => {
    let opened = 0;
    const button = await show(job("done", 2), () => opened++);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(opened).toBe(1);
    // The popover closes behind the dialog it opened.
    expect(host!.querySelector(".extract-pill")!.getAttribute("aria-expanded")).toBe("false");
  });

  test("a run still at work or one that linked its tests does not offer it", async () => {
    expect(await show(job("running", 1), () => {})).toBeNull();
    const linked = { ...job("done", 2), tests: { base: "https://github.com/acme/shop/blob/main/", repo: "acme/shop" } };
    expect(await show(linked, () => {})).toBeNull();
    // Nor a run that wrote no feature to link, nor a page with no dialog to open.
    expect(await show(job("done", 0), () => {})).toBeNull();
    expect(await show(job("done", 2))).toBeNull();
  });

  test("a run whose project has nowhere for links to point says why in place of the offer", async () => {
    const button = await show({ ...job("done", 2), testsProblem: "Test links point at files on github.com" }, () => {});
    expect(button).toBeNull();
    expect(host!.textContent).toContain("The tests are not linked: Test links point at files on github.com.");
  });

  test("a feature given its links is told to the page like a feature written", async () => {
    await render("/work/specs-shop");
    const withLink = (state: "pending" | "done") => {
      const j = job("done", 2);
      (j.folders[0] as { links?: unknown }).links = [{ fileName: "specs/f0/x.feature.md", title: "X", state, ...(state === "done" ? { linked: 2 } : {}) }];
      return j;
    };
    answer.body = { job: withLink("pending"), published: false };
    await render("/work/specs-shop", 1);
    expect(features).toBe(1);
    answer.body = { job: withLink("done"), published: false };
    await render("/work/specs-shop", 2);
    expect(features).toBe(2);
  });
});

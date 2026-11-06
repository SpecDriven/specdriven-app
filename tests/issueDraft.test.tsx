// specs/app/github-issues.feature.md "A new issue is kept as a draft until
// it is created": the New issue form saves what is typed as a draft, one per
// repository, on this device; a create GitHub refuses keeps it, opening the
// form again brings it back, and only a successful create or Discard clears
// it. The pure storage helpers run against a Map; the form runs under
// happy-dom (the recipe of tests/agentModelsSettings.test.tsx) against a
// stubbed /api/issues.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;
const realFetch = globalThis.fetch;

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
  globalThis.fetch = realFetch;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { DraftNotice, IssuesPane } from "../src/frontend/IssuesPane";
import { clearIssueDraft, draftKey, readIssueDraft, saveIssueDraft, type DraftStorage } from "../src/frontend/issueDraft";
import { issues, issuesState, type Issue } from "../src/frontend/issues";
import type { IssuesRoute } from "../src/plugins/builtin/issues/route";

const REPO = { url: "https://github.com/acme/app", host: "github.com", owner: "acme", name: "app" };
const OTHER = { url: "https://ghe.acme.com/acme/app", host: "ghe.acme.com", owner: "acme", name: "app" };

function memory(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("draft storage", () => {
  test("a draft is saved per repository, host included, and read back", () => {
    const store = memory();
    saveIssueDraft(REPO, { title: "Crash on save", body: "Steps…" }, store, new Date("2026-11-06T10:00:00Z"));
    expect(readIssueDraft(REPO, store)).toEqual({ title: "Crash on save", body: "Steps…", savedAt: "2026-11-06T10:00:00.000Z" });
    // The same owner/name on an Enterprise host is another repository.
    expect(readIssueDraft(OTHER, store)).toBeNull();
    expect(draftKey(REPO)).not.toBe(draftKey(OTHER));
  });

  test("a blank form is no draft, so saving it clears the saved one", () => {
    const store = memory();
    saveIssueDraft(REPO, { title: "x", body: "" }, store);
    saveIssueDraft(REPO, { title: "  ", body: "\n" }, store);
    expect(store.map.size).toBe(0);
    expect(readIssueDraft(REPO, store)).toBeNull();
  });

  test("clearing forgets it; a garbled entry or an unknown repo reads as none", () => {
    const store = memory();
    saveIssueDraft(REPO, { title: "x", body: "y" }, store);
    clearIssueDraft(REPO, store);
    expect(readIssueDraft(REPO, store)).toBeNull();
    store.setItem(draftKey(REPO), "{not json");
    expect(readIssueDraft(REPO, store)).toBeNull();
    expect(readIssueDraft(null, store)).toBeNull();
  });
});

describe("the list's draft notice", () => {
  test("names the draft and offers Resume and Discard", () => {
    const html = renderToStaticMarkup(
      <DraftNotice draft={{ title: "Crash on save", body: "", savedAt: "2026-11-06T10:00:00Z" }} onResume={() => {}} onDiscard={() => {}} />,
    );
    expect(html).toContain("Draft");
    expect(html).toContain("Crash on save");
    expect(html).toContain(">Resume<");
    expect(html).toContain(">Discard<");
  });

  test("an untitled draft says so", () => {
    const html = renderToStaticMarkup(<DraftNotice draft={{ title: "", body: "Only a body", savedAt: "" }} onResume={() => {}} onDiscard={() => {}} />);
    expect(html).toContain("Untitled");
  });
});

// --- The form ----------------------------------------------------------------------------

const created = (number: number, title: string): Issue => ({
  number,
  title,
  body: "",
  state: "open",
  stateReason: null,
  url: `https://github.com/acme/app/issues/${number}`,
  author: "octo",
  assignees: [],
  labels: [],
  comments: 0,
  createdAt: "2026-11-06T10:00:00Z",
  updatedAt: "2026-11-06T10:00:00Z",
  closedAt: null,
});

/** /api/issues answering the list with REPO, and POSTs with `post` in turn. */
function stubGitHub(posts: Array<() => Response>) {
  const sent: unknown[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      sent.push(JSON.parse(String(init.body)));
      return posts.shift()!();
    }
    return Response.json({ repo: REPO, state: "open", issues: [] });
  }) as unknown as typeof fetch;
  return sent;
}

const type = (el: HTMLInputElement, value: string) =>
  act(() => {
    el.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new window.KeyboardEvent("keyup", { key: "a", bubbles: true }) as unknown as Event);
  });

let mounted: { root: Root; host: HTMLElement } | null = null;
const navigations: IssuesRoute[] = [];

async function openForm(view: IssuesRoute = { kind: "new" }, confirmAnswer = true) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(
      <IssuesPane
        view={view}
        repoCrumb={{ label: "acme" }}
        prompt={async () => null}
        confirm={async () => confirmAnswer}
        onNavigate={(v) => navigations.push(v)}
        onOpenSettings={() => {}}
      />,
    );
  });
  return host;
}

function unmount() {
  if (!mounted) return;
  const { root, host } = mounted;
  act(() => root.unmount());
  host.remove();
  mounted = null;
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((r) => setTimeout(r, 0));
  });

afterEach(() => {
  unmount();
  localStorage.clear();
  navigations.length = 0;
  issues.reset();
});

describe("the New issue form", () => {
  test("a failed create keeps the draft; the form brings it back; a later create clears it", async () => {
    const sent = stubGitHub([
      () => Response.json({ error: "Bad credentials" }, { status: 401 }),
      () => Response.json({ issue: created(7, "Crash on save") }),
    ]);
    await issues.load();
    expect(issuesState().repo).toEqual(REPO);

    let host = await openForm();
    const title = host.querySelector("input.issue-title-input") as HTMLInputElement;
    await type(title, "Crash on save");
    // Saved as typed, before any create.
    expect(readIssueDraft(REPO)?.title).toBe("Crash on save");
    expect(host.textContent).toContain("Draft saved");

    await click(button(host, "Create issue")!);
    expect(sent).toHaveLength(1);
    // GitHub refused: the form and the draft both keep it, and nothing navigated.
    expect(readIssueDraft(REPO)?.title).toBe("Crash on save");
    expect((host.querySelector("input.issue-title-input") as HTMLInputElement).value).toBe("Crash on save");
    expect(navigations).toEqual([]);

    // Leave the form (Cancel, a reload, a restart): opening it again restores the draft.
    unmount();
    host = await openForm();
    expect((host.querySelector("input.issue-title-input") as HTMLInputElement).value).toBe("Crash on save");

    await click(button(host, "Create issue")!);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ title: "Crash on save" });
    expect(readIssueDraft(REPO)).toBeNull();
    expect(navigations).toEqual([{ kind: "issue", number: 7 }]);
  });

  test("the list shows the draft; Discard deletes it after a confirm", async () => {
    stubGitHub([]);
    await issues.load();
    saveIssueDraft(REPO, { title: "Half-written", body: "" });
    const host = await openForm({ kind: "list" });
    expect(host.querySelector(".issue-draft-notice")?.textContent).toContain("Half-written");

    await click(button(host, "Resume")!);
    expect(navigations).toEqual([{ kind: "new" }]);

    await click(button(host, "Discard")!);
    expect(readIssueDraft(REPO)).toBeNull();
    expect(host.querySelector(".issue-draft-notice")).toBeNull();
  });

  test("Discard draft on the form empties it, and only on a yes", async () => {
    stubGitHub([]);
    await issues.load();
    saveIssueDraft(REPO, { title: "Keep me", body: "" });
    let host = await openForm({ kind: "new" }, false);
    await click(button(host, "Discard draft")!);
    expect(readIssueDraft(REPO)?.title).toBe("Keep me");
    unmount();

    host = await openForm({ kind: "new" }, true);
    await click(button(host, "Discard draft")!);
    expect(readIssueDraft(REPO)).toBeNull();
    expect((host.querySelector("input.issue-title-input") as HTMLInputElement).value).toBe("");
  });
});

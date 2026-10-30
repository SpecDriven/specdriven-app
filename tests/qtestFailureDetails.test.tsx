// specs/external-links/qtest-test-cases.feature.md "Every call to qTest is
// logged, and a failure shows what qTest answered": a failure shows one line
// in the qTest dialog (and in Settings → qTest); clicking it opens what the
// server knows of the call — the request, what was sent, qTest's status and
// its answer — with a way to the Observability page. A test case qTest
// refuses mid-run keeps the dialog open on it. React needs a DOM to handle
// the clicks, so this file borrows one the way
// tests/confluenceFailureDetails.test.tsx does.
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
  "FocusEvent",
  "KeyboardEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
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
import { createRoot } from "react-dom/client";
import { QtestPublishDialog, type QtestPublishResult } from "../src/frontend/QtestPublishDialog";
import { QtestTokens } from "../src/frontend/QtestToken";

const SITE = { base: "https://acme.qtestnet.com", user: "3 projects" };
const PARENT = "https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=0&id=901";
const DETAILS = {
  method: "POST",
  url: "https://acme.qtestnet.com/api/v3/projects/12/test-cases",
  requestBody: '{\n  "name": "S3: Declined Quote"\n}',
  status: 400,
  statusText: "Bad Request",
  contentType: "application/json",
  body: '{\n  "message": "Field Type is required"\n}',
  time: "2026-10-25T10:15:00.000Z",
};

function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { host, unmount };
}

/** The dialog after a Create the route answered with `answer`. */
async function created(answer: Record<string, unknown>, status: number, hooks: { onOpenLogs?: () => void } = {}) {
  globalThis.fetch = (async () => Response.json(answer, { status })) as unknown as typeof fetch;
  const published: QtestPublishResult[] = [];
  const mounted = mount(
    <QtestPublishDialog
      file="specs/quote.feature.md"
      featureName="Quote Policy"
      initialParentUrl={PARENT}
      sites={[SITE]}
      onPublished={(r) => published.push(r)}
      onClose={() => {}}
      onOpenLogs={hooks.onOpenLogs}
    />,
  );
  await act(async () => {
    (mounted.host.querySelector("button[type=submit]") as HTMLButtonElement).click();
  });
  return { ...mounted, published };
}

describe("a failed Create in the qTest dialog", () => {
  test("shows the error as a line that opens the request, what was sent and qTest's answer", async () => {
    let opened = 0;
    const { host, unmount } = await created(
      { error: "qTest answered HTTP 400: Field Type is required", details: DETAILS },
      502,
      { onOpenLogs: () => opened++ },
    );
    const line = host.querySelector("button.error-link") as HTMLButtonElement;
    expect(line.textContent).toBe("qTest answered HTTP 400: Field Type is required");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".failure-details")).toBeNull();

    await act(async () => line.click());
    const box = host.querySelector(".failure-details")!;
    expect(box.textContent).toContain("POST https://acme.qtestnet.com/api/v3/projects/12/test-cases");
    expect(box.textContent).toContain("400 Bad Request");
    expect(box.textContent).toContain("The app sent");
    expect(box.textContent).toContain("qTest answered");
    const [sent, answered] = [...box.querySelectorAll("pre")].map((p) => p.textContent);
    expect(sent).toBe(DETAILS.requestBody);
    expect(answered).toBe(DETAILS.body);

    const logs = [...box.querySelectorAll("button")].find((b) => b.textContent === "Open in Observability")!;
    await act(async () => logs.click());
    expect(opened).toBe(1);

    await act(async () => line.click());
    expect(host.querySelector(".failure-details")).toBeNull();
    unmount();
  });

  test("a test case refused mid-run keeps the dialog open on it, with its details", async () => {
    const message = "1 of the test cases were written; “Declined Quote” was not: qTest answered HTTP 400";
    const { host, published, unmount } = await created(
      {
        module: { id: "66", pid: "MD-66", url: PARENT, created: true },
        cases: [],
        created: 1,
        updated: 0,
        title: "Quote Policy",
        parentUrl: PARENT,
        content: "",
        parsed: { name: "Quote Policy", scenarios: [] },
        failure: { scenarioName: "Declined Quote", message, details: DETAILS },
      },
      200,
    );
    // The feature still takes the links of what was written.
    expect(published).toHaveLength(1);
    const line = host.querySelector("button.error-link") as HTMLButtonElement;
    expect(line.textContent).toBe(message);
    await act(async () => line.click());
    expect(host.querySelector(".failure-details")!.textContent).toContain("Field Type is required");
    unmount();
  });

  test("an error without details stays plain text", async () => {
    const { host, unmount } = await created({ error: "No qTest token for https://acme.qtestnet.com" }, 401);
    expect(host.querySelector("button.error-link")).toBeNull();
    expect(host.querySelector("p.error")!.textContent).toBe("No qTest token for https://acme.qtestnet.com");
    unmount();
  });
});

describe("a token qTest refuses in Settings → qTest", () => {
  test("shows qTest's answer on click", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        {
          error: "qTest did not accept this token — check it and its expiry",
          details: { ...DETAILS, method: "GET", url: "https://acme.qtestnet.com/api/v3/projects", status: 401, statusText: "Unauthorized", requestBody: undefined, body: '{"message":"invalid_token"}' },
        },
        { status: 400 },
      )) as unknown as typeof fetch;
    const { host, unmount } = mount(<QtestTokens sites={[]} onChange={() => {}} />);
    const input = (label: string) => host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
    // React's onChange under happy-dom: focus, the prototype setter, then keyup.
    const type = (el: HTMLInputElement, value: string) =>
      act(() => {
        el.focus();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new window.KeyboardEvent("keyup", { key: "a", bubbles: true }) as unknown as Event);
      });
    type(input("qTest url"), "https://acme.qtestnet.com");
    type(input("qTest Bearer token"), "tok-bad");
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save token")!;
    await act(async () => save.click());
    const line = host.querySelector("button.error-link") as HTMLButtonElement;
    expect(line.textContent).toContain("did not accept this token");
    await act(async () => line.click());
    const box = host.querySelector(".failure-details")!;
    expect(box.textContent).toContain("GET https://acme.qtestnet.com/api/v3/projects");
    expect(box.textContent).toContain("401 Unauthorized");
    expect(box.textContent).toContain("invalid_token");
    expect(box.textContent).not.toContain("The app sent");
    unmount();
  });
});

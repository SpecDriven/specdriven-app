// specs/external-links/confluence-wiki.feature.md: a publish that fails
// shows one line in the dialog; clicking it opens what the server knows of
// the call — the request, Confluence's status and its answer — with a way to
// the Observability page, where the same failure is logged. React needs a
// DOM to handle the clicks, so this file borrows one the way
// tests/folderSwitchInFlight.test.tsx does.
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
import { ConfluencePublishDialog } from "../src/frontend/ConfluencePublishDialog";

const PARENT = "https://wiki.acme.com/spaces/ABC/pages/99999/Parent+Page";
const DETAILS = {
  method: "POST",
  url: "https://wiki.acme.com/rest/api/content",
  status: 500,
  statusText: "Internal Server Error",
  contentType: "text/html;charset=UTF-8",
  body: "System Error\njava.lang.NullPointerException",
  time: "2026-10-23T10:15:00.000Z",
};

/** The dialog after a Publish the route answered with `answer`. */
async function failedPublish(answer: Record<string, unknown>, onOpenLogs?: () => void) {
  globalThis.fetch = (async () => Response.json(answer, { status: 502 })) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ConfluencePublishDialog
        file="specs/quote.feature.md"
        featureName="Quote Policy"
        initialParentUrl={PARENT}
        wikis={[{ base: "https://wiki.acme.com", user: "David V" }]}
        onPublished={() => {}}
        onClose={() => {}}
        onOpenLogs={onOpenLogs}
      />,
    );
  });
  await act(async () => {
    (host.querySelector("button[type=submit]") as HTMLButtonElement).click();
  });
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { host, unmount };
}

describe("a failed publish", () => {
  test("shows the error as a line that opens the details on click, and closes them again", async () => {
    let opened = 0;
    const { host, unmount } = await failedPublish({ error: "Confluence answered HTTP 500", details: DETAILS }, () => {
      opened++;
    });
    const line = host.querySelector("button.error-link") as HTMLButtonElement;
    expect(line.textContent).toBe("Confluence answered HTTP 500");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".confluence-failure")).toBeNull();

    await act(async () => line.click());
    const box = host.querySelector(".confluence-failure")!;
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(box.textContent).toContain("POST https://wiki.acme.com/rest/api/content");
    expect(box.textContent).toContain("500 Internal Server Error");
    expect(box.textContent).toContain("text/html;charset=UTF-8");
    expect(box.querySelector("pre")!.textContent).toBe(DETAILS.body);

    const logs = [...box.querySelectorAll("button")].find((b) => b.textContent === "Open in Observability")!;
    await act(async () => logs.click());
    expect(opened).toBe(1);

    await act(async () => line.click());
    expect(host.querySelector(".confluence-failure")).toBeNull();
    unmount();
  });

  test("an unreachable wiki says there was no answer, and shows no body", async () => {
    const { host, unmount } = await failedPublish({
      error: "Could not reach Confluence at https://wiki.acme.com: Unable to connect",
      details: { method: "GET", url: DETAILS.url, cause: "Unable to connect", time: DETAILS.time },
    });
    await act(async () => (host.querySelector("button.error-link") as HTMLButtonElement).click());
    const box = host.querySelector(".confluence-failure")!;
    expect(box.textContent).toContain("No answer");
    expect(box.textContent).toContain("Unable to connect");
    expect(box.querySelector("pre")).toBeNull();
    unmount();
  });

  test("an error without details stays plain text", async () => {
    const { host, unmount } = await failedPublish({ error: "No Confluence token for https://wiki.acme.com" });
    expect(host.querySelector("button.error-link")).toBeNull();
    expect(host.querySelector("p.error")!.textContent).toBe("No Confluence token for https://wiki.acme.com");
    unmount();
  });
});

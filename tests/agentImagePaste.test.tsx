// Pasting an image into the coding agent pane's message box
// (specs/agents/agent-pane.feature.md "Paste an image into the message"):
// what a paste carries (src/frontend/pastedImages.ts), and the message box
// showing, dropping and sending the pasted images. React needs a DOM to
// handle the paste, so this file borrows one the way
// tests/agentModelsSettings.test.tsx does.
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
  "FileReader",
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
import { AgentPane } from "../src/frontend/AgentPane";
import { agentChat } from "../src/frontend/agentChat";
import { Toaster } from "../src/frontend/Toasts";
import {
  MAX_EDGE,
  base64Bytes,
  fitWithin,
  pastedImageFiles,
  sendsAsIs,
  splitDataUrl,
  type ClipboardLike,
} from "../src/frontend/pastedImages";
import { MAX_IMAGE_BYTES } from "../src/server/agentTypes";
import { CLAUDE_AGENT, PI_AGENT } from "./fixtures/agents";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A file the DOM's own FileReader can read. */
function pngFile(name = "shot.png"): File {
  const w = happyWindow as unknown as { File: typeof File };
  return new w.File([Buffer.from(PNG_1X1, "base64")], name, { type: "image/png" });
}

/** A clipboard holding `files`, and `text` as text/plain. */
function clipboard(files: File[], text = ""): ClipboardLike {
  return {
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
    files,
    getData: (type: string) => (type === "text/plain" ? text : ""),
  };
}

describe("what a paste carries", () => {
  test("a paste's image files are taken, unless it also carries text", () => {
    const shot = pngFile();
    expect(pastedImageFiles(clipboard([shot]))).toEqual([shot]);
    // A copy from a spreadsheet or Finder: a picture beside the text.
    expect(pastedImageFiles(clipboard([shot], "A1\tB1"))).toEqual([]);
    // Not an image, and no clipboard at all.
    const doc = new (happyWindow as unknown as { File: typeof File }).File(["x"], "a.pdf", { type: "application/pdf" });
    expect(pastedImageFiles(clipboard([doc]))).toEqual([]);
    expect(pastedImageFiles(null)).toEqual([]);
    // A clipboard that fills only `files`.
    expect(pastedImageFiles({ files: [shot], getData: () => "" })).toEqual([shot]);
  });

  test("an image goes as it is when its type and size fit, else it is scaled to fit", () => {
    expect(sendsAsIs("image/png", 1000)).toBe(true);
    expect(sendsAsIs("image/webp", MAX_IMAGE_BYTES)).toBe(true);
    expect(sendsAsIs("image/png", MAX_IMAGE_BYTES + 1)).toBe(false);
    expect(sendsAsIs("image/tiff", 1000)).toBe(false);
    expect(fitWithin(4000, 1000, MAX_EDGE)).toEqual({ width: 2048, height: 512 });
    expect(fitWithin(800, 600, MAX_EDGE)).toEqual({ width: 800, height: 600 });
    expect(base64Bytes(PNG_1X1)).toBe(Buffer.from(PNG_1X1, "base64").length);
    expect(splitDataUrl(`data:image/png;base64,${PNG_1X1}`)).toEqual({ type: "image/png", data: PNG_1X1 });
    expect(() => splitDataUrl("data:text/plain,hi")).toThrow("Could not read the image");
  });
});

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

/** Paste `data` into `el` as the browser would. */
async function paste(el: HTMLElement, data: ClipboardLike) {
  await act(async () => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    el.dispatchEvent(event);
  });
  // FileReader answers on a later tick.
  for (let i = 0; i < 20 && el.ownerDocument.querySelector('[aria-label="Reading an image"]'); i++) {
    await act(() => Bun.sleep(5));
  }
}

const pane = () => (
  <>
    <AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" onClose={() => {}} />
    <Toaster />
  </>
);

describe("the message box", () => {
  test("a pasted image shows as a thumbnail, can be removed, and is sent with the first message", async () => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    let refuse = true;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/choices")) return Response.json({ choices: null });
      if (url === "/api/agent/chat" && init.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        if (refuse) return Response.json({ error: "Claude could not start" }, { status: 502 });
        return Response.json({ id: "s1" });
      }
      if (url === "/api/agent/chat/s1") {
        const meta = {
          id: "s1",
          name: "Look",
          agent: "claude",
          cwd: "/w/code",
          dataRepo: "/w/data",
          startedAt: "2026-11-04T10:00:00.000Z",
          status: "ended",
          permissionMode: "auto",
          lastSeq: 1,
        };
        const user = {
          kind: "user",
          id: "u1",
          text: "Look",
          images: [{ id: "i1", mediaType: "image/png", url: "/api/agent/chat/s1/images/i1", name: "shot.png" }],
          seq: 1,
          at: "2026-11-04T10:00:00.000Z",
        };
        return Response.json({ meta, commands: [], events: [user] });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    agentChat.setAgents([{ ...CLAUDE_AGENT, capabilities: { ...CLAUDE_AGENT.capabilities, images: true } }]);
    const { host, unmount } = mount(pane());
    const box = () => host.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
    const thumbs = () => [...host.querySelectorAll(".agent-attachments img")] as HTMLImageElement[];
    const sendButton = () => host.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
    expect(sendButton().disabled).toBe(true);

    await paste(box(), clipboard([pngFile("shot.png"), pngFile("second.png")]));
    expect(thumbs().map((i) => i.alt)).toEqual(["shot.png", "second.png"]);
    expect(thumbs()[0]!.src).toBe(`data:image/png;base64,${PNG_1X1}`);
    // Images alone are enough to send.
    expect(sendButton().disabled).toBe(false);

    act(() => (host.querySelector('button[aria-label="Remove second.png"]') as HTMLButtonElement).click());
    expect(thumbs().map((i) => i.alt)).toEqual(["shot.png"]);

    // A refused start keeps the images in the box, to send again.
    await act(async () => sendButton().click());
    await act(() => Bun.sleep(5));
    expect(posts[0]!.body.images).toEqual([{ mediaType: "image/png", data: PNG_1X1, name: "shot.png" }]);
    expect(host.textContent).toContain("Claude could not start");
    expect(thumbs().map((i) => i.alt)).toEqual(["shot.png"]);

    refuse = false;
    await act(async () => sendButton().click());
    await act(() => Bun.sleep(5));
    expect(posts).toHaveLength(2);
    // The session's transcript shows the image in the message's bubble.
    const shown = host.querySelector(".agent-msg.user img") as HTMLImageElement;
    expect(shown.getAttribute("src")).toBe("/api/agent/chat/s1/images/i1");
    act(() => (host.querySelector('button[aria-label="Open shot.png"]') as HTMLButtonElement).click());
    expect(host.querySelector('.agent-image-zoom[role="dialog"]')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event);
    });
    expect(host.querySelector(".agent-image-zoom")).toBeNull();
    unmount();
    await agentChat.end("s1").catch(() => undefined);
    agentChat.setAgents([]);
  });

  test("an agent that reads no images refuses the paste by name", async () => {
    globalThis.fetch = (async () => Response.json({ choices: null })) as unknown as typeof fetch;
    agentChat.setAgents([PI_AGENT]);
    const { host, unmount } = mount(pane());
    const box = host.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
    await paste(box, clipboard([pngFile()]));
    expect(host.querySelector(".agent-attachments")).toBeNull();
    expect(host.textContent).toContain("Pi cannot read images — paste text instead");
    unmount();
    agentChat.setAgents([]);
  });
});

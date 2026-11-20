// A peer's edit shows on screen as it arrives (specs/datastore/
// automerge-store.feature.md): the server says so on the change stream the
// pages already hold open (src/plugins/host/loader.ts), and the page hears it
// apart from the plugin news on the same stream (src/plugins/client/loader.ts).

import { test, expect, afterEach } from "bun:test";
import { notifyDocumentsChange, notifyPluginChange } from "../src/plugins/host/loader";
import { documentsEventFile, watchPluginChanges } from "../src/plugins/client/loader";
import { DOCUMENTS_EVENT } from "../src/plugins/shared";

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

test("the change stream tells every open page which feature a peer changed", async () => {
  const { handleApi } = await import("../src/server/api");
  const open = async () => {
    const res = (await handleApi(new Request("http://x/api/plugins/events")))!;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);
    expect(await next()).toContain(": connected");
    return { reader, next };
  };
  const one = await open();
  const two = await open();
  try {
    notifyDocumentsChange("specs/app/sync.feature.md");
    // A named event: a page that listens for unnamed messages alone (one
    // loaded before this existed) is not sent re-reading its plugins.
    const event = `event: documents\ndata: {"file":"specs/app/sync.feature.md"}\n\n`;
    expect(await one.next()).toBe(event);
    expect(await two.next()).toBe(event);
    // The plugin news on the same stream is as it was.
    notifyPluginChange();
    expect(await one.next()).toBe(`data: {"type":"changed"}\n\n`);
  } finally {
    await one.reader.cancel();
    await two.reader.cancel();
  }
});

/** The part of EventSource the page uses, driven by the test. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  /** What the browser does with one event off the wire. */
  receive(name: string | null, data: string): void {
    if (name === null) this.onmessage?.({ data });
    else for (const listener of this.listeners.get(name) ?? []) listener({ data });
  }
}

test("a page hears of a peer's edit apart from the plugin news on the same stream", () => {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  let plugins = 0;
  const files: string[] = [];
  const dispose = watchPluginChanges(
    () => plugins++,
    (file) => files.push(file),
  );
  const source = FakeEventSource.last!;
  expect(source.url).toBe("/api/plugins/events");

  source.receive(DOCUMENTS_EVENT, `{"file":"specs/a.feature.md"}`);
  expect(files).toEqual(["specs/a.feature.md"]);
  expect(plugins).toBe(0);

  source.receive(null, `{"type":"changed"}`);
  expect(plugins).toBe(1);
  expect(files).toEqual(["specs/a.feature.md"]);

  dispose();
  expect(source.closed).toBe(true);
});

test("a page that asks for plugin news alone listens for nothing else", () => {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  const dispose = watchPluginChanges(() => {});
  expect(FakeEventSource.last!.listeners.size).toBe(0);
  dispose();
});

test("a documents event that names no feature still reads as one, with no name", () => {
  expect(documentsEventFile(`{"file":"specs/a.feature.md"}`)).toBe("specs/a.feature.md");
  expect(documentsEventFile(`{"file":7}`)).toBe("");
  expect(documentsEventFile("not json")).toBe("");
  expect(documentsEventFile("null")).toBe("");
  expect(documentsEventFile(undefined)).toBe("");
});

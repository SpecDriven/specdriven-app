// The clipboard helpers (src/frontend/clipboard.ts): copyWhenReady hands the
// clipboard a text still on its way, so the hosted app's session button can
// copy a prompt it has yet to fetch (specs/app/hosted-app.feature.md).
import { afterEach, expect, test } from "bun:test";
import { copyWhenReady } from "../src/frontend/clipboard";

const g = globalThis as unknown as { ClipboardItem?: unknown };
const savedItem = g.ClipboardItem;
const savedClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  g.ClipboardItem = savedItem;
  if (savedClipboard) Object.defineProperty(navigator, "clipboard", savedClipboard);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

/** A browser whose clipboard keeps what ClipboardItem was given. */
function fakeClipboard(opts: { writeFails?: boolean } = {}) {
  const copied: string[] = [];
  class Item {
    constructor(public items: Record<string, Promise<Blob>>) {}
  }
  g.ClipboardItem = Item;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: async (items: Item[]) => {
        const blob = await items[0]!.items["text/plain"]!;
        if (opts.writeFails) throw new Error("NotAllowedError");
        copied.push(await blob.text());
      },
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
  return copied;
}

test("a text still on its way is copied once it arrives, through a ClipboardItem made at once", async () => {
  const copied = fakeClipboard();
  let arrive!: (t: string) => void;
  const pending = copyWhenReady(new Promise<string>((r) => (arrive = r)));
  arrive("the prompt");
  expect(await pending).toBe(true);
  expect(copied).toEqual(["the prompt"]);
});

test("a text that fails to arrive throws its own error, and nothing is copied", async () => {
  const copied = fakeClipboard();
  await expect(copyWhenReady(Promise.reject(new Error("No spec selected")))).rejects.toThrow("No spec selected");
  expect(copied).toEqual([]);
});

test("a browser that refuses the ClipboardItem write gets the text the plain way", async () => {
  const copied = fakeClipboard({ writeFails: true });
  expect(await copyWhenReady(Promise.resolve("the prompt"))).toBe(true);
  expect(copied).toEqual(["the prompt"]);
});

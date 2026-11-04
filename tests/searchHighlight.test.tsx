// specs/search.feature.md: the words a hit matched on are marked where the hit
// lands — in the palette's snippet and in the editor the hit opens, source
// and preview alike — and the marks agree because one helper makes them.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { markNodes, markText, termsPattern } from "../src/frontend/highlight";
import { renderMarkdown } from "../src/frontend/markdown";
import { MarkdownEditor } from "../src/frontend/MarkdownEditor";

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe("markText", () => {
  test("wraps every occurrence, whatever its case", () => {
    expect(html(markText("Premium rules the premium", ["premium"]))).toBe(
      "<mark>Premium</mark> rules the <mark>premium</mark>",
    );
  });

  test("several terms mark independently", () => {
    expect(html(markText("a quote for a policy", ["quote", "policy"]))).toBe(
      "a <mark>quote</mark> for a <mark>policy</mark>",
    );
  });

  test("a prefix search's stem and its longer form mark the whole word", () => {
    expect(html(markText("our agents ask an agent", ["agent", "agents"]))).toBe(
      "our <mark>agents</mark> ask an <mark>agent</mark>",
    );
  });

  test("terms are literal text, not patterns", () => {
    expect(html(markText("a.b or axb", ["a.b"]))).toBe("<mark>a.b</mark> or axb");
    expect(termsPattern([])).toBeNull();
    expect(termsPattern([""])).toBeNull();
  });

  test("text without a match is returned as it was", () => {
    expect(markText("nothing here", ["premium"])).toBe("nothing here");
    expect(markText("nothing here", [])).toBe("nothing here");
  });
});

describe("markNodes", () => {
  test("marks inside rendered markdown, through inline formatting", () => {
    const rendered = renderMarkdown("Given a **premium** policy\n\n- the premium is due");
    expect(html(markNodes(rendered, ["premium"]))).toBe(
      "<p>Given a <strong><mark>premium</mark></strong> policy</p><ul><li>the <mark>premium</mark> is due</li></ul>",
    );
  });

  test("attributes are left alone — only what is read is marked", () => {
    const rendered = renderMarkdown("[premium](https://example.com/premium)");
    expect(html(markNodes(rendered, ["premium"]))).toBe(
      '<p><a href="https://example.com/premium" target="_blank" rel="noreferrer"><mark>premium</mark></a></p>',
    );
  });

  test("no terms, no change", () => {
    const rendered = renderMarkdown("Given a premium policy");
    expect(markNodes(rendered, [])).toBe(rendered);
  });
});

// The source pane is a CodeMirror editor, which needs a DOM to paint its
// marks; this file borrows one from happy-dom the way
// tests/commonEditor.test.tsx does.
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
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
  await new Promise((r) => setTimeout(r, 0));
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

describe("the editor opened from a hit", () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = (async () => new Response("[]")) as unknown as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    globalThis.fetch = realFetch;
  });

  async function mount(el: React.ReactElement) {
    root = createRoot(host!);
    await act(async () => root!.render(el));
  }

  test("the source paints the marks over its text", async () => {
    await mount(
      <MarkdownEditor value="Given a premium policy" onChange={() => {}} highlight={["premium"]} />,
    );
    const marks = [...host!.querySelectorAll(".md-source-mark")].map((m) => m.textContent);
    expect(marks).toEqual(["premium"]);
    // The text itself is as it was.
    expect(host!.querySelector(".cm-content")?.textContent).toBe("Given a premium policy");
  });

  test("a published scenario's preview marks the rendered text", () => {
    const out = renderToStaticMarkup(
      <MarkdownEditor value="Given a premium policy" onChange={() => {}} readOnly highlight={["premium"]} />,
    );
    expect(out).toContain('<div class="md-preview"><p>Given a <mark>premium</mark> policy</p></div>');
  });

  test("without terms the editor is as it was — no marks", async () => {
    await mount(<MarkdownEditor value="Given a premium policy" onChange={() => {}} />);
    expect(host!.querySelector(".md-source-mark")).toBeNull();
    expect(host!.querySelector(".cm-content")?.textContent).toBe("Given a premium policy");
  });
});

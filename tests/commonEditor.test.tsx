// Automates specs/editor/common-editor.feature.md.
//
// "web links are clickable":
// a web link of the format `https://abc.com` typed into an editor is
// clickable from it. The Preview tab renders it as a link; the Write tab,
// where a plain click places the caret, opens it on ⌘-click (Ctrl-click off
// the Mac) and offers an Open button in the toolbar while the caret is in it.
//
// "Increase and decrease font size": two buttons next to the Heading button
// step the text of every editor up and down, on every tab, and the size
// stays on this device.
//
// "Font color": a button next to Bold opens a menu of colors; picking one
// wraps the selection in `<span style="color: …">`, which the Preview tab
// shows in that color, and "Default color" takes it off again.
//
// React needs a DOM to run the Write tab's handlers, so this file borrows one
// from happy-dom — only the globals React touches, given back afterwards, as
// tests/descriptionFolderSwitch.test.tsx explains.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TEXT_COLORS, renderMarkdown, setColor } from "../src/frontend/markdown";
import { safeColor } from "../src/frontend/markdownSyntax";
import { MarkdownEditor } from "../src/frontend/MarkdownEditor";
import { isOpenLinkClick, webLinkAt, webLinks } from "../src/frontend/weblinks";
import { FONT_SCALES, stepFontScale } from "../src/frontend/fontSizePref";

const html = (src: string) => renderToStaticMarkup(<>{renderMarkdown(src)}</>);
const a = (url: string) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`;

describe("webLinks", () => {
  test("finds a bare https url, and an http one", () => {
    expect(webLinks("a webink of the format https://abc.com should be clickable")).toEqual([
      { start: 23, end: 38, url: "https://abc.com" },
    ]);
    expect(webLinks("http://abc.com/x?y=1#z")).toEqual([
      { start: 0, end: 22, url: "http://abc.com/x?y=1#z" },
    ]);
  });

  test("leaves the sentence's punctuation and quotes out of the link", () => {
    expect(webLinks("see https://abc.com.").map((l) => l.url)).toEqual(["https://abc.com"]);
    expect(webLinks("at https://abc.com/a, then").map((l) => l.url)).toEqual(["https://abc.com/a"]);
    expect(webLinks("'https://abc.com'").map((l) => l.url)).toEqual(["https://abc.com"]);
    expect(webLinks("**https://abc.com**").map((l) => l.url)).toEqual(["https://abc.com"]);
  });

  test("keeps a bracketed url's own parentheses, not the ones around it", () => {
    expect(webLinks("(see https://abc.com)").map((l) => l.url)).toEqual(["https://abc.com"]);
    expect(webLinks("https://en.wikipedia.org/wiki/Spec_(disambiguation)").map((l) => l.url)).toEqual([
      "https://en.wikipedia.org/wiki/Spec_(disambiguation)",
    ]);
    expect(webLinks("[https://abc.com]").map((l) => l.url)).toEqual(["https://abc.com"]);
  });

  test("is nothing for a scheme with no host, or one inside a word", () => {
    expect(webLinks("https://")).toEqual([]);
    expect(webLinks("https:// and more")).toEqual([]);
    expect(webLinks("xhttps://abc.com")).toEqual([]);
    expect(webLinks("ftp://abc.com and abc.com")).toEqual([]);
  });

  test("finds every link on every line", () => {
    expect(webLinks("https://a.com and https://b.com\nhttps://c.com").map((l) => l.url)).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
  });
});

describe("webLinkAt", () => {
  const text = "first line\nsee https://abc.com/x now";
  const link = { start: 15, end: 32, url: "https://abc.com/x" };

  test("is the link around the offset, either end included", () => {
    expect(webLinkAt(text, 20)).toEqual(link);
    expect(webLinkAt(text, 15)).toEqual(link);
    expect(webLinkAt(text, 32)).toEqual(link);
  });

  test("is nothing beside the link or on another line", () => {
    expect(webLinkAt(text, 14)).toBeNull();
    expect(webLinkAt(text, 34)).toBeNull();
    expect(webLinkAt(text, 3)).toBeNull();
    expect(webLinkAt("", 0)).toBeNull();
  });
});

describe("isOpenLinkClick", () => {
  const click = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  test("is ⌘-click or Ctrl-click, and nothing else", () => {
    expect(isOpenLinkClick({ ...click, metaKey: true })).toBe(true);
    expect(isOpenLinkClick({ ...click, ctrlKey: true })).toBe(true);
    expect(isOpenLinkClick(click)).toBe(false);
    // Shift-click extends the selection; Alt-click is the OS's.
    expect(isOpenLinkClick({ ...click, metaKey: true, shiftKey: true })).toBe(false);
    expect(isOpenLinkClick({ ...click, ctrlKey: true, altKey: true })).toBe(false);
  });
});

describe("the preview", () => {
  test("renders a bare web link as a link", () => {
    expect(html("a webink of the format https://abc.com should be clickable")).toBe(
      `<p>a webink of the format ${a("https://abc.com")} should be clickable</p>`,
    );
  });

  test("ends the link where the source tabs end it", () => {
    expect(html("see https://abc.com.")).toBe(`<p>see ${a("https://abc.com")}.</p>`);
    expect(html("(see https://abc.com)")).toBe(`<p>(see ${a("https://abc.com")})</p>`);
    expect(html("**https://abc.com**")).toBe(`<p><strong>${a("https://abc.com")}</strong></p>`);
  });

  test("renders an <https://…> autolink without its angle brackets", () => {
    expect(html("<https://abc.com>")).toBe(`<p>${a("https://abc.com")}</p>`);
  });

  test("keeps a link in lists, quotes and tables", () => {
    expect(html("- https://abc.com")).toBe(`<ul><li>${a("https://abc.com")}</li></ul>`);
    expect(html("> https://abc.com")).toContain(a("https://abc.com"));
    expect(html("| site |\n| --- |\n| https://abc.com |")).toContain(a("https://abc.com"));
  });

  test("leaves code, link labels and images as they were", () => {
    expect(html("run `curl https://abc.com`")).toBe("<p>run <code>curl https://abc.com</code></p>");
    // A link cannot hold another: the label stays text.
    expect(html("[https://abc.com](https://abc.com/docs)")).toBe(
      '<p><a href="https://abc.com/docs" target="_blank" rel="noreferrer">https://abc.com</a></p>',
    );
    expect(html("[docs](https://abc.com)")).toBe(
      '<p><a href="https://abc.com" target="_blank" rel="noreferrer">docs</a></p>',
    );
    expect(html("![logo](https://abc.com/logo.png)")).not.toContain("<a");
  });

  test("leaves a url-looking word alone", () => {
    expect(html("https:// is a scheme")).toBe("<p>https:// is a scheme</p>");
    expect(html("xhttps://abc.com")).toBe("<p>xhttps://abc.com</p>");
  });

  test("does not read emphasis inside a url", () => {
    expect(html("https://abc.com/__init__/x")).toBe(`<p>${a("https://abc.com/__init__/x")}</p>`);
  });
});

// ---- The Write tab, in a DOM ----

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLTextAreaElement",
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
  // React's scheduler may still have a task queued; let it run with a window.
  await new Promise((r) => setTimeout(r, 0));
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

describe("the Write tab", () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;
  let opened: string[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    opened = [];
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    // The editor asks for the entity fields it completes; there are none.
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

  const TEXT = "a webink of the format https://abc.com should be clickable";

  function Editor({ readOnly = false }: { readOnly?: boolean }) {
    const [value, setValue] = useState(TEXT);
    return <MarkdownEditor value={value} onChange={setValue} readOnly={readOnly} initialTab="write" />;
  }

  // Async, so the entity-field load the editor starts lands inside act().
  async function mount(el: React.ReactElement) {
    root = createRoot(host!);
    await act(async () => root!.render(el));
    return host!.querySelector("textarea")!;
  }

  /** A click that lands the caret at `offset`, as the browser does before the click event. */
  function clickAt(ta: HTMLTextAreaElement, offset: number, mods: MouseEventInit = {}) {
    act(() => {
      ta.focus();
      ta.setSelectionRange(offset, offset);
      // React reads a moved selection off the mouseup that ends a click.
      ta.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, ...mods }) as unknown as Event);
      ta.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true, ...mods }) as unknown as Event,
      );
    });
  }

  test("⌘-click on a web link opens it", async () => {
    const ta = await mount(<Editor />);
    clickAt(ta, 30, { metaKey: true });
    expect(opened).toEqual(["https://abc.com"]);
  });

  test("Ctrl-click opens it too, and in a read-only body's source", async () => {
    const ta = await mount(<Editor readOnly />);
    // A read-only body opens on Preview; its Source tab is the textarea.
    const source = [...host!.querySelectorAll("button[role=tab]")].find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
    expect(ta).toBeNull();
    act(() => source.click());
    clickAt(host!.querySelector("textarea")!, 25, { ctrlKey: true });
    expect(opened).toEqual(["https://abc.com"]);
  });

  test("a plain click only places the caret, so the url can be edited", async () => {
    const ta = await mount(<Editor />);
    clickAt(ta, 30);
    expect(opened).toEqual([]);
  });

  test("⌘-click away from a link opens nothing", async () => {
    const ta = await mount(<Editor />);
    clickAt(ta, 5, { metaKey: true });
    expect(opened).toEqual([]);
  });

  test("the toolbar offers to open the link the caret is in, and only then", async () => {
    const ta = await mount(<Editor />);
    const open = () => host!.querySelector('button[aria-label="Open https://abc.com"]') as HTMLButtonElement | null;
    clickAt(ta, 5);
    expect(open()).toBeNull();
    clickAt(ta, 30);
    expect(open()).not.toBeNull();
    act(() => open()!.click());
    expect(opened).toEqual(["https://abc.com"]);
  });
});

describe("the Preview tab", () => {
  test("shows the link as a link", () => {
    const markup = renderToStaticMarkup(
      <MarkdownEditor value="go to https://abc.com" onChange={() => {}} initialTab="preview" />,
    );
    expect(markup).toContain(a("https://abc.com"));
  });
});

describe("stepFontScale", () => {
  test("steps up and down through the sizes, from where an editor starts", () => {
    expect(stepFontScale(1, 1)).toBe(1.15);
    expect(stepFontScale(1.15, 1)).toBe(1.3);
    expect(stepFontScale(1.15, -1)).toBe(1);
    expect(stepFontScale(1, -1)).toBe(0.85);
  });

  test("stays put at either end", () => {
    expect(stepFontScale(FONT_SCALES[0], -1)).toBe(FONT_SCALES[0]);
    expect(stepFontScale(2, 1)).toBe(2);
  });

  test("moves a size between steps to the nearest step that way", () => {
    expect(stepFontScale(1.2, 1)).toBe(1.3);
    expect(stepFontScale(1.2, -1)).toBe(1.15);
  });
});

describe("font size", () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = (async () => new Response("[]")) as unknown as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    globalThis.fetch = realFetch;
    localStorage.clear();
  });

  function Editor(props: { readOnly?: boolean; initialTab?: "write" | "preview" }) {
    const [value, setValue] = useState("# Title\n\nSome text");
    return <MarkdownEditor value={value} onChange={setValue} initialTab="write" {...props} />;
  }

  async function mount(el: React.ReactElement) {
    root = createRoot(host!);
    await act(async () => root!.render(el));
  }

  const editors = () => [...host!.querySelectorAll<HTMLElement>(".md-editor")];
  const scale = (editor = editors()[0]!) => editor.style.getPropertyValue("--md-font-scale") || "1";
  const labels = (editor = editors()[0]!) =>
    [...editor.querySelectorAll(".md-tools button")].map((b) => b.getAttribute("aria-label"));
  const button = (name: "Increase" | "Decrease", editor = editors()[0]!) =>
    editor.querySelector<HTMLButtonElement>(`button[aria-label^="${name} font size"]`)!;

  test("the buttons sit next to the Heading button", async () => {
    await mount(<Editor />);
    expect(labels().slice(0, 3)).toEqual([
      "Decrease font size (100%)",
      "Increase font size (100%)",
      "Heading",
    ]);
  });

  test("increase makes the text bigger, decrease smaller, and the buttons say the size", async () => {
    await mount(<Editor />);
    expect(scale()).toBe("1");
    act(() => button("Increase").click());
    expect(scale()).toBe("1.15");
    expect(button("Increase").getAttribute("aria-label")).toBe("Increase font size (115%)");
    act(() => button("Decrease").click());
    act(() => button("Decrease").click());
    expect(scale()).toBe("0.85");
  });

  test("a button is disabled at its end of the range", async () => {
    await mount(<Editor />);
    act(() => button("Decrease").click());
    expect(button("Decrease").disabled).toBe(true);
    expect(button("Increase").disabled).toBe(false);
    for (let i = 0; i < FONT_SCALES.length; i++) act(() => button("Increase").click());
    expect(scale()).toBe("2");
    expect(button("Increase").disabled).toBe(true);
  });

  test("every open editor follows, and the size is kept for the next one", async () => {
    await mount(
      <>
        <Editor />
        <Editor initialTab="preview" />
      </>,
    );
    act(() => button("Increase", editors()[0]).click());
    expect(editors().map((e) => scale(e))).toEqual(["1.15", "1.15"]);
    act(() => root!.unmount());
    await mount(<Editor />);
    expect(scale()).toBe("1.15");
  });

  test("the Preview tab and a read-only body offer the font size, and nothing else", async () => {
    await mount(
      <>
        <Editor initialTab="preview" />
        <Editor readOnly />
      </>,
    );
    for (const editor of editors()) {
      expect(labels(editor)).toEqual(["Decrease font size (100%)", "Increase font size (100%)"]);
    }
  });
});

describe("setColor", () => {
  const red = "#e5484d";
  const blue = "#0090ff";

  test("wraps the selection in a colored span, leaving the text selected", () => {
    expect(setColor("make this red", 10, 13, red)).toEqual({
      text: `make this <span style="color: ${red}">red</span>`,
      start: 39,
      end: 42,
    });
  });

  test("with nothing selected, leaves the caret inside an empty colored span", () => {
    expect(setColor("ab", 1, 1, red)).toEqual({
      text: `a<span style="color: ${red}"></span>b`,
      start: 30,
      end: 30,
    });
  });

  test("recolors a span the selection is in, rather than nesting another", () => {
    const text = `x <span style="color: ${red}">word</span> y`;
    const inner = text.indexOf("word");
    const r = setColor(text, inner, inner + 4, blue);
    expect(r.text).toBe(`x <span style="color: ${blue}">word</span> y`);
    expect(r.text.slice(r.start, r.end)).toBe("word");
  });

  test("recolors a span selected whole, tags and all", () => {
    const text = `<span style="color: ${red}">word</span>`;
    const r = setColor(text, 0, text.length, blue);
    expect(r.text).toBe(`<span style="color: ${blue}">word</span>`);
    expect(r.text.slice(r.start, r.end)).toBe("word");
  });

  test("Default color takes the span off, and leaves plain text alone", () => {
    const text = `x <span style="color: ${red}">word</span> y`;
    const inner = text.indexOf("word");
    const r = setColor(text, inner + 1, inner + 3, null);
    expect(r.text).toBe("x word y");
    expect(r.text.slice(r.start, r.end)).toBe("or");
    expect(setColor("plain", 0, 5, null)).toEqual({ text: "plain", start: 0, end: 5 });
  });

  test("offers colors every one of which is a color the preview accepts", () => {
    expect(TEXT_COLORS.length).toBeGreaterThan(4);
    for (const c of TEXT_COLORS) expect(safeColor(c.value)).toBe(c.value);
  });
});

describe("colored text in the preview", () => {
  test("shows a colored span in its color, with the markdown inside it read", () => {
    expect(html(`a <span style="color: #e5484d">**red**</span> b`)).toBe(
      `<p>a <span class="md-color" style="color:#e5484d"><strong>red</strong></span> b</p>`,
    );
    expect(html(`<span style='color:blue;'>x</span>`)).toBe(
      `<p><span class="md-color" style="color:blue">x</span></p>`,
    );
  });

  test("reads no other style, and no color that could break out of one", () => {
    expect(safeColor("red; background: url(x)")).toBeNull();
    expect(safeColor("expression(alert(1))")).toBeNull();
    expect(safeColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(html(`<span style="background: red">x</span>`)).toBe(
      `<p>&lt;span style=&quot;background: red&quot;&gt;x&lt;/span&gt;</p>`,
    );
  });
});

describe("font color", () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
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

  let latest = "";
  function Editor({ initial = "make this red" }: { initial?: string }) {
    const [value, setValue] = useState(initial);
    latest = value;
    return <MarkdownEditor value={value} onChange={setValue} initialTab="write" />;
  }

  async function mount(el: React.ReactElement) {
    root = createRoot(host!);
    await act(async () => root!.render(el));
    return host!.querySelector("textarea")!;
  }

  const labels = () =>
    [...host!.querySelectorAll(".md-tools button")].map((b) => b.getAttribute("aria-label"));
  const colorButton = () => host!.querySelector<HTMLButtonElement>('button[aria-label="Font color"]')!;
  const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="Font color"]');
  const item = (label: string) =>
    [...menu()!.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(
      (b) => b.textContent === label,
    )!;

  test("the button sits next to the Bold button", async () => {
    await mount(<Editor />);
    const at = labels().indexOf("Bold");
    expect(at).toBeGreaterThan(-1);
    expect(labels()[at + 1]).toBe("Font color");
  });

  test("picking a color colors the selection; Default color takes it off", async () => {
    const ta = await mount(<Editor />);
    act(() => {
      ta.focus();
      ta.setSelectionRange(10, 13);
    });
    act(() => colorButton().click());
    expect(menu()).not.toBeNull();
    expect([...menu()!.querySelectorAll("[role=menuitem]")].map((b) => b.textContent)).toEqual([
      ...TEXT_COLORS.map((c) => c.label),
      "Default color",
    ]);
    act(() => item("Red").click());
    expect(latest).toBe(`make this <span style="color: ${TEXT_COLORS[0]!.value}">red</span>`);
    expect(menu()).toBeNull();

    // The selection is still the word, so the menu acts on its span.
    const start = latest.indexOf(">red") + 1;
    act(() => {
      ta.focus();
      ta.setSelectionRange(start, start + 3);
    });
    act(() => colorButton().click());
    act(() => item("Default color").click());
    expect(latest).toBe("make this red");
  });

  test("ESC closes the menu and leaves the text alone", async () => {
    await mount(<Editor />);
    act(() => colorButton().click());
    act(() => {
      menu()!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    });
    expect(menu()).toBeNull();
    expect(latest).toBe("make this red");
  });
});

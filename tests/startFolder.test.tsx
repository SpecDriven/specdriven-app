// The first-run screen's folder field (specs/ui/app-start.feature.md "one
// field opens a specification folder or a code repository" and "the folder
// field lists the recent folders"): src/frontend/StartFolder.tsx as markup
// and in a DOM. App.tsx owns the state and the requests; what these check
// is what the user is shown, and what the field hands back.
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { FolderEntry } from "../src/frontend/SpecFolders";
import {
  parseFolderVerdict,
  recentKindOf,
  StartFolderField,
  startFolderStep,
  type FolderVerdict,
  type KindQuestion,
} from "../src/frontend/StartFolder";

const noop = () => {};
const spec = (path: string): FolderEntry => ({ path, kind: "spec" });
const code = (path: string): FolderEntry => ({ path, kind: "code" });
const recent = [code("/code/app"), spec("/specs/insurance"), spec("https://github.com/acme/specs-billing")];

const field = (props: Partial<Parameters<typeof StartFolderField>[0]> = {}) => (
  <StartFolderField
    inputRef={createRef<HTMLInputElement>()}
    recent={recent}
    busy={false}
    error={null}
    question={null}
    onPickRecent={noop}
    onEdit={noop}
    onAnswer={noop}
    {...props}
  />
);
const html = (props: Partial<Parameters<typeof StartFolderField>[0]> = {}) => renderToStaticMarkup(field(props));

/** Runs `body` with a DOM, the field rendered into `host`. */
function inDom(el: React.ReactElement, body: (host: HTMLElement) => void) {
  const window = new Window({ url: "http://localhost/" });
  const g = globalThis as unknown as Record<string, unknown>;
  // The menu (src/frontend/Menu.tsx) checks nodes against the DOM's classes.
  const names = ["window", "document", "Element", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = Object.fromEntries(names.map((n) => [n, g[n]]));
  g.window = window;
  g.document = window.document;
  g.Element = window.Element;
  g.HTMLElement = window.HTMLElement;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    act(() => root.render(el));
    body(host as unknown as HTMLElement);
    act(() => root.unmount());
  } finally {
    for (const n of names) g[n] = saved[n];
    void window.happyDOM.close();
  }
}

describe("StartFolderField — one field for both kinds of folder", () => {
  test("there is one path field and one button, for a specification folder or a code repository", () => {
    const markup = html();
    expect(markup.match(/<input /g)).toHaveLength(1);
    expect(markup).toContain('name="repo"');
    expect(markup).toContain("a specification folder or a code repository");
    expect(markup).toContain(">Open this folder</button>");
    expect(markup).not.toContain("Open this code repository");
    // How the two are told apart is said under the button.
    expect(markup).toContain("<code>.specdriven</code>");
    expect(markup).toContain("<code>specs</code>");
    expect(markup).toContain("build file");
  });

  test("Browse… is there only where there is a native chooser", () => {
    expect(html()).not.toContain("Browse…");
    expect(html({ onBrowse: noop })).toContain(">Browse…</button>");
  });

  test("while a folder opens, the button waits and says so", () => {
    const markup = html({ busy: true });
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Opening…<\/button>/);
  });

  test("an error is shown under the field", () => {
    expect(html({ error: "Not a folder: /tmp/notes.txt" })).toContain(
      '<p class="error">Not a folder: /tmp/notes.txt</p>',
    );
  });
});

describe("StartFolderField — the folder that cannot be told apart", () => {
  const question: KindQuestion = { open: "/work/notes", path: "/work/notes", name: "notes" };

  test("the screen asks which kind it is, naming the folder", () => {
    const markup = html({ question });
    expect(markup).toContain('role="group"');
    expect(markup).toContain("<strong>notes</strong>");
    expect(markup).toContain("A specification folder</button>");
    expect(markup).toContain("A code repository</button>");
    // What a yes to "specification folder" does to the folder.
    expect(markup).toContain('title="Adds a .specdriven folder and a specs folder inside it"');
  });

  test("each answer hands back its kind", () => {
    const answers: string[] = [];
    inDom(field({ question, onAnswer: (kind) => answers.push(kind) }), (host) => {
      const buttons = [...host.querySelectorAll(".start-kind-answers button")] as unknown as HTMLButtonElement[];
      expect(buttons).toHaveLength(2);
      act(() => buttons[0]!.click());
      act(() => buttons[1]!.click());
    });
    expect(answers).toEqual(["spec", "code"]);
  });

  test("with no question, nothing is asked", () => {
    expect(html()).not.toContain("start-kind-question");
  });
});

describe("StartFolderField — the recent folders drop-down", () => {
  test("the field carries a Recent folders button, closed at first", () => {
    const markup = html();
    expect(markup).toMatch(/<button[^>]*aria-label="Recent folders"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
    expect(markup).not.toContain('role="menu"');
  });

  test("with no folder opened before, there is no drop-down", () => {
    const markup = html({ recent: [] });
    expect(markup).not.toContain("Recent folders");
    expect(markup).toContain('class="start-folder"');
  });

  test("opening it lists the folders newest first, each with its kind and path", () => {
    inDom(field(), (host) => {
      const toggle = host.querySelector('button[aria-label="Recent folders"]') as unknown as HTMLButtonElement;
      act(() => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      const items = [...host.querySelectorAll('[role="menu"] [role^="menuitem"]')] as unknown as HTMLElement[];
      expect(items.map((i) => i.querySelector(".folder-kind")?.getAttribute("aria-label"))).toEqual([
        "Code repository",
        "Specification folder",
        "Specification folder",
      ]);
      expect(items[0]!.textContent).toContain("app");
      expect(items[0]!.textContent).toContain("/code/app");
      expect(items[2]!.textContent).toContain("https://github.com/acme/specs-billing");
    });
  });

  test("it lists at most ten", () => {
    const many = Array.from({ length: 14 }, (_, i) => spec(`/specs/s${i}`));
    inDom(field({ recent: many }), (host) => {
      act(() => (host.querySelector('button[aria-label="Recent folders"]') as unknown as HTMLButtonElement).click());
      expect(host.querySelectorAll('[role="menu"] [role^="menuitem"]')).toHaveLength(10);
    });
  });

  test("picking a folder fills the field, hands back the entry and closes the list — the button still opens it", () => {
    const picked: FolderEntry[] = [];
    const inputRef = createRef<HTMLInputElement>();
    inDom(field({ inputRef, onPickRecent: (f) => picked.push(f) }), (host) => {
      act(() => (host.querySelector('button[aria-label="Recent folders"]') as unknown as HTMLButtonElement).click());
      const items = [...host.querySelectorAll('[role="menu"] [role^="menuitem"]')] as unknown as HTMLButtonElement[];
      act(() => items[0]!.click());
      expect(inputRef.current!.value).toBe("/code/app");
      expect(host.querySelector('[role="menu"]')).toBeNull();
      expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Open this folder");
    });
    expect(picked).toEqual([code("/code/app")]);
  });
});

describe("what the screen does with the server's answer", () => {
  const verdict = (kind: FolderVerdict["kind"]): FolderVerdict => ({ kind, open: "/w/x", path: "/w/x", name: "x" });

  test("each kind of folder has its step", () => {
    expect(startFolderStep(verdict("spec"))).toBe("spec");
    expect(startFolderStep(verdict("url"))).toBe("spec");
    // A missing folder goes the specification way, which asks before making it.
    expect(startFolderStep(verdict("missing"))).toBe("spec");
    expect(startFolderStep(verdict("code"))).toBe("code");
    expect(startFolderStep(verdict("empty-specs"))).toBe("confirm-specs");
    expect(startFolderStep(verdict("unknown"))).toBe("ask");
    expect(startFolderStep(verdict("not-a-folder"))).toBe("refuse");
  });

  test("a malformed answer is no verdict", () => {
    expect(parseFolderVerdict({ kind: "code", open: "/a", path: "/a", name: "a", buildTool: "Maven" })).toEqual({
      kind: "code",
      open: "/a",
      path: "/a",
      name: "a",
      buildTool: "Maven",
    });
    expect(parseFolderVerdict({ kind: "spec", open: "/a", path: "/a", name: "a" })).toEqual({
      kind: "spec",
      open: "/a",
      path: "/a",
      name: "a",
    });
    expect(parseFolderVerdict({ kind: "other", open: "/a", path: "/a", name: "a" })).toBeNull();
    expect(parseFolderVerdict({ kind: "spec" })).toBeNull();
    expect(parseFolderVerdict({ error: "nope" })).toBeNull();
    expect(parseFolderVerdict(null)).toBeNull();
  });

  test("a folder opened before as one kind opens as that kind again", () => {
    expect(recentKindOf(recent, "/code/app")).toBe("code");
    expect(recentKindOf(recent, "/specs/insurance")).toBe("spec");
    expect(recentKindOf(recent, "/never/opened")).toBeNull();
    // Opened as both: the contents decide.
    expect(recentKindOf([code("/work/repo"), spec("/work/repo")], "/work/repo")).toBeNull();
  });
});

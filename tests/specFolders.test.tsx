// Spec folders (specs/app/spec-folders.feature.md): the two dialogs in
// src/frontend/SpecFolders.tsx as static markup — the modal that covers the
// app while a folder switch runs, and the list where folders are opened,
// removed or added. App.tsx owns the state; what these check is what the
// user is shown for a given state.
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FolderSwitchDialog,
  SWITCH_STEPS,
  SpecFoldersDialog,
  parseRecentFolders,
  type FolderEntry,
} from "../src/frontend/SpecFolders";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};

describe("FolderSwitchDialog — Switch spec folder", () => {
  test("a modal dialog names the folder being opened and the step it is on", () => {
    const markup = html(<FolderSwitchDialog folder="/Users/me/specs/insurance" step="opening" />);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Switching spec folder");
    expect(markup).toContain("<strong>insurance</strong>");
    expect(markup).toContain("/Users/me/specs/insurance");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuetext="Opening the folder"');
  });

  test("the steps read done → current → pending as the switch advances", () => {
    const classes = (markup: string) =>
      [...markup.matchAll(/class="switch-step (\w+)"/g)].map((m) => m[1]);
    expect(SWITCH_STEPS.map((s) => s.id)).toEqual(["saving", "opening", "loading"]);
    expect(classes(html(<FolderSwitchDialog folder="/a" step="saving" />))).toEqual([
      "current",
      "pending",
      "pending",
    ]);
    expect(classes(html(<FolderSwitchDialog folder="/a" step="opening" />))).toEqual([
      "done",
      "current",
      "pending",
    ]);
    expect(classes(html(<FolderSwitchDialog folder="/a" step="loading" />))).toEqual([
      "done",
      "done",
      "current",
    ]);
    expect(html(<FolderSwitchDialog folder="/a" step="loading" />)).toContain('aria-current="step"');
  });

  test("nothing on it can be pressed — no buttons, and it says the rest waits", () => {
    const markup = html(<FolderSwitchDialog folder="/a" step="saving" />);
    expect(markup).not.toContain("<button");
    expect(markup).toContain("Everything else waits until the folder has loaded.");
    // Its own backdrop, stacked above every other dialog.
    expect(markup).toContain('class="dialog-backdrop switch-backdrop"');
  });
});

describe("SpecFoldersDialog — Manage specification folders", () => {
  const spec = (path: string): FolderEntry => ({ path, kind: "spec" });
  const code = (path: string): FolderEntry => ({ path, kind: "code" });
  const folders = [spec("/specs/insurance"), spec("/specs/banking"), spec("https://github.com/acme/specs")];
  const render = (current: FolderEntry | null = spec("/specs/insurance"), busy = false) =>
    html(
      <SpecFoldersDialog
        folders={folders}
        current={current}
        busy={busy}
        onOpen={noop}
        onRemove={noop}
        onAdd={noop}
        onClose={noop}
      />,
    );

  test("lists every folder by name with its path, the open one badged", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Folders"');
    expect(markup.match(/class="spec-folder spec-folder-spec( current)?"/g)).toHaveLength(3);
    expect(markup).toContain("insurance<span class=\"spec-folder-badge\">open</span>");
    expect(markup).toContain("banking");
    expect(markup).toContain('title="/specs/banking"');
    expect(markup).toContain("https://github.com/acme/specs");
    expect(markup.match(/ current"/g)).toHaveLength(1);
  });

  test("every folder but the open one can be opened or removed from the list", () => {
    const markup = render();
    expect(markup.match(/>Open<\/button>/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Remove banking from the list"');
    expect(markup).toContain('title="Remove from the list — the folder itself stays on disk"');
    // The open folder's remove button is there but inert, with the reason.
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Remove insurance from the list"/,
    );
    expect(markup).toContain("switch to another folder first");
  });

  test("a GitHub url shows the folder it is cloned to", () => {
    const markup = html(
      <SpecFoldersDialog
        folders={folders}
        current={spec("/specs/insurance")}
        dirs={{ "https://github.com/acme/specs": "/Users/me/repos/specs" }}
        onOpen={noop}
        onRemove={noop}
        onAdd={noop}
        onClose={noop}
      />,
    );
    expect(markup).toContain("Cloned to /Users/me/repos/specs");
    expect(markup).toContain('title="/Users/me/repos/specs"');
    // Local folders are already their own path.
    expect(markup.match(/Cloned to/g)).toHaveLength(1);
  });

  test("offers to open another folder from the file system, and to close", () => {
    const markup = render();
    expect(markup).toContain(">Open another folder…</button>");
    expect(markup).toContain(">Close</button>");
    expect(markup).toContain("the folder stays on disk");
  });

  test("while a request runs, the folder actions wait", () => {
    const markup = render(spec("/specs/insurance"), true);
    const disabled = markup.match(/<button[^>]*disabled=""/g) ?? [];
    // Two Open, three remove, and Open another folder… — Close stays live.
    expect(disabled).toHaveLength(6);
    expect(markup).toMatch(/<button type="button"(?: [^>]*)?>Close<\/button>/);
  });

  test("with no folders yet, says so", () => {
    const markup = html(
      <SpecFoldersDialog folders={[]} current={null} onOpen={noop} onRemove={noop} onAdd={noop} onClose={noop} />,
    );
    expect(markup).toContain("No folders yet.");
    expect(markup).not.toContain('class="spec-folders"');
  });

  // Code repositories (specs/app/code-repo-mode.feature.md "Open a code
  // repository"): on the same list as the spec folders, each marked by kind.
  const mixed = [code("/code/app"), spec("/specs/insurance"), code("/code/lib")];
  const withCode = (current: FolderEntry) =>
    html(
      <SpecFoldersDialog
        folders={mixed}
        current={current}
        onOpen={noop}
        onRemove={noop}
        onAdd={noop}
        onAddCodeRepo={noop}
        onClose={noop}
      />,
    );

  test("spec folders and code repositories share one list, in the given order, each marked by its kind", () => {
    const markup = withCode(spec("/specs/insurance"));
    expect(markup.match(/<ul /g)).toHaveLength(1);
    const kinds = [...markup.matchAll(/class="spec-folder spec-folder-(spec|code)/g)].map((m) => m[1]);
    expect(kinds).toEqual(["code", "spec", "code"]);
    expect(markup.match(/aria-label="Code repository"/g)).toHaveLength(2);
    expect(markup.match(/aria-label="Specification folder"/g)).toHaveLength(1);
    expect(markup).toContain("specification folders and code repositories");
    expect(markup).toContain(">Open a code repository…</button>");
  });

  test("the open folder is badged whether it is a spec folder or a code repository", () => {
    const specsOpen = withCode(spec("/specs/insurance"));
    expect(specsOpen.match(/spec-folder-badge/g)).toHaveLength(1);
    expect(specsOpen).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove insurance from the list"/);
    const codeOpen = withCode(code("/code/app"));
    expect(codeOpen.match(/spec-folder-badge/g)).toHaveLength(1);
    // The open code repository stays; the spec folder may now be removed or opened.
    expect(codeOpen).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove app from the list"/);
    expect(codeOpen).toContain('title="Open /specs/insurance"');
  });

  test("the same path as a spec folder and as a code repository is two entries, only the open kind badged", () => {
    const markup = html(
      <SpecFoldersDialog
        folders={[code("/work/repo"), spec("/work/repo")]}
        current={code("/work/repo")}
        onOpen={noop}
        onRemove={noop}
        onAdd={noop}
        onAddCodeRepo={noop}
        onClose={noop}
      />,
    );
    expect(markup.match(/spec-folder-badge/g)).toHaveLength(1);
    expect(markup).toContain('class="spec-folder spec-folder-code current"');
    expect(markup).toContain('title="Open /work/repo"');
  });

  test("where code repositories cannot be opened, the dialog has none of it", () => {
    const markup = html(
      <SpecFoldersDialog folders={[spec("/specs/a")]} current={spec("/specs/a")} onOpen={noop} onRemove={noop} onAdd={noop} onClose={noop} />,
    );
    expect(markup).not.toContain("code repositor");
    expect(markup).not.toContain("Open a code repository");
  });

  test("Open and Remove hand back the entry with its kind", () => {
    const window = new Window({ url: "http://localhost/" });
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { window: g.window, document: g.document, act: g.IS_REACT_ACT_ENVIRONMENT };
    g.window = window;
    g.document = window.document;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      const opened: FolderEntry[] = [];
      const removed: FolderEntry[] = [];
      const host = window.document.createElement("div");
      window.document.body.appendChild(host);
      const root = createRoot(host as unknown as HTMLElement);
      act(() =>
        root.render(
          <SpecFoldersDialog
            folders={mixed}
            current={spec("/specs/insurance")}
            onOpen={(f) => opened.push(f)}
            onRemove={(f) => removed.push(f)}
            onAdd={noop}
            onAddCodeRepo={noop}
            onClose={noop}
          />,
        ),
      );
      const button = (selector: string) => host.querySelector(selector) as unknown as HTMLButtonElement;
      act(() => button('button[title="Open /code/lib"]').click());
      act(() => button('button[aria-label="Remove app from the list"]').click());
      expect(opened).toEqual([code("/code/lib")]);
      expect(removed).toEqual([code("/code/app")]);
      act(() => root.unmount());
    } finally {
      g.window = saved.window;
      g.document = saved.document;
      g.IS_REACT_ACT_ENVIRONMENT = saved.act;
      void window.happyDOM.close();
    }
  });
});

describe("parseRecentFolders", () => {
  test("keeps well-formed entries in order and drops the rest", () => {
    expect(
      parseRecentFolders([
        { path: "/a", kind: "spec" },
        { path: "/b", kind: "code" },
        { path: "/c", kind: "other" },
        { kind: "spec" },
        "/d",
        null,
      ]),
    ).toEqual([
      { path: "/a", kind: "spec" },
      { path: "/b", kind: "code" },
    ]);
    expect(parseRecentFolders(undefined)).toEqual([]);
  });
});

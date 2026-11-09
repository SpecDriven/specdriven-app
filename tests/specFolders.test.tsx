// Spec folders (specs/app/spec-folders.feature.md): the two dialogs in
// src/frontend/SpecFolders.tsx as static markup — the modal that covers the
// app while a folder switch runs, and the list where folders are opened,
// removed or added. App.tsx owns the state; what these check is what the
// user is shown for a given state.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderSwitchDialog, SWITCH_STEPS, SpecFoldersDialog } from "../src/frontend/SpecFolders";

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
  const folders = ["/specs/insurance", "/specs/banking", "https://github.com/acme/specs"];
  const render = (current: string | null = "/specs/insurance", busy = false) =>
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
    expect(markup).toContain('aria-label="Spec folders"');
    expect(markup.match(/class="spec-folder( current)?"/g)).toHaveLength(3);
    expect(markup).toContain("insurance<span class=\"spec-folder-badge\">open</span>");
    expect(markup).toContain("banking");
    expect(markup).toContain('title="/specs/banking"');
    expect(markup).toContain("https://github.com/acme/specs");
    expect(markup.match(/class="spec-folder current"/g)).toHaveLength(1);
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
        current="/specs/insurance"
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
    const markup = render("/specs/insurance", true);
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
});

// Code repositories (specs/app/code-repo-mode.feature.md "Open a code
// repository"): a second list in the same dialog, where they can be opened.
describe("SpecFoldersDialog — Code repositories", () => {
  const withCode = (currentCodeRepo: string | null) =>
    html(
      <SpecFoldersDialog
        folders={["/specs/insurance"]}
        current={currentCodeRepo ? null : "/specs/insurance"}
        onOpen={noop}
        onRemove={noop}
        onAdd={noop}
        onClose={noop}
        codeRepos={["/code/app", "/code/lib"]}
        currentCodeRepo={currentCodeRepo}
        onOpenCodeRepo={noop}
        onRemoveCodeRepo={noop}
        onAddCodeRepo={noop}
      />,
    );

  test("lists the code repositories opened before, with Open a code repository…", () => {
    const markup = withCode(null);
    expect(markup).toContain("Code repositories");
    expect(markup).toContain('aria-label="Code repositories"');
    expect(markup).toContain("/code/app");
    expect(markup).toContain("/code/lib");
    expect(markup).toContain(">Open a code repository…</button>");
  });

  test("the open folder is badged whether it is a spec folder or a code repository", () => {
    const specsOpen = withCode(null);
    expect(specsOpen.match(/spec-folder-badge/g)).toHaveLength(1);
    expect(specsOpen).toContain('aria-label="Remove insurance from the list"');
    const codeOpen = withCode("/code/app");
    expect(codeOpen.match(/spec-folder-badge/g)).toHaveLength(1);
    // The open code repository stays; the spec folder may now be removed or opened.
    expect(codeOpen).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove app from the list"/);
    expect(codeOpen).toContain('title="Open /specs/insurance"');
  });

  test("where code repositories cannot be opened, the dialog has none of it", () => {
    const markup = html(
      <SpecFoldersDialog folders={["/specs/a"]} current="/specs/a" onOpen={noop} onRemove={noop} onAdd={noop} onClose={noop} />,
    );
    expect(markup).not.toContain("Code repositories");
    expect(markup).not.toContain("Open a code repository");
  });
});

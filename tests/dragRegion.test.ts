// The macOS drag regions (specs/app/desktop-app.feature.md "Window"): with the
// title bar hidden, the sidebar header and the editor pane's header row double
// as the window drag regions, so the window moves from the top of either pane
// alike. A drag region swallows the clicks of everything inside it, so each
// control in those headers has to opt back out with `-webkit-app-region:
// no-drag` — and a control that forgets is not subtly off, it is dead:
// clicking it drags the window instead. That is desktop-only and macOS-only,
// which is exactly the path no browser test covers, so the sidebar header's
// icons stayed broken while the same buttons worked in the web app.
//
// happy-dom parses selectors but drops `-webkit-app-region` from its CSSOM
// entirely, so the stylesheet's declarations are read from the file and the
// DOM is used only for what it is good at: telling which selectors actually
// match a given element. The result is a check on behaviour — what the
// cascade resolves to for each header control — rather than on the presence
// of some line of CSS.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const CSS = readFileSync(join(import.meta.dir, "../src/frontend/index.css"), "utf8");

type Decl = { selector: string; value: string; order: number };

/**
 * Every `-webkit-app-region` declaration in the stylesheet, paired with the
 * selector that carries it, in source order. Comments go first so a `}` or a
 * property name mentioned in prose cannot be mistaken for code — this file's
 * CSS is heavily commented.
 */
function appRegionDeclarations(css: string): Decl[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Decl[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let order = 0;
  while ((m = rule.exec(code))) {
    const body = m[2]!;
    const decl = /-webkit-app-region\s*:\s*([a-z-]+)/.exec(body);
    if (!decl) continue;
    for (const selector of m[1]!.split(",")) {
      out.push({ selector: selector.trim(), value: decl[1]!, order: order++ });
    }
  }
  return out;
}

/** `a.b .c[d]` → [ids, classes+attributes+pseudo-classes, elements]. */
function specificity(selector: string): [number, number, number] {
  const s = selector.replace(/::[a-z-]+/g, "");
  const ids = s.match(/#[\w-]+/g)?.length ?? 0;
  const classes =
    (s.match(/\.[\w-]+/g)?.length ?? 0) +
    (s.match(/\[[^\]]*\]/g)?.length ?? 0) +
    (s.match(/:(?!:)[\w-]+/g)?.length ?? 0);
  const elements = s.replace(/[.#:[][^\s>+~]*/g, " ").match(/\b[a-z][\w-]*/g)?.length ?? 0;
  return [ids, classes, elements];
}

const DECLS = appRegionDeclarations(CSS);

/** Higher specificity wins; equal specificity goes to the later rule. */
function wins(a: Decl, b: Decl): boolean {
  const ra = specificity(a.selector);
  const rb = specificity(b.selector);
  for (let i = 0; i < 3; i++) {
    if (ra[i]! !== rb[i]!) return ra[i]! > rb[i]!;
  }
  return a.order > b.order;
}

/** What the cascade resolves `-webkit-app-region` to for `el`. */
function appRegionOf(el: Element): string {
  let winner: Decl | null = null;
  for (const d of DECLS) {
    if (!el.matches(d.selector)) continue;
    if (winner === null || wins(d, winner)) winner = d;
  }
  // No rule at all means the element simply inherits its container's region.
  return winner?.value ?? "inherit";
}

/**
 * The sidebar header as App.tsx renders it on macOS: the folder name and its
 * recent-folders menu, the Sync button, then the icon row — the
 * Pomodoro's timer, the coding agent's Bot, and the sidebar collapse toggle.
 */
const HEADER = `
  <aside>
    <header>
      <h1><img class="logo" alt="" /></h1>
      <div class="repo-row">
        <a class="repo-name" href="/">specs-demo</a>
        <div class="repo-recent">
          <button type="button" class="repo-recent-toggle">▾</button>
          <div class="repo-recent-menu"><button type="button" class="menu-item">a folder</button></div>
        </div>
        <button type="button" class="repo-sync">Sync</button>
      </div>
      <button type="button" class="ibtn pomodoro-toggle" aria-label="Pomodoro">timer</button>
      <button type="button" class="ibtn" aria-label="Coding agent pane">bot</button>
      <button type="button" class="ibtn collapse-btn" aria-label="Collapse the sidebar">panel</button>
    </header>
  </aside>
`;

/**
 * The editor pane's header as App.tsx renders a feature on macOS: the trail
 * (folder link, folder button, the feature's name as the rename button), then
 * the action icons with the More menu — and, below the header, the page body
 * with an icon button of its own, which is not window chrome.
 */
const EDITOR_HEADER = `
  <main>
    <section class="editor">
      <header class="editor-bar page-header">
        <nav class="crumbs" aria-label="Breadcrumb">
          <ol>
            <li><a class="crumb" href="/">specs-demo</a></li>
            <li><button type="button" class="crumb">a folder</button></li>
            <li class="crumb-tail" aria-current="page">
              <button type="button" class="crumb current">A feature</button>
            </li>
          </ol>
        </nav>
        <div class="editor-actions page-actions">
          <button type="button" class="ibtn" aria-label="Edit description">pencil</button>
          <span class="page-more">
            <button type="button" class="ibtn" aria-label="More actions">more</button>
            <div role="menu" class="page-menu"><button type="button" role="menuitem">Rename feature</button></div>
          </span>
        </div>
      </header>
      <div class="feature-body">
        <button type="button" class="ibtn" aria-label="Add scenario">plus</button>
      </div>
    </section>
  </main>
`;

function headerDocument(desktop: string | null, markup = HEADER) {
  const document = new Window().document as unknown as Document;
  if (desktop !== null) document.documentElement.setAttribute("data-desktop", desktop);
  document.body.innerHTML = markup;
  return document;
}

describe("the macOS drag region", () => {
  test("the sidebar header is the drag region", () => {
    const document = headerDocument("darwin");
    expect(appRegionOf(document.querySelector("aside header")!)).toBe("drag");
  });

  test("every control in the header stays clickable", () => {
    const document = headerDocument("darwin");
    const controls = document.querySelectorAll("aside header button, aside header a");
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const name = control.getAttribute("aria-label") ?? control.className ?? control.tagName;
      expect(`${name}: ${appRegionOf(control)}`).toBe(`${name}: no-drag`);
    }
  });

  // The three icons at the header's right are the ones this rule was written
  // for: they carried no `no-drag` of their own, so on macOS every click on
  // them dragged the window instead of opening the pane they name.
  test("the header's icon buttons stay clickable", () => {
    const document = headerDocument("darwin");
    const icons = document.querySelectorAll("aside header .ibtn");
    expect(icons.length).toBe(3);
    for (const icon of icons) expect(appRegionOf(icon)).toBe("no-drag");
  });

  // On Windows and Linux the window wears the system title bar, and in a
  // browser there is no window chrome at all: the header is an ordinary
  // header, so nothing there is a drag region to escape. (Some controls
  // still carry a `no-drag` of their own, which is inert with no drag
  // region around them.)
  test("off macOS the header is not a drag region", () => {
    for (const desktop of ["other", null]) {
      const document = headerDocument(desktop);
      expect(appRegionOf(document.querySelector("aside header")!)).toBe("inherit");
      for (const icon of document.querySelectorAll("aside header .ibtn")) {
        expect(appRegionOf(icon)).toBe("inherit");
      }
    }
  });

  // The right pane's top used to be dead: the breadcrumb row began below the
  // top edge strip and neither it nor the gap above it moved the window, so
  // a grab near the top worked on the sidebar and failed on the editor.
  test("the editor pane's header is a drag region too", () => {
    const document = headerDocument("darwin", EDITOR_HEADER);
    expect(appRegionOf(document.querySelector(".editor .page-header")!)).toBe("drag");
  });

  test("every control in the editor header stays clickable", () => {
    const document = headerDocument("darwin", EDITOR_HEADER);
    const controls = document.querySelectorAll(
      ".page-header button, .page-header a, .page-header input, .page-header [role='menu']",
    );
    expect(controls.length).toBe(7);
    for (const control of controls) {
      const name = control.getAttribute("aria-label") ?? control.className ?? control.tagName;
      expect(`${name}: ${appRegionOf(control)}`).toBe(`${name}: no-drag`);
    }
  });

  test("off macOS the editor header is not a drag region", () => {
    for (const desktop of ["other", null]) {
      const document = headerDocument(desktop, EDITOR_HEADER);
      expect(appRegionOf(document.querySelector(".editor .page-header")!)).toBe("inherit");
      for (const icon of document.querySelectorAll(".page-header .ibtn")) {
        expect(appRegionOf(icon)).toBe("inherit");
      }
    }
  });

  // `.ibtn` is the app's icon-button styling, used all over the page. Only
  // the ones in the two drag-region headers need the opt-out; a blanket rule
  // on `.ibtn` would be a claim about buttons that have nothing to do with
  // the window chrome.
  test("the opt-out is scoped to the two headers", () => {
    const document = headerDocument("darwin", EDITOR_HEADER);
    expect(appRegionOf(document.querySelector(".feature-body .ibtn")!)).toBe("inherit");
  });
});

// Automates specs/app/code-repo-mode.feature.md "Source files are highlighted
// by language": which language a file in the Files tab is taken for, every
// grammar painting its keywords, strings and comments in the app's colours,
// and the editor staying the plain one in every other respect.
//
// The grammars are checked on an editor state, with no DOM; the last tests
// mount the editor itself in a DOM borrowed from happy-dom — only the
// globals React and CodeMirror touch, given back afterwards, as
// tests/descriptionFolderSwitch.test.tsx explains.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree, getIndentation, highlightingFor } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { codeStyle, jsonKeyStyle, markdownStyle } from "../src/frontend/editorHighlight";
import { languageOf, loadLanguage, LANGUAGE_NAMES, type CodeLanguage } from "../src/frontend/files/codeLanguage";
import { CodeEditor } from "../src/frontend/files/CodeEditor";

// --- Which language a file is ---------------------------------------------------

test("a file's extension picks its language, whatever its case or folder", () => {
  const cases: Record<string, CodeLanguage> = {
    "src/main/java/App.java": "java",
    "index.js": "javascript",
    "lib/a.mjs": "javascript",
    "lib/a.cjs": "javascript",
    "ui/App.jsx": "javascript",
    "src/index.ts": "typescript",
    "src/a.mts": "typescript",
    "src/a.cts": "typescript",
    "ui/App.tsx": "typescript",
    "types/a.d.ts": "typescript",
    "tools/build.py": "python",
    "stubs/a.pyi": "python",
    "install.sh": "bash",
    "x.bash": "bash",
    "x.zsh": "bash",
    "db/schema.sql": "sql",
    "db/SCHEMA.SQL": "sql",
    ".github/workflows/ci.yml": "yaml",
    "compose.yaml": "yaml",
    "package.json": "json",
    ".vscode/settings.jsonc": "json",
    "README.md": "markdown",
    "docs/x.MARKDOWN": "markdown",
  };
  for (const [path, language] of Object.entries(cases)) expect(languageOf(path), path).toBe(language);
});

test("a file in no known language is plain text", () => {
  for (const path of ["LICENSE", "Makefile", "notes.txt", "a.rs", "src/json", ".gitignore", "a.sql.bak"]) {
    expect(languageOf(path), path).toBe(null);
  }
});

test("a shell start-up file is Bash by its name", () => {
  for (const path of [".bashrc", "home/.zshrc", ".profile", ".envrc"]) expect(languageOf(path), path).toBe("bash");
});

test("a script with no extension is the language its first line runs it with", () => {
  expect(languageOf("bin/deploy", "#!/bin/bash\nset -e\n")).toBe("bash");
  expect(languageOf("gradlew", "#!/bin/sh\n")).toBe("bash");
  expect(languageOf("bin/run", "#!/usr/bin/env zsh\n")).toBe("bash");
  expect(languageOf("bin/tool", "#!/usr/bin/env python3\nimport sys\n")).toBe("python");
  expect(languageOf("bin/tool", "#!/usr/bin/python3.12")).toBe("python");
  expect(languageOf("bin/cli", "#!/usr/bin/env -S FOO=1 node --enable-source-maps\n")).toBe("javascript");
  expect(languageOf("bin/cli", "#! /usr/bin/env bun\n")).toBe("javascript");
  // Not a language shown here, not a script, and an extension always wins.
  expect(languageOf("bin/x", "#!/usr/bin/perl\n")).toBe(null);
  expect(languageOf("bin/x", "#!/usr/bin/env\n")).toBe(null);
  expect(languageOf("bin/x", "echo hi\n#!/bin/bash\n")).toBe(null);
  expect(languageOf("notes.txt", "#!/bin/bash\n")).toBe(null);
});

// --- What each grammar paints ---------------------------------------------------

/** The CSS variable each class of the editor's highlight styles paints its text in. */
const COLOURS = new Map<string, string>();
for (const style of [codeStyle, jsonKeyStyle, markdownStyle]) {
  for (const [, cls, colour] of style.module!.getRules().matchAll(/\.(\S+) \{[^}]*?color: var\((--[\w-]+)\)/g)) {
    COLOURS.set(cls!, colour!);
  }
}
const colourOf = (classes: string) => classes.split(" ").map((cls) => COLOURS.get(cls)).find(Boolean);

/** Every painted run of `text` as `[its text, its colour]`, in order, as the editor's own styles paint it. */
async function painted(path: string, text: string): Promise<[string, string][]> {
  const language = languageOf(path, text);
  if (!language) return [];
  const state = EditorState.create({ doc: text, extensions: [await loadLanguage(language, path)] });
  const tree = ensureSyntaxTree(state, text.length, 5000)!;
  const runs: [string, string][] = [];
  highlightTree(tree, { style: (tags) => highlightingFor(state, tags) }, (from, to, classes) => {
    const colour = colourOf(classes);
    if (colour) runs.push([text.slice(from, to), colour]);
  });
  return runs;
}

const SAMPLES: { path: string; text: string; expected: [string, string][] }[] = [
  {
    path: "App.java",
    text: 'public class App {\n  // entry\n  int n = 42;\n  String s = "hi";\n  void run() { go(null, true); }\n}\n',
    expected: [
      ["public", "--syntax-keyword"],
      ["class", "--syntax-keyword"],
      ["// entry", "--syntax-comment"],
      ["int", "--syntax-type"],
      ["42", "--syntax-constant"],
      ["String", "--syntax-type"],
      ['"hi"', "--syntax-string"],
      ["go", "--syntax-name"],
      ["null", "--syntax-constant"],
      ["true", "--syntax-constant"],
    ],
  },
  {
    path: "a.js",
    text: 'const n = 1; // one\nfunction f() { return <b title="x">{n}</b>; }\nlog(`a${n}`, /re/, null);\n',
    expected: [
      ["const", "--syntax-keyword"],
      ["1", "--syntax-constant"],
      ["// one", "--syntax-comment"],
      ["function", "--syntax-keyword"],
      ["f", "--syntax-name"],
      ["return", "--syntax-keyword"],
      ["b", "--syntax-type"],
      ["title", "--syntax-property"],
      ['"x"', "--syntax-string"],
      ["log", "--syntax-name"],
      ["/re/", "--syntax-string"],
      ["null", "--syntax-constant"],
    ],
  },
  {
    path: "a.ts",
    text: 'interface A { n: number }\nconst a = <A>{ n: 1 };\nexport const s: string = "x"; /* c */\n',
    expected: [
      ["interface", "--syntax-keyword"],
      ["A", "--syntax-type"],
      ["number", "--syntax-type"],
      ["const", "--syntax-keyword"],
      ["1", "--syntax-constant"],
      ["export", "--syntax-keyword"],
      ["string", "--syntax-type"],
      ['"x"', "--syntax-string"],
      ["/* c */", "--syntax-comment"],
    ],
  },
  {
    path: "App.tsx",
    text: "const el = <App n={1} />;\n",
    expected: [
      ["const", "--syntax-keyword"],
      ["App", "--syntax-type"],
      ["n", "--syntax-property"],
      ["1", "--syntax-constant"],
    ],
  },
  {
    path: "a.py",
    text: 'import os\n\ndef main(n):\n    # go\n    if n is None:\n        return "x"\n    print(1.5, True)\n',
    expected: [
      ["import", "--syntax-keyword"],
      ["def", "--syntax-keyword"],
      ["main", "--syntax-name"],
      ["# go", "--syntax-comment"],
      ["if", "--syntax-keyword"],
      ["is", "--syntax-keyword"],
      ["None", "--syntax-constant"],
      ["return", "--syntax-keyword"],
      ['"x"', "--syntax-string"],
      ["1.5", "--syntax-constant"],
      ["True", "--syntax-constant"],
    ],
  },
  {
    path: "run.sh",
    text: '#!/bin/bash\n# build\nif [ -f "$1" ]; then\n  echo "ok" 42\nfi\n',
    expected: [
      ["# build", "--syntax-comment"],
      ["if", "--syntax-keyword"],
      ['"ok"', "--syntax-string"],
      ["echo", "--syntax-name"],
      ["42", "--syntax-constant"],
      ["fi", "--syntax-keyword"],
    ],
  },
  {
    path: "q.sql",
    text: "-- totals\nSELECT name, COUNT(*) FROM t WHERE id = 7 AND tag = 'a' AND x IS NULL;\n",
    expected: [
      ["-- totals", "--syntax-comment"],
      ["SELECT", "--syntax-keyword"],
      ["FROM", "--syntax-keyword"],
      ["WHERE", "--syntax-keyword"],
      ["7", "--syntax-constant"],
      ["'a'", "--syntax-string"],
      ["NULL", "--syntax-constant"],
    ],
  },
  {
    path: "ci.yml",
    text: '# pipeline\nname: build\non:\n  push:\n    branches: ["main"]\n',
    expected: [
      ["# pipeline", "--syntax-comment"],
      ["name", "--syntax-property"],
      ["on", "--syntax-property"],
      ["branches", "--syntax-property"],
      ['"main"', "--syntax-string"],
    ],
  },
  {
    path: "package.json",
    text: '{ "name": "x", "n": 1, "ok": true, "none": null }\n',
    expected: [
      ['"name"', "--syntax-property"],
      ['"x"', "--syntax-string"],
      ["1", "--syntax-constant"],
      ["true", "--syntax-constant"],
      ["null", "--syntax-constant"],
    ],
  },
];

describe("a file is painted in its language's colours", () => {
  test("every language paints its keywords, strings, constants, comments, types and names", async () => {
    for (const { path, text, expected } of SAMPLES) {
      const runs = await painted(path, text);
      const language = LANGUAGE_NAMES[languageOf(path, text)!];
      for (const run of expected) expect(runs, `${language} (${path}): ${run[0]} as ${run[1]}`).toContainEqual(run);
    }
    // One sample for each language the editor knows but Markdown, which has its own colours.
    const sampled = new Set(SAMPLES.map(({ path, text }) => languageOf(path, text)));
    expect([...sampled].sort() as string[]).toEqual(Object.keys(LANGUAGE_NAMES).filter((id) => id !== "markdown").sort());
  });

  test("names, operators and brackets stay the text's own colour", async () => {
    const runs = await painted("a.js", "let total = count + (other * 2);\n");
    expect(runs).toEqual([
      ["let", "--syntax-keyword"],
      ["2", "--syntax-constant"],
    ]);
  });

  test("a member read is not painted in a program, a key is in JSON", async () => {
    expect(await painted("a.py", "a.b = c.d\n")).toEqual([]);
    expect(await painted("a.json", '{"b": {}}')).toEqual([['"b"', "--syntax-property"]]);
  });

  test("Markdown keeps its own colours", async () => {
    const runs = await painted("README.md", "# Title\n\nSee [docs](https://x.dev).\n");
    expect(runs).toContainEqual([" Title", "--accent-strong"]);
    expect(runs).toContainEqual(["docs", "--accent"]);
  });
});

test("Enter keeps the line's own indentation, never the grammar's", async () => {
  for (const { path, text } of SAMPLES) {
    const language = languageOf(path, text)!;
    const state = EditorState.create({ doc: text, extensions: [await loadLanguage(language, path)] });
    ensureSyntaxTree(state, text.length, 5000);
    for (let line = 1; line <= state.doc.lines; line++) {
      expect(getIndentation(state, state.doc.line(line).to), `${path}:${line}`).toBe(null);
    }
  }
});

// --- The editor, in a DOM -------------------------------------------------------

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
  "getComputedStyle",
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

describe("the Files tab's editor", () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
  });

  async function mount(path: string, value: string, vim = false) {
    root = createRoot(host!);
    const noop = () => {};
    await act(async () => root!.render(<CodeEditor path={path} value={value} vim={vim} onChange={noop} onSave={noop} />));
    // The grammar arrives after the editor does (and the editor after Vim's keys).
    const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    const plain = () => host!.querySelector<HTMLElement>(".code-source")?.dataset.language === "text";
    await tick();
    for (let i = 0; i < 50 && !plain() && !host!.querySelector(".cm-content span"); i++) await tick();
    return EditorView.findFromDOM(host!.querySelector<HTMLElement>(".cm-editor")!)!;
  }

  // specs/app/code-search.feature.md "A result opens the file at its line".
  test("a place asked of the editor is selected, at once and when asked later, a line past the end being the last", async () => {
    const text = "one\ntwo\n  three hello\nfour\n";
    const went: number[] = [];
    const render = (goto: { path: string; line: number; col: number; length: number; seq: number } | null) =>
      act(async () =>
        root!.render(
          <CodeEditor path="notes.txt" value={text} onChange={() => {}} onSave={() => {}} goto={goto} onWentTo={(seq) => went.push(seq)} />,
        ),
      );
    root = createRoot(host!);
    // Asked before the editor was there: a result in a file not yet open.
    await render({ path: "notes.txt", line: 3, col: 9, length: 5, seq: 1 });
    const view = EditorView.findFromDOM(host!.querySelector<HTMLElement>(".cm-editor")!)!;
    const selected = () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    expect(selected()).toBe("hello");
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
    expect(went).toEqual([1]);
    // Asked of the file already showing; the same request is not answered twice.
    await render({ path: "notes.txt", line: 2, col: 1, length: 3, seq: 2 });
    await render({ path: "notes.txt", line: 2, col: 1, length: 3, seq: 2 });
    expect(selected()).toBe("two");
    expect(went).toEqual([1, 2]);
    // The file changed since the search: the place is kept inside the text.
    await render({ path: "notes.txt", line: 99, col: 40, length: 5, seq: 3 });
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(view.state.doc.lines);
    // The focus stays out of the editor, so the results keep the arrow keys.
    expect(view.hasFocus).toBe(false);
  });

  /** The words the editor painted in `colour`. */
  function words(view: EditorView, colour: string): string[] {
    return [...view.contentDOM.querySelectorAll("span")]
      .filter((span) => colourOf(span.className) === colour)
      .map((span) => span.textContent ?? "");
  }

  test("a source file's keywords and strings are painted once its grammar has loaded", async () => {
    const view = await mount("tools/build.py", 'def main():\n    return "x"\n');
    expect(host!.querySelector<HTMLElement>(".code-source")!.dataset.language).toBe("python");
    expect(words(view, "--syntax-keyword")).toEqual(["def", "return"]);
    expect(words(view, "--syntax-string")).toEqual(['"x"']);
    // Still the file's own text, and still editable.
    expect(view.state.doc.toString()).toBe('def main():\n    return "x"\n');
    expect(view.state.readOnly).toBe(false);
  });

  test("a file in no known language shows as plain text", async () => {
    const view = await mount("LICENSE", "def main():\n");
    expect(host!.querySelector<HTMLElement>(".code-source")!.dataset.language).toBe("text");
    expect(view.contentDOM.querySelectorAll("span").length).toBe(0);
  });

  test("a source file is painted with Vim's keys on too", async () => {
    const view = await mount("db/schema.sql", "SELECT 1; -- one\n", true);
    expect(host!.querySelector(".code-source.md-vim")).not.toBeNull();
    expect(words(view, "--syntax-keyword")).toEqual(["SELECT"]);
    expect(words(view, "--syntax-comment")).toEqual(["-- one"]);
  });
});

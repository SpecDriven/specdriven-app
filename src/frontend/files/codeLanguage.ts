// Which language a file in the Files tab is highlighted as (specs/app/
// code-repo-mode.feature.md "Source files are highlighted by language"), and
// the CodeMirror grammar for it. The grammars load on demand: a specs-only
// user never opens a code file, and nobody needs all eight at once.
//
// Highlighting is all a grammar adds here. The editor stays the plain one:
// Enter keeps the line's own indentation rather than the grammar's idea of
// it (which assumes a two-space unit the file may not use), and nothing is
// completed or closed for the user.

import type { Extension } from "@codemirror/state";
import { indentService, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { codeStyle, jsonKeyStyle, markdownStyle } from "../editorHighlight";

export type CodeLanguage =
  | "java"
  | "javascript"
  | "typescript"
  | "python"
  | "bash"
  | "sql"
  | "yaml"
  | "json"
  | "markdown";

/** The name shown for each language. */
export const LANGUAGE_NAMES: Record<CodeLanguage, string> = {
  java: "Java",
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  bash: "Bash",
  sql: "SQL",
  yaml: "YAML",
  json: "JSON",
  markdown: "Markdown",
};

const BY_EXTENSION: Record<string, CodeLanguage> = {
  java: "java",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  py: "python",
  pyi: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ksh: "bash",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
};

// Shell start-up files have no extension to go by.
const SHELL_FILES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_aliases",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".envrc",
]);

// A script's first line names its interpreter: `#!/bin/bash`,
// `#!/usr/bin/env -S python3 -u`.
const BY_INTERPRETER: [RegExp, CodeLanguage][] = [
  [/^(ba|z|k|da|a)?sh$/, "bash"],
  [/^python[\d.]*$/, "python"],
  [/^(node|nodejs|bun|deno)$/, "javascript"],
];

function interpreterOf(firstLine: string): string | null {
  const m = /^#!\s*(\S+)(.*)$/.exec(firstLine);
  if (!m) return null;
  const name = (word: string) => word.slice(word.lastIndexOf("/") + 1);
  if (name(m[1]!) !== "env") return name(m[1]!);
  // `env` runs its first argument that is neither a flag nor an assignment.
  const arg = m[2]!.split(/\s+/).find((word) => word && !word.startsWith("-") && !word.includes("="));
  return arg ? name(arg) : null;
}

/**
 * The language a file is highlighted as, or null for plain text: by its
 * extension, then its name, then — for a file with no extension — the
 * interpreter its first line names.
 */
export function languageOf(path: string, text = ""): CodeLanguage | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot > 0) return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
  if (SHELL_FILES.has(name)) return "bash";
  const end = text.indexOf("\n");
  const interpreter = interpreterOf(end < 0 ? text.slice(0, 200) : text.slice(0, end));
  if (!interpreter) return null;
  return BY_INTERPRETER.find(([pattern]) => pattern.test(interpreter))?.[1] ?? null;
}

async function grammar(language: CodeLanguage, path: string): Promise<Extension> {
  switch (language) {
    case "java":
      return (await import("@codemirror/lang-java")).javaLanguage;
    case "javascript":
      // JSX parses plain JavaScript too, and `.js` files do hold JSX.
      return (await import("@codemirror/lang-javascript")).jsxLanguage;
    case "typescript": {
      // Not so for TypeScript: `<T>value` is a cast in `.ts` and a tag in `.tsx`.
      const js = await import("@codemirror/lang-javascript");
      return /\.tsx$/i.test(path) ? js.tsxLanguage : js.typescriptLanguage;
    }
    case "python":
      return (await import("@codemirror/lang-python")).pythonLanguage;
    case "bash":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "sql":
      return (await import("@codemirror/lang-sql")).StandardSQL.language;
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yamlLanguage;
    case "json":
      return [(await import("@codemirror/lang-json")).jsonLanguage, syntaxHighlighting(jsonKeyStyle)];
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
  }
}

/** The editor extension that highlights a file as `language`. */
export async function loadLanguage(language: CodeLanguage, path: string): Promise<Extension> {
  const parser = await grammar(language, path);
  if (language === "markdown") return [parser, syntaxHighlighting(markdownStyle)];
  return [parser, syntaxHighlighting(codeStyle), indentService.of(() => null)];
}

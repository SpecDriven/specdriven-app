// Names the "extract specs from a code project" flow makes up
// (specs/app/extract-specs-from-code.feature.md): the specification folder
// a project gets, and a folder's display name from a directory or package
// name. Pure, and free of imports: the dialog shares these with the server.

/** A language a project is analysed for (src/server/intentModules.ts). */
export type Language = "java" | "javascript" | "typescript" | "python";

/** Those languages, as the dialog names them. */
export const LANGUAGE_LABEL: Record<Language, string> = {
  java: "Java",
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
};

/**
 * The window event the desktop app's File menu sends the page to start
 * "Extract specs from a code project" (src/electron/main.ts).
 */
export const EXTRACT_SPECS_EVENT = "specdriven:extract-specs";

/** What a specification folder's name starts with (src/server/folderKind.ts knows the same prefix). */
const SPECS_REPO_PREFIX = "specs-";

/** The longest name GitHub takes for a repository. */
const MAX_REPO_NAME = 100;

/**
 * The specification folder a code project gets: `specs-<project folder>`,
 * with what GitHub would not take in a repository name turned into `-`. A
 * project already called `specs-…` keeps its name behind the prefix, so the
 * two never collide.
 */
export function specsRepoName(project: string): string {
  const clean = project
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `${SPECS_REPO_PREFIX}${clean || "project"}`.slice(0, MAX_REPO_NAME);
}

/**
 * Why a name cannot be a repository's, as one sentence, or null when it
 * can: GitHub takes letters, digits, `.`, `-` and `_`, up to 100
 * characters, and neither `.` nor `..`. The same name is the folder's on
 * disk, so the rule serves both.
 */
export function repoNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Give the specification folder a name";
  if (n.length > MAX_REPO_NAME) return `A name can be at most ${MAX_REPO_NAME} characters`;
  if (n === "." || n === "..") return "That name is not a folder's";
  if (!/^[A-Za-z0-9._-]+$/.test(n)) return "Use letters, digits, dots, dashes and underscores only";
  if (/\.git$/i.test(n)) return "A name cannot end in .git";
  return null;
}

/** Words that stay as written inside a display name. */
const KEEP_UPPER = new Set(["api", "ui", "cli", "sdk", "db", "id", "io", "http", "sql", "ai", "mcp", "sso", "ci", "cd", "pdf", "csv", "url", "ml"]);

/**
 * A directory, package or artifact name as a display name:
 * `billing-service` and `billingService` both read "Billing Service", an
 * npm scope goes (`@acme/web-ui` → "Web UI"), and a few short technical
 * words are upper-cased whole.
 */
export function displayName(raw: string): string {
  const unscoped = raw.trim().replace(/^@[^/]+\//, "");
  const words = unscoped
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words
    .map((w) => (KEEP_UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

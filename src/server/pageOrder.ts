// The order of the tasks in a folder (specs/app/tasks.feature.md "Reorder
// tasks by dragging"): an `order.txt` beside them, one file name per line,
// top to bottom. Kept out of the tasks themselves, whose markdown the editor
// shows whole, so a move rewrites one small file rather than a line on every
// task. The file is a hint, never the truth about which tasks exist: a task
// it does not name — a teammate's new one, a file dropped in by hand — is
// listed after the named ones in name order, and a name with no file behind
// it is skipped. Pure functions, so the listing, the routes and the sync's
// conflict pass (automerge/driftSync.ts) read and merge it the same way.

/** The order file's name, in each ordered folder and its subfolders. */
export const PAGE_ORDER_FILE = "order.txt";

/** True for a repo path that names an order file. */
export function isPageOrderFile(path: string): boolean {
  return path === PAGE_ORDER_FILE || path.endsWith(`/${PAGE_ORDER_FILE}`);
}

/** The file names an order file lists, blank lines and repeats dropped. */
export function parseOrder(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const name = line.trim();
    if (name && !name.includes("/")) seen.add(name);
  }
  return [...seen];
}

/** An order file's text: one name per line, ending with a newline. */
export function formatOrder(names: string[]): string {
  return names.length === 0 ? "" : `${names.join("\n")}\n`;
}

/**
 * Base names in the folder's order: those the order names first, as it
 * names them, then the rest in name order.
 */
export function inOrder(names: string[], order: string[]): string[] {
  const present = new Set(names);
  const listed = order.filter((name) => present.has(name));
  const placed = new Set(listed);
  const rest = names.filter((name) => !placed.has(name)).sort();
  return [...listed, ...rest];
}

/**
 * Three-way merge of an order file two teammates changed at once: a side
 * that left it as the base takes the other's; otherwise ours stands — the
 * move made here is what the person here sees — with every name only theirs
 * lists appended, so neither side's task drops out of the file.
 */
export function mergeOrder(base: string, ours: string, theirs: string): string {
  if (ours === base) return theirs;
  if (theirs === base || theirs === ours) return ours;
  const kept = parseOrder(ours);
  const known = new Set(kept);
  return formatOrder([...kept, ...parseOrder(theirs).filter((name) => !known.has(name))]);
}

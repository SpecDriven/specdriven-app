import type { MenuItemConstructorOptions } from "electron";

// The right-click menu (specs/editor/common-editor.feature.md "Spell check"):
// a browser offers one of its own, Electron offers none, so without this the
// desktop app's wavy underline under a misspelt word led nowhere. Over a
// misspelling the menu leads with the checker's suggestions, then an entry
// that teaches it the word; in any editable field it has the edit verbs; over
// a selection elsewhere, Copy. Anywhere else there is nothing to offer and no
// menu. Pure: main.ts hands it the event's params and the actions to run.

/** What the menu reads off Electron's ContextMenuParams. */
export interface ContextMenuInput {
  misspelledWord: string;
  dictionarySuggestions: string[];
  isEditable: boolean;
  selectionText: string;
}

/** What the menu's own entries do (the edit verbs are Electron roles). */
export interface ContextMenuActions {
  replaceMisspelling: (word: string) => void;
  addToDictionary: (word: string) => void;
}

/** Suggestions beyond this many are noise; the checker ranks them. */
export const MAX_SUGGESTIONS = 5;

/**
 * The menu for a right-click, or null when there is nothing to show.
 */
export function contextMenuTemplate(
  input: ContextMenuInput,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] | null {
  const items: MenuItemConstructorOptions[] = [];
  const word = input.misspelledWord;
  if (word && input.isEditable) {
    const suggestions = input.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    if (suggestions.length === 0) items.push({ label: "No guesses found", enabled: false });
    for (const s of suggestions)
      items.push({ label: s, click: () => actions.replaceMisspelling(s) });
    items.push({ type: "separator" });
    items.push({
      label: `Add “${word}” to Dictionary`,
      click: () => actions.addToDictionary(word),
    });
    items.push({ type: "separator" });
  }
  if (input.isEditable) {
    items.push({ role: "cut" }, { role: "copy" }, { role: "paste" });
    items.push({ type: "separator" }, { role: "selectAll" });
  } else if (input.selectionText.trim()) {
    items.push({ role: "copy" });
  }
  return items.length > 0 ? items : null;
}

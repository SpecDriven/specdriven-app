// Entity-field completion (specs/editor/data-model-integration-in-editor
// .feature.md): the `@firstName` / `@User.firstName` choices the scenario
// editor offers after `@` + Tab, read from GET /api/entity-fields — the
// Java classes and CDS entities in the project's code repo (src/server/
// entities.ts). Module-level state behind useSyncExternalStore, like the
// models store (src/frontend/eventModel/models.ts); loaded when an editor
// opens, forgotten when the data folder changes.
//
// The text helpers below are pure so the completion can be tested without
// a DOM: the same `atQuery` decides, for the textarea and for CodeMirror,
// whether the caret sits at the end of an `@…` run worth completing.

import { useSyncExternalStore } from "react";
import type { FieldChoice } from "../server/entities";
import type { Edit } from "./markdown";

export type { FieldChoice };

export interface EntityFieldsStore {
  fields: FieldChoice[];
  /** The code repo the fields came from; null when the project names none. */
  codeRepo: string | null;
  /** Whether GET /api/entity-fields has answered since the last reset. */
  loaded: boolean;
}

export const EMPTY_ENTITY_FIELDS: EntityFieldsStore = { fields: [], codeRepo: null, loaded: false };

let state: EntityFieldsStore = EMPTY_ENTITY_FIELDS;
const listeners = new Set<() => void>();

function set(next: EntityFieldsStore): void {
  state = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useEntityFields(): EntityFieldsStore {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

let inFlight: Promise<void> | null = null;

export const entityFields = {
  /**
   * Read the choices. Editors opening together share one request; a
   * failure leaves an empty list and says nothing — completion is a
   * convenience, not something to report on every editor open.
   */
  load(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const res = await fetch("/api/entity-fields");
        const data = (await res.json()) as { codeRepo: string | null; fields: FieldChoice[] };
        if (!res.ok || !Array.isArray(data.fields)) throw new Error("no fields");
        set({ fields: data.fields, codeRepo: data.codeRepo ?? null, loaded: true });
      } catch {
        set({ ...EMPTY_ENTITY_FIELDS, loaded: true });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  /** Forget everything — another data folder. */
  reset(): void {
    set(EMPTY_ENTITY_FIELDS);
  },
};

// ---- Text helpers (pure) ----

/**
 * The `@…` run the caret ends, if any: where it starts and what follows
 * the `@`. An `@` inside a word (`dana@acme`) or doubled (`@@`) is not one,
 * nor is a run the caret has left (`@Foo ` with the caret after the space).
 */
export function atQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|[^\w@])(@[\w.]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  const run = m[1]!;
  return { start: caret - run.length, query: run.slice(1) };
}

/**
 * The choices matching what was typed after the `@`, case-insensitively:
 * those whose field or label starts with it first, then those merely
 * containing it in their label, entity or field. Nothing typed offers the
 * first `limit` of them all.
 */
export function filterChoices(choices: FieldChoice[], query: string, limit = 40): FieldChoice[] {
  const q = query.toLowerCase();
  if (!q) return choices.slice(0, limit);
  const starts: FieldChoice[] = [];
  const contains: FieldChoice[] = [];
  for (const c of choices) {
    const label = c.label.slice(1).toLowerCase();
    const field = c.field.toLowerCase();
    if (label.startsWith(q) || field.startsWith(q)) starts.push(c);
    else if (label.includes(q) || field.includes(q) || c.entity.toLowerCase().includes(q)) contains.push(c);
  }
  return [...starts, ...contains].slice(0, limit);
}

/**
 * The text with the `@…` run from `start` to the caret replaced by the
 * choice, and the caret after it — no trailing space, since a `.` or `,`
 * may well follow.
 */
export function insertChoice(text: string, start: number, caret: number, choice: FieldChoice): Edit {
  const next = text.slice(0, start) + choice.insert + text.slice(caret);
  const at = start + choice.insert.length;
  return { text: next, start: at, end: at };
}

// What is done to a scenario from its editor pane and its card
// (specs/editor/spec-editor.feature.md): deleting and unpublishing it,
// leaving the pane — which saves — and landing on its card, a new scenario
// after it, a new version, its polarity, and moving it among the cards; and
// landing then sealing the editors before a feature's path changes. Moved
// out of App.tsx as they were, into a hook App.tsx calls: each handler sees
// the same render's values it saw there.

import { type RefObject, useEffect } from "react";
import { type Feature, type Scenario, serializeFeature } from "../../server/parser";
import { cleanLine } from "../../server/text";
import { type ConfirmOptions, type PromptOptions } from "../ModalPrompts";
import { type PromiseQueue } from "../promiseQueue";
import { resolvePendingTests } from "../testlinks";
import { toast } from "../Toasts";
import { type ScenarioRow, withOpenScenarios } from "../tree";
import { setUnpublishing, useEditorState } from "./editorState";
import { setCardMenu, setDescEdit } from "./featurePageState";
import { setFeatures } from "./listing";
import { setDirty, setEditing, setFeature, setSelectedScenario, useOpenFeature } from "./openFeature";
import {
  type Placement,
  cardOfScenario,
  featureFromResponse,
  insertAfterScenario,
  newScenarioDraft,
  scenarioSignature,
  withScenario,
  withScenarioMoved,
  withScenarioPolarity,
} from "./scenarioEdit";

export interface ScenarioOpsDeps {
  autosaveInFlight: RefObject<Promise<Placement> | null>;
  autosaved: RefObject<string | null>;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  deletingScenario: RefObject<boolean>;
  descSaveQueue: RefObject<PromiseQueue>;
  descTick: RefObject<() => Promise<void>>;
  draftVersion: number;
  editorRef: RefObject<{ close: () => Promise<{ ok: boolean; placed: Placement; }> | null; back: () => void; flush: () => Promise<void>; seal: () => void; }>;
  editorSession: RefObject<number>;
  featureEditorsRetiring: RefObject<boolean>;
  featureEditorsSealed: RefObject<boolean>;
  markSaved: () => void;
  nextVersionFor: (name: string, ignoreIndex?: number) => number;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  saveOnOpen: RefObject<boolean>;
  saveScenario: (tests: string[], close: boolean, status?: Scenario["status"]) => Promise<{ ok: boolean; placed: Placement; }> | null;
  scenarioSaveQueue: RefObject<PromiseQueue>;
  selectedRef: RefObject<string | null>;
}

export function useScenarioOps(deps: ScenarioOpsDeps) {
  const { editing, feature, selected } = useOpenFeature();
  const { publishing, testDraft, testEdit, testEditDraft, testNameDraft } = useEditorState();
  const {
    autosaveInFlight,
    autosaved,
    confirm,
    deletingScenario,
    descSaveQueue,
    descTick,
    draftVersion,
    editorRef,
    editorSession,
    featureEditorsRetiring,
    featureEditorsSealed,
    markSaved,
    nextVersionFor,
    prompt,
    saveOnOpen,
    saveScenario,
    scenarioSaveQueue,
    selectedRef,
  } = deps;
  /**
   * The confirmation a scenario delete asks for. A published scenario gets
   * the Danger Zone wording and a Confirm button
   * (specs/editor/spec-editor.feature.md "Delete Published Spec") — it is
   * published, immutable content, deletable only because Settings says so.
   */
  const confirmScenarioDelete = ({ name, version, status }: ScenarioRow) =>
    confirm(
      status === "published"
        ? {
            title: "Danger Zone!",
            body: `Confirm that you want to delete a Published spec — "${name}" v${version}.`,
            confirmLabel: "Confirm",
          }
        : {
            title: "Delete scenario",
            body:
              status === "draft"
                ? `Delete the draft "${name}" v${version}?`
                : `Delete "${name}" v${version}?`,
            confirmLabel: "Delete scenario",
          },
    );

  /**
   * Delete the dialog's scenario (specs/ui/ui.feature.md "Scenario editor"),
   * after a confirmation. Three removals, by what the scenario is: a
   * [proposed] one is saved out of the feature like any other edit; a draft —
   * which the `.feature.md` never held, so leaving it out of a save would
   * remove nothing — is deleted from the Automerge document through its own
   * route; and a [published] one (offered only while Settings allows it —
   * specs/editor/spec-editor.feature.md "Delete Published Spec") goes through
   * its own route too, which commits and pushes the removal right away.
   */
  const deleteScenario = async () => {
    if (!editing || editing.index === null || !feature || !selected) return;
    const idx = editing.index;
    // The entry as last saved, not the dialog's unsaved edits: that is what
    // the delete removes, and its name and version identify it to the server.
    const saved = feature.scenarios[idx];
    if (!saved) return;
    const { name, version } = saved;
    // From here on autosave stands down: a tick landing while the
    // confirmation is up could re-sort the feature under `idx`.
    deletingScenario.current = true;
    const ok = await confirmScenarioDelete(saved);
    if (!ok) {
      deletingScenario.current = false;
      return;
    }
    setEditing(null);
    await removeScenario(idx, saved, `Deleted scenario "${name}" v${version}.`);
  };

  /**
   * Back to proposed (specs/editor/spec-editor.feature.md "Unpublish a Spec"):
   * the published status chip's one action, offered only while Settings allows
   * deleting or moving published specs — the route checks the same switch,
   * and commits and pushes the demotion. The pane stays on the scenario, now
   * [proposed] and editable again; Publish takes it back.
   */
  const unpublishScenario = async () => {
    if (!editing || editing.index === null || !feature || !selected) return;
    const saved = feature.scenarios[editing.index];
    if (!saved || saved.status !== "published") return;
    const { name, version } = saved;
    const file = selected;
    const session = editorSession.current;
    setUnpublishing(true);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}/unpublish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: { name, version } }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Unpublish failed");
        return;
      }
      // Like a delete's answer: the feature's editor view, which goes to the
      // listing instead when another feature was opened meanwhile.
      const left = featureFromResponse(data, file);
      if (selectedRef.current === file) {
        setFeature(left);
        setDirty(false);
      } else {
        setFeatures((prev) => withOpenScenarios(prev, file, left));
      }
      if (session === editorSession.current) {
        setEditing((e) =>
          e && e.scenario.name === name && e.scenario.version === version
            ? { ...e, scenario: { ...e.scenario, status: "proposed" } }
            : e,
        );
      }
      toast.success(`Moved "${name}" v${version} back to proposed.`);
      markSaved();
    } catch {
      toast.error("Unpublish failed");
    } finally {
      setUnpublishing(false);
    }
  };

  /**
   * Take a scenario back out of the open feature, by what it is: a [proposed]
   * one is saved out of the feature like any other edit; a draft — which the
   * `.feature.md` never held — is deleted from the Automerge document through
   * its own route; a [published] one through the delete-published route,
   * which commits and pushes right away. The first two are local, picked up
   * by the reload cron. `saved` is the entry as last saved, at `idx` in the
   * feature.
   */
  const removeScenario = async (idx: number, saved: Scenario, done: string) => {
    if (!feature || !selected) return;
    const next: Feature = {
      ...feature,
      scenarios: feature.scenarios.filter((_, i) => i !== idx),
    };
    setFeature(next);
    // The keyboard highlight can't stay on the removed card; later cards
    // shift up one index.
    setSelectedScenario((prev) =>
      prev === null || prev === idx ? null : prev > idx ? prev - 1 : prev,
    );
    const file = selected;
    const url = `/api/features/${encodeURIComponent(file)}`;
    // Drafts and published scenarios go through their own routes — a draft
    // because the file never held it, a published one because both
    // immutability gates refuse a save without it
    // (specs/editor/spec-editor.feature.md "Delete Published Spec").
    const res =
      saved.status === "draft" || saved.status === "published"
        ? await fetch(`${url}/${saved.status === "draft" ? "delete-draft" : "delete-published"}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scenario: { name: saved.name, version: saved.version } }),
          })
        : await fetch(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: serializeFeature(next), save: true }),
          });
    const data = await res.json();
    // Another feature may have been opened while the delete was away — a
    // published one commits and pushes first — and then the answer is not
    // the feature on screen: it goes to the listing the tree reads it from.
    const stillHere = selectedRef.current === file;
    if (res.ok) {
      // Both routes answer with the editor's view of the feature — the file
      // content with the remaining drafts folded back in.
      const left = featureFromResponse(data, file);
      if (stillHere) {
        setFeature(left);
        setDirty(false);
      } else {
        setFeatures((prev) => withOpenScenarios(prev, file, left));
      }
      toast.success(done);
      markSaved();
    } else {
      if (stillHere) setDirty(true);
      toast.error(data.error ?? "Delete failed");
    }
  };

  /**
   * Leave the editor pane (specs/editor/spec-editor.feature.md "Spec editor
   * pane"): `<`, ESC and every navigation away from the feature leave the
   * scenario in its autosaved state — leaving discards nothing and reverts
   * nothing; Delete is the way to take a draft back out. One last save
   * catches what was typed since the previous tick — the test-link fields
   * included — so the state left behind is the pane's latest. Started before the editor state clears so it saves
   * under this editor session; while a tick is still in flight the parting
   * save follows it, placed where it lands. Returns the save when one went out.
   */
  const closeEditor = (): Promise<{ ok: boolean; placed: Placement }> | null => {
    let saving: Promise<{ ok: boolean; placed: Placement }> | null = null;
    if (
      !featureEditorsSealed.current &&
      editing &&
      editing.scenario.name.trim() && // no name, nothing to be saved under
      !deletingScenario.current
    ) {
      // A url still sitting in the add field or in an open ✎ row joins the
      // scenario on the way out, as if Add (or the row's Save) had been
      // pressed — it is never silently dropped (specs/traceability.feature.md).
      // A published scenario has no explicit save left to fold it in, so
      // leaving is the last chance. One that can't join the list has nowhere
      // to be reported once the pane is gone, so it is left behind rather
      // than holding the pane open.
      const tests = resolvePendingTests(
        editing.scenario.tests,
        testEdit === null ? null : { index: testEdit, ...testEditDraft },
        { url: testDraft, name: testNameDraft },
      ).tests;
      if (scenarioSignature({ ...editing.scenario, tests }, draftVersion) !== autosaved.current) {
        saving = saveScenario(tests, false);
      }
    }
    setEditing(null);
    return saving;
  };

  /**
   * Whether the open pane can be followed by a new scenario: its scenario
   * has a place in the feature, or at least a name to be saved under. A
   * brand-new unnamed scenario has neither, so nothing could come after it.
   */
  const canAddAfter =
    editing !== null && (editing.index !== null || editing.scenario.name.trim() !== "");

  /**
   * New scenario after the open one (specs/editor/spec-editor.feature.md
   * "Spec editor pane"): the pane's `+` and `c`. The pane saves on the way
   * out, as ESC and the arrows do, and the new draft opens right after where
   * that save landed the scenario — so S3's successor is S4, whatever a
   * rename re-sorted meanwhile.
   */
  const newScenarioAfterCurrent = async () => {
    if (!editing || !feature || !selected || !canAddAfter || publishing !== null) return;
    const file = selected;
    const current = { name: editing.scenario.name, version: draftVersion };
    const id = editing.scenario.id;
    const fallback =
      editing.index !== null ? editing.index + 1 : (editing.insertAt ?? feature.scenarios.length);
    const name = await prompt({
      title: "New scenario",
      placeholder: "Scenario name",
      confirmLabel: "Create",
    });
    if (!name || !cleanLine(name)) return;
    // The prompt was modal, but autosave may have ticked meanwhile: close
    // the pane as it stands now, and wait for every save ahead of the new
    // scenario to land before placing it.
    const ahead = autosaveInFlight.current;
    const saving = editorRef.current.close();
    const placed = saving === null ? null : ((await saving)?.placed ?? null);
    await ahead;
    await scenarioSaveQueue.current.idle();
    if (selectedRef.current !== file || featureEditorsSealed.current) return;
    const scenarios = placed?.feature.scenarios ?? feature.scenarios;
    saveOnOpen.current = true;
    setEditing(newScenarioDraft(name, insertAfterScenario(scenarios, current, id, fallback)));
  };

  /**
   * `<` and ESC (specs/editor/spec-editor.feature.md "Spec editor pane"):
   * back to the feature, landing on the scenario's card — highlighted and
   * scrolled into view. The card is found by identity in the feature as the
   * last save is writing it (the same placement commitScenario makes), or as
   * it stands when nothing needed saving; a new scenario that was never
   * saved has no card, so nothing is highlighted.
   */
  const backToFeature = () => {
    if (!editing || !feature) {
      closeEditor();
      return;
    }
    const s = { ...editing.scenario, version: draftVersion };
    const at = editing.index;
    const saved = closeEditor() !== null;
    // A new scenario lands where the pane was told to put it (a new
    // version, "New scenario below", the pane's `+`), not at the end.
    const landed = saved ? withScenario(feature, at, s, editing.insertAt) : feature;
    setSelectedScenario(cardOfScenario(landed.scenarios, s));
  };

  // Before a move, rename-file or delete: what the scenario and description
  // editors hold lands on the current path, then `seal` refuses every later
  // write to it — the order switchRepo uses, through the same queues.
  const flushFeatureEditors = async () => {
    if (featureEditorsSealed.current) return;
    featureEditorsRetiring.current = true;
    await closeEditor();
    await scenarioSaveQueue.current.idle();
    await descTick.current();
    await descSaveQueue.current.idle();
  };
  const sealFeatureEditors = () => {
    featureEditorsSealed.current = true;
    featureEditorsRetiring.current = true;
    editorSession.current += 1;
    setEditing(null);
    setDescEdit(null);
  };
  const unsealFeatureEditors = () => {
    featureEditorsSealed.current = false;
    featureEditorsRetiring.current = false;
  };
  // ESC and the navigation paths run whichever close/back is current, from
  // listeners and callbacks bound in earlier renders.
  useEffect(() => {
    editorRef.current = {
      close: closeEditor,
      back: backToFeature,
      flush: flushFeatureEditors,
      seal: sealFeatureEditors,
    };
  });

  /**
   * Move the scenario at `i` one place up or down (specs/ui/ui.feature.md
   * "number scenarios") and save the feature in its new order — a save like
   * any other, through the queue so it goes out after a tick already away.
   * The highlight follows the scenario. Not while the editor pane is open:
   * its index into the feature would go stale under it.
   */
  const reorderScenario = (i: number, delta: -1 | 1) => moveScenarioTo(i, i + delta);

  /**
   * Move the open feature's scenario at `i` to `to` — one place for Move up
   * / Move down, anywhere for a drop in the sidebar outline — and save it.
   */
  const moveScenarioTo = async (i: number, to: number) => {
    if (!feature || !selected || editing !== null || featureEditorsSealed.current) return;
    if (to < 0 || to >= feature.scenarios.length || to === i) return;
    const before = feature;
    const next = withScenarioMoved(feature, i, to);
    const file = selected;
    setFeature(next);
    setSelectedScenario(to);
    setCardMenu(null);
    await scenarioSaveQueue.current.run(async () => {
      try {
        const res = await fetch(`/api/features/${encodeURIComponent(file)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: serializeFeature(next), save: true }),
        });
        const data = await res.json();
        if (selectedRef.current !== file) return;
        if (res.ok) {
          setFeature(featureFromResponse(data, file));
          setDirty(false);
          markSaved();
        } else {
          setFeature(before);
          setSelectedScenario(i);
          toast.error(data.error ?? "Could not move the scenario");
        }
      } catch {
        if (selectedRef.current !== file) return;
        setFeature(before);
        setSelectedScenario(i);
        toast.error("Could not move the scenario — is the server running?");
      }
    });
  };

  /**
   * Flip the polarity of the scenario at `i` from its card
   * (specs/ui/scenario-polarity.feature.md): bookkeeping around the spec,
   * so a published scenario takes it too. Saved like a move — the whole
   * feature, optimistically, rolled back if the save fails.
   */
  const toggleScenarioPolarityAt = async (i: number) => {
    if (!feature || !selected || editing !== null || featureEditorsSealed.current) return;
    const current = feature.scenarios[i];
    if (!current) return;
    const before = feature;
    const next = withScenarioPolarity(feature, i, !current.negative);
    const file = selected;
    setFeature(next);
    await scenarioSaveQueue.current.run(async () => {
      try {
        const res = await fetch(`/api/features/${encodeURIComponent(file)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: serializeFeature(next), save: true }),
        });
        const data = await res.json();
        if (selectedRef.current !== file) return;
        if (res.ok) {
          setFeature(featureFromResponse(data, file));
          setDirty(false);
          markSaved();
        } else {
          setFeature(before);
          toast.error(data.error ?? "Could not change the scenario's polarity");
        }
      } catch {
        if (selectedRef.current !== file) return;
        setFeature(before);
        toast.error("Could not change the scenario's polarity — is the server running?");
      }
    });
  };

  /** Draft the next version of a published scenario as a new, editable scenario. */
  const newVersion = (i: number) => {
    if (!feature) return;
    const src = feature.scenarios[i]!;
    setEditing({
      index: null,
      // isNew marks it as new, so the version is derived on save.
      isNew: true,
      // Right after the version it continues, where the reader looks for it.
      insertAt: i + 1,
      // Draft like any other new scenario, so autosave can't propose the next
      // version of a published scenario on the user's behalf — and without
      // the source's document id: this is a new scenario, not that one renamed.
      // Its files stay the source's (specs/editor/store-associated-files
      // .feature.md): the new version starts with none.
      scenario: {
        ...src,
        id: undefined,
        files: undefined,
        version: nextVersionFor(src.name),
        status: "draft",
      },
    });
  };

  return {
    backToFeature,
    canAddAfter,
    closeEditor,
    confirmScenarioDelete,
    deleteScenario,
    moveScenarioTo,
    newScenarioAfterCurrent,
    newVersion,
    reorderScenario,
    toggleScenarioPolarityAt,
    unpublishScenario,
    unsealFeatureEditors,
  };
}

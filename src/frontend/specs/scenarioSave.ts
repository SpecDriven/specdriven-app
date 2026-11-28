// Saving the scenario open in the editor pane (specs/editor/editor-autosave
// .feature.md, spec-editor.feature.md): the save that writes it into its
// feature, Propose and Publish, the autosave tick with its interval, and
// the version the draft will be saved under. Moved out of App.tsx as they
// were, into a hook App.tsx calls: each handler sees the same render's
// values it saw there — the save places a scenario by what that render
// knew, and by where a tick still away lands it. The refs a tick reads
// between renders are still App's.

import { type RefObject, useEffect, useRef } from "react";
import {
  type Feature,
  type Scenario,
  type ScenarioTarget,
  serializeFeature,
  unclosedFence,
} from "../../server/parser";
import { resolveLinkDraft, resolveQtestDraft } from "../externallinks";
import { type PromiseQueue } from "../promiseQueue";
import { resolvePendingTests } from "../testlinks";
import { toast } from "../Toasts";
import { withOpenScenarios } from "../tree";
import {
  setLinkError,
  setPublishing,
  setQtestError,
  setSavedAt,
  setSaving,
  setTestsError,
  useEditorState,
} from "./editorState";
import { setFeatures } from "./listing";
import { setDirty, setEditing, setFeature, setSelectedScenario, useOpenFeature } from "./openFeature";
import {
  type Placement,
  cardOfScenario,
  featureFromResponse,
  landedScenario,
  namingInProgress,
  nextVersionIn,
  placeScenario,
  savedScenarioName,
  scenarioSignature,
  scenarioTarget,
} from "./scenarioEdit";
import { scenarioKey } from "./selection";

export interface ScenarioSaveDeps {
  autosaveInFlight: RefObject<Promise<Placement> | null>;
  autosaveSeconds: number;
  autosaved: RefObject<string | null>;
  deletingScenario: RefObject<boolean>;
  editingOpen: boolean;
  editorSession: RefObject<number>;
  featureEditorsRetiring: RefObject<boolean>;
  featureEditorsSealed: RefObject<boolean>;
  nameFieldRef: RefObject<HTMLInputElement | null>;
  publish: (scenario?: ScenarioTarget, over?: Feature, file?: string | null) => Promise<void>;
  saveOnOpen: RefObject<boolean>;
  scenarioSaveQueue: RefObject<PromiseQueue>;
  selectedRef: RefObject<string | null>;
}

export function useScenarioSave(deps: ScenarioSaveDeps) {
  const { editing, feature, selected } = useOpenFeature();
  const { linkDraft, qtestDraft, testDraft, testEdit, testEditDraft, testNameDraft } = useEditorState();
  const {
    autosaveInFlight,
    autosaveSeconds,
    autosaved,
    deletingScenario,
    editingOpen,
    editorSession,
    featureEditorsRetiring,
    featureEditorsSealed,
    nameFieldRef,
    publish,
    saveOnOpen,
    scenarioSaveQueue,
    selectedRef,
  } = deps;
  // crud-feature.md ("Scenario is automatically saved locally and
  // pushed to GitHub"): a landed save updates the header's Saved indicator.
  const markSaved = () => {
    setSaving(false);
    setSavedAt(Date.now());
  };

  /**
   * The version a scenario gets is derived, never typed
   * (specs/ui/ui.feature.md): one past the highest version already carrying
   * that name, or 1 when the name is new. Editing an existing entry keeps the
   * version it was given.
   */
  const nextVersionFor = (name: string, ignoreIndex?: number) =>
    nextVersionIn(feature, name, ignoreIndex);

  /** The version the open dialog will save under; shown read-only in the dialog.
      A new scenario autosave has already placed in the feature keeps deriving
      its version, with its own entry left out — or it would bump past itself
      on every tick. */
  const draftVersion = !editing
    ? 1
    : editing.isNew || editing.index === null
      ? nextVersionFor(editing.scenario.name, editing.index ?? undefined)
      : editing.scenario.version;

  /**
   * Write the editor's scenario into the feature and save the feature locally
   * (marked [proposed], so no data is lost); the server's reload cron commits
   * and pushes it. `close` false is the autosave path
   * (specs/editor/editor-autosave.feature.md): the pane stays open and follows
   * its scenario into the saved feature. Resolves to whether the save landed
   * and where it left the scenario; null when there is nothing to save.
   */
  const saveScenario = (
    tests: string[],
    close: boolean,
    // Propose (specs/editor/spec-editor.feature.md) is the explicit action
    // that advances the editor's draft; every other save keeps the status.
    status?: Scenario["status"],
  ): Promise<{ ok: boolean; placed: Placement }> | null => {
    if (featureEditorsSealed.current) return null;
    if (!editing || !feature || !selected) return null;
    const draft = { ...editing.scenario, status: status ?? editing.scenario.status, tests };
    const derived = editing.isNew === true;
    // Where this scenario sits in the feature: the entry the editor opened
    // on, or the one a previous save placed — never appended twice. While a
    // tick is still away that is wherever the tick lands it, not what this
    // render knows: its index and (for a new scenario) its missing document
    // id predate that save, so placing by them would append the scenario a
    // second time, or write over the neighbour a rename re-sorted into its
    // old slot.
    const ahead = autosaveInFlight.current;
    const known: Placement = { feature, index: editing.index, id: draft.id, insertAt: editing.insertAt };
    const place = (at: Placement) => placeScenario(draft, at, derived);
    if (!ahead) setFeature(place(known).next);
    if (close) setEditing(null);
    const session = editorSession.current;
    const file = selected;
    setSaving(true);
    // Through the queue so a folder switch can wait for this PUT, and so
    // a save meeting a tick already away goes out after it, from where it
    // landed.
    return scenarioSaveQueue.current.run(async () => {
      const base = ahead ? await ahead : known;
      const { s, next } = place(base);
      if (ahead && selectedRef.current === file) setFeature(next);
      const res = await fetch(`/api/features/${encodeURIComponent(file)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // The scenario goes out with its document id, so a retyped title or a
        // re-derived version renames the saved entry instead of leaving a draft
        // behind under its old name.
        body: JSON.stringify({
          content: serializeFeature(next),
          save: true,
          scenario: scenarioTarget(s),
        }),
      });
      const data = await res.json();
      // The user may have moved on while the save was away — navigating from
      // the sidebar leaves the editor pane with this last save
      // (specs/editor/spec-editor.feature.md "Spec editor pane") — and then
      // its result belongs to nothing on screen.
      const stillHere = selectedRef.current === file;
      if (res.ok) {
        const saved = featureFromResponse(data, file);
        if (stillHere) {
          setFeature(saved);
          setDirty(false);
        } else {
          // Its feature is no longer open, so the tree reads it from the
          // listing: the save lands there instead.
          setFeatures((prev) => withOpenScenarios(prev, file, saved));
        }
        // The feature comes back in canonical order, so a renamed scenario has
        // moved: a still-open editor has to find its scenario again, and an
        // explicit save that closed the editor lands on its card — by its
        // identity, else by its document id (landedScenario). Not finding it
        // (the entry was dropped underneath us) leaves the editor new, so
        // the next save re-adds the work rather than overwriting a neighbour.
        // The entry's document id comes back with it: a new scenario adopts it
        // here, and every later save names the entry by it.
        const moved = landedScenario(saved.scenarios, s, s.id);
        const id = moved === null ? undefined : saved.scenarios[moved]!.id;
        if (!close && session === editorSession.current) {
          setEditing((prev) =>
            prev === null
              ? null
              : {
                  ...prev,
                  index: moved,
                  scenario: id === undefined ? prev.scenario : { ...prev.scenario, id },
                },
          );
        }
        if (close && stillHere) setSelectedScenario(moved);
        // A published scenario's editor can only have changed its links — test
        // links (specs/traceability.feature.md) and its ticket link — so there
        // is nothing left to publish.
        if (stillHere) markSaved();
        else setSaving(false);
        return { ok: true, placed: { feature: saved, index: moved, id } };
      }
      setSaving(false);
      if (stillHere) {
        setDirty(true);
        toast.error(data.error ?? "Save failed");
      }
      // Nothing landed: the scenario is still where this save found it.
      return { ok: false, placed: base };
    });
  };
  const commitScenario = async (
    tests: string[],
    close: boolean,
    status?: Scenario["status"],
  ): Promise<boolean> => (await saveScenario(tests, close, status))?.ok ?? false;

  /**
   * A url still sitting in the add field or an open ✎ row rides along with
   * Propose and Publish — it must never be silently dropped — and one that
   * can't join the list blocks the save instead
   * (specs/traceability.feature.md). The ticket-link fields gate the save the
   * same way: a half-filled link is not written half-done, it blocks with a
   * message
   * (specs/external-links/project-management-jira-linear-etc.feature.md). Null
   * means blocked, with the reason already on screen.
   */
  const pendingTests = (): string[] | null => {
    if (!editing) return null;
    const link = resolveLinkDraft(linkDraft);
    if (link.error) {
      setLinkError(link.error);
      return null;
    }
    // The qTest test case fields gate it the same way
    // (specs/external-links/qtest-test-cases.feature.md).
    const qtest = resolveQtestDraft(qtestDraft);
    if (qtest.error) {
      setQtestError(qtest.error);
      return null;
    }
    const pending = resolvePendingTests(
      editing.scenario.tests,
      testEdit === null ? null : { index: testEdit, ...testEditDraft },
      { url: testDraft, name: testNameDraft },
    );
    if (pending.error) {
      setTestsError(pending.error);
      return null;
    }
    return pending.tests;
  };

  /**
   * Propose (specs/editor/spec-editor.feature.md): the explicit action that
   * moves the dialog's scenario into the `.feature.md` as [proposed]. Saves
   * and closes.
   */
  const proposeScenario = async () => {
    if (!editing) return;
    const tests = pendingTests();
    if (tests === null) return;
    const name = savedScenarioName(editing.scenario);
    const version = draftVersion;
    if (await commitScenario(tests, true, "proposed")) {
      toast.success(`Proposed "${name}" v${version} — publish it from its card, or press Publish All.`);
    }
  };

  /**
   * Publish straight from the dialog (specs/editor/spec-editor.feature.md):
   * the dialog's scenario goes into the feature and that one scenario is
   * published — marked [published], committed and pushed, exactly like a
   * card's Publish. The target carries the draft's document id, so a title
   * retyped since autosave filed it publishes that draft — renamed — rather
   * than a second scenario beside it. A merge conflict opens the usual
   * resolution dialog.
   *
   * Same placement as `saveScenario`: while a tick is still away, this render's
   * index and (for a new scenario) its missing document id predate that save.
   * Placing from them would append a second scenario — or write over the
   * neighbour a rename re-sorted into the old slot — and then publish that.
   * Through the queue so the publish PUT goes out after the tick, from where
   * it landed, and so a folder switch can wait for it.
   */
  const publishScenario = async () => {
    // A move, rename-file or delete has sealed this feature's path: a PUT
    // would mint the retired file again (tests/featurePathRetire.test.tsx).
    if (featureEditorsSealed.current) return;
    if (!editing || !feature || !selected) return;
    const tests = pendingTests();
    if (tests === null) return;
    const draft = { ...editing.scenario, tests };
    const derived = editing.isNew === true;
    const ahead = autosaveInFlight.current;
    const known: Placement = { feature, index: editing.index, id: draft.id, insertAt: editing.insertAt };
    const place = (at: Placement) => placeScenario(draft, at, derived);
    const shown = place(known);
    if (!ahead) {
      setFeature(shown.next);
      setSelectedScenario(cardOfScenario(shown.next.scenarios, shown.s));
    }
    setEditing(null);
    // Busy from the click, not from when the queue reaches the PUT: the wait
    // behind a tick would otherwise show nothing and leave Publish enabled.
    setPublishing(scenarioKey(shown.s));
    const file = selected;
    await scenarioSaveQueue.current.run(async () => {
      const base = ahead ? await ahead : known;
      // Sealed while it waited: the path is retired, so nothing goes out.
      if (featureEditorsSealed.current) {
        setPublishing(null);
        return;
      }
      const { s, next } = place(base);
      if (ahead && selectedRef.current === file) {
        setFeature(next);
        setSelectedScenario(cardOfScenario(next.scenarios, s));
      }
      await publish(scenarioTarget(s), next, file);
    });
  };

  /**
   * One autosave tick (specs/editor/editor-autosave.feature.md "Autosave
   * Triggered at Defined Interval"): save what the editor holds, unless it
   * holds nothing new. A url still being typed into the test-link fields stays
   * out — those join the scenario when the user adds them, or when the pane
   * closes.
   */
  const autosaveScenario = async () => {
    if (featureEditorsSealed.current || featureEditorsRetiring.current) return;
    if (!editing || !feature || !selected) return;
    if (autosaveInFlight.current) return; // the previous tick is still saving
    if (deletingScenario.current) return; // a delete is being confirmed or sent
    // The name is still being typed: saving now would put a half-typed name
    // on the draft (specs/editor/editor-autosave.feature.md "Autosave Waits
    // While the Name Is Being Typed"). The tick after focus moves on saves it.
    if (namingInProgress(nameFieldRef.current, document.activeElement)) return;
    // A scenario with no name has nothing to be saved under; the Save button
    // is disabled for the same reason.
    if (!editing.scenario.name.trim()) return;
    // A code fence is still being typed: the body ends inside it, so every
    // scenario heading after it would read as fenced content and the server
    // refuses the save rather than drop those scenarios
    // (specs/editor/editor-autosave.feature.md "Autosave Waits While a Code
    // Fence Is Open"). The tick after the fence closes saves it.
    if (unclosedFence(editing.scenario.body) !== null) return;
    const signature = scenarioSignature(editing.scenario, draftVersion);
    if (signature === autosaved.current) return;
    const session = editorSession.current;
    const before: Placement = {
      feature,
      index: editing.index,
      id: editing.scenario.id,
      insertAt: editing.insertAt,
    };
    const run = saveScenario(editing.scenario.tests, false);
    if (!run) return;
    // A save that meets this tick still away (the pane's parting save,
    // Propose) waits for it and places itself where it landed.
    const placed = run.then(
      (r) => r.placed,
      () => before,
    );
    autosaveInFlight.current = placed;
    try {
      // Only a landed save may mark the content saved — a failed one is
      // retried by the next tick, and reported on the banner meanwhile. A
      // save that lands after the dialog closed belongs to nothing.
      const { ok } = await run;
      if (ok && session === editorSession.current) autosaved.current = signature;
    } finally {
      if (autosaveInFlight.current === placed) autosaveInFlight.current = null;
    }
  };

  // The tick runs off a plain interval, so it fires on the defined cadence
  // however long the user keeps typing — a timer restarted per keystroke
  // would never come round while an edit is in flow.
  const autosaveTick = useRef(autosaveScenario);
  useEffect(() => {
    autosaveTick.current = autosaveScenario;
  });
  // A scenario added with `+` is in the feature from the moment its pane
  // opens, even if nothing is ever typed into its body: nothing counts as
  // saved yet, and one tick goes out right away. Should that tick stand down
  // (the name field holding the caret, say), the next one — or leaving the
  // pane — still saves it.
  useEffect(() => {
    if (!saveOnOpen.current || !editing) return;
    saveOnOpen.current = false;
    autosaved.current = null;
    void autosaveTick.current();
  }, [editing]);
  useEffect(() => {
    if (!editingOpen) return;
    const id = setInterval(() => void autosaveTick.current(), autosaveSeconds * 1000);
    return () => clearInterval(id);
  }, [editingOpen, autosaveSeconds]);
  return {
    draftVersion,
    markSaved,
    nextVersionFor,
    proposeScenario,
    publishScenario,
    saveScenario,
  };
}

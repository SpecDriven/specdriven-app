// The refs the Specs tab's hooks share: what an autosave tick reads between
// renders (the last saved signature, the tick still away, the save queues),
// the seal a move or a delete puts on a feature's editors, the ways out of
// the editor pane, and the DOM nodes the page and the tree scroll and
// measure. Declared together so every hook takes the same ones; moved out of
// App.tsx as they were.

import { useRef } from "react";
import { createPromiseQueue } from "../promiseQueue";
import { type TestDraft } from "../testlinks";
import { useFeaturePageState } from "./featurePageState";
import { useOpenFeature } from "./openFeature";
import { type Placement } from "./scenarioEdit";

export function useSpecsRefs() {
  const { descEdit, renameDraft } = useFeaturePageState();
  const { selected } = useOpenFeature();
  // The header field saves on blur, and a blur can arrive from a stale
  // render (the field closing on ESC, or while a save is out) — these refs
  // carry the current draft and whether a rename is in flight.
  const renameDraftRef = useRef(renameDraft);
  renameDraftRef.current = renameDraft;
  const renamingRef = useRef(false);
  const scenarioRefs = useRef<(HTMLElement | null)[]>([]);
  /** The sidebar's folder tree, for scrolling its highlighted row into view. */
  const treeRef = useRef<HTMLDivElement | null>(null);
  /**
   * True from a selection change until the tree has scrolled its highlighted
   * row into view (specs/ui/navigation.feature.md "the tree follows the open
   * feature") — the row may only render a commit or two later, once the
   * folders above it open and the listing is in.
   */
  const revealPending = useRef(false);
  // Editor autosave (specs/editor/editor-autosave.feature.md): the signature of
  // what the open dialog last had saved, and whether a tick is still saving.
  // Refs, because a tick reads them between renders and must not cause one.
  // Scenario PUTs share a queue with the description editor's reason: a folder
  // switch must wait for a tick already on its way. A boolean in-flight flag
  // would make that wait a no-op, and the server resolves the data folder per
  // request, so the late PUT would write this scenario into the folder that
  // comes next.
  const autosaved = useRef<string | null>(null);
  /** A scenario just added with `+` (specs/ui/ui.feature.md "Add A Scenario
      Button") is saved the moment its pane opens, empty body and all. */
  const saveOnOpen = useRef(false);
  /** The tick still saving, resolving to where it left the scenario — null when none is away. */
  const autosaveInFlight = useRef<Promise<Placement> | null>(null);
  const scenarioSaveQueue = useRef(createPromiseQueue());
  /**
   * The feature's path is about to change (move, rename-file) or go away
   * (delete). `retiring` blocks new autosave ticks while a flush lands;
   * `sealed` refuses every further write to the retired path — the same
   * pair a page editor uses (PagesPane flush/seal).
   */
  const featureEditorsRetiring = useRef(false);
  const featureEditorsSealed = useRef(false);
  /** The editor pane's title field, so a tick can see whether the name is
      still being typed (specs/editor/editor-autosave.feature.md). Null once the
      scenario is published, when the name is no longer editable. */
  const nameFieldRef = useRef<HTMLInputElement | null>(null);
  /** The ways out of the editor pane, for the handlers that leave it from
      outside the render that defines them — ESC, and every navigation away
      from the feature (specs/editor/spec-editor.feature.md "Spec editor
      pane"). Kept in a ref so they always run the current ones. `close`
      returns the last save when one went out, for a caller that must order
      itself after it. `flush` / `seal` land and then refuse writes when the
      file is about to be renamed, moved or deleted. */
  const editorRef = useRef<{
    close: () => Promise<{ ok: boolean; placed: Placement }> | null;
    back: () => void;
    flush: () => Promise<void>;
    seal: () => void;
  }>({
    close: () => null,
    back: () => {},
    flush: async () => {},
    seal: () => {},
  });
  /** True from the moment Delete is pressed until the removal is away, so no
      tick saves the scenario back while the confirmation is on screen — and
      so nothing re-sorts the feature under the entry being deleted. */
  const deletingScenario = useRef(false);
  /** Bumped every time the dialog opens or closes, so a save that lands after
      the user has moved on cannot stamp its result onto another scenario. */
  const editorSession = useRef(0);
  /** The row a Shift-click in the tree picks a range from. */
  const treePickAnchor = useRef<string | null>(null);
  /** Serial of the latest name lookup: an older one landing late is ignored. */
  const testLookup = useRef(0);
  /** The url and name an ✎ row opened with, to tell a changed url from a re-open. */
  const testEditOpened = useRef<TestDraft>({ url: "", name: "" });
  // The feature description editor's draft is in the feature page's store
  // (src/frontend/specs/featurePageState.ts). `descSaved` is the text last
  // landed on the server; refs, because a tick reads them between renders
  // and must not cause one.
  const descEditRef = useRef(descEdit);
  descEditRef.current = descEdit;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const descSaved = useRef<string | null>(null);
  /**
   * Description PUTs go through one queue, so a flush (leaving the feature, or
   * switching data folder) waits for a tick already on its way and then writes
   * what the editor still holds — the same reason the page editor and the
   * model canvas have queues of their own. A boolean in-flight flag would make
   * that flush a no-op instead, dropping whatever was typed since the tick
   * started.
   */
  const descSaveQueue = useRef(createPromiseQueue());
  const descPaneRef = useRef<HTMLDivElement | null>(null);
  const bodyFieldRef = useRef<HTMLDivElement | null>(null);
  return {
    autosaveInFlight,
    autosaved,
    bodyFieldRef,
    deletingScenario,
    descEditRef,
    descPaneRef,
    descSaveQueue,
    descSaved,
    editorRef,
    editorSession,
    featureEditorsRetiring,
    featureEditorsSealed,
    nameFieldRef,
    renameDraftRef,
    renamingRef,
    revealPending,
    saveOnOpen,
    scenarioRefs,
    scenarioSaveQueue,
    selectedRef,
    testEditOpened,
    testLookup,
    treePickAnchor,
    treeRef,
  };
}

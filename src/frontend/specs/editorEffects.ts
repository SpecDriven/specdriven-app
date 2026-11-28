// What follows the editor pane opening and closing, and the open feature
// changing: the test and link drafts start empty, the editor session is
// bumped and its autosave baseline set, the pane a link asked for opens,
// the open feature's scenarios reach the listing, the tree follows the open
// feature, a "Save was blocked" message goes, and the highlighted card is
// scrolled into view. Moved out of App.tsx as they were, into a hook App.tsx
// calls: the effects run in the order they ran there.

import { type RefObject, useEffect } from "react";
import { linkDraftOf } from "../externallinks";
import { revealed, withOpenScenarios } from "../tree";
import {
  setLinkDraft,
  setLinkError,
  setQtestDraft,
  setQtestError,
  setTestDraft,
  setTestEdit,
  setTestNameDraft,
  setTestNameHint,
  setTestsError,
  useEditorState,
} from "./editorState";
import { setFeatures } from "./listing";
import { setEditing, setPaneRequest, setSearchTerms, useOpenFeature } from "./openFeature";
import { type Placement, cardOfScenario, pageScenario, scenarioSignature } from "./scenarioEdit";
import { setCollapsed, setOutlined } from "./treeState";

export interface EditorEffectsDeps {
  autosaveInFlight: RefObject<Promise<Placement> | null>;
  autosaved: RefObject<string | null>;
  deletingScenario: RefObject<boolean>;
  editorSession: RefObject<number>;
  revealPending: RefObject<boolean>;
  scenarioRefs: RefObject<(HTMLElement | null)[]>;
  testLookup: RefObject<number>;
  treeRef: RefObject<HTMLDivElement | null>;
}

export function useEditorEffects(deps: EditorEffectsDeps) {
  const { editing, feature, paneRequest, selected, selectedScenario } = useOpenFeature();
  const { linkDraft, qtestDraft, testDraft, testEdit, testEditDraft, testNameDraft } = useEditorState();
  const {
    autosaveInFlight,
    autosaved,
    deletingScenario,
    editorSession,
    revealPending,
    scenarioRefs,
    testLookup,
    treeRef,
  } = deps;
  // The dialog's "Add test link" field starts empty each time it opens, with
  // no row left open for ✎ editing (specs/traceability.feature.md).
  const editingOpen = editing !== null;
  /** The scenario whose page is open — what the url and the title name. */
  const paneScenario = pageScenario(editing, feature?.scenarios);
  useEffect(() => {
    setTestDraft("");
    setTestNameDraft("");
    setTestEdit(null);
    setTestNameHint(null);
    testLookup.current++;
    // The ticket-link fields open showing the scenario's link, if any.
    setLinkDraft(linkDraftOf(editing?.scenario.link));
    setQtestDraft(linkDraftOf(editing?.scenario.qtest));
  }, [editingOpen]);

  // The tree reads the open feature's scenarios from its live state, every
  // other feature's from the listing — which only refreshes on start and on
  // the reload cron. So whatever the open feature now holds goes into its
  // listing entry too, or a scenario deleted (or renamed, or added) there
  // would come back the moment another feature is opened.
  useEffect(() => {
    if (!selected || !feature) return;
    setFeatures((prev) => withOpenScenarios(prev, selected, feature));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature]);

  // Autosave measures against what the dialog opened with, so a scenario that
  // is opened and read but not edited is never re-saved
  // (specs/editor/editor-autosave.feature.md).
  useEffect(() => {
    editorSession.current += 1;
    autosaved.current = editing
      ? scenarioSignature(editing.scenario, editing.scenario.version)
      : null;
    autosaveInFlight.current = null;
    // The delete that closed the dialog may still be in flight, but with no
    // dialog open there is no tick for the flag to hold back.
    deletingScenario.current = false;
  }, [editingOpen]);

  // A scenario deep link honored above left its scenario here: open its page
  // now that the feature it belongs to is on screen
  // (specs/ui/navigation.feature.md "open a scenario link"). By identity, like
  // every other card lookup — the link resolved against the same feature, so it
  // is still there.
  useEffect(() => {
    if (!paneRequest) return;
    setPaneRequest(null);
    if (!feature) return;
    const idx = cardOfScenario(feature.scenarios, paneRequest.scenario);
    if (idx !== null) {
      setEditing({ index: idx, scenario: { ...feature.scenarios[idx]! } });
      setSearchTerms(paneRequest.terms);
    }
  }, [paneRequest, feature]);

  // The tree follows the open feature (specs/ui/navigation.feature.md "the
  // tree follows the open feature"): whatever opened it — a search hit, a
  // link, a card, the palette — the folders above it open, a scenario pane
  // expands its feature's outline, and the highlighted row is scrolled into
  // view. The scroll itself waits for the next commit (the effect below),
  // since the row it wants may not be rendered yet.
  const paneKey = paneScenario ? `${paneScenario.name}@v${paneScenario.version}` : null;
  useEffect(() => {
    if (!selected) return;
    revealPending.current = true;
    setCollapsed((prev) => revealed(prev, selected));
    if (paneKey !== null)
      setOutlined((prev) => {
        if (prev.has(selected)) return prev;
        return new Set(prev).add(selected);
      });
  }, [selected, paneKey]);

  // After every commit: the pending reveal scrolls the tree's highlighted
  // row — the open scenario's while a pane is open, else the feature's —
  // into view, and is done once it found it. A listing still loading, a
  // folder still opening or an outline still expanding leaves it pending for
  // the next commit; a pane must wait for its own row, since the feature's is
  // there a commit earlier and the scenario's may sit below the fold.
  useEffect(() => {
    if (!revealPending.current) return;
    const tree = treeRef.current;
    if (!tree) return;
    const row = tree.querySelector<HTMLElement>(
      paneKey !== null ? "a.tree-scenario.active" : "a.tree-feature.active",
    );
    if (!row) return;
    revealPending.current = false;
    row.scrollIntoView({ block: "nearest" });
  });

  // The marks belong to the pane the hit opened: closing it takes them along,
  // so the scenario reopened from its card shows plain text. Not while a pane
  // request is pending — opening a hit closes the previous pane first, and
  // the request above is what carries the new terms in.
  useEffect(() => {
    if (editing === null && paneRequest === null) setSearchTerms(null);
  }, [editing === null, paneRequest]);

  // A "Save was blocked" message stops applying the moment the tests widgets
  // change — typing, adding, or opening/closing an ✎ row.
  useEffect(() => {
    setTestsError(null);
  }, [editingOpen, testDraft, testNameDraft, testEditDraft, testEdit]);

  useEffect(() => {
    setLinkError(null);
  }, [editingOpen, linkDraft]);

  useEffect(() => {
    setQtestError(null);
  }, [editingOpen, qtestDraft]);

  // The highlighted card is scrolled into view.
  // Also re-run when the editor pane gives the feature page back: the cards
  // mount afresh, so the highlighted one is scrolled to even if the highlight
  // itself did not move (specs/editor/spec-editor.feature.md "Spec editor
  // pane").
  useEffect(() => {
    if (selectedScenario !== null)
      scenarioRefs.current[selectedScenario]?.scrollIntoView({ block: "nearest" });
  }, [selectedScenario, editingOpen]);
  return {
    editingOpen,
    paneScenario,
  };
}

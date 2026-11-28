// What the keyboard does on a feature's page and in the editor
// (specs/ui/ui.feature.md, specs/editor/spec-editor.feature.md): the
// highlight walking the cards, opening the highlighted one, a new scenario
// by its name, and stepping to the scenario before or after the open one
// across the tree; and the url "Copy link" shares for a scenario. Moved out
// of App.tsx as they were, into a hook App.tsx calls.

import { type RefObject } from "react";
import { type Scenario } from "../../server/parser";
import { cleanLine } from "../../server/text";
import { type PromptOptions } from "../ModalPrompts";
import { latestScenarioPath, scenarioPath } from "../route";
import { type ScenarioRow, buildTree, scenarioNeighbors, scenarioSequence } from "../tree";
import { useSpecsListing } from "./listing";
import { setEditing, setSelectedScenario, useOpenFeature } from "./openFeature";
import { newScenarioDraft } from "./scenarioEdit";

export interface FeaturePageKeysDeps {
  openScenarioRow: (file: string, s: ScenarioRow) => void;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  readOnly: boolean;
  saveOnOpen: RefObject<boolean>;
  scenarioRefs: RefObject<(HTMLElement | null)[]>;
}

export function useFeaturePageKeys(deps: FeaturePageKeysDeps) {
  const { editing, feature, selected, selectedScenario } = useOpenFeature();
  const { featureOrders, features, folderDescriptions, folderOrders, folders } = useSpecsListing();
  const {
    openScenarioRow,
    prompt,
    readOnly,
    saveOnOpen,
    scenarioRefs,
  } = deps;
  /** A feature's page has the pane, with no scenario open in the editor. */
  const onFeaturePage = selected !== null && feature !== null && editing === null;
  // The scenario url "Copy link" shares. The public specs site hands links to
  // people outside the team, so there it is the versionless url, which still
  // opens after the scenario gets a new version (specs/app/public-specs-site
  // .feature.md "copies a deep link"); everywhere else, the versioned one.
  const scenarioLink = (fileName: string, s: Pick<Scenario, "name" | "version">) =>
    readOnly ? latestScenarioPath(fileName, s) : scenarioPath(fileName, s);
  // specs/editor/spec-editor.feature.md "Adding Scanarios": a small dialog
  // asks for the scenario's name first; the editor pane opens with it. A
  // new scenario starts as a draft: autosave
  // (specs/editor/editor-autosave.feature.md) writes the editor out every few
  // seconds, and a draft stays in the document. Proposing it — into the
  // .feature.md — takes the editor's Propose button, an explicit act.
  const newScenario = async (insertAt?: number) => {
    const name = await prompt({
      title: "New scenario",
      placeholder: "Scenario name",
      confirmLabel: "Create",
    });
    if (!name || !cleanLine(name)) return;
    // At `insertAt` — "New scenario below" on a card — or at the end.
    saveOnOpen.current = true;
    setEditing(newScenarioDraft(name, insertAt));
  };
  // specs/ui/ui.feature.md "Select scenarios via up and down keys": the
  // highlight walks the cards; Enter opens the highlighted one in the editor
  // pane.
  const moveScenarioSelection = (e: KeyboardEvent, delta: 1 | -1) => {
    if (!feature) return;
    const count = feature.scenarios.length;
    // Steal focus from a clicked button (e.g. the feature just opened in the
    // sidebar) so a following Enter edits the highlighted scenario instead
    // of re-activating that button.
    if (e.target instanceof HTMLElement) e.target.blur();
    setSelectedScenario((i) =>
      delta > 0
        ? i === null
          ? 0
          : Math.min(i + 1, count - 1)
        : i === null
          ? count - 1
          : Math.max(i - 1, 0),
    );
  };
  const openSelectedScenario = (e: KeyboardEvent): void | false => {
    if (!feature || selectedScenario === null) return false;
    const t = e.target;
    if (e.key === "Enter") {
      // A focused button or link keeps its native Enter activation — except
      // the highlighted card's own title link, which a click left focused:
      // Enter there edits the scenario rather than re-selecting it.
      const titleLink = scenarioRefs.current[selectedScenario]?.querySelector(
        ".scenario-title > a",
      );
      if (t instanceof HTMLButtonElement) return false;
      if (t instanceof HTMLAnchorElement && t !== titleLink) return false;
    }
    const s = feature.scenarios[selectedScenario];
    if (s) setEditing({ index: selectedScenario, scenario: { ...s } });
  };
  // The scenario editor's `<` / `>` and their keys: step to the scenario
  // before or after the open one, through every scenario in the tree in the
  // order the sidebar lists them — across features too. The same way the
  // tree's own rows switch scenarios (openScenarioRow), so the open pane
  // autosaves on the way out. Located by the scenario as last saved, not by
  // a name still being typed; a new scenario not yet saved has no place in
  // the walk, so both ways are off until it does.
  const editedEntry =
    editing !== null && editing.index !== null ? (feature?.scenarios[editing.index] ?? null) : null;
  const scenarioNav =
    selected && editedEntry
      ? scenarioNeighbors(
          scenarioSequence(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), selected, feature),
          selected,
          editedEntry,
        )
      : { prev: null, next: null };
  const stepScenario = (step: -1 | 1): void | false => {
    const to = step < 0 ? scenarioNav.prev : scenarioNav.next;
    if (!to) return false;
    openScenarioRow(to.file, to.scenario);
  };
  return {
    moveScenarioSelection,
    newScenario,
    onFeaturePage,
    openSelectedScenario,
    scenarioLink,
    scenarioNav,
    stepScenario,
  };
}

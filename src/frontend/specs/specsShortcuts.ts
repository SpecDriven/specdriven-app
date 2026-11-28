// The feature page's and the editor's keys (specs/ui/ui.feature.md,
// specs/editor/spec-editor.feature.md): the highlight on the cards, moving
// and opening the highlighted one, the steps between scenarios, and
// Propose / Publish. App.tsx spreads the list at the place these entries
// held in its own, so the cheat sheet and the palette show them where they
// did; their ids are the ones the read-only filters match on. Moved out of
// App.tsx as they were.

import { type Feature, type ScenarioTarget } from "../../server/parser";
import { type Shortcut } from "../shortcuts";
import { type ScenarioStop } from "../tree";
import { useEditorState } from "./editorState";
import { useOpenFeature } from "./openFeature";

export interface SpecsShortcutsDeps {
  moveScenarioSelection: (e: KeyboardEvent, delta: 1 | -1) => void;
  onFeaturePage: boolean;
  openSelectedScenario: (e: KeyboardEvent) => void | false;
  proposeScenario: () => Promise<void>;
  publish: (scenario?: ScenarioTarget, over?: Feature, file?: string | null) => Promise<void>;
  publishScenario: () => Promise<void>;
  quiet: boolean;
  quietBehindPalette: boolean;
  reorderScenario: (i: number, delta: -1 | 1) => Promise<void>;
  scenarioNav: { prev: ScenarioStop | null; next: ScenarioStop | null; };
  stepScenario: (step: -1 | 1) => void | false;
}

export function useSpecsShortcuts(deps: SpecsShortcutsDeps) {
  const { editing, feature, selectedScenario } = useOpenFeature();
  const { publishing } = useEditorState();
  const {
    moveScenarioSelection,
    onFeaturePage,
    openSelectedScenario,
    proposeScenario,
    publish,
    publishScenario,
    quiet,
    quietBehindPalette,
    reorderScenario,
    scenarioNav,
    stepScenario,
  } = deps;
  // The feature page's and the editor's keys (specs/ui/ui.feature.md,
  // specs/editor/spec-editor.feature.md): the highlight on the cards, the
  // steps between scenarios, and Propose / Publish.
  const specsShortcuts: Shortcut[] = [
    {
      id: "next",
      keys: ["j", "arrowdown"],
      label: "Next scenario",
      group: "Scenarios",
      when: () => !quiet && onFeaturePage && feature !== null && feature.scenarios.length > 0,
      run: (e) => moveScenarioSelection(e, 1),
    },
    {
      id: "prev",
      keys: ["k", "arrowup"],
      label: "Previous scenario",
      group: "Scenarios",
      when: () => !quiet && onFeaturePage && feature !== null && feature.scenarios.length > 0,
      run: (e) => moveScenarioSelection(e, -1),
    },
    {
      id: "move-up",
      keys: "alt+arrowup",
      label: "Move the selected scenario up",
      group: "Scenarios",
      when: () => !quiet && onFeaturePage && editing === null && selectedScenario !== null,
      run: () => void reorderScenario(selectedScenario!, -1),
    },
    {
      id: "move-down",
      keys: "alt+arrowdown",
      label: "Move the selected scenario down",
      group: "Scenarios",
      when: () => !quiet && onFeaturePage && editing === null && selectedScenario !== null,
      run: () => void reorderScenario(selectedScenario!, 1),
    },
    {
      id: "open",
      keys: ["enter", "e", "o"],
      label: "Open the selected scenario",
      group: "Scenarios",
      when: () => !quiet && onFeaturePage && selectedScenario !== null,
      run: openSelectedScenario,
    },
    {
      id: "editor-prev",
      keys: ["<", "k"],
      label: "Previous scenario (in the scenario editor)",
      group: "Scenarios",
      when: () => !quiet && editing !== null && scenarioNav.prev !== null,
      run: () => stepScenario(-1),
    },
    {
      id: "editor-next",
      keys: [">", "j"],
      label: "Next scenario (in the scenario editor)",
      group: "Scenarios",
      when: () => !quiet && editing !== null && scenarioNav.next !== null,
      run: () => stepScenario(1),
    },
    {
      id: "publish",
      keys: "mod+enter",
      label: editing
        ? editing.scenario.status === "draft"
          ? "Propose the scenario"
          : "Publish the scenario"
        : "Publish all",
      group: "Publish",
      inFields: true,
      when: () => !quiet && (editing !== null || onFeaturePage),
      palette: () => !quietBehindPalette && (editing !== null || onFeaturePage),
      run: () => {
        if (publishing !== null) return false;
        if (editing) {
          if (editing.scenario.status === "published" || !editing.scenario.name.trim())
            return false;
          if (editing.scenario.status === "draft") void proposeScenario();
          else void publishScenario();
          return;
        }
        void publish();
      },
    },
  ];
  return {
    specsShortcuts,
  };
}

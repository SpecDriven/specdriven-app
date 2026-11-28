// What a code gen session would be sent (specs/agents/claude.feature.md):
// the specs and scenarios checked, still listed; with nothing checked, the
// scenarios picked in the tree, the open scenario or the open feature; what
// the open view of another tab adds; and how the sidebar words and counts
// it. Moved out of App.tsx as they were, into a hook App.tsx calls: each
// one reads the same render's values it read there.

import { type PluginView, type TabPlugin } from "../../plugins/client/tabs";
import { type Scenario, type ScenarioPick } from "../../server/parser";
import { sessionSelection } from "../StartSessionDialog";
import { type ScenarioRow, scenarioRows, treeScenarioKey } from "../tree";
import { useSpecsListing } from "./listing";
import { useOpenFeature } from "./openFeature";
import { scenarioKey, useSpecSelection } from "./selection";
import { useTreeState } from "./treeState";

export interface SessionSelectionDeps {
  activeTab: TabPlugin<unknown> | null;
  locked: boolean;
  paneScenario: Scenario | null;
  pluginView: PluginView | null;
}

export function useSessionSelection(deps: SessionSelectionDeps) {
  const specSelection = useSpecSelection();
  const { feature, selected } = useOpenFeature();
  const { features } = useSpecsListing();
  const { treePicks } = useTreeState();
  const {
    activeTab,
    locked,
    paneScenario,
    pluginView,
  } = deps;
  // What the current selection sends to a session. Selections can outlive
  // the list (a checked spec deleted elsewhere, a scenario replaced by a new
  // version) — only specs and scenarios still listed go in.
  // With nothing checked, the scenarios picked in the tree, the open
  // scenario, or the open feature stand in (sessionSelection).
  const sessionFiles = (): { fileName: string; scenarios?: ScenarioPick[] }[] => {
    const picks: { file: string; row: ScenarioRow }[] = [];
    if (!locked && treePicks.size > 0) {
      for (const f of features) {
        for (const row of scenarioRows(f, selected, feature)) {
          if (treePicks.has(treeScenarioKey(f.fileName, row))) picks.push({ file: f.fileName, row });
        }
      }
    }
    return sessionSelection({
      checked: checkedSessionFiles(),
      treePicks: picks,
      openFeature: selected && feature ? selected : null,
      openScenario: paneScenario,
    });
  };

  /** The specs and scenarios checked for a session, still listed. */
  const checkedSessionFiles = (): { fileName: string; scenarios?: ScenarioPick[] }[] => {
    const files: { fileName: string; scenarios?: ScenarioPick[] }[] = [];
    for (const f of features) {
      const entry = specSelection.get(f.fileName);
      if (entry === undefined) continue;
      if (entry === "all") {
        files.push({ fileName: f.fileName });
        continue;
      }
      const picked = f.scenarios.filter((s) => entry.has(scenarioKey(s)));
      if (picked.length > 0) {
        files.push({
          fileName: f.fileName,
          scenarios: picked.map(({ name, version }) => ({ name, version })),
        });
      }
    }
    return files;
  };

  /**
   * What the open plugin view bundles into a session beyond the picked specs
   * (src/plugins/client/tabs.ts `session`) — the Event Model on the Models
   * plugin's canvas, whose JSON goes into the prompt after the specs — sent
   * as `attachments` under the plugin's id. What a tab bundles alone is a
   * session too (src/server/api.ts resolveSessionRequest).
   */
  const sessionBundle = (): {
    attachments: Record<string, string[]>;
    labels: string[];
    count: number;
  } => {
    const bundle = pluginView && activeTab ? activeTab.session?.(pluginView.view) : null;
    return bundle && activeTab
      ? { attachments: { [activeTab.id]: bundle.refs }, labels: bundle.labels, count: bundle.refs.length }
      : { attachments: {}, labels: [], count: 0 };
  };

  /** "2 whole specs and 3 scenarios from 1 spec" — the button and the name
      dialog both say what a session would run over. */
  const describeSelection = (
    files: { scenarios?: ScenarioPick[] }[],
    bundled: string[] = sessionBundle().labels,
  ): string => {
    const whole = files.filter((f) => !f.scenarios).length;
    const partial = files.length - whole;
    const scenarios = files.reduce((n, f) => n + (f.scenarios?.length ?? 0), 0);
    const parts: string[] = [];
    if (whole > 0) parts.push(`${whole} whole spec${whole === 1 ? "" : "s"}`);
    if (partial > 0) {
      parts.push(
        `${scenarios} scenario${scenarios === 1 ? "" : "s"} from ` +
          `${partial} spec${partial === 1 ? "" : "s"}`,
      );
    }
    parts.push(...bundled);
    return parts.join(" and ");
  };

  const selectionLabel = describeSelection(sessionFiles());
  /** The sidebar's "Selected:" note: what was checked, not what stands in. */
  const checkedLabel = describeSelection(checkedSessionFiles());
  // What a session would run over, counted: the Start session button is
  // off at zero (nothing checked, picked or open).
  const sessionCount = sessionFiles().length + sessionBundle().count;

  return {
    checkedLabel,
    describeSelection,
    selectionLabel,
    sessionBundle,
    sessionCount,
    sessionFiles,
  };
}

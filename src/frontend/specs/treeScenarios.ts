// What the tree does with a scenario row (specs/ui/navigation.feature.md
// "Scenario navigation"): opening it, picking several, deleting one or the
// picked ones, cloning, and moving one by the menu or by a drag — within
// its feature or into another. Moved out of App.tsx as they were, into a
// hook App.tsx calls: each handler sees the same render's values it saw
// there.

import { type RefObject, useRef } from "react";
import { type Feature, type Scenario, serializeFeature, slugify, titleFromFileName } from "../../server/parser";
import { type AgentChatStore } from "../agentChat";
import { type ConfirmOptions, type PickOptions } from "../ModalPrompts";
import { type PromiseQueue } from "../promiseQueue";
import { toast } from "../Toasts";
import {
  type ScenarioRow,
  scenarioDrop,
  scenarioPlace,
  scenarioRows,
  treeScenarioKey,
  withOpenScenarios,
} from "../tree";
import { type Listing, setFeatures, useSpecsListing } from "./listing";
import { type OpenOptions, setFeature, setSelectedScenario, useOpenFeature } from "./openFeature";
import { type Placement, featureFromResponse, withScenarioMoved } from "./scenarioEdit";
import { useSpecsSettings } from "./settings";
import {
  setScenarioDrag,
  setScenarioDropAt,
  setScenarioDropInto,
  setSelectedFolder,
  setTreeMenu,
  setTreePicks,
  useTreeState,
} from "./treeState";

export interface TreeScenariosDeps {
  autosaveInFlight: RefObject<Promise<Placement> | null>;
  closeEditor: () => Promise<{ ok: boolean; placed: Placement; }> | null;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  confirmScenarioDelete: ({ name, version, status }: ScenarioRow) => Promise<boolean>;
  deleteScenario: () => Promise<void>;
  featureEditorsSealed: RefObject<boolean>;
  loadFeatures: () => Promise<Listing | null>;
  markSaved: () => void;
  moveScenarioTo: (i: number, to: number) => Promise<void>;
  openFeature: (file: string, opts?: OpenOptions) => Promise<void>;
  pane: AgentChatStore;
  paneScenario: Scenario | null;
  pick: (opts: PickOptions) => Promise<string | null>;
  savedEntry: Scenario | null;
  scenarioSaveQueue: RefObject<PromiseQueue>;
  selectedRef: RefObject<string | null>;
  treePickAnchor: RefObject<string | null>;
  treeRef: RefObject<HTMLDivElement | null>;
}

export function useTreeScenarios(deps: TreeScenariosDeps) {
  const { deletePublished } = useSpecsSettings();
  const { editing, feature, selected } = useOpenFeature();
  const { features } = useSpecsListing();
  const { treePicks } = useTreeState();
  const {
    autosaveInFlight,
    closeEditor,
    confirm,
    confirmScenarioDelete,
    deleteScenario,
    featureEditorsSealed,
    loadFeatures,
    markSaved,
    moveScenarioTo,
    openFeature,
    pane,
    paneScenario,
    pick,
    savedEntry,
    scenarioSaveQueue,
    selectedRef,
    treePickAnchor,
    treeRef,
  } = deps;
  /**
   * A scenario in the sidebar tree (specs/ui/navigation.feature.md "Scenario
   * navigation"): opens that scenario's page, from the feature page or
   * straight from another scenario's pane — the whole point, switching
   * scenarios without going back to the feature view. The same path a deep
   * link takes, so an open pane autosaves on the way out
   * (specs/editor/spec-editor.feature.md "Spec editor pane").
   */
  const openScenarioRow = (file: string, s: ScenarioRow) => {
    setSelectedFolder(null);
    void openFeature(file, {
      push: true,
      scenario: { slug: slugify(s.name), version: s.version },
      pane: true,
    });
  };

  /**
   * Delete from a scenario's menu in the sidebar tree
   * (specs/ui/navigation.feature.md "Scenario navigation"): the
   * same removal the editor pane's Delete makes, by what the scenario is,
   * for any feature in the tree — not only the open one. A pane open on that
   * very scenario takes the pane's own Delete. A pane open on another
   * scenario of the same feature is left first, autosaving like any
   * navigation away, since the removal re-indexes the feature under it.
   */
  const deleteTreeScenario = async (file: string, s: ScenarioRow) => {
    const same = (x: { name: string; version: number }) =>
      x.name === s.name && x.version === s.version;
    if (file === selected && savedEntry !== null && same(savedEntry)) {
      await deleteScenario();
      return;
    }
    if (!(await confirmScenarioDelete(s))) return;
    if (file === selected && editing) {
      const ahead = autosaveInFlight.current;
      await closeEditor();
      await ahead;
    }
    const url = `/api/features/${encodeURIComponent(file)}`;
    let res: Response;
    if (s.status === "draft" || s.status === "published") {
      res = await fetch(`${url}/${s.status === "draft" ? "delete-draft" : "delete-published"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: { name: s.name, version: s.version } }),
      });
    } else {
      // A [proposed] scenario is saved out of the feature, from the server's
      // copy: the feature may not be the open one.
      const got = await fetch(url);
      if (!got.ok) {
        toast.error("Delete failed");
        return;
      }
      const current = featureFromResponse(await got.json(), file);
      const next: Feature = { ...current, scenarios: current.scenarios.filter((x) => !same(x)) };
      res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
    }
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? "Delete failed");
      return;
    }
    // Every route answers with the editor's view of the feature.
    if (selectedRef.current === file) {
      setFeature(featureFromResponse(data, file));
      setSelectedScenario(null);
      markSaved();
    }
    await loadFeatures();
    toast.success(`Deleted scenario "${s.name}" v${s.version}.`);
  };

  /**
   * The rows picked in the sidebar tree (specs/ui/navigation.feature.md
   * "delete several scenarios at once"), in tree order, each with its
   * feature. Picks can outlive their rows — a scenario deleted or renamed
   * elsewhere — so only rows still listed come back.
   */
  const pickedTreeScenarios = (): { file: string; row: ScenarioRow }[] => {
    if (treePicks.size === 0) return [];
    const out: { file: string; row: ScenarioRow }[] = [];
    for (const f of features) {
      for (const row of scenarioRows(f, selected, feature)) {
        if (treePicks.has(treeScenarioKey(f.fileName, row))) out.push({ file: f.fileName, row });
      }
    }
    return out;
  };

  /** The open scenario's tree key, when its page is open. */
  const openTreeKey = (): string | null =>
    selected && paneScenario ? treeScenarioKey(selected, paneScenario) : null;

  /**
   * ⌘/Ctrl-click (toggle) or Shift-click (range) on a scenario row of the
   * tree. The first pick takes the open scenario along, as a desktop list's
   * first ⌘-click keeps the row already highlighted; a range runs from the
   * anchor — the last row toggled, else the open one — over the rows as the
   * tree shows them, across features too. `add` keeps the picks a range
   * would otherwise replace (⌘⇧-click).
   */
  const pickTreeScenario = (key: string, mode: "toggle" | "range", add = false) => {
    const open = openTreeKey();
    if (mode === "toggle") {
      setTreePicks((prev) => {
        const next = new Set(prev);
        if (next.size === 0 && open !== null && open !== key) next.add(open);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      treePickAnchor.current = key;
      return;
    }
    const keys = [...(treeRef.current?.querySelectorAll<HTMLElement>("[data-scenario]") ?? [])].map(
      (el) => el.dataset.scenario!,
    );
    let from = keys.indexOf(treePickAnchor.current ?? open ?? key);
    const to = keys.indexOf(key);
    if (to === -1) return;
    if (from === -1) from = to;
    if (treePickAnchor.current === null) treePickAnchor.current = keys[from]!;
    const span = keys.slice(Math.min(from, to), Math.max(from, to) + 1);
    setTreePicks((prev) => new Set([...(add ? prev : []), ...span]));
  };

  const clearTreePicks = () => {
    setTreePicks((prev) => (prev.size === 0 ? prev : new Set()));
    treePickAnchor.current = null;
  };

  /**
   * Delete every scenario picked in the tree (specs/ui/navigation.feature.md
   * "delete several scenarios at once") after one confirmation — each the
   * way its own Delete removes it, one request per feature. Published ones
   * go only while Settings allows it; with the switch off they stay, and the
   * confirmation says so. One pick is just that row's own Delete.
   */
  const deletePickedScenarios = async () => {
    // A ⋯ menu left open on a row about to go would stay open with no row
    // to close it from, holding every shortcut — Esc included — quiet.
    setTreeMenu(null);
    const picked = pickedTreeScenarios();
    if (picked.length === 0) {
      clearTreePicks();
      return;
    }
    if (picked.length === 1) {
      clearTreePicks();
      await deleteTreeScenario(picked[0]!.file, picked[0]!.row);
      return;
    }
    const going = picked.filter((p) => p.row.status !== "published" || deletePublished);
    const kept = picked.length - going.length;
    if (going.length === 0) {
      toast.error("Published scenarios can't be deleted — deleting them is switched off in Settings.");
      return;
    }
    const published = going.filter((p) => p.row.status === "published").length;
    const files = new Map<string, ScenarioRow[]>();
    for (const p of going) files.set(p.file, [...(files.get(p.file) ?? []), p.row]);
    const n = going.length;
    const what = `${n} scenario${n === 1 ? "" : "s"}`;
    const from = files.size > 1 ? ` from ${files.size} features` : "";
    const body = [
      published > 0
        ? `Confirm that you want to delete ${what}${from} — ${published} of them published.`
        : `Delete ${what}${from}?`,
      kept > 0
        ? `${kept} published scenario${kept === 1 ? " stays" : "s stay"} — deleting published specs is switched off in Settings.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    const ok = await confirm(
      published > 0
        ? { title: "Danger Zone!", body, confirmLabel: "Confirm" }
        : { title: `Delete ${what}`, body, confirmLabel: `Delete ${what}` },
    );
    if (!ok) return;
    // An editor pane open on one of these features is left first, autosaving
    // like any navigation away: the removal re-indexes the feature under it.
    if (selected !== null && files.has(selected) && editing) {
      const ahead = autosaveInFlight.current;
      await closeEditor();
      await ahead;
    }
    await scenarioSaveQueue.current.idle();
    let deleted = 0;
    for (const [file, rows] of files) {
      let res: Response;
      try {
        res = await fetch(`/api/features/${encodeURIComponent(file)}/delete-scenarios`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenarios: rows.map(({ name, version }) => ({ name, version })) }),
        });
      } catch {
        toast.error("Delete failed — is the server running?");
        break;
      }
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Delete failed");
        continue;
      }
      deleted += rows.length;
      if (selectedRef.current === file) {
        setFeature(featureFromResponse(data, file));
        setSelectedScenario(null);
        markSaved();
      }
    }
    clearTreePicks();
    await loadFeatures();
    if (deleted > 0) toast.success(`Deleted ${deleted} scenario${deleted === 1 ? "" : "s"}.`);
  };

  /**
   * Move to… from a scenario's menu in the sidebar tree
   * (specs/ui/navigation.feature.md "move a scenario to another feature"):
   * pick another feature, and the server adds the scenario there and takes it
   * out of this one — whatever it is, as its Delete would. An editor pane open
   * on either feature is left first, autosaving like any navigation away: its
   * next save would otherwise write the feature back without the move. A pane
   * that was on the moved scenario follows it to its new feature.
   */
  const moveTreeScenario = async (file: string, s: ScenarioRow) => {
    const options = features
      .filter((f) => f.fileName !== file)
      .map((f) => ({
        value: f.fileName,
        label: f.name || titleFromFileName(f.fileName),
        hint: f.fileName.replace(/^specs\//, ""),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const to = await pick({
      title: `Move “${s.name}” v${s.version}`,
      hint:
        s.status === "published"
          ? "To another feature — published, so the move is committed and pushed right away."
          : "To another feature.",
      placeholder: "Find a feature…",
      options,
      empty: options.length === 0 ? "There is no other feature to move it to." : "No feature matches.",
    });
    if (to === null) return;
    await moveScenarioToFeature(file, s, to);
  };

  /**
   * Move a scenario out of `file` into the feature `to` — from Move to…, or
   * dropped there (specs/ui/navigation.feature.md "drag a scenario to another
   * feature"): last in it, or next to the scenario `at` names. The toast's
   * Undo moves it back to where it was.
   */
  const moveScenarioToFeature = async (
    file: string,
    s: { name: string; version: number },
    to: string,
    at?: { name: string; version: number; after: boolean },
  ) => {
    const following =
      file === selected &&
      paneScenario !== null &&
      paneScenario.name === s.name &&
      paneScenario.version === s.version;
    // Its place before the move, for Undo: the open feature knows its drafts
    // too, the listing only what the file holds.
    const listed = features.find((f) => f.fileName === file);
    const back = scenarioPlace(
      file === selected && feature ? feature.scenarios : (listed?.scenarios ?? []),
      s,
    );
    if ((file === selected || to === selected) && editing) {
      const ahead = autosaveInFlight.current;
      await closeEditor();
      await ahead;
    }
    await scenarioSaveQueue.current.idle();
    let res: Response;
    try {
      res = await fetch(`/api/features/${encodeURIComponent(file)}/move-scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: { name: s.name, version: s.version }, to, at }),
      });
    } catch {
      toast.error("Move failed — is the server running?");
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? "Move failed");
      return;
    }
    if (following) {
      await openFeature(to, {
        push: true,
        scenario: { slug: slugify(s.name), version: s.version },
        pane: true,
      });
    } else if (selectedRef.current === file) {
      setFeature(featureFromResponse(data, file));
      setSelectedScenario(null);
      markSaved();
    } else if (selectedRef.current === to) {
      await openFeature(to);
    }
    await loadFeatures();
    const target = features.find((f) => f.fileName === to);
    // Undo runs whenever it is clicked, so through the latest render's move:
    // this one's selection and editor pane may be long gone by then.
    toast.success(`Moved "${s.name}" v${s.version} to ${target?.name || titleFromFileName(to)}.`, {
      action: { label: "Undo", run: () => void latestMoveScenario.current(to, s, file, back ?? undefined) },
    });
  };
  const latestMoveScenario = useRef(moveScenarioToFeature);
  latestMoveScenario.current = moveScenarioToFeature;

  /**
   * Clone from a scenario's menu — its card's on the feature page or its
   * row's in the sidebar tree (specs/ui/navigation.feature.md "clone a
   * scenario"): the server puts a draft copy right after it, and the copy
   * opens in the editor pane, ready to be renamed and changed. An editor
   * pane open on the feature is left first, autosaving like any navigation
   * away, so its save goes out before the copy is made rather than after.
   */
  const cloneTreeScenario = async (file: string, s: ScenarioRow) => {
    if (file === selected && editing) {
      const ahead = autosaveInFlight.current;
      await closeEditor();
      await ahead;
    }
    await scenarioSaveQueue.current.idle();
    let res: Response;
    try {
      res = await fetch(`/api/features/${encodeURIComponent(file)}/clone-scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: { name: s.name, version: s.version } }),
      });
    } catch {
      toast.error("Clone failed — is the server running?");
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? "Clone failed");
      return;
    }
    const copy = data.clone as { name: string; version: number };
    await openFeature(file, {
      push: true,
      scenario: { slug: slugify(copy.name), version: copy.version },
      pane: true,
    });
    await loadFeatures();
    toast.success(`Cloned "${s.name}" v${s.version} as "${copy.name}".`);
  };

  /**
   * A scenario dropped on another row of its feature's outline
   * (specs/ui/navigation.feature.md "reorder scenarios by dragging them in
   * the tree"): it lands before or after that row and the feature is saved
   * in its new order, as Move up / Move down save it. The open feature with
   * no editor pane moves in place. Any other feature moves in the server's
   * copy, the way the tree's Delete edits it; an editor pane open on that
   * feature is left first, autosaving like any navigation away, and opens
   * again on the scenario it showed — its index would go stale under it.
   */
  const dropTreeScenario = async (
    file: string,
    dragged: { name: string; version: number },
    target: { name: string; version: number },
    after: boolean,
  ) => {
    if (file === selected && feature && editing === null) {
      const move = scenarioDrop(feature.scenarios, dragged, target, after);
      if (move) await moveScenarioTo(move.from, move.to);
      return;
    }
    if (file === selected && featureEditorsSealed.current) return;
    const reopen = file === selected ? paneScenario : null;
    if (file === selected && editing) {
      const ahead = autosaveInFlight.current;
      await closeEditor();
      await ahead;
    }
    await scenarioSaveQueue.current.idle();
    const url = `/api/features/${encodeURIComponent(file)}`;
    const reopenPane = () =>
      reopen && selectedRef.current === file
        ? openFeature(file, {
            scenario: { slug: slugify(reopen.name), version: reopen.version },
            pane: true,
          })
        : undefined;
    try {
      const got = await fetch(url);
      if (!got.ok) throw new Error("Could not move the scenario");
      const current = featureFromResponse(await got.json(), file);
      const move = scenarioDrop(current.scenarios, dragged, target, after);
      if (!move) {
        await reopenPane();
        return;
      }
      const next = withScenarioMoved(current, move.from, move.to);
      // The outline shows the new order while the save is out.
      setFeatures((prev) => withOpenScenarios(prev, file, next));
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not move the scenario");
      if (reopen) await reopenPane();
      else if (selectedRef.current === file) {
        setFeature(featureFromResponse(data, file));
        markSaved();
      }
    } catch (e) {
      toast.error(
        e instanceof TypeError
          ? "Could not move the scenario — is the server running?"
          : (e as Error).message,
      );
      await reopenPane();
    }
    await loadFeatures();
  };

  /** A scenario drag is over: dropped, or let go anywhere else. */
  const endScenarioDrag = () => {
    setScenarioDrag(null);
    setScenarioDropAt(null);
    setScenarioDropInto(null);
  };
  return {
    clearTreePicks,
    cloneTreeScenario,
    deletePickedScenarios,
    deleteTreeScenario,
    dropTreeScenario,
    endScenarioDrag,
    moveScenarioToFeature,
    moveTreeScenario,
    openScenarioRow,
    pickTreeScenario,
    pickedTreeScenarios,
  };
}

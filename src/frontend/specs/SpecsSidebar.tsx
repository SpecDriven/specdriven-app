// The feature tree (specs/ui/navigation.feature.md, specs/ui/folders.feature.md):
// the Specs tab's sidebar panel — folders, features and their scenario
// outlines, with the filter, the rows' menus, drag and drop and the session
// picks. Moved out of App.tsx (specs/app/plugins.feature.md "Specs is a
// built-in plugin"); it reads the listing and its own state from their
// stores, and what it does to features and folders App still hands it.

import { type TabPlugin } from "../../plugins/client/tabs";
import { type FeatureListing } from "../../server/features";
import { type ProjectMember } from "../../server/members";
import { type Feature, type Scenario, scenarioNumbers } from "../../server/parser";
import { NewFeatureIcon, NewFolderIcon, StartSessionIcon } from "../ActionIcons";
import { Menu } from "../Menu";
import { SidebarSection } from "../SidebarSection";
import { PublishRing, StatusCounts, StatusIcon } from "../StatusIcon";
import { Tooltip } from "../Tooltip";
import { codeGenTargetLabel } from "../codeGenTarget";
import { initialsOf } from "../initials";
import { featurePath, scenarioPath, SPECS_FOLDER } from "../route";
import { buildTree, featureDrop, folderDrop, folderDropsInto, folderLabel, type FolderNode, scenarioMovesInto, type ScenarioRow, scenarioRows, treeScenarioKey } from "../tree";
import { attributeFilterGroups, attributeFilterLabel, sameAttributeFilter } from "../treeFilter";
import { ArrowDown, ArrowRightLeft, ArrowUp, BookOpen, ChevronDown, ChevronRight, CopyPlus, Ellipsis, FolderInput, Import, Link, ListFilter, Pencil, Tag, Trash2, X } from "lucide-react";
import { useSpecsListing } from "./listing";
import { setDragging, setDropTarget, setFeatureDropAt, setFilter, setFilterMenuOpen, setFolderDrag, setFolderDropAt, setScenarioDrag, setScenarioDropAt, setScenarioDropInto, setSelectedFolder, setTreeMenu, useTreeState } from "./treeState";
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode, RefObject, SetStateAction } from "react";
import type { AgentDescriptor } from "../../server/agentTypes";
import type { AttributeDefinitions } from "../../server/customAttributes";
import type { Listing, OpenOptions } from "../App";

/** What App hands the tree: the handlers that act on its state, and what it derives. */
export interface SpecsSidebarProps {
  agents: AgentDescriptor[];
  ahaImport: boolean;
  assignments: boolean;
  attributeDefs: AttributeDefinitions;
  barTabs: TabPlugin<unknown>[];
  clearTreePicks: () => void;
  cloneTreeScenario: (file: string, s: ScenarioRow) => Promise<void>;
  codeGen: boolean;
  confluenceEnabled: boolean;
  copyLink: (path: string) => Promise<void>;
  createFeature: () => Promise<void>;
  createFeatureIn: (parent: string | null) => Promise<void>;
  createFolder: () => Promise<void>;
  createFolderIn: (parent: string | null) => Promise<void>;
  deletePickedScenarios: () => Promise<void>;
  deletePublished: boolean;
  deleteTreeScenario: (file: string, s: ScenarioRow) => Promise<void>;
  dropTreeScenario: (file: string, dragged: { name: string; version: number; }, target: { name: string; version: number; }, after: boolean) => Promise<void>;
  editFeatureDisplayName: (f: FeatureListing) => Promise<void>;
  editFolderDisplayName: (path: string) => Promise<void>;
  endScenarioDrag: () => void;
  feature: Feature | null;
  filtering: boolean;
  folderMenuKey: (path: string) => string;
  hosted: boolean;
  jiraEnabled: boolean;
  loadError: string | null;
  loadFeatures: () => Promise<Listing | null>;
  locked: boolean;
  matchesFilter: (f: FeatureListing) => boolean;
  me: string | null;
  members: ProjectMember[];
  moveFeaturePrompt: (fileName?: string | null) => Promise<void>;
  moveFeatureTo: (parent: string, from: number, to: number) => Promise<void>;
  moveFolder: (path: string, parent: string) => Promise<void>;
  moveFolderPrompt: (path: string) => Promise<void>;
  moveFolderTo: (parent: string, from: number, to: number) => Promise<void>;
  moveScenarioToFeature: (file: string, s: { name: string; version: number; }, to: string, at?: { name: string; version: number; after: boolean; } | undefined) => Promise<void>;
  moveTo: (fileName: string, folder: string) => Promise<void>;
  moveTreeScenario: (file: string, s: ScenarioRow) => Promise<void>;
  openConfluenceFolder: (node: FolderNode) => Promise<void>;
  openFeature: (file: string, opts?: OpenOptions) => Promise<void>;
  openScenarioRow: (file: string, s: ScenarioRow) => void;
  openSpecImport: boolean;
  paneScenario: Scenario | null;
  pickTreeScenario: (key: string, mode: "range" | "toggle", add?: boolean) => void;
  removeFeature: (f: FeatureListing) => Promise<void>;
  removeFolder: (path: string) => Promise<void>;
  renameFile: (fileName: string) => Promise<void>;
  renameFolder: (path: string) => Promise<void>;
  selected: string | null;
  selectionLabel: string;
  /** What was checked for a session, for the "Selected:" note. */
  checkedLabel: string;
  sessionCount: number;
  sessionNotice: ReactNode;
  sessionRunning: boolean;
  sessionTarget: string;
  setAhaImportOpen: Dispatch<SetStateAction<{ folder: string | null; } | null>>;
  setImportOpen: Dispatch<SetStateAction<{ folder: string | null; mode: "both" | "jira" | "wiki"; } | null>>;
  setOpenSpecImportOpen: Dispatch<SetStateAction<{ folder: string | null; } | null>>;
  spaClick: (e: MouseEvent, go: () => void) => void;
  specSelection: Map<string, Set<string> | "all">;
  startSession: () => void;
  statusTotals: { draft: number; proposed: number; published: number; };
  toggleFolder: (path: string) => void;
  toggleOutline: (file: string) => void;
  toggleSpecSelected: (fileName: string) => void;
  treePickAnchor: RefObject<string | null>;
  treePicksCount: number;
  treeRef: RefObject<HTMLDivElement | null>;
}

export function SpecsSidebar(props: SpecsSidebarProps) {
  const {
    agents,
    ahaImport,
    assignments,
    attributeDefs,
    barTabs,
    clearTreePicks,
    cloneTreeScenario,
    codeGen,
    confluenceEnabled,
    copyLink,
    createFeature,
    createFeatureIn,
    createFolder,
    createFolderIn,
    deletePickedScenarios,
    deletePublished,
    deleteTreeScenario,
    dropTreeScenario,
    editFeatureDisplayName,
    editFolderDisplayName,
    endScenarioDrag,
    feature,
    filtering,
    folderMenuKey,
    hosted,
    jiraEnabled,
    loadError,
    loadFeatures,
    locked,
    matchesFilter,
    me,
    members,
    moveFeaturePrompt,
    moveFeatureTo,
    moveFolder,
    moveFolderPrompt,
    moveFolderTo,
    moveScenarioToFeature,
    moveTo,
    moveTreeScenario,
    openConfluenceFolder,
    openFeature,
    openScenarioRow,
    openSpecImport,
    paneScenario,
    pickTreeScenario,
    removeFeature,
    removeFolder,
    renameFile,
    renameFolder,
    selected,
    selectionLabel,
    checkedLabel,
    sessionCount,
    sessionNotice,
    sessionRunning,
    sessionTarget,
    setAhaImportOpen,
    setImportOpen,
    setOpenSpecImportOpen,
    spaClick,
    specSelection,
    startSession,
    statusTotals,
    toggleFolder,
    toggleOutline,
    toggleSpecSelected,
    treePickAnchor,
    treePicksCount,
    treeRef,
  } = props;
  const { featureOrders, features, folderDescriptions, folderOrders, folders } = useSpecsListing();
  const {
    collapsed,
    dragging,
    dropTarget,
    featureDropAt,
    filter,
    filterMenuOpen,
    folderDrag,
    folderDropAt,
    outlined,
    scenarioDrag,
    scenarioDropAt,
    scenarioDropInto,
    selectedFolder,
    treeMenu,
    treePicks,
  } = useTreeState();

  /**
   * One sidebar entry per feature; the entry is the drag source. `parent` is
   * the folder it sits in, whose features it moves up and down among
   * (specs/ui/folders.feature.md "order features").
   */
  const featureItem = (f: FeatureListing, depth: number, parent: FolderNode) => {
    const index = parent.features.findIndex((x) => x.fileName === f.fileName);
    // Drag to reorder ("order features"): a feature dragged over a sibling's
    // row lands before or after it; over a row in another folder it still
    // drops into that folder, the folder's own drag-move.
    const siblingDrag =
      dragging !== null && dragging !== f.fileName && parent.features.some((x) => x.fileName === dragging);
    const featureDropEdge =
      siblingDrag && featureDropAt?.fileName === f.fileName
        ? featureDropAt.after
          ? " drop-after"
          : " drop-before"
        : "";
    // A scenario dragged out of another feature — a row of its outline or a
    // card of its page — drops in here, last (specs/ui/navigation.feature.md
    // "drag a scenario to another feature").
    const scenarioInto =
      scenarioDrag !== null && scenarioMovesInto(scenarioDrag, f.fileName, deletePublished);
    const entry = specSelection.get(f.fileName);
    // The feature's scenarios, listed under it when the outline is expanded
    // (specs/ui/navigation.feature.md "Scenario navigation"). The open feature
    // reads from its live state, so a save shows here before the listing's
    // next refresh.
    const rows = scenarioRows(f, selected, feature);
    const expanded = rows.length > 0 && outlined.has(f.fileName);
    return (
      <div key={f.fileName}>
        <div
          className={`tree-row${matchesFilter(f) ? "" : " dim"}${featureDropEdge}${
            dragging === f.fileName ? " dragging" : ""
          }${scenarioInto && scenarioDropInto === f.fileName ? " drop-target" : ""}`}
          onDragOver={(e) => {
            if (scenarioInto) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              setScenarioDropAt(null);
              if (scenarioDropInto !== f.fileName) setScenarioDropInto(f.fileName);
              return;
            }
            if (!siblingDrag) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(null);
            const box = e.currentTarget.getBoundingClientRect();
            const after = e.clientY > box.top + box.height / 2;
            if (featureDropAt?.fileName !== f.fileName || featureDropAt.after !== after) {
              setFeatureDropAt({ fileName: f.fileName, after });
            }
          }}
          onDragLeave={(e) => {
            if (scenarioDropInto === f.fileName && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setScenarioDropInto(null);
            }
          }}
          onDrop={(e) => {
            if (scenarioInto) {
              e.preventDefault();
              e.stopPropagation();
              const dragged = scenarioDrag!;
              endScenarioDrag();
              void moveScenarioToFeature(dragged.file, dragged, f.fileName);
              return;
            }
            if (!siblingDrag) return;
            e.preventDefault();
            e.stopPropagation();
            const box = e.currentTarget.getBoundingClientRect();
            const dragged = dragging!;
            setDragging(null);
            setDropTarget(null);
            setFeatureDropAt(null);
            const move = featureDrop(parent.features, dragged, f.fileName, e.clientY > box.top + box.height / 2);
            if (move) void moveFeatureTo(parent.path, move.from, move.to);
          }}
        >
          {/* Code gen selection (specs/agents/claude.feature.md): checking a
              spec here takes the whole thing; a dash means some of its
              scenarios are picked, which is done on the scenario cards.
              Gone entirely when the Settings switch is off. */}
          {codeGen && (
            <input
              type="checkbox"
              className="tree-check"
              style={{ marginLeft: `${0.4 + depth * 0.9}rem` }}
              checked={entry === "all"}
              ref={(el) => {
                if (el) el.indeterminate = entry !== undefined && entry !== "all";
              }}
              onChange={() => toggleSpecSelected(f.fileName)}
              aria-label={`Select ${f.name} for an AI session`}
              title={
                entry !== undefined && entry !== "all"
                  ? "Some scenarios of this spec are selected"
                  : `Select all of ${f.name} for an AI session`
              }
            />
          )}
          {/* The outline twisty (specs/ui/navigation.feature.md "Scenario
              navigation"): expands the feature's scenarios under it. Not a
              treeitem of its own — the feature link keeps that role, so the
              tree's ↑/↓ walk is unchanged. A feature with no scenarios keeps
              the same-width spacer so every label stays on one line. */}
          {rows.length > 0 ? (
            <button
              type="button"
              className="scenario-toggle"
              style={{ marginLeft: codeGen ? undefined : `${depth * 0.9}rem` }}
              aria-expanded={expanded}
              aria-label={`Scenarios of ${f.name}`}
              onClick={() => toggleOutline(f.fileName)}
            >
              {expanded ? (
                <ChevronDown size={12} aria-hidden="true" />
              ) : (
                <ChevronRight size={12} aria-hidden="true" />
              )}
            </button>
          ) : (
            <span
              className="scenario-toggle spacer"
              style={{ marginLeft: codeGen ? undefined : `${depth * 0.9}rem` }}
              aria-hidden="true"
            />
          )}
          {/* A real link (specs/ui/navigation.feature.md "share a link"): plain
          clicks navigate in-app, right-click → Copy Link works. The label is
          the feature name, not the file name (specs/ui/ui.feature.md "Main
          page"). */}
      <a
        href={featurePath(f.fileName)}
        className={`tree-feature${f.fileName === selected ? " active" : ""}`}
        role="treeitem"
        aria-level={depth + 1}
        aria-current={f.fileName === selected ? "page" : undefined}
        data-file={f.fileName}
        /* The checkbox and the twisty carry the depth indent before it. */
        style={{ paddingLeft: "0.2rem" }}
        draggable={!locked}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", f.fileName);
          e.dataTransfer.effectAllowed = "move";
          setDragging(f.fileName);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDropTarget(null);
          setFeatureDropAt(null);
        }}
        onClick={(e) =>
          spaClick(e, () => {
            // Opening a feature is a deliberate move away from the folder.
            setSelectedFolder(null);
            void openFeature(f.fileName, { push: true });
          })
        }
      >
        {f.name}
      </a>
      {/* The feature's rollup (specs/ui/ui.feature.md "Design system"): how
          many of its scenarios are published, as a small ring. */}
      <PublishRing
        published={f.scenarios.filter((s) => s.status === "published").length}
        total={f.scenarios.length}
      />
      {/* Drop down menu (specs/ui/ui.feature.md "Feature entry menu"): File →
          Rename edits the underlying file name; Delete removes the file. */}
      <span className="tree-row-menu">
        <Tooltip label="More actions">
          <button
            type="button"
            className="tree-menu-btn"
            aria-label={`Menu for ${f.fileName}`}
            aria-haspopup="menu"
            aria-expanded={treeMenu === f.fileName}
            onClick={() => setTreeMenu((m) => (m === f.fileName ? null : f.fileName))}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </button>
        </Tooltip>
        <Menu
          open={treeMenu === f.fileName}
          onClose={() => setTreeMenu(null)}
          label={`Menu for ${f.fileName}`}
          className="tree-menu"
          containerSelector=".tree-row-menu"
          items={[
            // Plain "Rename" on the menu itself (ui.feature.md "Feature entry
            // menu"): the name belongs to the row, and a long one would widen
            // the menu past the sidebar's left edge.
            {
              id: "rename",
              label: "Rename",
              icon: <Pencil size={13} />,
              onSelect: () => void renameFile(f.fileName),
            },
            {
              id: "display-name",
              label: "Edit display name",
              icon: <Tag size={13} />,
              onSelect: () => void editFeatureDisplayName(f),
            },
            // Move up / Move down (specs/ui/folders.feature.md "order
            // features"): the order among its siblings is the user's, kept
            // in the folder's feature-order.txt.
            {
              id: "move-up",
              label: "Move up",
              icon: <ArrowUp size={13} />,
              disabled: index <= 0,
              onSelect: () => void moveFeatureTo(parent.path, index, index - 1),
            },
            {
              id: "move-down",
              label: "Move down",
              icon: <ArrowDown size={13} />,
              disabled: index < 0 || index === parent.features.length - 1,
              onSelect: () => void moveFeatureTo(parent.path, index, index + 1),
            },
            {
              id: "move",
              label: "Move to folder…",
              icon: <FolderInput size={13} />,
              onSelect: () => void moveFeaturePrompt(f.fileName),
            },
            // Copy link (specs/ui/navigation.feature.md "share a link"): the
            // feature's url, as the page's ⋯ offers it.
            {
              id: "copy",
              label: "Copy link",
              icon: <Link size={13} />,
              onSelect: () => void copyLink(featurePath(f.fileName)),
            },
            {
              id: "delete",
              label: "Delete",
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: () => void removeFeature(f),
            },
          ]}
        />
      </span>
        </div>
        {/* The expanded outline (specs/ui/navigation.feature.md "Scenario
            navigation"): each scenario is a real link to its own page, so
            right-click → Copy Link and cmd-click work like every other
            sidebar entry. A plain click opens that scenario's editor pane —
            the point of the scenario, switching without going back to the
            feature view. */}
        {expanded && (
          <div role="group">
            {rows.map((s) => {
              const here =
                f.fileName === selected &&
                paneScenario !== null &&
                paneScenario.name === s.name &&
                paneScenario.version === s.version;
              // Its menu (specs/ui/navigation.feature.md "Scenario
              // navigation"): Clone always; Move to… and Delete on the
              // same terms as the editor pane's Delete — a published scenario
              // only while Settings allows it.
              const menuKey = treeScenarioKey(f.fileName, s);
              const deletable = s.status !== "published" || deletePublished;
              // Picked for a bulk action ("delete several scenarios at
              // once"); with more than this one picked, its Delete deletes
              // them all.
              const picked = treePicks.has(menuKey);
              const pickedCount = picked ? treePicksCount : 0;
              // Drag to reorder (specs/ui/navigation.feature.md "reorder
              // scenarios by dragging them in the tree"): landing before or
              // after the row it is over — in this feature, or moved here
              // out of another one ("drag a scenario to another feature").
              const same = (x: { name: string; version: number } | null) =>
                x !== null && x.name === s.name && x.version === s.version;
              const draggingHere = scenarioDrag !== null && scenarioDrag.file === f.fileName;
              const droppable = draggingHere || scenarioInto;
              const dropEdge =
                droppable &&
                scenarioDropAt?.file === f.fileName &&
                same(scenarioDropAt) &&
                !(draggingHere && same(scenarioDrag))
                  ? scenarioDropAt.after
                    ? " drop-after"
                    : " drop-before"
                  : "";
              return (
                <div
                  key={`${s.name}-v${s.version}`}
                  className={`tree-scenario-row${dropEdge}${draggingHere && same(scenarioDrag) ? " dragging" : ""}${
                    picked ? " picked" : ""
                  }`}
                  onDragOver={(e) => {
                    if (!droppable) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "move";
                    setScenarioDropInto(null);
                    const box = e.currentTarget.getBoundingClientRect();
                    const after = e.clientY > box.top + box.height / 2;
                    if (
                      scenarioDropAt?.file !== f.fileName ||
                      !same(scenarioDropAt) ||
                      scenarioDropAt.after !== after
                    ) {
                      setScenarioDropAt({ file: f.fileName, name: s.name, version: s.version, after });
                    }
                  }}
                  onDrop={(e) => {
                    if (!droppable) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const box = e.currentTarget.getBoundingClientRect();
                    const dragged = scenarioDrag!;
                    const at = {
                      name: s.name,
                      version: s.version,
                      after: e.clientY > box.top + box.height / 2,
                    };
                    endScenarioDrag();
                    if (draggingHere) void dropTreeScenario(f.fileName, dragged, at, at.after);
                    else void moveScenarioToFeature(dragged.file, dragged, f.fileName, at);
                  }}
                >
                  <a
                    href={scenarioPath(f.fileName, s)}
                    className={`tree-scenario${here ? " active" : ""}`}
                    role="treeitem"
                    aria-level={depth + 2}
                    /* Shift+F10 on the row opens its ⋯ (onTreeKeyDown). */
                    data-scenario={menuKey}
                    aria-current={here ? "page" : undefined}
                    aria-selected={locked ? undefined : picked}
                    /* Line up just past the feature's twisty: the codegen
                       checkbox, when on, already carries the depth indent for
                       the whole row, so it is not added twice. */
                    style={{ paddingLeft: `${(codeGen ? 1.5 : 0.6) + depth * 0.9}rem` }}
                    title={`${s.name} v${s.version}`}
                    draggable={!locked}
                    onDragStart={(e) => {
                      e.stopPropagation();
                      e.dataTransfer.setData("text/plain", scenarioPath(f.fileName, s));
                      e.dataTransfer.effectAllowed = "move";
                      setScenarioDrag({ file: f.fileName, name: s.name, version: s.version, status: s.status });
                    }}
                    onDragEnd={endScenarioDrag}
                    /* Shift-click would select the page's text from here to
                       the last click before the click picks the range. */
                    onMouseDown={(e) => {
                      if (!locked && e.shiftKey) e.preventDefault();
                    }}
                    onClick={(e) => {
                      // ⌘/Ctrl-click toggles the row, Shift-click picks the
                      // range ("delete several scenarios at once") — in place
                      // of the browser's new tab or window for this link;
                      // right-click → Open in new tab still works.
                      if (!locked && !e.altKey && (e.metaKey || e.ctrlKey || e.shiftKey)) {
                        e.preventDefault();
                        if (e.shiftKey) pickTreeScenario(menuKey, "range", e.metaKey || e.ctrlKey);
                        else pickTreeScenario(menuKey, "toggle");
                        return;
                      }
                      spaClick(e, () => {
                        clearTreePicks();
                        treePickAnchor.current = menuKey;
                        openScenarioRow(f.fileName, s);
                      });
                    }}
                  >
                    {scenarioNumbers(rows)[rows.indexOf(s)] !== null && (
                      <span className="scenario-number">S{scenarioNumbers(rows)[rows.indexOf(s)]}</span>
                    )}
                    <StatusIcon status={s.status} size={12} />
                    <span className="tree-scenario-name">{s.name}</span>
                    <span className="version">v{s.version}</span>
                  </a>
                  <span className="tree-row-menu">
                    <Tooltip label="More actions">
                      <button
                        type="button"
                        className="tree-menu-btn"
                        aria-label={`Menu for ${s.name} v${s.version}`}
                        aria-haspopup="menu"
                        aria-expanded={treeMenu === menuKey}
                        onClick={() => setTreeMenu((m) => (m === menuKey ? null : menuKey))}
                      >
                        <Ellipsis size={14} aria-hidden="true" />
                      </button>
                    </Tooltip>
                    <Menu
                      open={treeMenu === menuKey}
                      onClose={() => setTreeMenu(null)}
                      label={`Menu for ${s.name} v${s.version}`}
                      className="tree-menu"
                      containerSelector=".tree-row-menu"
                      items={[
                        ...(deletable
                          ? [
                              {
                                id: "move",
                                label: "Move to…",
                                icon: <ArrowRightLeft size={13} />,
                                onSelect: () => void moveTreeScenario(f.fileName, s),
                              },
                            ]
                          : []),
                        // Copy link (specs/ui/navigation.feature.md "share a
                        // link"): the versioned permalink the card copies.
                        {
                          id: "copy",
                          label: "Copy link",
                          icon: <Link size={13} />,
                          onSelect: () => void copyLink(scenarioPath(f.fileName, s)),
                        },
                        {
                          id: "clone",
                          label: "Clone",
                          icon: <CopyPlus size={13} />,
                          onSelect: () => void cloneTreeScenario(f.fileName, s),
                        },
                        ...(pickedCount > 1
                          ? [
                              {
                                id: "delete",
                                label: `Delete ${pickedCount} scenarios`,
                                icon: <Trash2 size={13} />,
                                danger: true,
                                onSelect: () => void deletePickedScenarios(),
                              },
                            ]
                          : deletable
                            ? [
                                {
                                  id: "delete",
                                  label: "Delete",
                                  icon: <Trash2 size={13} />,
                                  danger: true,
                                  onSelect: () => void deleteTreeScenario(f.fileName, s),
                                },
                              ]
                            : []),
                      ]}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderTree = (node: FolderNode, depth: number) => (
    <>
      {node.folders.map((child, i) => {
        // Drag to reorder (specs/ui/folders.feature.md "order folders"):
        // among this folder's siblings only, landing before or after the
        // row it is over. A folder dragged elsewhere drops nowhere.
        const siblingDrag = folderDrag !== null && folderDrag.parent === node.path;
        const folderDropEdge =
          siblingDrag && folderDropAt?.path === child.path && folderDrag!.path !== child.path
            ? folderDropAt!.after
              ? " drop-after"
              : " drop-before"
            : "";
        const endFolderDrag = () => {
          setFolderDrag(null);
          setFolderDropAt(null);
          setDropTarget(null);
        };
        return (
        <div
          key={child.path}
          onDragOver={(e) => {
            // A folder dragged over another folder's subtree ("move a
            // folder") drops into it — sibling rows took the drag already,
            // to reorder. The nearest folder decides: over the folder it is
            // in, or itself, it drops nowhere, never falling through to the
            // tree background.
            if (folderDrag !== null) {
              e.stopPropagation();
              if (!folderDropsInto(folderDrag, child.path)) {
                setDropTarget(null);
                return;
              }
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(child.path);
              return;
            }
            if (dragging === null) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(child.path);
          }}
          onDragLeave={() => setDropTarget((t) => (t === child.path ? null : t))}
          onDrop={(e) => {
            if (folderDrag !== null) {
              e.stopPropagation();
              if (!folderDropsInto(folderDrag, child.path)) return;
              e.preventDefault();
              const dragged = folderDrag.path;
              endFolderDrag();
              void moveFolder(dragged, child.path);
              return;
            }
            if (dragging === null) return;
            e.preventDefault();
            e.stopPropagation();
            void moveTo(dragging, child.path);
          }}
        >
          <div
            className={`folder-row${(dragging !== null || folderDrag !== null) && dropTarget === child.path ? " drop-target" : ""}${
              child.path === selectedFolder ? " selected" : ""
            }${folderDropEdge}${siblingDrag && folderDrag!.path === child.path ? " dragging" : ""}`}
            style={{ paddingLeft: `${depth * 0.9}rem` }}
            onDragOver={(e) => {
              if (!siblingDrag) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(null);
              const box = e.currentTarget.getBoundingClientRect();
              const after = e.clientY > box.top + box.height / 2;
              if (folderDropAt?.path !== child.path || folderDropAt.after !== after) {
                setFolderDropAt({ path: child.path, after });
              }
            }}
            onDrop={(e) => {
              if (!siblingDrag) return;
              e.preventDefault();
              e.stopPropagation();
              const box = e.currentTarget.getBoundingClientRect();
              const dragged = folderDrag!.path;
              endFolderDrag();
              const move = folderDrop(node.folders, dragged, child.path, e.clientY > box.top + box.height / 2);
              if (move) void moveFolderTo(node.path, move.from, move.to);
            }}
          >
            {/* Clicking selects the folder (specs/ui/folders.feature.md — "+
                New folder" then creates inside it) and toggles its subtree.
                The button is the drag handle too ("order folders"). */}
            <button
              type="button"
              className="folder-toggle"
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={!collapsed.has(child.path)}
              data-folder={child.path}
              title={child.description ? child.path : undefined}
              draggable={!locked}
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.setData("text/plain", child.path);
                e.dataTransfer.effectAllowed = "move";
                setFolderDrag({ parent: node.path, path: child.path });
              }}
              onDragEnd={endFolderDrag}
              onClick={() => {
                setSelectedFolder(child.path);
                toggleFolder(child.path);
              }}
            >
              <span className="twist">
                {collapsed.has(child.path) ? (
                  <ChevronRight size={12} aria-hidden="true" />
                ) : (
                  <ChevronDown size={12} aria-hidden="true" />
                )}
              </span>{" "}
              {/* The display-name.txt's line when the folder has one
                  (specs/ui/folders.feature.md "describe a folder"); the
                  folder's own name is then a hover away. */}
              {folderLabel(child)}
            </button>
            {/* The folder's own ⋯ (specs/ui/folders.feature.md "Folder
                menu"): create inside it, rename it, delete it — the same
                quiet button a feature row carries, keyboard included. */}
            <span className="tree-row-menu">
              <Tooltip label="More actions">
                <button
                  type="button"
                  className="tree-menu-btn"
                  aria-label={`Menu for folder ${child.path}`}
                  aria-haspopup="menu"
                  aria-expanded={treeMenu === folderMenuKey(child.path)}
                  onClick={() =>
                    setTreeMenu((m) => (m === folderMenuKey(child.path) ? null : folderMenuKey(child.path)))
                  }
                >
                  <Ellipsis size={14} aria-hidden="true" />
                </button>
              </Tooltip>
              <Menu
                open={treeMenu === folderMenuKey(child.path)}
                onClose={() => setTreeMenu(null)}
                label={`Menu for folder ${child.path}`}
                className="tree-menu"
                containerSelector=".tree-row-menu"
                items={[
                  {
                    id: "new-feature",
                    label: "New feature here",
                    icon: <NewFeatureIcon size={13} />,
                    onSelect: () => void createFeatureIn(child.path),
                  },
                  // Import from Aha! (specs/external-links/aha-import
                  // .feature.md): the feature lands in this folder. Only
                  // while switched on in Settings; never in the demo or the
                  // hosted app, which keep no API key.
                  ...(!ahaImport
                    ? []
                    : [
                        {
                          id: "import-aha",
                          label: "Import from Aha! here…",
                          icon: <Import size={13} />,
                          onSelect: () => setAhaImportOpen({ folder: child.path }),
                        },
                      ]),
                  // Import from OpenSpec (specs/external-links/openspec-
                  // import.feature.md): the code repo's capabilities land
                  // in this folder.
                  ...(!openSpecImport
                    ? []
                    : [
                        {
                          id: "import-openspec",
                          label: "Import from OpenSpec here…",
                          icon: <Import size={13} />,
                          onSelect: () => setOpenSpecImportOpen({ folder: child.path }),
                        },
                      ]),
                  // Import from Jira/Wiki (specs/external-links/jira-wiki
                  // -import.feature.md "Jira and Confluence imports are
                  // switched on in Settings"): which item shows depends on
                  // which integrations are on — both the combined importer,
                  // one that side only, neither no item. Never in the demo or
                  // the hosted app, which keep no token and no agent.
                  ...(jiraEnabled && confluenceEnabled
                    ? [
                        {
                          id: "import-jira-wiki",
                          label: "Import from Jira/Wiki here…",
                          icon: <Import size={13} />,
                          onSelect: () => setImportOpen({ folder: child.path, mode: "both" as const }),
                        },
                      ]
                    : jiraEnabled
                      ? [
                          {
                            id: "import-jira",
                            label: "Import from Jira here…",
                            icon: <Import size={13} />,
                            onSelect: () => setImportOpen({ folder: child.path, mode: "jira" as const }),
                          },
                        ]
                      : confluenceEnabled
                        ? [
                            {
                              id: "import-confluence",
                              label: "Import from Confluence here…",
                              icon: <Import size={13} />,
                              onSelect: () => setImportOpen({ folder: child.path, mode: "wiki" as const }),
                            },
                          ]
                        : []),
                  {
                    id: "new-folder",
                    label: "New folder here",
                    icon: <NewFolderIcon size={13} />,
                    onSelect: () => void createFolderIn(child.path),
                  },
                  {
                    id: "rename",
                    label: "Rename",
                    icon: <Pencil size={13} />,
                    onSelect: () => void renameFolder(child.path),
                  },
                  {
                    id: "display-name",
                    label: "Edit display name",
                    icon: <Tag size={13} />,
                    onSelect: () => void editFolderDisplayName(child.path),
                  },
                  // Move up / Move down (specs/ui/folders.feature.md "order
                  // folders"): the order among its siblings is the user's,
                  // kept in the parent's folder-order.txt.
                  {
                    id: "move-up",
                    label: "Move up",
                    icon: <ArrowUp size={13} />,
                    disabled: i === 0,
                    onSelect: () => void moveFolderTo(node.path, i, i - 1),
                  },
                  {
                    id: "move-down",
                    label: "Move down",
                    icon: <ArrowDown size={13} />,
                    disabled: i === node.folders.length - 1,
                    onSelect: () => void moveFolderTo(node.path, i, i + 1),
                  },
                  {
                    id: "move",
                    label: "Move to folder…",
                    icon: <FolderInput size={13} />,
                    onSelect: () => void moveFolderPrompt(child.path),
                  },
                  // Publish to Confluence (specs/external-links/confluence
                  // -wiki.feature.md "Publish a folder's features to
                  // Confluence"): each feature under the folder its own page
                  // under one parent. Only while Confluence is switched on in
                  // Settings; never in the demo or the hosted app.
                  ...(confluenceEnabled
                    ? [
                        {
                          id: "confluence",
                          label: "Publish to Confluence…",
                          icon: <BookOpen size={13} />,
                          onSelect: () => void openConfluenceFolder(child),
                        },
                      ]
                    : []),
                  {
                    id: "delete",
                    label: "Delete",
                    icon: <Trash2 size={13} />,
                    danger: true,
                    onSelect: () => void removeFolder(child.path),
                  },
                ]}
              />
            </span>
          </div>
          {!collapsed.has(child.path) && <div role="group">{renderTree(child, depth + 1)}</div>}
        </div>
        );
      })}
      {node.features.map((f) => featureItem(f, depth, node))}
    </>
  );

  // Tree keyboard: ↑/↓ walk the visible rows, → opens a folder (or steps
  // in), ← closes it or climbs to it from a feature, Home/End jump,
  // Shift+F10 or the menu key opens a feature's ⋯. Enter stays the row's own.
  const onTreeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=treeitem]")];
    const i = rows.indexOf(t);
    if (i === -1) return;
    const move = (to: number) => rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
    const folderPath = t.dataset.folder;
    // Shift+↑/↓ from a scenario row grows the pick to the next scenario row
    // ("delete several scenarios at once"), as Shift-click would.
    const extend = (to: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      const from = t.dataset.scenario;
      if (!next?.dataset.scenario || from === undefined) return false;
      if (treePickAnchor.current === null || !treePicks.has(treePickAnchor.current)) {
        treePickAnchor.current = from;
      }
      pickTreeScenario(next.dataset.scenario, "range");
      next.focus();
      return true;
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (e.shiftKey && !locked && extend(i + 1)) return;
        move(i + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (e.shiftKey && !locked && extend(i - 1)) return;
        move(i - 1);
        return;
      case "Delete":
      case "Backspace": {
        // Delete on a scenario row: the picks when there are any, else the
        // row itself — each with its confirmation.
        const key = t.dataset.scenario;
        if (key === undefined || locked) return;
        e.preventDefault();
        if (treePicks.size > 0) {
          void deletePickedScenarios();
          return;
        }
        const [file, name, version] = key.split("\u0000");
        const listing = features.find((f) => f.fileName === file);
        const row = listing
          ? scenarioRows(listing, selected, feature).find(
              (r) => r.name === name && String(r.version) === version,
            )
          : undefined;
        if (!row || (row.status === "published" && !deletePublished)) return;
        void deleteTreeScenario(file!, row);
        return;
      }
      case "Home":
        e.preventDefault();
        move(0);
        return;
      case "End":
        e.preventDefault();
        move(rows.length - 1);
        return;
      case "ArrowRight":
        // A feature row opens its scenario outline the way a folder opens its
        // subtree (specs/ui/navigation.feature.md "Scenario navigation").
        if (folderPath === undefined) {
          const file = t.dataset.file;
          if (file === undefined) return;
          e.preventDefault();
          // Already outlined: step into it, as ArrowRight on an open folder
          // moves to its first child.
          if (outlined.has(file)) move(i + 1);
          else toggleOutline(file);
          return;
        }
        e.preventDefault();
        if (collapsed.has(folderPath)) toggleFolder(folderPath);
        else move(i + 1);
        return;
      case "ArrowLeft": {
        e.preventDefault();
        if (folderPath !== undefined && !collapsed.has(folderPath)) {
          toggleFolder(folderPath);
          return;
        }
        const file = t.dataset.file;
        if (file !== undefined && outlined.has(file)) {
          toggleOutline(file);
          return;
        }
        t.closest("[role=group]")
          ?.parentElement?.querySelector<HTMLElement>("[role=treeitem]")
          ?.focus();
        return;
      }
      case "F10":
        if (!e.shiftKey) return;
        if (t.dataset.scenario) setTreeMenu(t.dataset.scenario);
        else if (t.dataset.file) setTreeMenu(t.dataset.file);
        else if (folderPath !== undefined) setTreeMenu(folderMenuKey(folderPath));
        else return;
        e.preventDefault();
        return;
      case "ContextMenu":
        if (t.dataset.scenario) setTreeMenu(t.dataset.scenario);
        else if (t.dataset.file) setTreeMenu(t.dataset.file);
        else if (folderPath !== undefined) setTreeMenu(folderMenuKey(folderPath));
        else return;
        e.preventDefault();
        return;
    }
  };

  return (
    <div
      className="side-panel"
      role={barTabs.length > 1 ? "tabpanel" : undefined}
      id="side-panel-specs"
      aria-labelledby={barTabs.length > 1 ? "side-tab-specs" : undefined}
    >
    {/* A load that failed every retry offers the manual one: without it
        the sidebar would sit empty until the next page load, and with
        the cron refresh off (reloadFrequencySeconds 0) nothing else asks. */}
    {loadError && (
      <p className="error">
        {loadError}{" "}
        <button type="button" className="link" onClick={() => void loadFeatures()}>
          Try again
        </button>
      </p>
    )}
    {/* The Features section head carries the filter: by status, by
        assignee. Active filters show as chips that clear on click, on a
        row of their own under the head so they never crowd its icons. */}
    <SidebarSection
      label={<>Features <StatusCounts {...statusTotals} /></>}
      filter={<>
        <Tooltip label="Filter features">
          <button
            type="button"
            className={`chip${filtering ? " on" : ""}`}
            aria-label="Filter features"
            aria-haspopup="menu"
            aria-expanded={filterMenuOpen}
            onClick={() => setFilterMenuOpen((o) => !o)}
          >
            <ListFilter size={12} aria-hidden="true" /> Filter
          </button>
        </Tooltip>
        <Menu
          open={filterMenuOpen}
          onClose={() => setFilterMenuOpen(false)}
          label="Filter features"
          className="filter-menu"
          containerSelector=".filter-anchor"
          items={[
            {
              id: "status",
              label: "Status",
              items: [
                {
                  id: "status-any",
                  label: "Any status",
                  checked: filter.status === null,
                  onSelect: () => setFilter((f) => ({ ...f, status: null })),
                },
                ...(["draft", "proposed", "published"] as const).map((st) => ({
                  id: `status-${st}`,
                  label: st[0]!.toUpperCase() + st.slice(1),
                  icon: <StatusIcon status={st} size={13} />,
                  checked: filter.status === st,
                  onSelect: () => setFilter((f) => ({ ...f, status: st })),
                })),
              ],
            },
            ...(assignments
              ? [
                  {
                    id: "assignee",
                    label: "Assignee",
                    items: [
                      {
                        id: "assignee-any",
                        label: "Anyone",
                        checked: filter.assignee === null,
                        onSelect: () => setFilter((f) => ({ ...f, assignee: null })),
                      },
                      ...members.map((m) => ({
                        id: `assignee-${m.name}`,
                        label: m.name,
                        icon: (
                          <span className="avatar chip-avatar" aria-hidden="true">
                            {initialsOf(m.name)}
                          </span>
                        ),
                        checked: filter.assignee === m.name,
                        onSelect: () => setFilter((f) => ({ ...f, assignee: m.name })),
                      })),
                    ],
                  },
                ]
              : []),
            // One entry per attribute key the specs use: "Any …", each
            // attribute by its names, and each with its value.
            ...attributeFilterGroups(features, attributeDefs).map((group) => ({
              id: `attribute-${group.key}`,
              label: group.label,
              items: group.items.map((item) => ({
                id: `attribute-${item.id}`,
                label: item.label,
                title: item.label,
                checked: sameAttributeFilter(filter.attribute, item.filter),
                onSelect: () =>
                  setFilter((f) => ({
                    ...f,
                    attribute: sameAttributeFilter(f.attribute, item.filter) ? null : item.filter,
                  })),
              })),
            })),
          ]}
        />
      </>}
      /* The tree's actions (src/frontend/ActionIcons.tsx) sit on its
          head rather than in rows of their own. New folder and New
          feature create inside the clicked folder, and their tooltips
          name it. Code gen session (specs/agents/claude.feature.md): check
          whole specs in the tree or single scenarios on their cards,
          then Start session asks for a name and where to run; the
          count of checked specs rides on its button. Timing your own
          work is the Pomodoro at the foot of the sidebar
          (specs/app/pomodoro.feature.md), not a kind of session. */
      actions={!locked && (<>
        <Tooltip label={selectedFolder ? `New folder in "${selectedFolder}"` : "New folder"}>
          <button type="button" className="ibtn" aria-label="New folder" onClick={createFolder}>
            <NewFolderIcon size={15} />
          </button>
        </Tooltip>
        <Tooltip
          label={selectedFolder ? `New feature in "${selectedFolder}"` : "New feature"}
          keys="c"
        >
          <button type="button" className="ibtn" aria-label="New feature" onClick={createFeature}>
            <NewFeatureIcon size={15} />
          </button>
        </Tooltip>
        {ahaImport && (
          <Tooltip label={selectedFolder ? `Import from Aha! into "${selectedFolder}"` : "Import from Aha!"}>
            <button
              type="button"
              className="ibtn"
              aria-label="Import from Aha!"
              onClick={() => setAhaImportOpen({ folder: selectedFolder })}
            >
              <Import size={15} />
            </button>
          </Tooltip>
        )}
        <Tooltip
          label={
            sessionRunning
              ? "Session running…"
              : sessionCount === 0
                ? "Select a feature or scenarios to start an AI session"
                : hosted
                  ? `Open Claude Code with a prompt for ${selectionLabel}`
                  : codeGen
                    ? `Start an AI session in ${codeGenTargetLabel(sessionTarget, agents)} with ${selectionLabel}`
                    : "Start an AI session"
          }
        >
          <button
            type="button"
            className={`ibtn session-btn${codeGen && specSelection.size > 0 ? " armed" : ""}${
              sessionRunning ? " running" : ""
            }`}
            aria-label={
              sessionRunning
                ? "Session running…"
                : hosted
                  ? "Open Claude Code with a prompt"
                  : `Start session…${codeGen && specSelection.size > 0 ? ` (${specSelection.size})` : ""}`
            }
            // Off with nothing to run over, but still hoverable (a disabled
            // button gets no hover), so its tooltip says what to select.
            aria-disabled={sessionCount === 0 || undefined}
            onClick={() => {
              if (sessionCount > 0) startSession();
            }}
            disabled={sessionRunning}
          >
            <StartSessionIcon size={15} />
            {codeGen && specSelection.size > 0 && !sessionRunning && (
              <span className="action-count" aria-hidden="true">
                {specSelection.size}
              </span>
            )}
          </button>
        </Tooltip>
      </>)}
    >
    {filtering && (
      <div className="filter-chips">
        {filter.status && (
          <button
            type="button"
            className="chip on"
            aria-label={`Clear the ${filter.status} filter`}
            onClick={() => setFilter((f) => ({ ...f, status: null }))}
          >
            <StatusIcon status={filter.status} size={12} /> {filter.status}{" "}
            <X size={11} aria-hidden="true" />
          </button>
        )}
        {filter.assignee && (
          <button
            type="button"
            className="chip on"
            aria-label="Clear the assignee filter"
            onClick={() => setFilter((f) => ({ ...f, assignee: null }))}
          >
            {filter.assignee === me ? "Mine" : filter.assignee} <X size={11} aria-hidden="true" />
          </button>
        )}
        {filter.attribute && (
          <button
            type="button"
            className="chip on attribute-filter-chip"
            aria-label="Clear the attribute filter"
            title={attributeFilterLabel(filter.attribute, attributeDefs)}
            onClick={() => setFilter((f) => ({ ...f, attribute: null }))}
          >
            <Tag size={12} aria-hidden="true" />{" "}
            <span className="filter-chip-label">{attributeFilterLabel(filter.attribute, attributeDefs)}</span>{" "}
            <X size={11} aria-hidden="true" />
          </button>
        )}
      </div>
    )}
    {/* What a session would run over, so a scenario checked on a card
        two clicks away is still visible from here. */}
    {codeGen && checkedLabel && !sessionRunning && (
      <p className="session-notice">Selected: {checkedLabel}</p>
    )}
    {sessionNotice && <p className="session-notice">{sessionNotice}</p>}
    </SidebarSection>
    {/* Folder tree (specs/ui/folders.feature.md): folders are drop targets
        for drag-moving features; the tree background is the top level. */}
    {(
      <div
        className={`tree${(dragging !== null || folderDrag !== null) && dropTarget === "" ? " drop-target" : ""}`}
        ref={treeRef}
        role="tree"
        aria-label="Features"
        aria-multiselectable={locked ? undefined : true}
        onKeyDown={onTreeKeyDown}
        onClick={(e) => {
          // A click on the bare background deselects the folder, so the
          // next "+ New folder" creates at the top level again.
          if (e.target === e.currentTarget) setSelectedFolder(null);
        }}
        onDragOver={(e) => {
          // A folder from inside another folder moves to the top level
          // here ("move a folder"); a top-level one is already there.
          if (folderDrag !== null) {
            if (!folderDropsInto(folderDrag, SPECS_FOLDER)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTarget("");
            return;
          }
          if (dragging === null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropTarget("");
        }}
        onDragLeave={() => setDropTarget((t) => (t === "" ? null : t))}
        onDrop={(e) => {
          if (folderDrag !== null) {
            if (!folderDropsInto(folderDrag, SPECS_FOLDER)) return;
            e.preventDefault();
            const dragged = folderDrag.path;
            setFolderDrag(null);
            setFolderDropAt(null);
            setDropTarget(null);
            void moveFolder(dragged, SPECS_FOLDER);
            return;
          }
          if (dragging === null) return;
          e.preventDefault();
          void moveTo(dragging, "");
        }}
      >
        {renderTree(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), 0)}
        {features.length === 0 && folders.length === 0 && (
          <p className="empty">No feature files yet</p>
        )}
      </div>
    )}
    {/* The scenarios picked in the tree (specs/ui/navigation.feature.md
        "delete several scenarios at once"): how many, Delete, and a way
        out — Esc does the same. Under the tree, not over it, so the
        rows stay put while the next one is clicked. */}
    {treePicksCount > 0 && (
      <div className="tree-picks-bar" role="toolbar" aria-label="Selected scenarios">
        <span className="tree-picks-count">
          {treePicksCount} selected
        </span>
        <button
          type="button"
          className="btn btn-danger tree-picks-delete"
          onClick={() => void deletePickedScenarios()}
        >
          <Trash2 size={13} aria-hidden="true" /> Delete
        </button>
        <Tooltip label="Clear the selection" keys="Esc">
          <button
            type="button"
            className="ibtn"
            aria-label="Clear the selection"
            onClick={clearTreePicks}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    )}
    </div>
  );
}

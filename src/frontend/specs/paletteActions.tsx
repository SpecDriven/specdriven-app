// The command palette's actions on the folder selected in the tree and on
// the open feature (specs/ui/folders.feature.md, specs/ui/ui.feature.md):
// rename, display name, move, order and delete. App.tsx spreads the two
// lists at the places these actions held in its own list, so the palette
// shows them where it did. Moved out of App.tsx as they were.

import { ArrowDown, ArrowUp, FolderInput, Pencil, Tag, Trash2 } from "lucide-react";
import { type ReactNode } from "react";
import { type FeatureListing } from "../../server/features";
import { titleFromFileName } from "../../server/parser";
import { type PaletteItem } from "../CommandPalette";
import { setRenameDraft } from "./featurePageState";
import { useSpecsListing } from "./listing";
import { useOpenFeature } from "./openFeature";
import { useTreeState } from "./treeState";

export interface SpecsPaletteActionsDeps {
  action: (id: string, label: string, icon: ReactNode, run: () => void, extra?: Partial<PaletteItem>) => PaletteItem;
  editFolderDisplayName: (path: string) => Promise<void>;
  moveFeaturePrompt: (fileName?: string | null) => Promise<void>;
  moveFolderPrompt: (path: string) => Promise<void>;
  removeFeature: (f: FeatureListing) => Promise<void>;
  removeFolder: (path: string) => Promise<void>;
  renameFolder: (path: string) => Promise<void>;
  reorderFeature: (fileName: string, delta: -1 | 1) => void;
  reorderFolder: (path: string, delta: -1 | 1) => void;
}

export function useSpecsPaletteActions(deps: SpecsPaletteActionsDeps) {
  const { feature, selected } = useOpenFeature();
  const { features } = useSpecsListing();
  const { selectedFolder } = useTreeState();
  const {
    action,
    editFolderDisplayName,
    moveFeaturePrompt,
    moveFolderPrompt,
    removeFeature,
    removeFolder,
    renameFolder,
    reorderFeature,
    reorderFolder,
  } = deps;
  const listing = selected ? features.find((f) => f.fileName === selected) : undefined;
  // The palette's commands on the folder selected in the tree and on the
  // open feature (specs/ui/folders.feature.md, specs/ui/ui.feature.md).
  const specsFolderActions: PaletteItem[] = selectedFolder
  ? [
      action("rename-folder", `Rename folder “${selectedFolder.split("/").pop()}”`, <Pencil size={14} />, () =>
        void renameFolder(selectedFolder),
      ),
      action(
        "folder-display-name",
        `Edit display name of folder “${selectedFolder.split("/").pop()}”`,
        <Tag size={14} />,
        () => void editFolderDisplayName(selectedFolder),
      ),
      action(
        "move-folder",
        `Move folder “${selectedFolder.split("/").pop()}” to folder…`,
        <FolderInput size={14} />,
        () => void moveFolderPrompt(selectedFolder),
      ),
      action("move-folder-up", `Move folder “${selectedFolder.split("/").pop()}” up`, <ArrowUp size={14} />, () =>
        reorderFolder(selectedFolder, -1),
      ),
      action(
        "move-folder-down",
        `Move folder “${selectedFolder.split("/").pop()}” down`,
        <ArrowDown size={14} />,
        () => reorderFolder(selectedFolder, 1),
      ),
      action("delete-folder", `Delete folder “${selectedFolder.split("/").pop()}”`, <Trash2 size={14} />, () =>
        void removeFolder(selectedFolder),
      ),
    ]
  : [];
  const specsFeatureActions: PaletteItem[] = selected && feature
  ? [
      action("rename", "Rename feature", <Pencil size={14} />, () =>
        setRenameDraft(feature.name || titleFromFileName(selected)),
      ),
      action("move", "Move feature to folder…", <FolderInput size={14} />, () =>
        void moveFeaturePrompt(),
      ),
      action("move-feature-up", "Move feature up", <ArrowUp size={14} />, () => reorderFeature(selected, -1)),
      action("move-feature-down", "Move feature down", <ArrowDown size={14} />, () =>
        reorderFeature(selected, 1),
      ),
      ...(listing
        ? [
            action("delete", "Delete feature", <Trash2 size={14} />, () =>
              void removeFeature(listing),
            ),
          ]
        : []),
    ]
  : [];
  return {
    specsFeatureActions,
    specsFolderActions,
  };
}

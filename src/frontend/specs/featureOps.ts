// What the tree and a feature's page do to folders and features
// (specs/ui/folders.feature.md, specs/ui/ui.feature.md): creating, deleting,
// renaming, moving and ordering a folder; moving, ordering and renaming a
// feature and its file, by the menu, the header or a drag. Moved out of
// App.tsx as they were, into a hook App.tsx calls: each handler sees the
// same render's values it saw there.

import { type RefObject } from "react";
import { type FeatureListing } from "../../server/features";
import { titleFromFileName } from "../../server/parser";
import { cleanLine, cleanSegments } from "../../server/text";
import { type ConfirmOptions, type PickOptions, type PromptOptions } from "../ModalPrompts";
import { type PromiseQueue } from "../promiseQueue";
import { SPECS_FOLDER } from "../route";
import { toast } from "../Toasts";
import {
  buildTree,
  featureNamesMoved,
  featuresBeneath,
  findFolder,
  folderMoveOptions,
  folderNamesMoved,
  folderRenamed,
  initialCaseDisplayName,
} from "../tree";
import { setRenameDraft, setRenaming } from "./featurePageState";
import { type Listing, setFeatureOrders, setFolderOrders, useSpecsListing } from "./listing";
import {
  type OpenOptions,
  setEditing,
  setFeature,
  setSelected,
  setSelectedScenario,
  useOpenFeature,
} from "./openFeature";
import { type Placement } from "./scenarioEdit";
import {
  setCollapsed,
  setDragging,
  setDropTarget,
  setOutlined,
  setSelectedFolder,
  setTreeMenu,
  useTreeState,
} from "./treeState";

export interface FeatureOpsDeps {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  descSaveQueue: RefObject<PromiseQueue>;
  editorRef: RefObject<{ close: () => Promise<{ ok: boolean; placed: Placement; }> | null; back: () => void; flush: () => Promise<void>; seal: () => void; }>;
  featureEditorsRetiring: RefObject<boolean>;
  loadFeatures: () => Promise<Listing | null>;
  openFeature: (file: string, opts?: OpenOptions) => Promise<void>;
  pick: (opts: PickOptions) => Promise<string | null>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  renameDraftRef: RefObject<string | null>;
  renamingRef: RefObject<boolean>;
  scenarioSaveQueue: RefObject<PromiseQueue>;
  selectedRef: RefObject<string | null>;
  unsealFeatureEditors: () => void;
}

export function useFeatureOps(deps: FeatureOpsDeps) {
  const { feature, selected } = useOpenFeature();
  const { featureOrders, features, folderDescriptions, folderOrders, folders } = useSpecsListing();
  const { selectedFolder } = useTreeState();
  const {
    confirm,
    descSaveQueue,
    editorRef,
    featureEditorsRetiring,
    loadFeatures,
    openFeature,
    pick,
    prompt,
    renameDraftRef,
    renamingRef,
    scenarioSaveQueue,
    selectedRef,
    unsealFeatureEditors,
  } = deps;
  // Folders (specs/ui/folders.feature.md): plain directories in the data repo.
  // With a folder selected, the new folder is created inside it.
  const createFolder = () => createFolderIn(selectedFolder);
  /** `parent` is a repo-relative folder path, or null for the top level. */
  const createFolderIn = async (parent: string | null) => {
    const input = await prompt({
      title: parent ? `New folder in "${parent}"` : "New folder",
      hint: parent ? undefined : "Use / for nesting.",
      confirmLabel: "Create folder",
    });
    if (!input) return;
    const path = cleanSegments(input);
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: parent ? `${parent}/${path}` : path }),
    });
    const data = await res.json();
    if (res.ok) {
      // Reveal and select the new folder, so a follow-up "+ New folder"
      // nests inside it and a drag has a visible target.
      if (parent) setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parent);
        return next;
      });
      setSelectedFolder(data.path);
      // The new folder starts with its name in initial case as its display
      // name; a failed save leaves it showing its plain name.
      const display = initialCaseDisplayName(String(data.path).split("/").pop() ?? "");
      if (display) {
        await fetch(`/api/folders/${encodeURIComponent(data.path)}/description`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description: display }),
        }).catch(() => undefined);
      }
      await loadFeatures();
    } else {
      toast.error(data.error ?? "Could not create the folder");
    }
  };

  // Delete from a folder's ⋯ menu (specs/ui/folders.feature.md "delete a
  // folder" / "delete a folder with features in it"): an empty folder goes
  // at once, with Undo; one with features asks again, naming how many, and
  // then goes with them — a `git rm -r` on the server, committed and pushed.
  const removeFolder = async (path: string) => {
    const node = findFolder(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), path);
    const count = node ? featuresBeneath(node) : 0;
    const ok = await confirm({
      title: "Delete folder",
      body:
        count === 0
          ? `Delete the empty folder "${path}"?`
          : `Delete "${path}" and the ${count} feature${count === 1 ? "" : "s"} in it? They are removed from the repository, committed and pushed.`,
      confirmLabel: count === 0 ? "Delete folder" : `Delete folder and ${count} feature${count === 1 ? "" : "s"}`,
    });
    if (!ok) return;
    // An editor open on a feature beneath the folder has nothing left to save
    // into — the same seal as deleting that feature from its own menu.
    const retiring = selected !== null && selected.startsWith(`${path}/`);
    if (retiring) {
      featureEditorsRetiring.current = true;
      await scenarioSaveQueue.current.idle();
      await descSaveQueue.current.idle();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(path)}${count > 0 ? "?force=true" : ""}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (res.ok) {
        if (retiring) {
          setEditing(null);
          setSelected(null);
          setFeature(null);
          setSelectedScenario(null);
        }
        // A selection under the deleted folder points nowhere — drop it.
        setSelectedFolder((f) => (f === path || f?.startsWith(`${path}/`) ? null : f));
        await loadFeatures();
        if (count === 0) {
          toast.success(`Deleted folder "${path}".`, {
            action: { label: "Undo", run: () => void restoreFolder(path) },
          });
        } else {
          toast.success(`Deleted folder "${path}" and ${count} feature${count === 1 ? "" : "s"} — ${data.message}.`);
        }
      } else {
        toast.error(data.error ?? "Could not delete the folder");
      }
    } finally {
      if (retiring) unsealFeatureEditors();
    }
  };

  // Rename from a folder's ⋯ menu (specs/ui/folders.feature.md "rename a
  // folder"): the last segment changes, the server git-mvs the directory, and
  // everything keyed by a path beneath it — the open feature, the selected
  // folder, the collapsed set — follows to the new path.
  const renameFolder = async (path: string) => {
    const current = path.split("/").pop()!;
    const name = await prompt({
      title: "Rename folder",
      hint: "The folder keeps its place in the tree; names are slugified like file names.",
      initial: current,
      confirmLabel: "Rename",
    });
    if (!name || cleanLine(name) === current) return;
    // The editors over a feature in the folder flush, then seal, before the
    // git mv — the same pair renameFile uses, so no save names the old path.
    const retiring = selected !== null && selected.startsWith(`${path}/`);
    if (retiring) {
      await editorRef.current.flush();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(path)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleanLine(name) }),
      });
      const data = (await res.json()) as { path?: string; message?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Rename failed");
        return;
      }
      const to = data.path!;
      if (to === path) return;
      await followFolder(path, to, retiring);
      toast.success(`Renamed folder to ${to.split("/").pop()} — ${data.message}.`);
    } finally {
      if (retiring) unsealFeatureEditors();
    }
  };

  // After a folder rename or move, everything keyed by a path beneath it —
  // the selected folder, the collapsed set, the open feature — follows to
  // the new path.
  const followFolder = async (path: string, to: string, retiring: boolean) => {
    setSelectedFolder((f) => (f === null ? f : folderRenamed(f, path, to)));
    setCollapsed((prev) => new Set([...prev].map((p) => folderRenamed(p, path, to))));
    setOutlined((prev) => new Set([...prev].map((p) => folderRenamed(p, path, to))));
    await loadFeatures();
    if (selected !== null && retiring) await openFeature(folderRenamed(selected, path, to));
  };

  // Move to folder… from a folder's ⋯ menu or the palette
  // (specs/ui/folders.feature.md "move a folder"): pick a new parent — the
  // top level included — and the server git-mvs the directory there, keeping
  // its name. The open feature follows the way it does on a rename; Undo
  // moves the folder back to where it came from.
  const moveFolder = async (path: string, parent: string) => {
    const from = path.slice(0, path.lastIndexOf("/"));
    const retiring = selected !== null && selected.startsWith(`${path}/`);
    if (retiring) {
      await editorRef.current.flush();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(path)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent }),
      });
      const data = (await res.json()) as { path?: string; message?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Move failed");
        return;
      }
      const to = data.path!;
      if (to === path) return;
      await followFolder(path, to, retiring);
      const where = parent === "" || parent === SPECS_FOLDER ? "the top level" : parent.split("/").pop();
      toast.success(`Moved folder to ${where} — ${data.message}.`, {
        action: { label: "Undo", run: () => void moveFolder(to, from) },
      });
    } catch (e) {
      toast.error(e instanceof TypeError ? "Could not move the folder — is the server running?" : (e as Error).message);
    } finally {
      if (retiring) unsealFeatureEditors();
    }
  };
  const moveFolderPrompt = async (path: string) => {
    setTreeMenu(null);
    const options = folderMoveOptions(
      buildTree(folders, features, folderDescriptions, folderOrders, featureOrders),
      path,
    );
    const to = await pick({
      title: `Move folder “${path.split("/").pop()}”`,
      hint: "To the top level or another folder — a git mv, committed and pushed.",
      placeholder: "Find a folder…",
      options,
      empty: options.length === 0 ? "There is no other folder to move it to." : "No folder matches.",
    });
    if (to === null) return;
    await moveFolder(path, to);
  };

  // Display name from a folder's ⋯ menu (specs/ui/folders.feature.md "edit a
  // folder's display name"): the label the sidebar shows in place of the
  // folder name, kept in the folder's display-name.txt. The folder — and every
  // path beneath it — stays put; a blank name clears the label.
  const editFolderDisplayName = async (path: string) => {
    const current = folderDescriptions[path] ?? "";
    const name = await prompt({
      title: "Edit display name",
      hint: "Shown in the tree in place of the folder name. Leave blank to show the folder name.",
      initial: current,
      placeholder: path.split("/").pop(),
      confirmLabel: "Save",
      allowEmpty: true,
    });
    if (name === null || cleanLine(name) === current) return;
    const res = await fetch(`/api/folders/${encodeURIComponent(path)}/description`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: cleanLine(name) }),
    });
    const data = (await res.json()) as { description?: string | null; message?: string; error?: string };
    if (!res.ok) {
      toast.error(data.error ?? "Could not save the display name");
      return;
    }
    await loadFeatures();
    toast.success(
      data.description
        ? `Folder display name set to "${data.description}" — ${data.message}.`
        : `Cleared the folder's display name — ${data.message}.`,
    );
  };

  /**
   * Move the subfolder at `from` among `parent`'s subfolders to `to`
   * (specs/ui/folders.feature.md "order folders") — one place for Move up /
   * Move down, anywhere for a drop on a sibling's row — and save the order:
   * the parent's folder-order.txt, committed and pushed. The tree shows the
   * new order while the save is out, and falls back if it fails.
   */
  const moveFolderTo = async (parent: string, from: number, to: number) => {
    const siblings = findFolder(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), parent)?.folders;
    if (!siblings) return;
    const names = folderNamesMoved(siblings, from, to);
    if (!names) return;
    const before = folderOrders;
    setFolderOrders({ ...before, [parent]: names });
    setTreeMenu(null);
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(parent)}/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folders: names }),
      });
      const data = (await res.json()) as { folders?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not move the folder");
      await loadFeatures();
    } catch (e) {
      setFolderOrders(before);
      toast.error(
        e instanceof TypeError ? "Could not move the folder — is the server running?" : (e as Error).message,
      );
    }
  };

  /** Move a folder one place up or down among its siblings, from its menu or the palette. */
  const reorderFolder = (path: string, delta: -1 | 1) => {
    const parent = path.split("/").slice(0, -1).join("/");
    const siblings = findFolder(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), parent)?.folders;
    if (!siblings) return;
    const i = siblings.findIndex((f) => f.path === path);
    if (i < 0) return;
    void moveFolderTo(parent, i, i + delta);
  };

  /**
   * Move the feature at `from` among `parent`'s features to `to` (specs/ui/
   * folders.feature.md "order features") — one place for Move up / Move
   * down, anywhere for a drop on a sibling's row — and save the order: the
   * folder's feature-order.txt, committed and pushed. The tree shows the new
   * order while the save is out, and falls back if it fails.
   */
  const moveFeatureTo = async (parent: string, from: number, to: number) => {
    const siblings = findFolder(
      buildTree(folders, features, folderDescriptions, folderOrders, featureOrders),
      parent,
    )?.features;
    if (!siblings) return;
    const names = featureNamesMoved(siblings, from, to);
    if (!names) return;
    const before = featureOrders;
    setFeatureOrders({ ...before, [parent]: names });
    setTreeMenu(null);
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(parent)}/feature-order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: names }),
      });
      const data = (await res.json()) as { features?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not move the feature");
      await loadFeatures();
    } catch (e) {
      setFeatureOrders(before);
      toast.error(
        e instanceof TypeError ? "Could not move the feature — is the server running?" : (e as Error).message,
      );
    }
  };

  /** Move a feature one place up or down among its siblings, from the palette. */
  const reorderFeature = (fileName: string, delta: -1 | 1) => {
    const parent = fileName.slice(0, fileName.lastIndexOf("/"));
    const siblings = findFolder(
      buildTree(folders, features, folderDescriptions, folderOrders, featureOrders),
      parent,
    )?.features;
    if (!siblings) return;
    const i = siblings.findIndex((f) => f.fileName === fileName);
    if (i < 0) return;
    void moveFeatureTo(parent, i, i + delta);
  };

  /** Undo of a folder delete: only empty folders go, so re-creating restores it. */
  const restoreFolder = async (path: string) => {
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (res.ok) await loadFeatures();
    else toast.error(`Could not restore "${path}".`);
  };

  // Drag-move (specs/ui/folders.feature.md): the server does a `git mv` into
  // the target folder, committed and pushed. A selected feature stays
  // selected under its new path — the canonical-url effect follows along.
  // What the scenario / description editors hold lands on the current path
  // first, then they seal, so the openFeature close after git-mv cannot PUT
  // the retired path and recreate the old file.
  const moveTo = async (fileName: string, folder: string) => {
    setDragging(null);
    setDropTarget(null);
    const from = fileName.includes("/") ? fileName.slice(0, fileName.lastIndexOf("/")) : "";
    // A drop on the folder it is already in moves nothing ("already there"):
    // no need to close the editors over it.
    const retiring = selected === fileName && folder !== from;
    if (retiring) {
      await editorRef.current.flush();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(fileName)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder }),
      });
      const data = await res.json();
      if (res.ok) {
        await loadFeatures();
        if (data.fileName !== fileName) {
          if (selected === fileName) await openFeature(data.fileName);
          // Undo moves it straight back to where it came from.
          toast.success(`Moved to ${folder || "the top level"} — ${data.message}.`, {
            action: { label: "Undo", run: () => void moveTo(data.fileName, from) },
          });
        }
      } else {
        toast.error(data.error ?? "Move failed");
      }
    } finally {
      // Moved, refused, unchanged or never answered: the seal is over either
      // way, or the next scenario opened here would silently never save.
      if (retiring) unsealFeatureEditors();
    }
  };

  // specs/ui/ui.feature.md "Main page": the Edit link next to the feature name
  // lets the user edit the feature name — the file's `# <name>` heading. The
  // server rewrites the heading, commits and pushes; the file name (and so the
  // feature's url) stays the same.
  const renameSelected = async () => {
    const draft = renameDraftRef.current;
    if (!selected || draft === null || renamingRef.current) return;
    const target = cleanLine(draft);
    const currentName = feature ? feature.name || titleFromFileName(selected) : "";
    if (!target || target === currentName) {
      setRenameDraft(null);
      return;
    }
    renamingRef.current = true;
    setRenaming(true);
    try {
      if (await renameFeature(selected, target)) setRenameDraft(null);
    } finally {
      renamingRef.current = false;
      setRenaming(false);
    }
  };

  /** Rewrite `fileName`'s `# <name>` heading to `name` — committed and pushed
      by the server; the file (and its url) stays put. True once saved. */
  const renameFeature = async (fileName: string, name: string) => {
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(fileName)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Rename failed");
        return false;
      }
      await loadFeatures();
      // Still the open feature? A blur-save can be out while the user
      // already opened another one — that one stays.
      if (selectedRef.current === fileName) await openFeature(fileName);
      toast.success(`Renamed to "${data.name}" — ${data.message}.`);
      return true;
    } catch {
      toast.error("Rename failed — is the server running?");
      return false;
    }
  };

  // Edit display name from a feature's ⋯ menu in the sidebar
  // (specs/ui/ui.feature.md "Feature entry menu"): the feature name — the
  // file's `# <name>` heading the tree shows — as the page's Edit link does.
  // The file name and url stay the same.
  const editFeatureDisplayName = async (f: FeatureListing) => {
    const current = f.name || titleFromFileName(f.fileName);
    const name = await prompt({
      title: "Edit display name",
      hint: "The feature name shown in the tree and on its page. The file name stays the same.",
      initial: current,
      confirmLabel: "Save",
    });
    if (name === null || !cleanLine(name) || cleanLine(name) === current) return;
    await renameFeature(f.fileName, cleanLine(name));
  };

  /** The file name shown in the menu: only the part left of the dot —
      the `.feature.md` extension is hidden (specs/ui/ui.feature.md "Feature
      entry menu"). */
  const fileStem = (fileName: string) => fileName.split("/").pop()!.split(".")[0]!;
  /** A folder's entry in `treeMenu` — a NUL keeps it apart from file names. */
  const folderMenuKey = (path: string) => `folder\u0000${path}`;

  // File → Rename (specs/ui/ui.feature.md "Feature entry menu"): renames the
  // underlying file. The extension stays; a selected feature follows its
  // new file name (and so a new url — old links go stale).
  const renameFile = async (fileName: string) => {
    const stem = await prompt({
      title: "Rename file",
      hint: "The .feature.md extension is kept.",
      initial: fileStem(fileName),
      confirmLabel: "Rename",
    });
    if (!stem || cleanLine(stem) === fileStem(fileName)) return;
    // The server slugs the stem, so the name can still come back unchanged;
    // the finally below lifts the seal then too.
    const retiring = selected === fileName;
    if (retiring) {
      await editorRef.current.flush();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(fileName)}/rename-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stem: cleanLine(stem) }),
      });
      const data = await res.json();
      if (res.ok) {
        await loadFeatures();
        if (data.fileName !== fileName) {
          if (selected === fileName) await openFeature(data.fileName);
          toast.success(`Renamed file to ${fileStem(data.fileName)} — ${data.message}.`);
        }
      } else {
        toast.error(data.error ?? "Rename failed");
      }
    } finally {
      if (retiring) unsealFeatureEditors();
    }
  };
  return {
    createFolder,
    createFolderIn,
    editFeatureDisplayName,
    editFolderDisplayName,
    fileStem,
    folderMenuKey,
    moveFeatureTo,
    moveFolder,
    moveFolderPrompt,
    moveFolderTo,
    moveTo,
    removeFolder,
    renameFile,
    renameFolder,
    renameSelected,
    reorderFeature,
    reorderFolder,
  };
}

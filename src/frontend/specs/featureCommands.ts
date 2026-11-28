// The Specs tab's remaining commands: a new feature in the folder selected,
// "Move to folder…" for a feature, folding a folder and a feature's outline
// in the tree, publishing a folder's features to Confluence, and the two
// ways out of a merge conflict. Gathered in App.tsx, then moved out as they
// were, into a hook App.tsx calls.

import { type FeatureListing } from "../../server/features";
import { cleanSegments } from "../../server/text";
import { type FolderFeature } from "../ConfluenceFolderPublishDialog";
import { type PickOptions, type PromptOptions } from "../ModalPrompts";
import { toast } from "../Toasts";
import { type FolderNode, buildTree, folderLabel, folderOptions } from "../tree";
import { setConfluenceFolder } from "./dialogs";
import { setConflict, setResolving, useEditorState } from "./editorState";
import { type Listing, useSpecsListing } from "./listing";
import { type OpenOptions, useOpenFeature } from "./openFeature";
import { setCollapsed, setOutlined, useTreeState } from "./treeState";

export interface FeatureCommandsDeps {
  fileStem: (fileName: string) => string;
  loadFeatures: () => Promise<Listing | null>;
  moveTo: (fileName: string, folder: string) => Promise<void>;
  openFeature: (file: string, opts?: OpenOptions) => Promise<void>;
  pick: (opts: PickOptions) => Promise<string | null>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

export function useFeatureCommands(deps: FeatureCommandsDeps) {
  const { conflict, resolving } = useEditorState();
  const { selected } = useOpenFeature();
  const { featureOrders, features, folderDescriptions, folderOrders, folders } = useSpecsListing();
  const { selectedFolder } = useTreeState();
  const {
    fileStem,
    loadFeatures,
    moveTo,
    openFeature,
    pick,
    prompt,
  } = deps;
  // With a folder selected, the new feature is created inside it — the same
  // insertion point "+ New folder" uses; `folder/name` nests further below
  // it (specs/ui/folders.feature.md).
  const createFeature = () => createFeatureIn(selectedFolder);
  /** `parent` is a repo-relative folder path, or null for the top level. */
  const createFeatureIn = async (parent: string | null) => {
    const input = await prompt({
      title: parent ? `New feature in "${parent}"` : "New feature",
      hint: parent ? undefined : "Use folder/name to create inside a folder.",
      placeholder: parent ? "Basic Quote" : "billing/Basic Quote",
      confirmLabel: "Create feature",
    });
    if (!input) return;
    const name = cleanSegments(input);
    const res = await fetch("/api/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: parent ? `${parent}/${name}` : name }),
    });
    const data = await res.json();
    if (res.ok) {
      // Reveal the new feature: a selected folder may be collapsed, since
      // clicking one both selects it and toggles its subtree.
      if (parent) setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parent);
        return next;
      });
      await loadFeatures();
      // A new feature opens on its description editor (specs/editor/feature-
      // editor.feature.md "Edit feature descrition").
      await openFeature(data.fileName, { push: true, editDescription: true });
    } else {
      toast.error(data.error ?? "Could not create the feature");
    }
  };
  const resolveWith = async (which: "ours" | "theirs" | "draft", resolved: string) => {
    if (!selected || resolving) return;
    setResolving(which);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: resolved,
          resolveConflict: true,
          // Keep an individual publish scoped to its scenario — and, by its
          // document id, renaming rather than doubling — through the
          // conflict resolution.
          scenario: conflict?.scenario,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // openFeature closes the dialog by clearing the conflict.
        await openFeature(selected);
      } else {
        toast.error(data.error ?? "Publish failed");
      }
    } catch {
      toast.error("Publish failed — is the server running?");
    } finally {
      setResolving(null);
    }
  };
  /** Close the conflict dialog without resolving. The unfinished merge stays
      in the repo, so Publish brings the same choices back. */
  const dismissConflict = () => {
    setConflict(null);
    toast.info("Merge conflict left unresolved — Publish again to pick a resolution.");
  };
  const toggleFolder = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  /**
   * Open or close a feature's scenario outline
   * (specs/ui/navigation.feature.md).
   */
  const toggleOutline = (file: string) =>
    setOutlined((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  /**
   * Folders then features, indented per depth (specs/ui/folders.feature.md).
   * A folder's whole subtree is its drop zone — dropping on a feature drops
   * into the folder that holds it; nested folders win via stopPropagation.
   */
  // "Publish to Confluence…" on a folder: the dialog opens on the folder's
  // features in the sidebar's order, its subfolders' after its own, then
  // learns from the server which pages they link and where they were last
  // published under.
  const openConfluenceFolder = async (node: FolderNode) => {
    const inOrder: FeatureListing[] = [];
    const walk = (n: FolderNode) => {
      inOrder.push(...n.features);
      n.folders.forEach(walk);
    };
    walk(node);
    const path = node.path;
    setConfluenceFolder({ path, label: folderLabel(node), features: null });
    let known = new Map<string, FolderFeature>();
    try {
      const res = await fetch(`/api/folders/${encodeURIComponent(path)}/confluence`);
      if (res.ok) {
        const data = (await res.json()) as { features: FolderFeature[] };
        known = new Map(data.features.map((f) => [f.file, f]));
      }
    } catch {
      // Without the server's answer every feature reads as a new page; the
      // publish itself still finds the pages they link.
    }
    const features = inOrder.map((f) => known.get(f.fileName) ?? { file: f.fileName, name: f.name });
    setConfluenceFolder((open) => (open?.path === path ? { ...open, features } : open));
  };
  // Move to folder… (specs/ui/folders.feature.md "move a feature from its
  // menu"): the keyboard's way to what a drag does — pick a folder from the
  // list, the top level included, and the same git mv runs.
  const moveFeaturePrompt = async (fileName: string | null = selected) => {
    if (!fileName) return;
    const from = fileName.slice(0, fileName.lastIndexOf("/"));
    const options = folderOptions(buildTree(folders, features, folderDescriptions, folderOrders, featureOrders), from);
    const to = await pick({
      title: `Move “${fileStem(fileName)}”`,
      hint: "To another folder — a git mv, committed and pushed.",
      placeholder: "Find a folder…",
      options,
      empty: options.length === 0 ? "There is no other folder to move it to." : "No folder matches.",
    });
    if (to === null) return;
    await moveTo(fileName, to);
  };
  return {
    createFeature,
    createFeatureIn,
    dismissConflict,
    moveFeaturePrompt,
    openConfluenceFolder,
    resolveWith,
    toggleFolder,
    toggleOutline,
  };
}

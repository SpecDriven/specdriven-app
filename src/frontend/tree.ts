// Sidebar folder tree (specs/folders.spec.md): folders are directories
// in the data repo; features hang off the folder they live in. The tree is
// built from the flat /api/features listing.

import type { FeatureListing } from "../server/features";

export interface FolderNode {
  /** Display segment, e.g. `billing`. */
  name: string;
  /** Full folder path relative to the repo root; `""` for the root node. */
  path: string;
  folders: FolderNode[];
  features: FeatureListing[];
}

/**
 * Arrange the flat listing into a tree rooted at the repo top level. Folders
 * come from the explicit folder list (so empty folders show — they are drop
 * targets) plus any folder implied by a feature's path. Folders sort before
 * features; both alphabetically.
 */
export function buildTree(folders: string[], features: FeatureListing[]): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], features: [] };
  const nodes = new Map<string, FolderNode>([["", root]]);

  const folderNode = (path: string): FolderNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const segments = path.split("/");
    const node: FolderNode = { name: segments[segments.length - 1]!, path, folders: [], features: [] };
    nodes.set(path, node);
    folderNode(segments.slice(0, -1).join("/")).folders.push(node);
    return node;
  };

  for (const path of folders) folderNode(path);
  for (const f of features) {
    folderNode(f.fileName.split("/").slice(0, -1).join("/")).features.push(f);
  }

  for (const node of nodes.values()) {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.features.sort((a, b) => a.name.localeCompare(b.name));
  }
  return root;
}

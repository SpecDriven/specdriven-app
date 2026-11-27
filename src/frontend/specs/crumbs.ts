// The trail above a feature's page and a scenario's: the folders the
// feature's file is in, each selecting its folder in the tree.

import type { Crumb } from "../Breadcrumbs";
import { setCollapsed, setSelectedFolder } from "./treeState";

/** A crumb per folder of a feature's path; a click selects the folder and opens the way down to it. */
export function folderCrumbs(fileName: string): Crumb[] {
  const parts = fileName.split("/").slice(0, -1);
  return parts.map((part, i) => {
    const path = parts.slice(0, i + 1).join("/");
    return {
      label: part,
      title: `Select the folder ${path}`,
      onClick: () => {
        setSelectedFolder(path);
        setCollapsed((prev) => {
          const next = new Set(prev);
          for (let k = 1; k <= i + 1; k++) next.delete(parts.slice(0, k).join("/"));
          return next;
        });
      },
    };
  });
}

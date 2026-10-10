// Who created and last updated a feature or a scenario
// (specs/app/specs-authorship.feature.md), as the feature page shows it: one
// short line under the scenario card, one chip on the feature's header.
// The names come from the Automerge document (src/server/features.ts
// featureView), whether or not the repo writes them into its markdown.

export interface Authorship {
  createdBy?: string;
  updatedBy?: string;
}

/**
 * The line a feature or a scenario's authorship reads as, or null when the
 * app has recorded none — a spec written before authorship was kept, or
 * dropped into the repo by hand.
 */
export function authorshipLine({ createdBy, updatedBy }: Authorship): string | null {
  if (createdBy && updatedBy && createdBy !== updatedBy) {
    return `Created by ${createdBy} · updated by ${updatedBy}`;
  }
  if (createdBy && updatedBy) return `Created and last updated by ${createdBy}`;
  if (createdBy) return `Created by ${createdBy}`;
  if (updatedBy) return `Last updated by ${updatedBy}`;
  return null;
}

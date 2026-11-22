// The Resources tab's client half (src/frontend/ResourcesPanel.tsx): the
// shapes /api/resources/* answers with (src/server/resourceUsage.ts) and the
// pure helpers the tab shows them with.

import type { CleanupOffer, DiskEntry, DiskGroup, DiskSnapshot, MemoryGroup, MemorySnapshot } from "../server/resourceUsage";

export type { CleanupOffer, DiskEntry, DiskGroup, DiskSnapshot, MemoryGroup, MemorySnapshot };

export const MEMORY_URL = "/api/resources/memory";
export const DISK_URL = "/api/resources/disk";
export const CLEANUP_URL = "/api/resources/cleanup";

/** How often memory is measured again while the tab is shown. */
export const MEMORY_POLL_MS = 3000;

/** Bytes as people read them: "812 KB", "4.2 MB", "32 GB". */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))} ${units[i]}`;
}

/** Each group's share of the total, for the stacked bar; groups too small to see still get a sliver. */
export function shares(groups: readonly { bytes: number }[]): number[] {
  const total = groups.reduce((n, g) => n + g.bytes, 0);
  if (total <= 0) return groups.map(() => 0);
  return groups.map((g) => Math.max((g.bytes / total) * 100, g.bytes > 0 ? 0.5 : 0));
}

/** The confirmation a cleanup asks for. */
export function cleanupPrompt(entry: DiskEntry, offer: CleanupOffer): { title: string; body: string; confirmLabel: string } {
  const what =
    offer.kind === "worktree"
      ? `the worktree ${entry.label}`
      : offer.kind === "logs"
        ? "the old log files"
        : offer.kind === "browser-cache"
          ? "the browser cache"
          : entry.label.toLowerCase();
  const verb = offer.label.split(" ")[0]!;
  return {
    title: `${verb} ${what}?`,
    body: `${offer.warning} This frees about ${formatSize(offer.bytes)}.`,
    confirmLabel: verb,
  };
}

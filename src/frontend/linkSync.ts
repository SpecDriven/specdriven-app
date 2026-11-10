// A link from outside opens on synced data (specs/ui/navigation.feature.md
// "a link opens on synced data"). A `specdriven://` link is usually followed
// seconds after a teammate made what it names, so the folder is pulled before
// the link is resolved — waiting for the next reload tick would call a
// feature that exists on the remote "stale". Switching folders pulls on the
// server already (PUT /api/state); this is the pull for a link into the
// folder that is open. Pure but for the fetch it is handed, so it runs under
// bun test.

/** Why the pull behind a link brought nothing in; null when it went through. */
export type PullProblem = string | null;

/** The pull problem an /api/reload or /api/state answer carries, if any. */
export function pullProblemOf(body: unknown): PullProblem {
  const value = (body as { pullProblem?: unknown } | null)?.pullProblem;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Run one sync tick before a link is resolved. Never throws and never blocks
 * the link: a server that refuses the sync (the read-only site, the demo)
 * has nothing to pull, and one that cannot be reached will say so itself
 * when the link's own request fails.
 */
export async function syncForLink(fetcher: typeof fetch = fetch): Promise<PullProblem> {
  try {
    const res = await fetcher("/api/reload", { method: "POST" });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) return pullProblemOf(body);
    // The tick itself failed (502): its reason is why nothing was pulled.
    const error = (body as { error?: unknown } | null)?.error;
    return res.status >= 500 && typeof error === "string" && error.trim() ? error.trim() : null;
  } catch {
    return null;
  }
}

/** A git message cut to what a toast can carry: its first line, capped. */
function brief(reason: string): string {
  const line = reason.split("\n").find((l) => l.trim())?.trim() ?? reason.trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/**
 * The note for a feature that did not open. "The link may be stale" is only
 * said when that is what the app knows: the file is not there (404) and the
 * folder was pulled. A miss behind a failed pull names the pull, and any
 * other answer — no folder open, a folder that cannot be reached, a server
 * error — is reported as what it is rather than blamed on the link.
 */
export function missedFeatureNote(
  file: string,
  status: number,
  opts: { pullProblem?: PullProblem; error?: string | null } = {},
): string {
  if (status !== 404) {
    const why = opts.error?.trim();
    return `Could not open feature "${file}"${why ? `: ${brief(why)}` : ` (server answered ${status})`}.`;
  }
  if (opts.pullProblem) {
    return `Feature "${file}" not found, and this folder could not be synced with its remote (${brief(opts.pullProblem)}) — it may not have arrived yet. Sync, then follow the link again.`;
  }
  return `Feature "${file}" not found — the link may be stale.`;
}

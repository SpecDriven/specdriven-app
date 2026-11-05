import type { ScenarioStatus } from "../server/parser";

/**
 * Status glyphs (specs/ui/ui.feature.md "Design system"): one icon
 * vocabulary for a scenario's status, used wherever a scenario appears —
 * cards, the editor pane, the sidebar rollup. Draft is a dashed circle,
 * proposed a half-filled one, published a filled circle with a check. Each
 * takes its colour from the matching `--status-*` token via `currentColor`,
 * so both themes come from the token block.
 */
export function StatusIcon({
  status,
  size = 16,
  label,
}: {
  status: ScenarioStatus;
  size?: number;
  /** Accessible name; defaults to the status word. */
  label?: string;
}) {
  const name = label ?? status;
  return (
    <svg
      className={`status-icon ${status}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role="img"
      aria-label={name}
    >
      <title>{name}</title>
      {status === "draft" && (
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeDasharray="2.2 2.2"
        />
      )}
      {status === "proposed" && (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />
        </>
      )}
      {status === "published" && (
        <>
          <circle cx="8" cy="8" r="6.8" fill="currentColor" />
          <path
            d="M5 8.3l2 2 4-4.3"
            fill="none"
            stroke="var(--surface-2)"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

/**
 * A feature's rollup in the sidebar: the share of its scenarios that are
 * published, as a small ring — like a project's progress circle. Reads the
 * feature listing's per-scenario status; a feature without scenarios shows
 * nothing.
 */
export function PublishRing({ published, total }: { published: number; total: number }) {
  return <ProgressRing done={published} total={total} label={`${published} of ${total} published`} />;
}

/**
 * The same ring for any "n of m" rollup a sidebar row carries — a test
 * plan's cases run, say — so progress reads the same way on every tab
 * (specs/ui/ui.feature.md "Design system": glyphs, not text badges).
 */
export function ProgressRing({ done, total, label }: { done: number; total: number; label: string }) {
  if (total === 0) return null;
  const r = 5.5;
  const circ = 2 * Math.PI * r;
  const filled = (done / total) * circ;
  const published = done;
  return (
    <svg
      className="publish-ring"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle cx="7" cy="7" r={r} fill="none" stroke="var(--border-strong)" strokeWidth="2" />
      {published > 0 && (
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="var(--status-published)"
          strokeWidth="2"
          strokeDasharray={`${filled} ${circ}`}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
}

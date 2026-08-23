/**
 * Sync mark for the header's Sync button (specs/ui.spec.md "Main page"): two
 * arrows chasing each other round a circle. Stroke-drawn like SearchIcon so
 * it takes the button's colour; `.spinning` (set while a sync runs) turns it.
 */
export function SyncIcon({ size = 14, spinning = false }: { size?: number; spinning?: boolean }) {
  return (
    <svg
      className={spinning ? "sync-icon spinning" : "sync-icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Upper arc, clockwise, ending in an arrowhead at the right */}
      <path d="M4.5 10A8 8 0 0 1 19 7.5" />
      <path d="M19 3v4.5h-4.5" />
      {/* Lower arc, clockwise, ending in an arrowhead at the left */}
      <path d="M19.5 14A8 8 0 0 1 5 16.5" />
      <path d="M5 21v-4.5h4.5" />
    </svg>
  );
}

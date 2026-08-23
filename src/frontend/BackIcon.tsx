/**
 * Chevron-left mark for the editor pane's back button
 * (specs/editor/spec-editor.feature.md "Spec editor pane"). Stroke-drawn on
 * currentColor like SearchIcon, so it takes the button's colour.
 */
export function BackIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="back-icon"
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
      <polyline points="15 6 9 12 15 18" />
    </svg>
  );
}

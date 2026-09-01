/**
 * "SD" logo mark shown in the sidebar's upper-left corner. Filled with the
 * accent token (specs/ui/ui.feature.md "Design system"), so it follows the
 * theme like every other coloured element.
 */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label="Spec-driven"
    >
      <defs>
        <linearGradient id="sd-sheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="9" style={{ fill: "var(--accent)" }} />
      <rect x="1" y="1" width="38" height="19" rx="9" fill="url(#sd-sheen)" />
      {/* Faint "spec lines", nodding to a written spec document. */}
      <g stroke="#ffffff" strokeOpacity="0.35" strokeWidth="1.6" strokeLinecap="round">
        <line x1="8" y1="8.5" x2="24" y2="8.5" />
        <line x1="8" y1="13" x2="18" y2="13" />
      </g>
      <text
        x="20"
        y="24.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize="16"
        fontWeight="700"
        letterSpacing="-0.3"
        fill="#ffffff"
      >
        SD
      </text>
    </svg>
  );
}

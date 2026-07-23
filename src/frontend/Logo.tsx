import React from "react";

/** "SD" logo mark shown in the sidebar's upper-left corner. */
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
        {/* Terracotta, matching the design system's accent tokens. */}
        <linearGradient id="sd-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#d97757" />
          <stop offset="100%" stopColor="#b8552f" />
        </linearGradient>
        <linearGradient id="sd-sheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="9" fill="url(#sd-bg)" />
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
        fontFamily="'Source Serif 4 Variable', 'Iowan Old Style', Georgia, serif"
        fontSize="17"
        fontWeight="600"
        letterSpacing="0.5"
        fill="#ffffff"
      >
        SD
      </text>
    </svg>
  );
}

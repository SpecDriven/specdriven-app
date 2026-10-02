/**
 * The Features head's action icons (specs/ui/folders.feature.md, specs/
 * agents/claude.feature.md): New folder, New feature and Start session.
 * They are drawn as one set on a 16 px grid with a 1.5 stroke, so they sit
 * beside lucide's glyphs without looking borrowed. Each one is the thing it
 * acts on, with a mark in the corner for what it does: the two create icons
 * get the same + in the bottom-right corner, where the outline breaks off to
 * make room for it, and the session icon gets a spark in the top-right
 * corner for the AI agent that runs it. Every path uses `currentColor`.
 */
import type { ReactNode } from "react";

type IconProps = { size?: number; className?: string };

function Glyph({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** The corner + the two create icons share. */
const PLUS = "M12.5 10.25v4.5M10.25 12.5h4.5";

/** A folder whose outline stops short of the corner +. */
export function NewFolderIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 13.25H3a1.25 1.25 0 0 1-1.25-1.25V4A1.25 1.25 0 0 1 3 2.75h2.6c.4 0 .77.19 1 .5l.9 1.25H13a1.25 1.25 0 0 1 1.25 1.25V8" />
      <path d={PLUS} />
    </Glyph>
  );
}

/** A spec page — folded corner, two scenario lines — and the corner +. */
export function NewFeatureIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 14.25H4A1.25 1.25 0 0 1 2.75 13V3A1.25 1.25 0 0 1 4 1.75h4.5l3.75 3.75V8" />
      <path d="M8.5 1.75V4.5a1 1 0 0 0 1 1h2.75" />
      <path d="M5.25 8.25h3.5M5.25 11h2" />
      <path d={PLUS} />
    </Glyph>
  );
}

/** Play with a spark: run an AI agent over the selection. */
export function StartSessionIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 4.9v8.2a.9.9 0 0 0 1.38.76l6.56-4.1a.9.9 0 0 0 0-1.52L4.88 4.14A.9.9 0 0 0 3.5 4.9z" />
      <path
        className="spark"
        d="M12.75 1c.2 1.3 1.2 2.3 2.5 2.5-1.3.2-2.3 1.2-2.5 2.5-.2-1.3-1.2-2.3-2.5-2.5 1.3-.2 2.3-1.2 2.5-2.5z"
        fill="currentColor"
        stroke="none"
      />
    </Glyph>
  );
}

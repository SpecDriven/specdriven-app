import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

// Search-term highlighting (specs/search.feature.md): the words a hit matched
// on are wrapped in <mark> — in the palette's snippets, and in the editor the
// hit opens, so the reader lands on why the result was a result. One helper
// for both, so the marks agree.

/**
 * A regex matching any of `terms`, case-insensitively, in a capture group.
 * Longer terms first: a prefix search hands back both "agent" and "agents",
 * and the whole word should be the mark, not the stem with a bare "s".
 */
export function termsPattern(terms: string[]): RegExp | null {
  const escaped = terms
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return null;
  return new RegExp(`(${escaped.join("|")})`, "gi");
}

/** `text` with every occurrence of the terms wrapped in <mark>. */
export function markText(text: string, terms: string[], keyBase = ""): ReactNode {
  const re = termsPattern(terms);
  if (!re) return text;
  // Split with a capture group: odd indices are the matches.
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? <mark key={`${keyBase}${i}`}>{part}</mark> : part,
  );
}

/**
 * Rendered markdown with the terms marked: every string inside the tree is
 * split around its matches, elements are kept as they are. Attributes (a
 * link's href, an image's alt) are left alone — only what is read is marked.
 */
export function markNodes(node: ReactNode, terms: string[]): ReactNode {
  const re = termsPattern(terms);
  if (!re) return node;
  let k = 0;
  const walk = (n: ReactNode): ReactNode => {
    if (typeof n === "string") return markText(n, terms, `m${k++}.`);
    if (Array.isArray(n)) return Children.map(n, walk);
    if (isValidElement(n)) {
      const el = n as ReactElement<{ children?: ReactNode }>;
      if (el.props.children === undefined || el.props.children === null) return el;
      // A void element (input, img, br) has no children to mark.
      if (typeof el.type === "string" && ["input", "img", "br", "hr"].includes(el.type)) return el;
      return cloneElement(el, undefined, walk(el.props.children));
    }
    return n;
  };
  return walk(node);
}

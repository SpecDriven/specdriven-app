/** Two-letter initials for an assignee chip. */
export function initialsOf(name: string): string {
  return (
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .map((w) => w[0]!)
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

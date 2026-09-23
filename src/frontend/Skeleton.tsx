// Loading placeholders, shared by App and the plugins' panes.

/** Placeholder for a page while its content is on the way. */
export function PageSkeleton({ cards }: { cards: number }) {
  return (
    <div className="skeleton-page" aria-busy="true" aria-label="Loading">
      <div className="skeleton-bar">
        <span className="skeleton" style={{ height: "1.1rem", width: "18rem" }} />
        <span className="skeleton" style={{ height: "1.75rem", width: "6rem", marginLeft: "auto" }} />
      </div>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="skeleton-card">
          <span className="skeleton" style={{ height: "0.9rem", width: `${40 + (i % 3) * 10}%` }} />
          <span className="skeleton" style={{ height: "0.7rem", width: "90%" }} />
          <span className="skeleton" style={{ height: "0.7rem", width: "72%" }} />
        </div>
      ))}
    </div>
  );
}

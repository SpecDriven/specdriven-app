import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";

/**
 * The main pane's safety net (specs/ui/ui.feature.md "Design system"): a
 * render error in one view shows a note with a way back instead of a blank
 * window. "Reload view" remounts the view; the sidebar keeps working
 * throughout, so another page is always one click away. Given a `key` that
 * follows the page, navigating away resets it too.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("view crashed", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="view-error" role="alert">
        <TriangleAlert size={20} aria-hidden="true" />
        <div>
          <h2>This view hit an error</h2>
          <p>{this.state.error.message || String(this.state.error)}</p>
          <div className="view-error-actions">
            <button type="button" onClick={() => this.setState({ error: null })}>
              <RotateCw size={13} aria-hidden="true" /> Reload view
            </button>
            <button type="button" className="secondary" onClick={() => location.reload()}>
              Reload the app
            </button>
          </div>
        </div>
      </div>
    );
  }
}

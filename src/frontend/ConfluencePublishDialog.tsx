import { useState, type Ref } from "react";
import type { Feature } from "../server/parser";
import { parseParentPageUrl, sameBase } from "../server/confluenceUrl";
import type { ConfluenceWiki } from "./ConfluenceToken";
import { PromptChoices } from "./ModalPrompts";

// "Publish to Confluence…" from a feature's ⋯ menu
// (specs/external-links/confluence-wiki.feature.md): the parent page to
// publish under, which scenarios go in, and Publish. The server renders the
// page, creates or updates it, and links it from the feature.

export type PublishScope = "all" | "published";

/** What the publish route answers: the page, and the feature as saved. */
export interface ConfluencePublishResult {
  id: string;
  url: string;
  created: boolean;
  title: string;
  parentUrl: string;
  content: string;
  parsed: Feature;
  message?: string;
  warning?: string;
}

const SCOPES = [
  { value: "all", label: "All scenarios", hint: "Published, proposed and draft, each with its status" },
  { value: "published", label: "Published scenarios only" },
];

/**
 * What stands between the url typed and a publish: nothing (null), or the
 * one sentence the dialog shows under the field.
 */
export function parentUrlProblem(parentUrl: string, wikis: ConfluenceWiki[]): string | null {
  if (!parentUrl.trim()) return "Paste the url of the page to publish under.";
  const ref = parseParentPageUrl(parentUrl);
  if (!ref) return "Not a Confluence page url — open the parent page and copy its address.";
  if (!wikis.some((w) => sameBase(w.base, ref.base))) {
    return `No token for ${ref.base} — add one in Settings → Confluence.`;
  }
  return null;
}

export function ConfluencePublishDialog({
  file,
  featureName,
  linkedUrl,
  initialParentUrl,
  wikis,
  trapRef,
  onPublished,
  onClose,
}: {
  file: string;
  featureName: string;
  /** The page the feature already links, when it was published before. */
  linkedUrl?: string;
  initialParentUrl: string;
  wikis: ConfluenceWiki[];
  trapRef?: Ref<HTMLDivElement>;
  onPublished: (result: ConfluencePublishResult) => void;
  onClose: () => void;
}) {
  const [parentUrl, setParentUrl] = useState(initialParentUrl);
  const [scope, setScope] = useState<PublishScope>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = parentUrlProblem(parentUrl, wikis);

  const publish = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}/confluence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentUrl: parentUrl.trim(), scope }),
      });
      const data = (await res.json()) as ConfluencePublishResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Confluence publish failed (HTTP ${res.status})`);
        return;
      }
      onPublished(data);
    } catch {
      setError("Could not publish — is the server running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog modal-dialog confluence-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Publish to Confluence"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          className="modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void publish();
          }}
        >
          <h3>Publish to Confluence</h3>
          <p>
            <strong>{featureName}</strong> becomes a page under the parent page
            {linkedUrl ? (
              <>
                ; publishing again updates{" "}
                <a href={linkedUrl} target="_blank" rel="noreferrer">
                  its page
                </a>
              </>
            ) : null}
            .
          </p>
          <label>
            Parent page url
            <input
              aria-label="Parent page url"
              autoFocus
              value={parentUrl}
              onChange={(e) => setParentUrl(e.target.value)}
              placeholder="https://wiki.acme.com/spaces/ABC/pages/99999/Parent+Page"
            />
          </label>
          {parentUrl.trim() && problem && <p className="hint">{problem}</p>}
          <PromptChoices
            label="Scenarios"
            choices={SCOPES}
            value={scope}
            onChange={(v) => setScope(v === "published" ? "published" : "all")}
          />
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy || problem !== null}>
              {busy ? "Publishing…" : "Publish"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

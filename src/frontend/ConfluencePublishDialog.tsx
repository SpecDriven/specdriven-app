import { useState, type Ref } from "react";
import { backdropDismiss } from "./backdropDismiss";
import type { Feature } from "../server/parser";
import { parseParentPageUrl, sameBase } from "../server/confluenceUrl";
import type { ConfluenceWiki } from "./ConfluenceToken";
import { PromptChoices } from "./ModalPrompts";
import { FailureLine, whenText, type FailureDetails } from "./FailureDetails";

// "Publish to Confluence…" from a feature's ⋯ menu
// (specs/external-links/confluence-wiki.feature.md): the parent page to
// publish under, which scenarios go in, and Publish. The server renders the
// page, creates or updates it, and links it from the feature. A page changed
// in Confluence since it was last published from here comes back as a
// conflict ("Changes made in Confluence are not overwritten unnoticed"): the
// dialog says who changed it and when, and Publish anyway replaces it. Any
// other failure shows as one line; clicking it opens what the server knows of
// the call that failed — the request, Confluence's status and its answer —
// the same entry the Observability page shows under "confluence".

export type PublishScope = "all" | "published";

/** What the publish route answers: the page, and the feature as saved. */
export interface ConfluencePublishResult {
  id: string;
  url: string;
  created: boolean;
  /** The page's version now, as recorded in the feature. */
  version: number;
  title: string;
  parentUrl: string;
  content: string;
  parsed: Feature;
  message?: string;
  warning?: string;
}

/** Why a publish stopped: the page's version in Confluence is past the one last published. */
export interface ConfluenceConflict {
  pageId: string;
  url: string;
  version: number;
  lastVersion: number;
  by?: string;
  when?: string;
}

/** The call that failed, as the route reports it (src/server/confluence.ts). */
export type ConfluenceFailureDetails = FailureDetails;

/**
 * The notice a conflict shows in the dialog: who changed the page in
 * Confluence and when, that publishing would replace it, and the page to
 * look at first.
 */
export function ConfluenceConflictNotice({ conflict }: { conflict: ConfluenceConflict }) {
  const who = conflict.by ? ` by ${conflict.by}` : "";
  const when = conflict.when ? ` on ${whenText(conflict.when)}` : "";
  return (
    <div className="confluence-conflict" role="alert">
      <p>
        <strong>This page was changed in Confluence</strong> since it was last published from here: version{" "}
        {conflict.version}
        {who}
        {when} (the last publish wrote version {conflict.lastVersion}).
      </p>
      <p>
        Publishing will replace those changes.{" "}
        <a href={conflict.url} target="_blank" rel="noreferrer">
          Open the page
        </a>{" "}
        to see them first.
      </p>
    </div>
  );
}

export const SCOPES = [
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

/** How one feature's publish ended, as the dialogs show it. */
export type PublishOutcome =
  | { kind: "done"; result: ConfluencePublishResult }
  | { kind: "conflict"; conflict: ConfluenceConflict }
  | { kind: "failed"; error: string; status?: number; details?: ConfluenceFailureDetails };

/**
 * Publish one feature through its route: the page, a conflict to ask about
 * (the page changed in Confluence since), or the failure as one sentence
 * with what the server knows of the call. `force` is the user's answer to a
 * conflict shown before.
 */
export async function postConfluencePublish(
  file: string,
  p: { parentUrl: string; scope: PublishScope; force?: boolean },
): Promise<PublishOutcome> {
  try {
    const res = await fetch(`/api/features/${encodeURIComponent(file)}/confluence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentUrl: p.parentUrl.trim(), scope: p.scope, ...(p.force ? { force: true } : {}) }),
    });
    const data = (await res.json()) as ConfluencePublishResult & {
      error?: string;
      conflict?: ConfluenceConflict;
      details?: ConfluenceFailureDetails;
    };
    if (res.status === 409 && data.conflict) return { kind: "conflict", conflict: data.conflict };
    if (!res.ok) {
      return {
        kind: "failed",
        error: data.error ?? `Confluence publish failed (HTTP ${res.status})`,
        status: res.status,
        ...(data.details ? { details: data.details } : {}),
      };
    }
    return { kind: "done", result: data };
  } catch {
    return { kind: "failed", error: "Could not publish — is the server running?" };
  }
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
  onOpenLogs,
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
  /** Leave for the Observability page, showing Confluence's entries. */
  onOpenLogs?: () => void;
}) {
  const [parentUrl, setParentUrl] = useState(initialParentUrl);
  const [scope, setScope] = useState<PublishScope>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What the server knows of the failed call; shown when the error is clicked. */
  const [details, setDetails] = useState<ConfluenceFailureDetails | null>(null);
  /** The page changed in Confluence since the last publish; Publish anyway replaces it. */
  const [conflict, setConflict] = useState<ConfluenceConflict | null>(null);
  const problem = parentUrlProblem(parentUrl, wikis);

  const publish = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    setDetails(null);
    // A second Publish, with the conflict shown, is the user's answer.
    const outcome = await postConfluencePublish(file, { parentUrl, scope, force: conflict !== null });
    setBusy(false);
    if (outcome.kind === "conflict") setConflict(outcome.conflict);
    else if (outcome.kind === "failed") {
      setError(outcome.error);
      setDetails(outcome.details ?? null);
    } else onPublished(outcome.result);
  };

  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
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
              onChange={(e) => {
                setParentUrl(e.target.value);
                setConflict(null);
              }}
              placeholder="https://wiki.acme.com/spaces/ABC/pages/99999/Parent+Page"
            />
          </label>
          {parentUrl.trim() && problem && <p className="hint">{problem}</p>}
          <PromptChoices
            label="Scenarios"
            choices={SCOPES}
            value={scope}
            onChange={(v) => {
              setScope(v === "published" ? "published" : "all");
              setConflict(null);
            }}
          />
          {conflict && <ConfluenceConflictNotice conflict={conflict} />}
          {error && <FailureLine service="Confluence" error={error} details={details} onOpenLogs={onOpenLogs} />}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={`btn ${conflict ? "btn-danger" : "btn-primary"}`} disabled={busy || problem !== null}>
              {busy ? "Publishing…" : conflict ? "Publish anyway" : "Publish"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

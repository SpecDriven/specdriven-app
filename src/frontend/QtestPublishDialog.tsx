import { useState, type Ref } from "react";
import { backdropDismiss } from "./backdropDismiss";
import type { Feature } from "../server/parser";
import { parseModuleUrl, sameQtestBase } from "../server/qtestUrl";
import type { QtestSite } from "./QtestToken";
import { PromptChoices } from "./ModalPrompts";
import { FailureLine, type FailureDetails } from "./FailureDetails";

// "Publish qTest Test Cases…" from a feature's ⋯ menu
// (specs/external-links/qtest-test-cases.feature.md "Create qTest test cases
// from a feature"): the parent module to create them under, which scenarios
// go in, and Publish. The server makes a module named after the feature under
// it, one test case per scenario, and links each from the feature. A failure
// shows as one line; clicking it opens what the server knows of the call
// that failed — the request, what was sent, qTest's status and its answer —
// the same exchange the Observability page shows under "qtest". A test case
// qTest refuses stops the run: what was written is linked back, and the
// dialog stays open on the failure so Publish carries on from it.

export type PublishScope = "all" | "published";

/** What the route answers: the module, the test cases, and the feature as saved. */
export interface QtestPublishResult {
  module: { id: string; pid: string; url: string; created: boolean };
  cases: { scenarioName: string; id: string; pid: string; url: string; created: boolean }[];
  created: number;
  updated: number;
  /** The test cases deleted from the module because no scenario stands for them any more. */
  deleted?: number;
  deletedCases?: { id: string; pid: string; name: string }[];
  /** The requirements of the feature's Jira issues the test cases were linked to, one per key found. */
  requirements?: { key: string; id: string; pid: string; name: string; url: string; linked: number; alreadyLinked: number }[];
  title: string;
  parentUrl: string;
  content: string;
  parsed: Feature;
  message?: string;
  warning?: string;
  /** The test case qTest refused, which stopped the run; the dialog stays open on it. */
  failure?: { scenarioName: string; message: string; details?: FailureDetails };
}

const SCOPES = [
  { value: "all", label: "All scenarios", hint: "Published, proposed and draft" },
  { value: "published", label: "Published scenarios only" },
];

/**
 * What stands between the url typed and a publish: nothing (null), or the
 * one sentence the dialog shows under the field.
 */
export function parentModuleProblem(parentUrl: string, sites: QtestSite[]): string | null {
  if (!parentUrl.trim()) return "Paste the url of the module to create the test cases under.";
  const ref = parseModuleUrl(parentUrl);
  if (!ref) return "Not a qTest module url — select the module in Test Design and copy the address.";
  if (!sites.some((s) => sameQtestBase(s.base, ref.base))) {
    return `No token for ${ref.base} — add one in Settings → qTest.`;
  }
  return null;
}

/** How one run through the qTest route ended, as the dialogs show it. */
export type QtestPublishOutcome =
  | { kind: "done"; result: QtestPublishResult }
  | { kind: "failed"; error: string; status?: number; details?: FailureDetails };

/**
 * Create a feature's test cases through its route: the module and the
 * cases written (`result.failure` set when qTest refused one mid-run), or
 * the failure as one sentence with what the server knows of the call.
 */
export async function postQtestPublish(
  file: string,
  p: { parentUrl: string; scope: PublishScope },
): Promise<QtestPublishOutcome> {
  try {
    const res = await fetch(`/api/features/${encodeURIComponent(file)}/qtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentUrl: p.parentUrl.trim(), scope: p.scope }),
    });
    const data = (await res.json()) as QtestPublishResult & { error?: string; details?: FailureDetails };
    if (!res.ok) {
      return {
        kind: "failed",
        error: data.error ?? `Creating the test cases failed (HTTP ${res.status})`,
        status: res.status,
        ...(data.details ? { details: data.details } : {}),
      };
    }
    return { kind: "done", result: data };
  } catch {
    return { kind: "failed", error: "Could not reach the server — is it running?" };
  }
}

export function QtestPublishDialog({
  file,
  featureName,
  linkedUrl,
  initialParentUrl,
  sites,
  trapRef,
  onPublished,
  onClose,
  onOpenLogs,
}: {
  file: string;
  featureName: string;
  /** The module the feature already links, when its test cases were created before. */
  linkedUrl?: string;
  initialParentUrl: string;
  sites: QtestSite[];
  trapRef?: Ref<HTMLDivElement>;
  /** Called after every run that wrote something; the dialog stays open when `result.failure` is set. */
  onPublished: (result: QtestPublishResult) => void;
  onClose: () => void;
  /** Leave for the Observability page, showing qTest's entries. */
  onOpenLogs?: () => void;
}) {
  const [parentUrl, setParentUrl] = useState(initialParentUrl);
  const [scope, setScope] = useState<PublishScope>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What the server knows of the failed call; shown when the error is clicked. */
  const [details, setDetails] = useState<FailureDetails | null>(null);
  const problem = parentModuleProblem(parentUrl, sites);

  const publish = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    setDetails(null);
    const outcome = await postQtestPublish(file, { parentUrl, scope });
    setBusy(false);
    if (outcome.kind === "failed") {
      setError(outcome.error);
      setDetails(outcome.details ?? null);
      return;
    }
    if (outcome.result.failure) {
      setError(outcome.result.failure.message);
      setDetails(outcome.result.failure.details ?? null);
    }
    onPublished(outcome.result);
  };

  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
      <div
        className="dialog modal-dialog confluence-dialog qtest-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Publish qTest Test Cases"
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
          <h3>Publish qTest Test Cases</h3>
          <p>
            Each scenario of <strong>{featureName}</strong> becomes a test case in a module named after the feature,
            under the parent module
            {linkedUrl ? (
              <>
                ; creating them again updates{" "}
                <a href={linkedUrl} target="_blank" rel="noreferrer">
                  its module
                </a>
              </>
            ) : null}
            .
          </p>
          <label>
            Parent module url
            <input
              aria-label="Parent module url"
              autoFocus
              value={parentUrl}
              onChange={(e) => setParentUrl(e.target.value)}
              placeholder="https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=0&id=901"
            />
          </label>
          {parentUrl.trim() && problem && <p className="hint">{problem}</p>}
          <PromptChoices
            label="Scenarios"
            choices={SCOPES}
            value={scope}
            onChange={(v) => setScope(v === "published" ? "published" : "all")}
          />
          {error && <FailureLine service="qTest" error={error} details={details} onOpenLogs={onOpenLogs} />}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || problem !== null}>
              {busy ? "Publishing…" : "Publish test cases"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

import { useState, type Ref } from "react";
import { backdropDismiss } from "./backdropDismiss";
import type { ConfluenceWiki } from "./ConfluenceToken";
import type { QtestSite } from "./QtestToken";
import { PromptChoices } from "./ModalPrompts";
import { FailureLine, type FailureDetails } from "./FailureDetails";
import {
  ConfluenceConflictNotice,
  parentUrlProblem,
  postConfluencePublish,
  SCOPES,
  type ConfluenceConflict,
  type ConfluencePublishResult,
  type PublishOutcome,
  type PublishScope,
} from "./ConfluencePublishDialog";
import { parentModuleProblem, postQtestPublish, type QtestPublishOutcome, type QtestPublishResult } from "./QtestPublishDialog";

// "Publish to Wiki & qTest…" from a feature's ⋯ menu
// (specs/external-links/qtest-test-cases.feature.md "Publish the page and
// the test cases from one dialog"): the parent page and the parent module —
// the same two the separate dialogs ask for, remembered the same way — which
// scenarios go in, and one Publish. The page goes first, through the
// Confluence route, so that when the test cases follow, through the qTest
// route, each links its scenario on the page just written rather than the
// spec file. A page changed in Confluence since the last publish stops
// before anything is written, as the Confluence dialog's conflict does, and
// Publish anyway goes on. A page already published in this run is not
// published again when the test cases are retried after a refusal.

/** Both halves of a run: the page first, the test cases only once it stands. */
export interface CombinedOutcome {
  page?: PublishOutcome;
  cases?: QtestPublishOutcome;
}

/**
 * The order the two publishes go in, and where a run stops: the page
 * (skipped when `pageDone`, published in this dialog already) and then the
 * test cases, which are not attempted while the page is not there.
 */
export async function publishPageThenCases(p: {
  pageDone: boolean;
  publishPage: () => Promise<PublishOutcome>;
  publishCases: () => Promise<QtestPublishOutcome>;
}): Promise<CombinedOutcome> {
  const out: CombinedOutcome = {};
  if (!p.pageDone) {
    out.page = await p.publishPage();
    if (out.page.kind !== "done") return out;
  }
  out.cases = await p.publishCases();
  return out;
}

type StepState = { kind: "pending" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "failed" };

function StepLine({ label, state }: { label: string; state: StepState }) {
  const said =
    state.kind === "busy" ? "publishing…" : state.kind === "done" ? state.text : state.kind === "failed" ? "failed" : "waiting";
  return (
    <li className={`publish-step publish-step-${state.kind}`}>
      <span className="publish-step-label">{label}</span>
      <span className="publish-step-state">{said}</span>
    </li>
  );
}

export function WikiQtestPublishDialog({
  file,
  featureName,
  linkedPageUrl,
  linkedModuleUrl,
  initialParentPageUrl,
  initialParentModuleUrl,
  wikis,
  sites,
  trapRef,
  onPagePublished,
  onCasesPublished,
  onClose,
  onOpenLogs,
}: {
  file: string;
  featureName: string;
  /** The page the feature already links, when it was published before. */
  linkedPageUrl?: string;
  /** The module the feature already links, when its test cases were created before. */
  linkedModuleUrl?: string;
  initialParentPageUrl: string;
  initialParentModuleUrl: string;
  wikis: ConfluenceWiki[];
  sites: QtestSite[];
  trapRef?: Ref<HTMLDivElement>;
  /** The page is published: the feature now links it. */
  onPagePublished: (result: ConfluencePublishResult) => void;
  /** The test cases are written; the dialog stays open when `result.failure` is set. */
  onCasesPublished: (result: QtestPublishResult) => void;
  onClose: () => void;
  /** Leave for the Observability page, narrowed to the service that failed. */
  onOpenLogs?: (service: "confluence" | "qtest") => void;
}) {
  const [pageUrl, setPageUrl] = useState(initialParentPageUrl);
  const [moduleUrl, setModuleUrl] = useState(initialParentModuleUrl);
  const [scope, setScope] = useState<PublishScope>("all");
  const [busy, setBusy] = useState(false);
  /** The page as published in this run; a retry after a refused test case starts from the test cases. */
  const [page, setPage] = useState<ConfluencePublishResult | null>(null);
  const [cases, setCases] = useState<QtestPublishResult | null>(null);
  const [conflict, setConflict] = useState<ConfluenceConflict | null>(null);
  const [pageError, setPageError] = useState<{ error: string; details: FailureDetails | null } | null>(null);
  const [casesError, setCasesError] = useState<{ error: string; details: FailureDetails | null } | null>(null);
  const pageProblem = parentUrlProblem(pageUrl, wikis);
  const moduleProblem = parentModuleProblem(moduleUrl, sites);
  const problem = pageProblem ?? moduleProblem;
  const started = busy || page !== null || pageError !== null || casesError !== null;

  /** A new page url or scope makes the page's publish stand again. */
  const resetPage = () => {
    setPage(null);
    setConflict(null);
    setPageError(null);
    setCases(null);
    setCasesError(null);
  };

  const publish = async () => {
    if (problem || busy) return;
    setBusy(true);
    setPageError(null);
    setCasesError(null);
    setCases(null);
    const outcome = await publishPageThenCases({
      pageDone: page !== null,
      // A second Publish, with the conflict shown, is the user's answer.
      publishPage: () => postConfluencePublish(file, { parentUrl: pageUrl, scope, force: conflict !== null }),
      publishCases: () => postQtestPublish(file, { parentUrl: moduleUrl, scope }),
    });
    setBusy(false);
    if (outcome.page) {
      if (outcome.page.kind === "conflict") return setConflict(outcome.page.conflict);
      if (outcome.page.kind === "failed") {
        return setPageError({ error: outcome.page.error, details: outcome.page.details ?? null });
      }
      setConflict(null);
      setPage(outcome.page.result);
      onPagePublished(outcome.page.result);
    }
    if (!outcome.cases) return;
    if (outcome.cases.kind === "failed") {
      return setCasesError({ error: outcome.cases.error, details: outcome.cases.details ?? null });
    }
    const written = outcome.cases.result;
    setCases(written);
    if (written.failure) setCasesError({ error: written.failure.message, details: written.failure.details ?? null });
    onCasesPublished(written);
  };

  const pageState: StepState = page
    ? { kind: "done", text: page.created ? "page created" : "page updated" }
    : busy
      ? { kind: "busy" }
      : pageError || conflict
        ? { kind: "failed" }
        : { kind: "pending" };
  const casesState: StepState = cases
    ? {
        kind: cases.failure ? "failed" : "done",
        text: [cases.created > 0 ? `${cases.created} created` : "", cases.updated > 0 ? `${cases.updated} updated` : ""]
          .filter(Boolean)
          .join(", "),
      }
    : busy && page
      ? { kind: "busy" }
      : casesError
        ? { kind: "failed" }
        : { kind: "pending" };

  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
      <div
        className="dialog modal-dialog confluence-dialog wiki-qtest-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Publish to Wiki & qTest"
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
          <h3>Publish to Wiki &amp; qTest</h3>
          <p>
            <strong>{featureName}</strong> becomes a page under the parent page
            {linkedPageUrl ? (
              <>
                {" "}
                (updating{" "}
                <a href={linkedPageUrl} target="_blank" rel="noreferrer">
                  its page
                </a>
                )
              </>
            ) : null}
            , and then each scenario a test case in a module named after the feature, under the parent module
            {linkedModuleUrl ? (
              <>
                {" "}
                (updating{" "}
                <a href={linkedModuleUrl} target="_blank" rel="noreferrer">
                  its module
                </a>
                )
              </>
            ) : null}
            . The test cases link their scenarios on the page.
          </p>
          <label>
            Parent page url
            <input
              aria-label="Parent page url"
              autoFocus
              value={pageUrl}
              onChange={(e) => {
                setPageUrl(e.target.value);
                resetPage();
              }}
              placeholder="https://wiki.acme.com/spaces/ABC/pages/99999/Parent+Page"
            />
          </label>
          {pageUrl.trim() && pageProblem && <p className="hint">{pageProblem}</p>}
          <label>
            Parent module url
            <input
              aria-label="Parent module url"
              value={moduleUrl}
              onChange={(e) => {
                setModuleUrl(e.target.value);
                setCasesError(null);
              }}
              placeholder="https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=0&id=901"
            />
          </label>
          {moduleUrl.trim() && moduleProblem && <p className="hint">{moduleProblem}</p>}
          <PromptChoices
            label="Scenarios"
            choices={SCOPES}
            value={scope}
            onChange={(v) => {
              setScope(v === "published" ? "published" : "all");
              resetPage();
            }}
          />
          {started && (
            <ul className="publish-steps" aria-label="Progress">
              <StepLine label="Wiki page" state={pageState} />
              <StepLine label="qTest test cases" state={casesState} />
            </ul>
          )}
          {conflict && <ConfluenceConflictNotice conflict={conflict} />}
          {pageError && (
            <FailureLine
              service="Confluence"
              error={pageError.error}
              details={pageError.details}
              onOpenLogs={onOpenLogs ? () => onOpenLogs("confluence") : undefined}
            />
          )}
          {casesError && (
            <FailureLine
              service="qTest"
              error={casesError.error}
              details={casesError.details}
              onOpenLogs={onOpenLogs ? () => onOpenLogs("qtest") : undefined}
            />
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={`btn ${conflict ? "btn-danger" : "btn-primary"}`} disabled={busy || problem !== null}>
              {busy ? "Publishing…" : conflict ? "Publish anyway" : page ? "Publish test cases" : "Publish"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

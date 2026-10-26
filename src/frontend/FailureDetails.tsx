import { useState } from "react";
import type { FailureDetails } from "../server/httpFailure";

// A failed call to a service the app talks to (Confluence, qTest), as a
// dialog shows it: one error line, and — when the server knows what went
// wrong on the wire — clicking the line opens a detail box with the request,
// the service's status and its answer, and a way to the Observability page,
// where the same exchange is logged (src/server/httpFailure.ts).

export type { FailureDetails };

/** A timestamp as a dialog shows it, in the reader's locale; the raw text when it is no date. */
export function whenText(when: string): string {
  const date = new Date(when);
  if (Number.isNaN(date.getTime())) return when;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The detail box under a failure: the request and what was sent, the
 * service's status and content type, and its answer.
 */
export function FailureDetailsBox({
  service,
  details,
  onOpenLogs,
}: {
  /** The service's name, as in "Confluence answered". */
  service: string;
  details: FailureDetails;
  onOpenLogs?: () => void;
}) {
  const status =
    details.status !== undefined ? `${details.status}${details.statusText ? ` ${details.statusText}` : ""}` : null;
  return (
    <div className="failure-details" role="region" aria-label="Error details">
      <dl>
        <dt>Request</dt>
        <dd>
          <code>
            {details.method} {details.url}
          </code>
        </dd>
        <dt>Status</dt>
        <dd>{status ?? "No answer"}</dd>
        {details.cause && (
          <>
            <dt>Cause</dt>
            <dd>{details.cause}</dd>
          </>
        )}
        {details.location && (
          <>
            <dt>Redirected to</dt>
            <dd>
              <code>{details.location}</code>
            </dd>
          </>
        )}
        {details.contentType && (
          <>
            <dt>Content type</dt>
            <dd>{details.contentType}</dd>
          </>
        )}
        <dt>Time</dt>
        <dd>
          <time dateTime={details.time}>{whenText(details.time)}</time>
        </dd>
      </dl>
      {details.requestBody && (
        <>
          <p className="failure-details-label">The app sent</p>
          <pre className="failure-details-body">{details.requestBody}</pre>
        </>
      )}
      {details.status !== undefined && (
        <>
          <p className="failure-details-label">{service} answered</p>
          {details.body ? (
            <pre className="failure-details-body">{details.body}</pre>
          ) : (
            <p className="hint">An empty body.</p>
          )}
        </>
      )}
      {onOpenLogs && (
        <button type="button" className="link" onClick={onOpenLogs}>
          Open in Observability
        </button>
      )}
    </div>
  );
}

/**
 * The error line: plain text when there are no details, else a button that
 * opens and closes the detail box. New details start closed.
 */
export function FailureLine({
  service,
  error,
  details,
  onOpenLogs,
}: {
  service: string;
  error: string;
  details?: FailureDetails | null;
  onOpenLogs?: () => void;
}) {
  const [openFor, setOpenFor] = useState<FailureDetails | null>(null);
  if (!details) return <p className="error">{error}</p>;
  const open = openFor === details;
  return (
    <>
      <button
        type="button"
        className="error error-link"
        aria-expanded={open}
        title={open ? "Hide the details" : "Show the details"}
        onClick={() => setOpenFor(open ? null : details)}
      >
        {error}
      </button>
      {open && <FailureDetailsBox service={service} details={details} onOpenLogs={onOpenLogs} />}
    </>
  );
}

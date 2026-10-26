// What went wrong on the wire when a REST client of the app (Confluence,
// qTest) gets an error back, for the dialog's detail box and the app's log
// (the Observability page): the request — never its token — and the answer
// when there was one, its body read as text and cut to a readable length.

/** A failed call as the dialog's detail box shows it. */
export interface FailureDetails {
  method: string;
  url: string;
  /** What the app sent, as text and cut to a readable length; absent for a GET. */
  requestBody?: string;
  /** The HTTP status the service answered; absent when it could not be reached. */
  status?: number;
  statusText?: string;
  contentType?: string;
  /** Where a redirect pointed. */
  location?: string;
  /** The service's response body, as text and cut to a readable length. */
  body?: string;
  /** Why the request never got an answer (a network error). */
  cause?: string;
  /** When the call failed, ISO 8601. */
  time: string;
}

/** Bodies are kept to this many characters in details and the log. */
export const BODY_EXCERPT_CHARS = 4000;

/**
 * A body as text a person can read: an HTML error page loses its markup,
 * whitespace collapses, and the rest is cut to BODY_EXCERPT_CHARS.
 */
export function bodyExcerpt(text: string, contentType = ""): string {
  let out = text;
  if (/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text)) {
    out = text
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  } else {
    out = text.trim();
  }
  return out.length > BODY_EXCERPT_CHARS ? `${out.slice(0, BODY_EXCERPT_CHARS)}… (${out.length - BODY_EXCERPT_CHARS} more characters)` : out;
}

/** The details as log attributes, named the OpenTelemetry way. */
export function failureAttributes(d: FailureDetails): Record<string, string | number> {
  return {
    "http.request.method": d.method,
    "url.full": d.url,
    ...(d.requestBody ? { "http.request.body": d.requestBody } : {}),
    ...(d.status !== undefined ? { "http.response.status_code": d.status } : {}),
    ...(d.contentType ? { "http.response.content_type": d.contentType } : {}),
    ...(d.location ? { "http.response.location": d.location } : {}),
    ...(d.body ? { "http.response.body": d.body } : {}),
    ...(d.cause ? { "error.cause": d.cause } : {}),
  };
}

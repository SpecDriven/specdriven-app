// The "Tickets" field of the feature header's popover
// (specs/external-links/project-management-jira-linear-etc.feature.md
// "Several tickets on a feature"): the feature's tickets, each a link to the
// tool with a ✕, and — while there is room for another — an add row of the
// same url/tool/ticket fields the scenario editor uses (ExternalLinkField).
// Every add and remove goes straight to `onChange` with the whole list; the
// parent saves it, there is nothing to autosave. A repeat, or a sixth, is
// refused under the fields rather than sent.

import { useState } from "react";
import { X } from "lucide-react";
import { MAX_FEATURE_TICKETS } from "../server/parser";
import type { ExternalLink } from "../server/parser";
import { ExternalLinkField } from "./ExternalLinkField";
import { EMPTY_LINK_DRAFT, externalLinkLabel, isBlankLinkDraft, resolveLinkDraft, ticketAddProblem } from "./externallinks";
import type { LinkDraft } from "./externallinks";

export function TicketLinkField({
  links,
  onChange,
  tool,
  error,
  saving = false,
  autoFocus = false,
}: {
  links: ExternalLink[];
  onChange: (next: ExternalLink[]) => void | Promise<void>;
  /** The tool Settings names; set means the url-only fields. */
  tool?: string | null;
  /** Why the last save was refused by the server, if it was. */
  error?: string | null;
  saving?: boolean;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState<LinkDraft>(EMPTY_LINK_DRAFT);
  /** Why the last Add was refused by the fields, if it was. */
  const [addError, setAddError] = useState<string | null>(null);
  const resolved = resolveLinkDraft(draft);
  // Told live, as the fields fill: the list is full, or already has it.
  const problem = resolved.link ? ticketAddProblem(links, resolved.link) : null;
  const full = links.length >= MAX_FEATURE_TICKETS;

  const add = () => {
    if (isBlankLinkDraft(draft) || saving) return;
    if (resolved.error) return setAddError(resolved.error);
    if (!resolved.link) return;
    if (problem) return setAddError(problem);
    void onChange([...links, resolved.link]);
    setDraft(EMPTY_LINK_DRAFT);
    setAddError(null);
  };

  return (
    <div className="prs-field ticket-field">
      {links.length > 0 && (
        <ul className="pr-list pr-edit-list ticket-list">
          {links.map((l) => (
            <li key={`${l.program}:${l.ticket}:${l.url}`}>
              <a href={l.url} target="_blank" rel="noreferrer" title={l.url} data-ticket-link="">
                {externalLinkLabel(l)}
              </a>
              <button
                type="button"
                className="link"
                title={`Remove ${externalLinkLabel(l)}`}
                aria-label={`Remove ${externalLinkLabel(l)}`}
                disabled={saving}
                onClick={() => void onChange(links.filter((k) => k !== l))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {full ? (
        <p className="pr-hint">
          {links.length} of {MAX_FEATURE_TICKETS} tickets linked — remove one to link another.
        </p>
      ) : (
        <form
          className="ticket-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <div className="link-field">
            <ExternalLinkField
              draft={draft}
              onChange={(next) => {
                setAddError(null);
                setDraft(next);
              }}
              error={addError ?? problem ?? error}
              autoFocus={autoFocus}
              tool={tool}
            />
          </div>
          <div className="ticket-add-actions">
            <p className="pr-hint">
              {links.length} of {MAX_FEATURE_TICKETS} tickets linked.
            </p>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || isBlankLinkDraft(draft) || !!problem}
            >
              {saving ? "Saving…" : "Add"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// The "Ticket link" fields (specs/external-links/project-management-jira-
// linear-etc.feature.md): the url of the ticket in Jira, Linear, etc., plus
// the tool — a dropdown of the usual ones, with a name field for "Other" —
// and the ticket id that make up the chip and the `[Jira:ABC-123](url)` line
// in the feature file. Pasting the url first fills the other two where the
// url gives them away (./externallinks).

import { useRef } from "react";
import { EXTERNAL_LINK_TYPES, externalLinkTypeOf, formatExternalLink } from "../server/parser";
import type { ExternalLinkType } from "../server/parser";
import { EMPTY_LINK_DRAFT, isBlankLinkDraft, resolveLinkDraft, withLinkUrl } from "./externallinks";
import type { LinkDraft } from "./externallinks";

interface Props {
  draft: LinkDraft;
  onChange: (draft: LinkDraft) => void;
  /** Why the last save was blocked by these fields, if it was. */
  error?: string | null;
  autoFocus?: boolean;
}

/** What a ticket id looks like in each tool, as the ticket field's placeholder. */
const TICKET_HINT: Record<ExternalLinkType, string> = {
  GitHub: "#17",
  Jira: "ABC-123",
  Linear: "ENG-42",
  Other: "ABC-123",
};

export function ExternalLinkField({ draft, onChange, error, autoFocus }: Props) {
  const resolved = resolveLinkDraft(draft);
  // No tool named yet is "Other" with an empty name — the name field is where
  // a tool the dropdown doesn't offer gets typed.
  const type = externalLinkTypeOf(draft.program);
  // The name field takes the caret when "Other" is picked from the dropdown —
  // not when the fields first appear with no tool named, or it would steal
  // the focus from whatever the editor put it on (its title field).
  const nameFieldWanted = useRef(false);
  const chooseType = (next: ExternalLinkType) => {
    nameFieldWanted.current = next === "Other";
    onChange({ ...draft, program: next === "Other" ? "" : next });
  };
  return (
    <>
      <div className="link-inputs">
        <input
          className="link-url"
          value={draft.url}
          placeholder="https://acme.atlassian.net/browse/ABC-123"
          aria-label="Ticket url"
          spellCheck={false}
          autoFocus={autoFocus}
          onChange={(e) => onChange(withLinkUrl(draft, e.target.value))}
        />
        <select
          className="link-type"
          value={type}
          aria-label="Tool"
          onChange={(e) => chooseType(e.target.value as ExternalLinkType)}
        >
          {EXTERNAL_LINK_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {type === "Other" && (
          <input
            className="link-program"
            value={draft.program}
            placeholder="Tool name"
            aria-label="Tool name"
            spellCheck={false}
            autoFocus={nameFieldWanted.current && !draft.program}
            onChange={(e) => onChange({ ...draft, program: e.target.value })}
          />
        )}
        <input
          className="link-ticket"
          value={draft.ticket}
          placeholder={TICKET_HINT[type]}
          aria-label="Ticket id"
          spellCheck={false}
          onChange={(e) => onChange({ ...draft, ticket: e.target.value })}
        />
        {!isBlankLinkDraft(draft) && (
          <button
            type="button"
            className="link"
            title="Remove the ticket link"
            aria-label="Remove the ticket link"
            onClick={() => onChange(EMPTY_LINK_DRAFT)}
          >
            ✕
          </button>
        )}
      </div>
      {error ? (
        <p className="error">{error}</p>
      ) : resolved.link ? (
        <p className="hint link-preview">
          In the feature file: <code>{formatExternalLink(resolved.link)}</code>
        </p>
      ) : (
        <p className="hint link-preview">
          Paste the ticket's url; the tool and ticket id fill in when the url gives them away.
        </p>
      )}
    </>
  );
}

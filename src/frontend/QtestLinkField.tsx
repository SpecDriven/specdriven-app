// The "qTest test case" fields (specs/external-links/qtest-test-cases
// .feature.md): the url of the test case in qTest and its id (TC-42), which
// make up the chip and the `[qTest:TC-42](url)` line in the feature file.
// The tool is always qTest, so there is no tool to pick; the id fills in
// from the url when the url spells it out (./externallinks qtestCaseFromUrl).

import { X } from "lucide-react";
import { formatExternalLink } from "../server/parser";
import { EMPTY_LINK_DRAFT, isBlankLinkDraft, resolveQtestDraft, withQtestUrl } from "./externallinks";
import type { LinkDraft } from "./externallinks";

interface Props {
  draft: LinkDraft;
  onChange: (draft: LinkDraft) => void;
  /** Why the last save was blocked by these fields, if it was. */
  error?: string | null;
  autoFocus?: boolean;
}

export function QtestLinkField({ draft, onChange, error, autoFocus }: Props) {
  const resolved = resolveQtestDraft(draft);
  return (
    <>
      <div className="link-inputs">
        <input
          className="link-url"
          value={draft.url}
          placeholder="https://acme.qtestnet.com/p/1/portal/project#tab=testdesign&object=1&id=9"
          aria-label="Test case url"
          spellCheck={false}
          autoFocus={autoFocus}
          onChange={(e) => onChange(withQtestUrl(draft, e.target.value))}
        />
        <input
          className="link-ticket"
          value={draft.ticket}
          placeholder="TC-42"
          aria-label="Test case id"
          spellCheck={false}
          onChange={(e) => onChange({ ...draft, ticket: e.target.value })}
        />
        {!isBlankLinkDraft(draft) && (
          <button
            type="button"
            className="link"
            title="Remove the test case link"
            aria-label="Remove the test case link"
            onClick={() => onChange(EMPTY_LINK_DRAFT)}
          >
            <X size={12} aria-hidden="true" />
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
          Paste the qTest test case's url and its id; the id fills in when the url gives it away.
        </p>
      )}
    </>
  );
}

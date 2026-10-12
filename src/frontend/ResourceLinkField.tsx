import { useState } from "react";
import { X } from "lucide-react";
import type { ResourceLink } from "../server/parser";
import type { ResourceLinkKind } from "../server/resourceLinks";
import {
  RESOURCE_LINK_TOOLS,
  canAddResourceLink,
  isOwnResourceUrl,
  isResourceLinkUrl,
  resourceLinkLabel,
} from "../server/resourceLinks";
import { cleanLine } from "../server/text";

/** One tool's links on a card or in a popover: each a link, by its label. */
export function ResourceLinkList({
  kind,
  links,
  className,
}: {
  kind: ResourceLinkKind;
  links: ResourceLink[];
  className?: string;
}) {
  if (links.length === 0) return null;
  return (
    <ul className={`pr-list${className ? ` ${className}` : ""}`}>
      {links.map((l) => (
        <li key={l.url}>
          <a href={l.url} target="_blank" rel="noreferrer" title={l.url} data-resource-link={kind}>
            {resourceLinkLabel(kind, l)}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the hint under the add field says about the url typed so far: nothing
 * while it is empty or on the tool's own site, a warning when it is on
 * another site (it can still be added), and why it can't be added otherwise.
 */
export function resourceUrlHint(
  kind: ResourceLinkKind,
  links: ResourceLink[],
  url: string,
): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const { name } = RESOURCE_LINK_TOOLS[kind];
  if (!isResourceLinkUrl(trimmed)) return "Paste an http or https url.";
  if (links.some((l) => l.url === trimmed)) return `This ${name} link is already in the list.`;
  if (!isOwnResourceUrl(kind, trimmed)) return `Not a ${name} url — it is added as it stands.`;
  return null;
}

/**
 * The "Aha!" or "Figma" field of the scenario editor pane and the feature
 * header (specs/external-links/aha-and-figma-links.feature.md): the current
 * links with a ✕ each, and an add row — the url and an optional title. Every
 * add and remove goes straight to `onChange`; the parent saves it to the
 * document, there is nothing to autosave.
 */
export function ResourceLinkField({
  kind,
  links,
  onChange,
  disabled = false,
  disabledHint,
  autoFocus = false,
}: {
  kind: ResourceLinkKind;
  links: ResourceLink[];
  onChange: (next: ResourceLink[]) => void | Promise<void>;
  /** The scenario is not in the document yet — nothing to link to. */
  disabled?: boolean;
  disabledHint?: string;
  autoFocus?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const tool = RESOURCE_LINK_TOOLS[kind];

  const add = () => {
    if (!canAddResourceLink(links, url)) return;
    void onChange([...links, { url: url.trim(), title: cleanLine(title) }]);
    setUrl("");
    setTitle("");
  };

  const hint = resourceUrlHint(kind, links, url);
  return (
    <div className="prs-field resource-field">
      {links.length > 0 && (
        <ul className="pr-list pr-edit-list">
          {links.map((l) => (
            <li key={l.url}>
              <a href={l.url} target="_blank" rel="noreferrer" title={l.url} data-resource-link={kind}>
                {resourceLinkLabel(kind, l)}
              </a>
              <button
                type="button"
                className="link"
                title={`Remove ${l.url}`}
                aria-label={`Remove ${l.url}`}
                disabled={disabled}
                onClick={() => void onChange(links.filter((m) => m.url !== l.url))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="pr-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={url}
          placeholder={tool.placeholder}
          aria-label={`${tool.name} url`}
          spellCheck={false}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => setUrl(e.target.value)}
        />
        <input
          className="pr-title"
          value={title}
          placeholder="title"
          aria-label={`${tool.name} title`}
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" className="link" disabled={disabled || !canAddResourceLink(links, url)}>
          Add
        </button>
      </form>
      {disabled && disabledHint ? (
        <p className="pr-hint">{disabledHint}</p>
      ) : (
        hint && <p className="pr-hint">{hint}</p>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { PullRequestLink } from "../server/parser";
import type { PullRequestLookup } from "../server/pullRequests";
import { isPullRequestUrl, parsePullRequestUrl, pullRequestLabel } from "../server/pullRequests";
import { cleanLine } from "../server/text";

/** The list of pull requests on a card or in a popover: `#n title`, each a link. */
export function PullRequestList({ prs, className }: { prs: PullRequestLink[]; className?: string }) {
  if (prs.length === 0) return null;
  return (
    <ul className={`pr-list${className ? ` ${className}` : ""}`}>
      {prs.map((p) => (
        <li key={p.url}>
          <a href={p.url} target="_blank" rel="noreferrer" title={p.url} data-pr-link="">
            {pullRequestLabel(p)}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** How the hint under the add field words a pull request's state. */
export function pullRequestStateHint(lookup: PullRequestLookup): string {
  if (lookup.title === null) return lookup.reason;
  const state = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed, not merged" }[lookup.state];
  return `#${lookup.number} — ${state}`;
}

/** Whether a url can join the list: an http(s) url the list does not hold yet. */
export function canAddPullRequest(prs: PullRequestLink[], url: string): boolean {
  const trimmed = url.trim();
  return isPullRequestUrl(trimmed) && !prs.some((p) => p.url === trimmed);
}

/**
 * The "Pull requests" field of the scenario editor pane and the feature
 * header (specs/external-links/related-pull-requests.feature.md): the
 * current links with a ✕ each, and an add field for another. Every add and
 * remove goes straight to `onChange` — the parent saves it to the document,
 * there is nothing to autosave. A GitHub pull request url typed into the
 * add field is looked up for its title and state; a title typed by hand
 * is kept.
 */
export function PullRequestField({
  prs,
  onChange,
  disabled = false,
  disabledHint,
  autoFocus = false,
}: {
  prs: PullRequestLink[];
  onChange: (next: PullRequestLink[]) => void | Promise<void>;
  /** The scenario is not in the document yet — nothing to link to. */
  disabled?: boolean;
  disabledHint?: string;
  autoFocus?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  /** True once the title was typed, so a lookup landing late leaves it alone. */
  const titleTyped = useRef(false);
  const [hint, setHint] = useState<string | null>(null);
  /** Serial of the latest lookup: an older one landing late is ignored. */
  const lookup = useRef(0);

  useEffect(() => {
    const serial = ++lookup.current;
    const ref = parsePullRequestUrl(url);
    if (!ref) {
      setHint(null);
      return;
    }
    setHint("Reading the pull request from GitHub…");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/pull-request?url=${encodeURIComponent(url.trim())}`);
        if (serial !== lookup.current) return;
        if (!res.ok) {
          setHint(null);
          return;
        }
        const found = (await res.json()) as PullRequestLookup;
        if (serial !== lookup.current) return;
        setHint(pullRequestStateHint(found));
        if (found.title !== null && !titleTyped.current) setTitle(found.title);
      } catch {
        if (serial === lookup.current) setHint("Could not reach the server to read the title.");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [url]);

  const add = () => {
    if (!canAddPullRequest(prs, url)) return;
    void onChange([...prs, { url: url.trim(), title: cleanLine(title) }]);
    setUrl("");
    setTitle("");
    titleTyped.current = false;
    lookup.current++;
    setHint(null);
  };

  return (
    <div className="prs-field">
      {prs.length > 0 && (
        <ul className="pr-list pr-edit-list">
          {prs.map((p) => (
            <li key={p.url}>
              <a href={p.url} target="_blank" rel="noreferrer" title={p.url} data-pr-link="">
                {pullRequestLabel(p)}
              </a>
              <button
                type="button"
                className="link"
                title={`Remove ${p.url}`}
                aria-label={`Remove ${p.url}`}
                disabled={disabled}
                onClick={() => void onChange(prs.filter((q) => q.url !== p.url))}
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
          placeholder="https://github.com/owner/repo/pull/123"
          aria-label="Pull request url"
          spellCheck={false}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => setUrl(e.target.value)}
        />
        <input
          className="pr-title"
          value={title}
          placeholder="title"
          aria-label="Pull request title"
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => {
            titleTyped.current = e.target.value !== "";
            setTitle(e.target.value);
          }}
        />
        <button type="submit" className="link" disabled={disabled || !canAddPullRequest(prs, url)}>
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

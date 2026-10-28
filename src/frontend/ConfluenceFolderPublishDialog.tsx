import { useState, type Ref } from "react";
import { backdropDismiss } from "./backdropDismiss";
import type { ConfluenceWiki } from "./ConfluenceToken";
import { PromptChoices } from "./ModalPrompts";
import { FailureLine, whenText } from "./FailureDetails";
import {
  parentUrlProblem,
  postConfluencePublish,
  SCOPES,
  type ConfluencePublishResult,
  type PublishOutcome,
  type PublishScope,
} from "./ConfluencePublishDialog";

// "Publish to Confluence…" from a folder's ⋯ menu
// (specs/external-links/confluence-wiki.feature.md "Publish a folder's
// features to Confluence"): every feature under the folder, its subfolders'
// included, becomes its own page under one parent page — the features in a
// checklist the user can leave some out of. Each is published in turn
// through the feature's own route, exactly as "Publish to Confluence…" on
// the feature does, and its row says how it went: published, updated, a
// page changed in Confluence since (Publish anyway replaces those, and only
// those), or what failed. A failure that would fail every feature — a token
// Confluence refuses, a wiki that does not answer — stops the run.

/** A feature under the folder, with the page it links and its last parent. */
export interface FolderFeature {
  file: string;
  name: string;
  linkedUrl?: string;
  parentUrl?: string;
}

/** Where a feature's row stands in a run. */
export type RowState = { kind: "waiting" } | { kind: "publishing" } | PublishOutcome;

/**
 * The parent page the dialog offers: the one most of the folder's features
 * were last published under — the first such in the folder's order on a
 * tie — or none.
 */
export function commonParentUrl(features: FolderFeature[]): string {
  const counts = new Map<string, number>();
  for (const f of features) if (f.parentUrl) counts.set(f.parentUrl, (counts.get(f.parentUrl) ?? 0) + 1);
  let best = "";
  for (const [url, n] of counts) if (n > (counts.get(best) ?? 0)) best = url;
  return best;
}

/**
 * A failure every other feature would meet too: a token Confluence refuses,
 * or a wiki that gave no answer at all. The run stops there rather than
 * repeating it for each feature.
 */
export function failsEveryFeature(outcome: PublishOutcome): boolean {
  if (outcome.kind !== "failed") return false;
  if (outcome.status === 401) return true;
  return outcome.details !== undefined && outcome.details.status === undefined;
}

/**
 * Publish `files` one after another, each through `publishOne`, telling
 * `onState` as each starts and ends. `force` names the files whose conflict
 * the user chose to replace. Stops at a failure every feature would meet;
 * the files after it are left as they were.
 */
export async function publishEach(
  files: string[],
  publishOne: (file: string, force: boolean) => Promise<PublishOutcome>,
  onState: (file: string, state: RowState) => void,
  force: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const file of files) {
    onState(file, { kind: "publishing" });
    const outcome = await publishOne(file, force.has(file));
    onState(file, outcome);
    if (failsEveryFeature(outcome)) return;
  }
}

/** The features a Publish press would send: checked, and not published in this run. */
export function pendingFiles(
  features: FolderFeature[],
  checked: ReadonlySet<string>,
  states: ReadonlyMap<string, RowState>,
): string[] {
  return features.filter((f) => checked.has(f.file) && states.get(f.file)?.kind !== "done").map((f) => f.file);
}

function FeatureRowStatus({
  feature,
  state,
  onOpenLogs,
}: {
  feature: FolderFeature;
  state: RowState;
  onOpenLogs?: () => void;
}) {
  switch (state.kind) {
    case "publishing":
      return <span className="hint">Publishing…</span>;
    case "done":
      return (
        <span className="confluence-row-done">
          {state.result.created ? "Published" : "Updated"} ·{" "}
          <a href={state.result.url} target="_blank" rel="noreferrer">
            Open page
          </a>
        </span>
      );
    case "conflict": {
      const c = state.conflict;
      return (
        <span className="confluence-row-conflict" role="alert">
          <a href={c.url} target="_blank" rel="noreferrer">
            Changed in Confluence
          </a>{" "}
          since the last publish: version {c.version}
          {c.by ? ` by ${c.by}` : ""}
          {c.when ? ` on ${whenText(c.when)}` : ""}
        </span>
      );
    }
    case "failed":
      return <FailureLine service="Confluence" error={state.error} details={state.details} onOpenLogs={onOpenLogs} />;
    default:
      return feature.linkedUrl ? (
        <span className="hint">
          Updates{" "}
          <a href={feature.linkedUrl} target="_blank" rel="noreferrer">
            its page
          </a>
        </span>
      ) : (
        <span className="hint">New page</span>
      );
  }
}

export function ConfluenceFolderPublishDialog({
  folderLabel,
  features,
  wikis,
  trapRef,
  onPublished,
  onFinished,
  onClose,
  onOpenLogs,
}: {
  /** The folder as the sidebar names it. */
  folderLabel: string;
  /**
   * The folder's features in the sidebar's order, with what the server knows
   * of their pages; null while loading. The dialog reads them once, so the
   * caller remounts it (a new key) when they arrive.
   */
  features: FolderFeature[] | null;
  wikis: ConfluenceWiki[];
  trapRef?: Ref<HTMLDivElement>;
  /** One feature published, with the feature as saved. */
  onPublished: (file: string, result: ConfluencePublishResult) => void;
  /** Every checked feature published: the dialog's work is done. */
  onFinished: (results: ConfluencePublishResult[]) => void;
  onClose: () => void;
  /** Leave for the Observability page, showing Confluence's entries. */
  onOpenLogs?: () => void;
}) {
  const [parentUrl, setParentUrl] = useState(() => commonParentUrl(features ?? []));
  const [scope, setScope] = useState<PublishScope>("all");
  const [checked, setChecked] = useState<Set<string>>(() => new Set((features ?? []).map((f) => f.file)));
  const [states, setStates] = useState<Map<string, RowState>>(new Map());
  const [busy, setBusy] = useState(false);
  const problem = parentUrlProblem(parentUrl, wikis);

  // A new parent or scope makes a new run: what the last one did no longer holds.
  const restart = () => setStates(new Map());
  const pending = pendingFiles(features ?? [], checked, states);
  const conflicts = pending.filter((f) => states.get(f)?.kind === "conflict");

  const publish = async () => {
    if (problem || busy || pending.length === 0) return;
    setBusy(true);
    // Publish anyway answers the conflicts shown; nothing else is forced.
    const force = new Set(conflicts);
    const next = new Map(states);
    await publishEach(
      pending,
      (file, forced) => postConfluencePublish(file, { parentUrl, scope, force: forced }),
      (file, state) => {
        next.set(file, state);
        setStates(new Map(next));
        if (state.kind === "done") onPublished(file, state.result);
      },
      force,
    );
    setBusy(false);
    const all = (features ?? []).filter((f) => checked.has(f.file)).map((f) => next.get(f.file));
    if (all.every((s) => s?.kind === "done")) {
      onFinished(all.map((s) => (s as Extract<RowState, { kind: "done" }>).result));
    }
  };

  const count = (n: number) => `${n} feature${n === 1 ? "" : "s"}`;
  const label = busy
    ? "Publishing…"
    : conflicts.length > 0
      ? "Publish anyway"
      : states.size > 0 && pending.length > 0
        ? `Publish the remaining ${count(pending.length)}`
        : pending.length > 0
          ? `Publish ${count(pending.length)}`
          : "Publish";

  return (
    <div className="dialog-backdrop" {...backdropDismiss(busy ? () => {} : onClose)}>
      <div
        className="dialog modal-dialog confluence-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Publish folder to Confluence"
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
            Each feature in <strong>{folderLabel}</strong> becomes its own page under the parent page; a feature
            published before updates its page.
          </p>
          <label>
            Parent page url
            <input
              aria-label="Parent page url"
              autoFocus
              value={parentUrl}
              disabled={busy}
              onChange={(e) => {
                setParentUrl(e.target.value);
                restart();
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
              if (busy) return;
              setScope(v === "published" ? "published" : "all");
              restart();
            }}
          />
          {features === null ? (
            <p className="hint">Loading the folder's features…</p>
          ) : features.length === 0 ? (
            <p className="hint">This folder has no features to publish.</p>
          ) : (
            <fieldset className="confluence-features">
              <legend>Features</legend>
              <ul>
                {features.map((f) => (
                  <li key={f.file}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={f.name}
                        checked={checked.has(f.file)}
                        disabled={busy || states.get(f.file)?.kind === "done"}
                        onChange={(e) => {
                          const next = new Set(checked);
                          if (e.target.checked) next.add(f.file);
                          else next.delete(f.file);
                          setChecked(next);
                        }}
                      />
                      {f.name}
                    </label>
                    <FeatureRowStatus
                      feature={f}
                      state={states.get(f.file) ?? { kind: "waiting" }}
                      onOpenLogs={onOpenLogs}
                    />
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          {conflicts.length > 0 && !busy && (
            <p className="confluence-conflict" role="alert">
              {conflicts.length === 1 ? "A page was" : `${conflicts.length} pages were`} changed in Confluence since
              last published from here. Publish anyway replaces those changes.
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              {states.size > 0 ? "Close" : "Cancel"}
            </button>
            <button
              type="submit"
              className={`btn ${conflicts.length > 0 ? "btn-danger" : "btn-primary"}`}
              disabled={busy || problem !== null || pending.length === 0}
            >
              {label}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

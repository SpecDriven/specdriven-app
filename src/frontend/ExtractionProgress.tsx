import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleDashed, LoaderCircle, Sparkles, TriangleAlert } from "lucide-react";
import { backdropDismiss } from "./backdropDismiss";
import { Popover } from "./Popover";
import type { JobFolder } from "../server/intentExtraction";
import type { ExtractGithub } from "./ExtractSpecsDialog";
import {
  drafting,
  featuresTouched,
  folderLine,
  linking,
  progressLabel,
  resumable,
  type ExtractionStatus,
} from "./extractSpecs";

// The drafting of a new specification folder's specs, as it goes
// (specs/app/extract-specs-from-code.feature.md "Progress and cancel"): a
// pill in the sidebar's corner that says how far the run is, and opens a
// list of the folders — the features drafted for each, what failed, what
// is still waiting — with Cancel while it runs, Retry for a folder that
// failed, Resume for a run that stopped, and Dismiss once it is over. A
// folder that is only on this computer is published to GitHub from here.
//
// The same pill follows the linking of the project's tests to the scenarios
// ("Tests are linked in a pass of their own") — the pass a run goes on to
// after drafting, or a run of its own — and a run that drafted without
// linking offers "Link tests…" once it is over.

/** How often the page asks how a run stands while it is at work. */
const POLL_MS = 2000;

export interface Extraction {
  status: ExtractionStatus | null;
  cancel: () => Promise<void>;
  /** Take up what is not done: one folder, or all of them. */
  retry: (folder?: string) => Promise<string | null>;
  dismiss: () => Promise<void>;
  /** The folder got its repository: it is published from now on. */
  published: () => void;
}

/**
 * How the open folder's drafting stands, kept current: asked once when the
 * folder opens — a run from an earlier start may be waiting to be resumed —
 * again whenever `kick` changes (a run was just started), and every two
 * seconds while a run is at work. `onFeature` is called each
 * time a run has written another feature, or given one its test links, for
 * the page to show it.
 */
export function useExtraction(folder: string | null, kick: number, onFeature: () => void): Extraction {
  const [status, setStatus] = useState<ExtractionStatus | null>(null);
  const written = useRef(0);
  const onFeatureRef = useRef(onFeature);
  onFeatureRef.current = onFeature;

  const apply = useCallback((next: ExtractionStatus | null) => {
    setStatus(next);
    const count = featuresTouched(next?.job);
    if (count > written.current) onFeatureRef.current();
    written.current = count;
  }, []);

  const ask = useCallback(
    async (method = "GET", path = "", body?: unknown): Promise<string | null> => {
      if (!folder) return null;
      try {
        const res = await fetch(`/api/extract/draft${path}`, {
          method,
          ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
        });
        const data = (await res.json()) as ExtractionStatus & { error?: string };
        if (!res.ok) return data.error ?? `HTTP ${res.status}`;
        apply({ job: data.job ?? null, published: data.published === true });
        return null;
      } catch {
        return "Could not reach the server";
      }
    },
    [folder, apply],
  );

  useEffect(() => {
    written.current = 0;
    setStatus(null);
  }, [folder]);
  useEffect(() => {
    if (folder) void ask();
  }, [folder, kick, ask]);

  const busy = drafting(status?.job);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void ask(), POLL_MS);
    return () => clearInterval(timer);
  }, [busy, ask]);

  return {
    status,
    cancel: async () => void (await ask("POST", "/cancel")),
    retry: (name) => ask("POST", "/retry", name ? { folder: name } : {}),
    dismiss: async () => void (await ask("DELETE")),
    published: () => setStatus((s) => (s ? { ...s, published: true } : s)),
  };
}

function FolderGlyph({ state }: { state: JobFolder["state"] }) {
  if (state === "running") return <LoaderCircle size={13} className="extract-spin" aria-hidden="true" />;
  if (state === "done") return <Check size={13} aria-hidden="true" />;
  if (state === "failed") return <TriangleAlert size={13} aria-hidden="true" />;
  return <CircleDashed size={13} aria-hidden="true" />;
}

/** The list of folders with what came of each: presentational, so it renders without a server. */
export function ExtractionFolders({
  folders,
  busy,
  onOpenFeature,
  onRetry,
}: {
  folders: readonly JobFolder[];
  busy: boolean;
  onOpenFeature: (fileName: string) => void;
  onRetry: (folder: string) => void;
}) {
  return (
    <ul className="extract-folders" aria-label="Folders being drafted">
      {folders.map((f) => (
        <li key={f.folder} className={`extract-folder is-${f.state}`}>
          <div className="extract-folder-head">
            <FolderGlyph state={f.state} />
            <span className="extract-folder-name">{f.name}</span>
            {!busy && (f.state === "failed" || f.state === "cancelled") && (
              <button type="button" className="btn btn-ghost" onClick={() => onRetry(f.folder)}>
                Retry
              </button>
            )}
          </div>
          <p className={f.state === "failed" ? "error extract-note" : "hint extract-note"}>{folderLine(f)}</p>
          {f.batches
            .filter((b) => b.fileName)
            .map((b) => (
              <button key={b.fileName} type="button" className="extract-feature" onClick={() => onOpenFeature(b.fileName!)}>
                {b.title}
              </button>
            ))}
          {/* A run that only links tests has no batches: its features are the links'. */}
          {f.batches.length === 0 &&
            (f.links ?? [])
              .filter((l) => l.state === "done" || l.state === "failed")
              .map((l) => (
                <button
                  key={l.fileName}
                  type="button"
                  className="extract-feature"
                  title={l.error}
                  onClick={() => onOpenFeature(l.fileName)}
                >
                  {l.title}
                  {l.state === "done" ? ` — ${l.linked} test${l.linked === 1 ? "" : "s"}` : " — failed"}
                </button>
              ))}
        </li>
      ))}
    </ul>
  );
}

/** "Publish to GitHub…": the accounts the open folder can go under, and the button that does it. */
export function PublishSpecsDialog({ onPublished, onClose }: { onPublished: (url: string) => void; onClose: () => void }) {
  const [github, setGithub] = useState<ExtractGithub | null>(null);
  const [owner, setOwner] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch("/api/extract/github")
      .then(async (res) => {
        const data = (await res.json()) as ExtractGithub & { error?: string };
        if (!live) return;
        if (!res.ok) return setError(data.error ?? `HTTP ${res.status}`);
        setGithub(data);
        setOwner(data.owners[0] ?? "");
      })
      .catch(() => live && setError("Could not reach the server — is it running?"));
    return () => {
      live = false;
    };
  }, []);

  const publish = async () => {
    if (busy || !github || !owner) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/extract/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ github: { host: github.host, owner, private: isPrivate } }),
      });
      const data = (await res.json()) as { github?: string; error?: string };
      if (!res.ok || !data.github) return setError(data.error ?? `Publishing failed (HTTP ${res.status})`);
      onPublished(data.github);
    } catch {
      setError("Could not reach the server — is it running?");
    } finally {
      setBusy(false);
    }
  };

  const can = Boolean(github && github.owners.length > 0 && !github.problem);
  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
      <div className="dialog modal-dialog" role="dialog" aria-modal="true" aria-label="Publish to GitHub" onClick={(e) => e.stopPropagation()}>
        <form
          className="modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void publish();
          }}
        >
          <h3>Publish to GitHub</h3>
          <p>This folder is on this computer only. A repository of its name is made on GitHub and the folder pushed to it.</p>
          {!github && !error && <p className="hint">Asking GitHub…</p>}
          {github && !can && <p className="hint">{github.problem ?? "No GitHub sign-in to create a repository with."}</p>}
          {github && can && (
            <>
              <label>
                Owner
                <select aria-label="Repository owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
                  {github.owners.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
              <label className="choice">
                <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                <span className="choice-label">Private</span>
              </label>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !can}>
              {busy ? "Publishing…" : "Publish"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ExtractionProgress({
  extraction,
  onOpenFeature,
  onPublish,
  onLinkTests,
  onError,
}: {
  extraction: Extraction;
  onOpenFeature: (fileName: string) => void;
  /** Open "Publish to GitHub…", where the folder is only on this computer. */
  onPublish?: () => void;
  /** Open "Link tests to specs", for a run that drafted without linking. */
  onLinkTests?: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const job = extraction.status?.job;
  if (!job) return null;
  const busy = drafting(job);
  const failed = job.folders.some((f) => f.state === "failed" || f.links?.some((l) => l.state === "failed"));
  const onlyLinks = job.kind === "link";
  const title = onlyLinks ? "Tests linked to the specs" : "Specs drafted from the code";
  const idle = onlyLinks
    ? `Each scenario lists the tests of ${job.tests?.repo ?? job.project} that check it, under Automated tests. Read them as you read the scenarios: a link is the agent's reading of the test.`
    : "Every scenario is proposed: read them, correct them, and publish the ones that say what the code is meant to do.";
  const atWork = linking(job)
    ? `${job.agentLabel ?? "An agent"} reads each feature's scenarios and the tests of its code, and links the tests that check them, one feature at a time.`
    : `${job.agentLabel ?? "An agent"} reads each folder's code and writes proposed scenarios, one folder at a time.`;
  const retry = async (folder?: string) => {
    const problem = await extraction.retry(folder);
    if (problem) onError(problem);
  };
  return (
    <div className="extract-progress">
      <button
        type="button"
        className={`extract-pill${failed || job.state === "interrupted" ? " needs-attention" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? <LoaderCircle size={13} className="extract-spin" aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
        <span>{progressLabel(job)}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label={title} className="extract-popover" containerSelector=".extract-progress">
        <h4>{onlyLinks ? `Tests of ${job.project} linked to its specs` : `Specs drafted from ${job.project}`}</h4>
        <p className={job.problem ? "error" : "hint"}>{job.problem ?? (busy ? atWork : idle)}</p>
        {job.testsProblem && <p className="hint">The tests are not linked: {job.testsProblem}.</p>}
        <ExtractionFolders
          folders={job.folders}
          busy={busy}
          onOpenFeature={(fileName) => {
            setOpen(false);
            onOpenFeature(fileName);
          }}
          onRetry={(folder) => void retry(folder)}
        />
        <div className="dialog-actions">
          {onPublish && extraction.status?.published === false && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setOpen(false);
                onPublish();
              }}
            >
              Publish to GitHub…
            </button>
          )}
          {onLinkTests && !busy && !onlyLinks && !job.tests && !job.testsProblem && job.folders.some((f) => f.batches.some((b) => b.fileName)) && (
            <button
              type="button"
              className="btn btn-secondary"
              title="Have an agent link the project's tests to the scenarios drafted from it"
              onClick={() => {
                setOpen(false);
                onLinkTests();
              }}
            >
              Link tests…
            </button>
          )}
          {busy ? (
            <button type="button" className="btn btn-secondary" disabled={job.state === "cancelling"} onClick={() => void extraction.cancel()}>
              {job.state === "cancelling" ? "Stopping…" : "Cancel"}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setOpen(false);
                  void extraction.dismiss();
                }}
              >
                Dismiss
              </button>
              {resumable(job) && (
                <button type="button" className="btn btn-primary" onClick={() => void retry()}>
                  {job.state === "interrupted" || job.state === "cancelled" ? "Resume" : "Retry failed"}
                </button>
              )}
            </>
          )}
        </div>
      </Popover>
    </div>
  );
}

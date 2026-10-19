// Fix this app's pane and sidebar (specs/app/self-healing.feature.md): the
// form a bug is described on, with its screenshots, and one fix's page —
// the agent session it opened, the change as a diff, and the Rebuild,
// Restart and Revert controls. The agent's own transcript is the agent
// pane's (src/frontend/AgentPane.tsx); this pane only opens it.

import { Bot, FileDiff, Hammer, Image as ImageIcon, RotateCcw, Undo2, Wrench } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type MouseEvent, type ReactNode } from "react";
import type { Confirm, Navigate as TabNavigate } from "../plugins/client/tabs";
import { selfFixPath, type SelfFixRoute } from "../plugins/builtin/self-fix/route";
import { agentChat } from "./agentChat";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";
import {
  bootBanner,
  fixControls,
  fixLabel,
  preconditionHints,
  selfFix,
  selfFixState,
  useSelfFix,
  type FixView,
  type Hint,
  type SelfFixIndex,
} from "./selfFix";
import { toast } from "./Toasts";

type Navigate = TabNavigate<SelfFixRoute>;

function spaClick(e: MouseEvent, go: () => void) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go();
}

function PaneHeader({ crumbs, tail, actions }: { crumbs: Crumb[]; tail: ReactNode; actions?: ReactNode }) {
  return (
    <header className="editor-bar page-header">
      <Breadcrumbs items={crumbs} tail={<span className="crumb current plain">{tail}</span>} />
      <div className="editor-actions page-actions">{actions}</div>
    </header>
  );
}

function homeCrumb(go: Navigate): Crumb {
  return {
    label: "Fix this app",
    href: "/fix-app",
    onClick: (e) => spaClick(e, () => go({ kind: "new" }, { push: true })),
  };
}

// --- Pieces the tests render on their own ------------------------------------------------

/** The hints about the machine; blocking ones first. */
export function Hints({ hints, onOpenSettings }: { hints: Hint[]; onOpenSettings: () => void }) {
  if (hints.length === 0) return null;
  return (
    <ul className="self-fix-hints">
      {hints.map((h) => (
        <li key={h.text} className={h.blocking ? "blocking" : "muted"}>
          {h.text}
          {h.settings && (
            <>
              {" "}
              <button type="button" className="link" onClick={onOpenSettings}>
                Open Settings
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The line about which bundle the desktop booted, when it is worth a line. */
export function BootBanner({ index }: { index: SelfFixIndex }) {
  const text = bootBanner(index.boot, index.fixes);
  if (!text) return null;
  const warn = index.boot.source === "asar";
  return (
    <p className={`self-fix-banner${warn ? " warn" : ""}`} role="status">
      {text}
    </p>
  );
}

const STATUS_LABEL: Record<FixView["fix"]["status"], string> = {
  draft: "Not started",
  running: "Agent working",
  built: "Rebuilt — restart to use it",
  applied: "Applied",
  reverted: "Reverted",
};

/** One fix's status line, with the session's state while it runs. */
export function FixStatus({ view }: { view: FixView }) {
  const { fix, session } = view;
  const agent = session ? ` · agent ${session.status.replace("_", " ")}` : "";
  return (
    <p className="self-fix-status">
      <span className={`chip ${fix.status}`}>{STATUS_LABEL[fix.status]}</span>
      {agent && <span className="muted small">{agent}</span>}
      {fix.error && <span className="self-fix-error"> · {fix.error}</span>}
    </p>
  );
}

/** The files the fix touched so far and git's summary of them. */
export function ChangeList({ view }: { view: FixView }) {
  const { diff } = view;
  if (!diff || diff.files.length === 0) return <p className="hint">Nothing changed yet.</p>;
  return (
    <div className="self-fix-changes">
      <ul>
        {diff.files.map((f) => (
          <li key={f}>
            <code>{f}</code>
          </li>
        ))}
      </ul>
      <p className="muted small">{diff.summary}</p>
    </div>
  );
}

// --- The new-fix form ------------------------------------------------------------------------

interface PaneProps {
  view: SelfFixRoute;
  repoCrumb: Crumb;
  confirm: Confirm;
  onNavigate: Navigate;
  onOpenSettings: () => void;
}

function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  const files: File[] = [];
  if (!list) return files;
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const file = entry instanceof File ? entry : (entry as DataTransferItem).kind === "file" ? (entry as DataTransferItem).getAsFile() : null;
    if (file && file.type.startsWith("image/")) files.push(file);
  }
  return files;
}

function NewView({ repoCrumb, onNavigate, onOpenSettings }: PaneProps) {
  const store = useSelfFix();
  const [description, setDescription] = useState("");
  const [shots, setShots] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const index = store.index;
  const hints = index ? preconditionHints(index) : [];
  const blocked = !index || hints.some((h) => h.blocking);

  const addFiles = (files: File[]) => {
    if (files.length > 0) setShots((prev) => [...prev, ...files]);
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = imageFiles(e.clipboardData?.files);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(imageFiles(e.dataTransfer?.files));
  };

  const submit = async () => {
    if (!description.trim() || busy || blocked) return;
    setBusy(true);
    try {
      const id = await selfFix.create();
      for (const file of shots) await selfFix.upload(id, file);
      await selfFix.start(id, description);
      toast.success("The agent is on it.");
      onNavigate({ kind: "fix", id }, { push: true });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PaneHeader
        crumbs={[repoCrumb, homeCrumb(onNavigate)]}
        tail="New fix"
        actions={
          <button type="button" className="primary-action" disabled={!description.trim() || busy || blocked} onClick={() => void submit()}>
            <Wrench size={14} aria-hidden="true" /> {busy ? "Starting…" : "Ask the agent to fix it"}
          </button>
        }
      />
      <div className="tests-body issue-form self-fix-form">
        {store.error && <p className="view-error">{store.error}</p>}
        {index ? <BootBanner index={index} /> : <p className="hint">Checking this machine…</p>}
        {index && <Hints hints={hints} onOpenSettings={onOpenSettings} />}
        {index?.source && (
          <p className="muted small">
            Source: <code>{index.source.dir}</code> (version {index.source.version}
            {index.source.mode === "dev" ? ", a git checkout" : ""})
          </p>
        )}
        <textarea
          className="self-fix-description"
          value={description}
          placeholder="What went wrong? What did you expect? How can it be reproduced? Paste screenshots here too."
          aria-label="Bug description"
          autoFocus
          rows={10}
          onChange={(e) => setDescription(e.target.value)}
          onPaste={onPaste}
        />
        <div
          className={`self-fix-drop${dragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <ImageIcon size={16} aria-hidden="true" />
          <span>
            {shots.length === 0 ? "Drop or paste screenshots, or " : `${shots.length} screenshot${shots.length === 1 ? "" : "s"} attached; `}
            <button type="button" className="link" onClick={() => fileInput.current?.click()}>
              choose files
            </button>
          </span>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(imageFiles(e.target.files))} />
        </div>
        {shots.length > 0 && (
          <ul className="self-fix-shots">
            {shots.map((file, i) => (
              <li key={`${file.name}-${i}`}>
                <img src={URL.createObjectURL(file)} alt={file.name} />
                <button type="button" className="link" onClick={() => setShots((prev) => prev.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

// --- One fix ---------------------------------------------------------------------------------

const POLL_MS = 3000;

function FixPage({ id, repoCrumb, confirm, onNavigate, onOpenSettings }: PaneProps & { id: string }) {
  const store = useSelfFix();
  const view = store.views[id] ?? null;
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState<"build" | "restart" | "revert" | null>(null);

  useEffect(() => {
    void selfFix.refresh(id);
    // The interval reads the latest view from the store, not this closure.
    const timer = setInterval(() => {
      const v = selfFixState().views[id];
      if (!v || v.fix.status === "running" || v.fix.status === "built") void selfFix.refresh(id);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [id]);

  if (!view) {
    return (
      <>
        <PaneHeader crumbs={[repoCrumb, homeCrumb(onNavigate)]} tail="Fix" />
        <div className="tests-body">{store.error ? <p className="view-error">{store.error}</p> : <p className="hint">Loading…</p>}</div>
      </>
    );
  }
  const { fix, session } = view;
  const controls = fixControls(view);
  const index = store.index;
  const build = async () => {
    if (!(await confirm({ title: "Rebuild the app from the fixed source?", body: "The bundles are rebuilt under the installed source. Nothing runs them until you restart.", confirmLabel: "Rebuild", danger: false }))) return;
    setBusy("build");
    if (await selfFix.build(id)) toast.success("Rebuilt. Restart to use the fix.");
    setBusy(null);
  };
  const restart = async () => {
    const desktop = view.canRelaunch;
    if (!(await confirm({ title: desktop ? "Restart the app into the fix?" : "Mark the fix as applied?", body: desktop ? "The app quits and starts again. If the rebuilt app fails to start twice, the shipped build runs instead." : "The web server cannot restart itself; run `bun run start` again afterwards.", confirmLabel: desktop ? "Restart" : "Apply", danger: false }))) return;
    setBusy("restart");
    await selfFix.restart(id);
    setBusy(null);
  };
  const revert = async () => {
    if (!(await confirm({ title: "Revert this fix?", body: "The source goes back to the installed version, the agent's session ends, and the app restarts into the shipped build.", confirmLabel: "Revert" }))) return;
    setBusy("revert");
    await selfFix.revert(id);
    setBusy(null);
  };
  const openSession = () => {
    if (!fix.sessionId) return;
    agentChat.setActive(fix.sessionId);
    agentChat.openPane();
  };
  const toggleDiff = async () => {
    if (!showDiff && store.diffs[id] === undefined) await selfFix.diff(id).catch((e: Error) => toast.error(e.message));
    setShowDiff((s) => !s);
  };

  return (
    <>
      <PaneHeader
        crumbs={[repoCrumb, homeCrumb(onNavigate)]}
        tail={fixLabel(fix)}
        actions={
          <>
            {fix.sessionId && (
              <button type="button" className="secondary" onClick={openSession} disabled={!session}>
                <Bot size={14} aria-hidden="true" /> Open session
              </button>
            )}
            <button type="button" className="secondary" onClick={() => void toggleDiff()} disabled={!view.diff || view.diff.files.length === 0}>
              <FileDiff size={14} aria-hidden="true" /> {showDiff ? "Hide changes" : "Review changes"}
            </button>
            <button type="button" className="secondary" onClick={() => void build()} disabled={!controls.build || busy !== null}>
              <Hammer size={14} aria-hidden="true" /> {busy === "build" ? "Rebuilding…" : "Rebuild"}
            </button>
            <button type="button" className="primary-action" onClick={() => void restart()} disabled={!controls.restart || busy !== null}>
              <RotateCcw size={14} aria-hidden="true" /> {view.canRelaunch ? "Restart" : "Apply"}
            </button>
            <button type="button" className="secondary danger" onClick={() => void revert()} disabled={!controls.revert || busy !== null}>
              <Undo2 size={14} aria-hidden="true" /> Revert
            </button>
          </>
        }
      />
      <div className="tests-body self-fix-view">
        {index && <BootBanner index={index} />}
        {index && <Hints hints={preconditionHints(index).filter((h) => !h.blocking)} onOpenSettings={onOpenSettings} />}
        <FixStatus view={view} />
        <section>
          <h3 className="issue-section-title">The bug</h3>
          <pre className="self-fix-words">{fix.description}</pre>
          {fix.screenshots.length > 0 && (
            <p className="muted small">
              {fix.screenshots.length} screenshot{fix.screenshots.length === 1 ? "" : "s"}: {fix.screenshots.join(", ")}
            </p>
          )}
        </section>
        <section>
          <h3 className="issue-section-title">The change</h3>
          <ChangeList view={view} />
          {showDiff && <pre className="self-fix-diff">{store.diffs[id] ?? ""}</pre>}
        </section>
        {fix.sourceDir && (
          <p className="muted small">
            Source: <code>{fix.sourceDir}</code>
          </p>
        )}
      </div>
    </>
  );
}

export function SelfFixPane(props: PaneProps) {
  const { view } = props;
  if (view.kind === "new") return <NewView {...props} />;
  return <FixPage {...props} id={view.id} />;
}

// --- The sidebar ----------------------------------------------------------------------------

export function SelfFixSidebar({ view, onNavigate }: { view: SelfFixRoute | null; onNavigate: Navigate }) {
  const store = useSelfFix();
  const fixes = store.index?.fixes ?? [];
  const active = view?.kind === "fix" ? view.id : null;
  return (
    <div className="side-panel page-list" role="tabpanel" id="side-panel-self-fix" aria-labelledby="side-tab-self-fix">
      <div className="sidebar-actions">
        <button onClick={() => onNavigate({ kind: "new" }, { push: true })}>+ Fix this app</button>
      </div>
      <div className="page-rows">
        {fixes.length === 0 && <p className="hint">No fixes yet.</p>}
        {fixes.map((fix) => (
          <div key={fix.id} className="page-row">
            <a
              href={selfFixPath({ kind: "fix", id: fix.id })}
              className={`page-entry${active === fix.id ? " active" : ""}`}
              title={fixLabel(fix)}
              aria-current={active === fix.id ? "page" : undefined}
              onClick={(e) => spaClick(e, () => onNavigate({ kind: "fix", id: fix.id }, { push: true }))}
            >
              <Wrench size={13} aria-hidden="true" /> {fixLabel(fix)}
              <span className={`chip muted self-fix-chip ${fix.status}`}>{STATUS_LABEL[fix.status]}</span>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

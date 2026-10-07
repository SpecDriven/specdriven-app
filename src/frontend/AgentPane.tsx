import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  Bot,
  ChevronDown,
  CircleHelp,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  PanelRightClose,
  Plus,
  Search,
  ShieldAlert,
  Square,
  Terminal,
  Wrench,
} from "lucide-react";
import { Menu, type MenuItem } from "./Menu";
import type { PromptOptions } from "./ModalPrompts";
import { Tooltip } from "./Tooltip";
import { renderMarkdown } from "./markdown";
import { toast } from "./Toasts";
import { cleanLine, cleanText } from "../server/text";
import { PERMISSION_MODES, defaultPermissionMode } from "../server/permissionModes";
import {
  AGENT_LABEL,
  agentChat,
  applyCommand,
  defaultSessionName,
  filterCommands,
  formatCost,
  formatDuration,
  isFinalStatus,
  shouldFollow,
  useAgentChat,
  type AgentChatStore,
  type ChatAgent,
  type ChatSessionMeta,
  type ChatStatus,
  type PermissionMode,
  type Question,
  type SessionState,
  type TranscriptItem,
} from "./agentChat";

/**
 * The coding agent pane (specs/agents/coding-agent-ui.feature.md): a live
 * coding agent chat inside SpecDriven for developers who have a CLI but not
 * Claude Code Desktop — Claude Code, or Pi over its RPC mode
 * (specs/agents/integration-with-pi-dev-agent.feature.md). Header (session,
 * work dir, status, permission mode, Stop, close), a scrolling transcript
 * that follows new output until the reader scrolls up, and a composer with a
 * "/" popup listing the commands the session supports. State lives in
 * src/frontend/agentChat.ts; this file only renders it and forwards what the
 * user does.
 */

export const STATUS_LABEL: Record<ChatStatus, string> = {
  starting: "Starting…",
  idle: "Ready",
  running: "Working…",
  awaiting_input: "Waiting for your answer",
  ended: "Ended",
  error: "Failed",
};

/** The status as the pane says it: only "starting" names the agent. */
export function statusLabel(status: ChatStatus, agent: ChatAgent = "claude"): string {
  return status === "starting" ? `Starting ${AGENT_LABEL[agent]}…` : STATUS_LABEL[status];
}

// "default" is the SDK's name for asking every time; the pane calls it
// Manual and saves "Default" for the mode a new session starts in.
export const MODE_LABEL: Record<PermissionMode, string> = {
  auto: "Auto",
  default: "Manual",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypassPermissions: "Bypass permissions",
};
export const MODE_DESCRIPTION: Record<PermissionMode, string> = {
  auto: "Claude handles permission decisions",
  default: "Always ask before making changes",
  acceptEdits: "Automatically accept all file edits",
  plan: "Create a plan before making changes",
  bypassPermissions: "Accepts all permissions",
};

export interface Answer {
  requestId: string;
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
  remember?: boolean;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/**
 * A folder without its trailing separators, so "/a/b/" and "/a/b" are one
 * folder: the open spec folder keeps the slash it was typed with, while a
 * session's folder comes back resolved. A root ("/", "C:\") stays.
 */
export function folderPath(path: string): string {
  return path.replace(/(?<=[^\\/:])[\\/]+$/, "");
}

export function AgentPane({
  compact,
  demo,
  codeRepo,
  dataRepo,
  prompt,
  browseFolder,
  onClose,
}: {
  compact: boolean;
  /** Demo mode: every session in here is the simulation (src/server/demoAgent.ts). */
  demo: boolean;
  codeRepo: string | null;
  dataRepo: string | null;
  /** The app's path prompt, for "Other folder…"; absent hides that item. */
  prompt?: (opts: PromptOptions) => Promise<string | null>;
  /** The native folder chooser, offered as Browse… in that prompt. */
  browseFolder?: () => Promise<string | null>;
  onClose: () => void;
}) {
  const store = useAgentChat();
  const session = store.activeId ? (store.sessions[store.activeId] ?? null) : null;
  // Asks for any folder; null when canceled or there is no prompt.
  const askFolder = prompt
    ? async (initial: string): Promise<string | null> =>
        (
          await prompt({
            title: "Agent folder",
            hint: "The absolute path of the folder the coding agent works in.",
            initial,
            confirmLabel: "Use this folder",
            browse: browseFolder,
          })
        )?.trim() || null
    : undefined;
  return (
    <aside className={`agent-pane${compact ? " overlay" : ""}`} aria-label="Coding agent">
      <AgentHeader
        store={store}
        session={session}
        demo={demo}
        folders={knownFolders(codeRepo, dataRepo, store.list)}
        askFolder={askFolder}
        onClose={onClose}
      />
      {session ? (
        <>
          <Transcript session={session} />
          <Composer session={session} />
        </>
      ) : (
        <EmptyState
          store={store}
          demo={demo}
          codeRepo={codeRepo}
          dataRepo={dataRepo}
          askFolder={askFolder}
        />
      )}
      {demo && <SimulationWatermark />}
    </aside>
  );
}

/**
 * The demo's watermark: nothing in this pane is a real agent, and a screen
 * recording of it must not be mistaken for one. Decorative and inert —
 * pointer-events off so it never eats a click, aria-hidden because the
 * "Simulation" chip in the header says the same thing to a screen reader.
 * Exported so a static-markup test can assert on it.
 */
export function SimulationWatermark() {
  return (
    <div className="agent-sim-watermark" aria-hidden="true">
      {/* Repeated, because the pane is a tall column and one line of it
          would sit off screen for most of the transcript. */}
      {[0, 1, 2].map((i) => (
        <span key={i}>Simulation…</span>
      ))}
    </div>
  );
}

/**
 * The folders the pane offers an agent: the code repo, the data repo, then
 * every other folder a session here has worked in, newest first.
 */
export function knownFolders(
  codeRepo: string | null,
  dataRepo: string | null,
  sessions: readonly ChatSessionMeta[],
): string[] {
  const used = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((m) => m.cwd);
  const all = [codeRepo, dataRepo, ...used].filter((f): f is string => Boolean(f));
  return [...new Set(all.map(folderPath))];
}

function AgentHeader({
  store,
  session,
  demo,
  folders,
  askFolder,
  onClose,
}: {
  store: AgentChatStore;
  session: SessionState | null;
  demo: boolean;
  folders: string[];
  askFolder?: (initial: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const meta = session?.meta ?? null;
  const fail = (e: Error) => toast.error(e.message);
  const items: MenuItem[] = [
    ...store.list.map((m) => ({
      id: m.id,
      label: m.name,
      checked: m.id === store.activeId,
      title: `${AGENT_LABEL[m.agent]} · ${statusLabel(m.status, m.agent)} · ${m.cwd}`,
      onSelect: () => agentChat.setActive(m.id),
    })),
    {
      id: "new",
      label: "New session",
      icon: <Plus size={14} aria-hidden="true" />,
      onSelect: () => agentChat.setActive(null),
    },
    ...(meta
      ? [
          {
            id: "end",
            label: "End session",
            danger: true,
            onSelect: () => void agentChat.end(meta.id).catch(fail),
          },
        ]
      : []),
  ];
  const busy = meta !== null && (meta.status === "running" || meta.status === "awaiting_input");
  return (
    <div className="agent-head">
      <Bot size={16} aria-hidden="true" className="agent-head-icon" />
      <div className="agent-session-picker">
        <button
          type="button"
          className="agent-session-btn"
          aria-label="Sessions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="agent-session-name">{meta ? meta.name : "Coding agent"}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          label="Sessions"
          items={items}
          className="agent-session-menu"
        />
      </div>
      {meta && (
        <div className="agent-cwd-picker">
          <Tooltip label={`${AGENT_LABEL[meta.agent]} · ${meta.cwd}`}>
            <button
              type="button"
              className="chip muted agent-cwd"
              aria-label={`Folder: ${meta.cwd}`}
              aria-haspopup="menu"
              aria-expanded={folderOpen}
              onClick={() => setFolderOpen((o) => !o)}
            >
              <span className="agent-cwd-name">{basename(meta.cwd)}</span>
              <ChevronDown size={12} aria-hidden="true" className="agent-cwd-chevron" />
            </button>
          </Tooltip>
          <Menu
            open={folderOpen}
            onClose={() => setFolderOpen(false)}
            label="Folder"
            heading="Folder · another one starts a new session there"
            items={folderItems(folders, meta.cwd, askFolder, (cwd) => {
              if (cwd === meta.cwd) return;
              // A running agent cannot move: the new folder gets its own
              // session, same agent and mode, and this one stays listed.
              void agentChat
                .createSession({
                  name: defaultSessionName(),
                  agent: meta.agent,
                  cwd,
                  ...(meta.agent === "pi" ? {} : { permissionMode: meta.permissionMode }),
                })
                .catch(fail);
            })}
            className="agent-cwd-menu"
            containerSelector=".agent-cwd-picker"
          />
        </div>
      )}
      {meta && (
        <span
          className="agent-dot"
          data-status={meta.status}
          role="img"
          aria-label={statusLabel(meta.status, meta.agent)}
          title={statusLabel(meta.status, meta.agent)}
        />
      )}
      <span className="spacer" />
      {/* The watermark over the transcript is decorative; this is the same
          fact in text, for a screen reader and for a narrow pane where the
          diagonal lettering is easy to read past. */}
      {demo && (
        <Tooltip label="Scripted output — no coding agent runs in the demo">
          <span className="agent-sim-chip" tabIndex={0}>
            Simulation
          </span>
        </Tooltip>
      )}
      {/* Pi's RPC mode has no permission protocol — it runs its own tools,
          so there is no mode to offer and the pane says as much. */}
      {meta && meta.agent === "pi" && (
        <Tooltip label="Pi runs its own tools — SpecDriven cannot gate them">
          <span className="chip muted" tabIndex={0}>
            No permission gate
          </span>
        </Tooltip>
      )}
      {meta && meta.agent !== "pi" && (
        <div className="agent-mode-picker">
          <button
            type="button"
            className="agent-mode"
            aria-label={`Permission mode: ${MODE_LABEL[meta.permissionMode]}`}
            title="Permission mode"
            aria-haspopup="menu"
            aria-expanded={modeOpen}
            disabled={meta.status === "starting" || isFinalStatus(meta.status)}
            onClick={() => setModeOpen((o) => !o)}
          >
            <span className="agent-mode-name">{MODE_LABEL[meta.permissionMode]}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          <Menu
            open={modeOpen}
            onClose={() => setModeOpen(false)}
            label="Permission mode"
            heading="Mode"
            items={modeItems(meta.agent, meta.permissionMode, (m) =>
              void agentChat.setMode(meta.id, m).catch(fail),
            )}
            className="agent-mode-menu"
            containerSelector=".agent-mode-picker"
          />
        </div>
      )}
      {meta && busy && (
        <Tooltip label="Stop this turn">
          <button
            type="button"
            className="ibtn"
            aria-label="Stop"
            onClick={() => void agentChat.interrupt(meta.id).catch(fail)}
          >
            <Square size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      <Tooltip label="Close the coding agent pane" keys="]">
        <button
          type="button"
          className="ibtn"
          aria-label="Close the coding agent pane"
          onClick={onClose}
        >
          <PanelRightClose size={15} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}

/** The folder menu: each known folder by name over its path, then "Other folder…". */
export function folderItems(
  folders: readonly string[],
  current: string,
  askFolder: ((initial: string) => Promise<string | null>) | undefined,
  onSelect: (folder: string) => void,
): MenuItem[] {
  current = folderPath(current);
  const all = folders.includes(current) ? folders : [current, ...folders];
  return [
    ...all.map((f) => ({
      id: `folder:${f}`,
      label: basename(f),
      description: f,
      title: f,
      checked: f === current,
      onSelect: () => onSelect(f),
    })),
    ...(askFolder
      ? [
          {
            id: "other",
            label: "Other folder…",
            icon: <FolderOpen size={14} aria-hidden="true" />,
            onSelect: () =>
              void askFolder(current).then((f) => {
                if (f) onSelect(f);
              }),
          },
        ]
      : []),
  ];
}

/** The mode menu: one item per mode, numbered 1–5, the agent's default badged. */
export function modeItems(
  agent: ChatAgent,
  current: PermissionMode,
  onSelect: (mode: PermissionMode) => void,
): MenuItem[] {
  const start = defaultPermissionMode(agent);
  return PERMISSION_MODES.map((m, i) => ({
    id: m,
    label:
      m === start ? (
        <>
          {MODE_LABEL[m]} <span className="menu-badge">Default</span>
        </>
      ) : (
        MODE_LABEL[m]
      ),
    description: MODE_DESCRIPTION[m],
    keys: String(i + 1),
    checked: m === current,
    onSelect: () => onSelect(m),
  }));
}

function EmptyState({
  store,
  demo,
  codeRepo,
  dataRepo,
  askFolder,
}: {
  store: AgentChatStore;
  demo: boolean;
  codeRepo: string | null;
  dataRepo: string | null;
  askFolder?: (initial: string) => Promise<string | null>;
}) {
  const [name, setName] = useState(() => defaultSessionName());
  /** A folder picked here; null keeps the default (code repo, else data repo). */
  const [folder, setFolder] = useState<string | null>(null);
  const [agent, setAgent] = useState<ChatAgent>(() =>
    store.available ? "claude" : store.codexAvailable ? "codex" : "pi",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultDir = codeRepo ?? dataRepo;
  const workDir = folder ?? defaultDir;
  if (!store.available && !store.piAvailable && !store.codexAvailable) {
    return (
      <div className="agent-empty">
        <h3>Coding agent</h3>
        <p>
          No coding agent CLI found — install the <code>claude</code> command
          (or <code>codex</code>, from OpenAI, or <code>pi</code>, from pi.dev) and reload.
        </p>
      </div>
    );
  }
  // Only the agents whose CLI is on PATH; with one, there is nothing to pick.
  const agents: ChatAgent[] = [
    ...(store.available ? (["claude"] as ChatAgent[]) : []),
    ...(store.codexAvailable ? (["codex"] as ChatAgent[]) : []),
    ...(store.piAvailable ? (["pi"] as ChatAgent[]) : []),
  ];
  const picked = agents.includes(agent) ? agent : agents[0]!;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await agentChat.createSession({
        name: cleanLine(name) || defaultSessionName(),
        agent: picked,
        ...(folder && folder !== defaultDir ? { cwd: folder } : {}),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="agent-empty"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <h3>New coding agent session</h3>
      {/* The demo runs the script in src/server/demoAgent.ts, not an agent —
          say so here as well as on the watermark, since this is the screen a
          visitor reads before starting anything. */}
      {demo ? (
        <p>
          A simulated Claude Code session: the transcript, the tool rows and the
          permission prompt are scripted, and nothing runs or is written to disk.
        </p>
      ) : (
        <p>
          A live {picked === "pi" ? "Pi" : picked === "codex" ? "Codex" : "Claude Code"} session,
          run by SpecDriven.
          {workDir && (
            <>
              {" "}
              Works in <span className="agent-workdir">{workDir}</span>
              {workDir === codeRepo
                ? " — the code repo from project-settings.json."
                : workDir === dataRepo
                  ? " — the data repo."
                  : "."}
            </>
          )}
          {askFolder && workDir && (
            <>
              {" "}
              <button
                type="button"
                className="agent-folder-change"
                onClick={() =>
                  void askFolder(workDir).then((f) => {
                    if (f) setFolder(f);
                  })
                }
              >
                Change folder…
              </button>
            </>
          )}
        </p>
      )}
      {agents.length > 1 && (
        <fieldset className="choice-group" role="radiogroup" aria-label="Agent">
          <legend>Agent</legend>
          {agents.map((a) => (
            <label key={a} className="choice">
              <input
                type="radio"
                name="agent-empty-agent"
                value={a}
                checked={picked === a}
                onChange={() => setAgent(a)}
              />
              <span>
                <span>{AGENT_LABEL[a]}</span>
                <div className="agent-option-desc">
                  {a === "pi"
                    ? "Minimal, and runs its own tools — nothing asks for permission"
                    : a === "codex"
                      ? "OpenAI's Codex CLI, with permission cards for commands and file changes"
                      : "Claude Code, with permission cards and its own commands"}
                </div>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <label>
        Session name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <button type="submit" className="primary-action" disabled={busy}>
        {busy ? "Starting…" : "Start chat"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Transcript({ session }: { session: SessionState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const { items } = session.transcript;
  // A new session starts at its bottom.
  useEffect(() => {
    setFollowing(true);
    setUnseen(false);
  }, [session.meta.id]);
  // New output: keep the bottom in view while the reader is there, else
  // offer the way down.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (following) el.scrollTop = el.scrollHeight;
    else setUnseen(true);
  }, [session.transcript]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const f = shouldFollow(el.scrollTop, el.scrollHeight, el.clientHeight);
    setFollowing(f);
    if (f) setUnseen(false);
  };
  const jump = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollowing(true);
    setUnseen(false);
  };
  const answer = (a: Answer) =>
    void agentChat.answer(session.meta.id, a).catch((e: Error) => toast.error(e.message));
  return (
    <div
      className="agent-transcript"
      ref={ref}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-label="Session transcript"
    >
      {items.length === 0 && (
        <p className="agent-note">{statusLabel(session.meta.status, session.meta.agent)}</p>
      )}
      {items.map((item) => (
        <TranscriptRow key={item.id} item={item} agent={session.meta.agent} onAnswer={answer} />
      ))}
      {session.connection === "reconnecting" && (
        <p className="agent-note" data-level="error">
          Connection lost — reconnecting…
        </p>
      )}
      {!following && unseen && (
        <button type="button" className="chip agent-jump" onClick={jump}>
          <ArrowDown size={12} aria-hidden="true" /> Jump to latest
        </button>
      )}
    </div>
  );
}

/** One transcript entry. Exported so tests can render a row on its own. */
export function TranscriptRow({
  item,
  agent = "claude",
  onAnswer,
}: {
  item: TranscriptItem;
  agent?: ChatAgent;
  onAnswer?: (answer: Answer) => void;
}) {
  switch (item.kind) {
    case "user":
      return <div className="agent-msg user">{item.text}</div>;
    case "assistant":
      return (
        <div className="agent-msg assistant">
          {renderMarkdown(item.text)}
          {item.streaming && <span className="agent-caret" aria-hidden="true" />}
        </div>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "permission":
      return <PermissionCard item={item} agent={agent} onAnswer={onAnswer} />;
    case "question":
      return <QuestionCard item={item} onAnswer={onAnswer} />;
    case "result": {
      const loginHint =
        item.isError && /not logged in|no api key|unauthorized/i.test(item.text ?? "");
      return (
        <div className={`agent-turn-footer${item.isError ? " err" : ""}`}>
          <span>
            {!item.isError
              ? "Turn done"
              : item.subtype === "success"
                ? "Turn failed"
                : `Turn failed (${item.subtype.replace(/^error_/, "").replace(/_/g, " ")})`}
          </span>
          {item.costUsd !== null && <span>{formatCost(item.costUsd)}</span>}
          <span>{formatDuration(item.durationMs)}</span>
          {item.isError && item.text && <span className="agent-err-text">{item.text}</span>}
          {loginHint && (
            <span className="agent-err-text">
              {agent === "pi" ? (
                <>
                  Pi has no credentials for this model here: run <code>pi</code> in a terminal and{" "}
                  <code>/login</code>, then start a new session.
                </>
              ) : agent === "codex" ? (
                <>
                  The Codex CLI is not signed in on this machine: run <code>codex login</code> in a
                  terminal, then start a new session.
                </>
              ) : (
                <>
                  The Claude CLI is not signed in on this machine: run{" "}
                  <code>claude auth login</code> in a terminal, then start a new session.
                </>
              )}
            </span>
          )}
        </div>
      );
    }
    case "note":
      return (
        <p className="agent-note" data-level={item.level}>
          {item.text}
        </p>
      );
  }
}

function toolIcon(name: string): ReactNode {
  const size = 13;
  switch (name) {
    case "Bash":
      return <Terminal size={size} aria-hidden="true" />;
    case "Read":
      return <FileText size={size} aria-hidden="true" />;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return <FilePen size={size} aria-hidden="true" />;
    case "Grep":
    case "Glob":
      return <Search size={size} aria-hidden="true" />;
    case "WebFetch":
    case "WebSearch":
      return <Globe size={size} aria-hidden="true" />;
    case "Task":
    case "Agent":
      return <Bot size={size} aria-hidden="true" />;
    default:
      return <Wrench size={size} aria-hidden="true" />;
  }
}

function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const state = item.result ? (item.result.isError ? "failed" : "done") : "running…";
  return (
    <details className={`agent-tool${item.result?.isError ? " err" : ""}`}>
      <summary>
        {toolIcon(item.name)}
        <span className="agent-tool-name">{item.name || "Tool"}</span>
        <span className="agent-tool-summary" title={item.summary}>
          {item.summary}
        </span>
        <span className="agent-tool-state">{state}</span>
      </summary>
      {item.input !== null && item.input !== undefined && (
        <pre className="agent-tool-input">{JSON.stringify(item.input, null, 2)}</pre>
      )}
      {item.result && <pre className="agent-tool-output">{item.result.content || "(no output)"}</pre>}
    </details>
  );
}

function PermissionCard({
  item,
  agent = "claude",
  onAnswer,
}: {
  item: Extract<TranscriptItem, { kind: "permission" }>;
  agent?: ChatAgent;
  onAnswer?: (answer: Answer) => void;
}) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const done = item.resolved;
  const who = AGENT_LABEL[agent];
  const send = (a: Omit<Answer, "requestId">) => onAnswer?.({ requestId: item.requestId, ...a });
  const deny = () => send({ behavior: "deny", ...(cleanLine(reason) ? { message: cleanLine(reason) } : {}) });
  return (
    <div className="agent-card" role="group" aria-label={`Permission: ${item.toolName}`}>
      <div className="agent-card-title">
        <ShieldAlert size={14} aria-hidden="true" />
        {item.title ?? `${who} wants to use ${item.toolName}`}
      </div>
      {item.summary && <div className="agent-card-summary">{item.summary}</div>}
      <details className="agent-tool">
        <summary>
          <span className="agent-tool-name">Input</span>
        </summary>
        <pre className="agent-tool-input">{JSON.stringify(item.input, null, 2)}</pre>
      </details>
      {done ? (
        <div className="agent-card-verdict">
          {done.behavior === "allow" ? "Allowed" : "Denied"}
          {done.via === "interrupt" ? " (stopped)" : done.via === "ended" ? " (session ended)" : ""}
        </div>
      ) : denying ? (
        <div className="agent-card-actions">
          <input
            type="text"
            aria-label="Why not"
            placeholder={`Why not? Optional — ${who} reads it`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                deny();
              }
            }}
            autoFocus
          />
          <button type="button" className="danger" onClick={deny}>
            Deny
          </button>
          <button type="button" onClick={() => setDenying(false)}>
            Back
          </button>
        </div>
      ) : (
        <div className="agent-card-actions">
          <button type="button" className="primary" onClick={() => send({ behavior: "allow" })}>
            Allow once
          </button>
          {item.suggestions.length > 0 && (
            <button
              type="button"
              title={
                agent === "codex"
                  ? "Also allow this for the rest of the session, so Codex stops asking for it"
                  : `Also keep the rule ${who} suggests, so it stops asking for this`
              }
              onClick={() => send({ behavior: "allow", remember: true })}
            >
              Allow always
            </button>
          )}
          <button type="button" className="danger" onClick={() => setDenying(true)}>
            Deny…
          </button>
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  item,
  onAnswer,
}: {
  item: Extract<TranscriptItem, { kind: "question" }>;
  onAnswer?: (answer: Answer) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const done = item.resolved;
  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const current = p[q.question] ?? [];
      if (!q.multiSelect) return { ...p, [q.question]: [label] };
      return {
        ...p,
        [q.question]: current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label],
      };
    });
  // Answers keyed by the question text, values the picked labels — and the
  // typed text, for what the options did not cover.
  const answers: Record<string, string> = {};
  for (const q of item.questions) {
    const free = cleanLine(other[q.question] ?? "");
    const value = [...(picked[q.question] ?? []), ...(free ? [free] : [])].join(", ");
    if (value) answers[q.question] = value;
  }
  const complete = item.questions.every((q) => answers[q.question]);
  const submit = () =>
    onAnswer?.({
      requestId: item.requestId,
      behavior: "allow",
      updatedInput: { questions: item.questions, answers },
    });
  const skip = () =>
    onAnswer?.({
      requestId: item.requestId,
      behavior: "deny",
      message: "The user dismissed the question without answering",
    });
  return (
    <div className="agent-card" role="group" aria-label="Claude has a question">
      <div className="agent-card-title">
        <CircleHelp size={14} aria-hidden="true" />
        Claude has a question
      </div>
      {item.questions.map((q) => (
        <fieldset className="agent-question" key={q.question} disabled={done !== undefined}>
          <legend className="agent-question-header">{q.header}</legend>
          <div>{q.question}</div>
          {q.options.map((o) => (
            <label className="agent-option" key={o.label}>
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={`${item.requestId}:${q.header}`}
                checked={(picked[q.question] ?? []).includes(o.label)}
                onChange={() => toggle(q, o.label)}
              />
              <span>
                <span>{o.label}</span>
                {o.description && <div className="agent-option-desc">{o.description}</div>}
              </span>
            </label>
          ))}
          <input
            type="text"
            aria-label={`Other answer to: ${q.question}`}
            placeholder="Other…"
            value={other[q.question] ?? ""}
            onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))}
          />
        </fieldset>
      ))}
      {done ? (
        <div className="agent-card-verdict">{done.behavior === "allow" ? "Answered" : "Dismissed"}</div>
      ) : (
        <div className="agent-card-actions">
          <button type="button" className="primary" disabled={!complete} onClick={submit}>
            Send answers
          </button>
          <button type="button" onClick={skip}>
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

function Composer({ session }: { session: SessionState }) {
  const id = session.meta.id;
  const status = session.meta.status;
  const who = AGENT_LABEL[session.meta.agent];
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const slash = filterCommands(session.commands, draft, caret);
  const popup = slash.active && !dismissed && slash.items.length > 0;
  useEffect(() => {
    setSlashIndex(0);
  }, [slash.query]);
  useEffect(() => {
    setDismissed(false);
  }, [draft]);
  // Grow with the text, up to a share of the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [draft]);
  const final = isFinalStatus(status);
  const canSend = status === "idle" && draft.trim().length > 0;
  const send = async () => {
    // Blank lines around the message go; an indented first line (a code
    // block) keeps its indentation (specs/ui/ui.feature.md "User-entered
    // text is cleaned up").
    const text = cleanText(draft);
    if (!text.trim() || status !== "idle") return;
    setDraft("");
    try {
      await agentChat.send(id, text);
    } catch (e) {
      setDraft(text);
      toast.error((e as Error).message);
    }
  };
  const pick = (c: (typeof slash.items)[number]) => {
    const next = applyCommand(c);
    setDraft(next);
    setCaret(next.length);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (popup) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slash.items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slash.items.length) % slash.items.length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        pick(slash.items[slashIndex] ?? slash.items[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const hint =
    status === "idle"
      ? "Enter to send · Shift+Enter for a new line · / for commands"
      : status === "starting"
        ? `${who} is starting…`
        : status === "running"
          ? `${who} is working — Stop to send something else`
          : status === "awaiting_input"
            ? `Answer ${who}'s request above`
            : "This session has ended — start a new one from the session menu";
  const listId = `agent-slash-${id}`;
  return (
    <div className="agent-composer">
      {popup && (
        <div className="agent-slash" role="listbox" id={listId} aria-label="Slash commands">
          {slash.items.map((c, i) => (
            <button
              type="button"
              key={c.name}
              role="option"
              id={`${listId}-${i}`}
              aria-selected={i === slashIndex}
              className="agent-slash-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(c)}
            >
              <span className="agent-slash-name">/{c.name}</span>
              {c.argumentHint && <span className="agent-slash-hint">{c.argumentHint}</span>}
              {c.description && <span className="agent-slash-desc">{c.description}</span>}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        placeholder={final ? "Session ended" : `Message ${who}, or type / for a command`}
        disabled={final}
        aria-label="Message"
        aria-autocomplete="list"
        aria-controls={popup ? listId : undefined}
        aria-activedescendant={popup ? `${listId}-${slashIndex}` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onKeyDown={onKeyDown}
      />
      <div className="agent-composer-hint">
        <span>{hint}</span>
        {status === "idle" && (
          <button type="button" className="chip" disabled={!canSend} onClick={() => void send()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

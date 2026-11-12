import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  Bot,
  ChevronDown,
  CircleHelp,
  CircleUserRound,
  FilePen,
  FileText,
  ArrowUp,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  PanelRightClose,
  Pin,
  Plug,
  Plus,
  Puzzle,
  Search,
  ShieldAlert,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { Menu, type MenuItem } from "./Menu";
import type { ConfirmOptions, PromptOptions } from "./ModalPrompts";
import { SourceCheckDialog } from "./SourceCheckDialog";
import { SessionRailButton } from "./SessionRail";
import { accountChipDetail, accountChipKind, accountChipWord } from "./agentAccount";
import { Tooltip } from "./Tooltip";
import { renderMarkdown } from "./markdown";
import { useSpellCheck } from "./spellCheckPref";
import { toast } from "./Toasts";
import { cleanLine, cleanText } from "../server/text";
import {
  HISTORY_START,
  agentChat,
  applyCommand,
  canOpenAnother,
  composeRefs,
  defaultSessionName,
  describeAgent,
  filterCommands,
  folderBranch,
  formatCost,
  formatDuration,
  hasModes,
  historyStep,
  isBusy,
  isFinalStatus,
  isHelpCommand,
  loadFolderInfo,
  loadSourceStatus,
  pushPromptHistory,
  readAgentFollow,
  readAgentWorktree,
  readPromptHistory,
  refLabel,
  refreshSource,
  shouldFollow,
  sourceNeedsAttention,
  tabOrder,
  usableAgents,
  useAgentChat,
  useAgentChoices,
  useFolderInfo,
  worktreeTooltip,
  withLocalCommands,
  writeAgentFollow,
  writeAgentWorktree,
  type AgentChatStore,
  type AgentChoices,
  type AgentDescriptor,
  type AgentModelOption,
  type AgentOffer,
  type ChatSessionMeta,
  type ChatStatus,
  type EffortLevel,
  type FolderGitInfo,
  type PermissionMode,
  type Question,
  type RefState,
  type RefreshMode,
  type SessionState,
  type SourceStatus,
  type TranscriptItem,
} from "./agentChat";
import { EFFORT_LABEL, EFFORT_LEVELS, MAX_IMAGES_PER_MESSAGE, MAX_OPEN_SESSIONS } from "../server/agentTypes";
import type { ChatAccount, ChatImage, ImageUpload } from "../server/agentTypes";
import { pastedImageFiles, prepareImage, toUpload, type PendingImage } from "./pastedImages";

/**
 * The coding agent pane (specs/agents/agent-pane.feature.md): a live
 * coding agent chat inside SpecDriven for developers who have a CLI but not
 * Claude Code Desktop. Which agents there are is the plugins' business
 * (specs/agents/agent-plugins.feature.md): every branch in here reads the
 * agent's descriptor — its label, its modes, what it can do — and names
 * none. Header (session, work dir, status, permission mode, Stop, close), a
 * row of tabs with one per open session (at most MAX_OPEN_SESSIONS), a
 * scrolling transcript that follows new output until the reader scrolls
 * up, and a composer with a "/" popup listing the commands the session
 * supports. State lives in src/frontend/agentChat.ts; this file only
 * renders it and forwards what the user does.
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
export function statusLabel(status: ChatStatus, agent: Pick<AgentDescriptor, "label">): string {
  return status === "starting" ? `Starting ${agent.label}…` : STATUS_LABEL[status];
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
  auto: "The agent handles permission decisions",
  default: "Always ask before making changes",
  acceptEdits: "Automatically accept all file edits",
  plan: "Create a plan before making changes",
  bypassPermissions: "Accepts all permissions",
};

/** A mode's one-line description, naming the agent where the mode is its call. */
export function modeDescription(mode: PermissionMode, agent: Pick<AgentDescriptor, "label">): string {
  return mode === "auto" ? `${agent.label} handles permission decisions` : MODE_DESCRIPTION[mode];
}

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

/**
 * The opener of an agent's own Settings section — where its sign-in lives —
 * or undefined when it has none. A plugin's section shares its agent's id.
 */
export type AgentSettingsOpener = (agentId: string) => (() => void) | undefined;

export function AgentPane({
  compact,
  demo,
  codeRepo,
  codeRepos = [],
  dataRepo,
  prompt,
  browseFolder,
  onClose,
  onOpenPlugins,
  agentSettings,
  homeDir = null,
  ghostty = false,
  confirm,
  codeRepoOpen = false,
  current = null,
}: {
  compact: boolean;
  /** Demo mode: every session in here is the simulation (src/server/demoAgent.ts). */
  demo: boolean;
  codeRepo: string | null;
  /** Every code repo the project names (specs/app/project-settings.feature.md), the default first. */
  codeRepos?: readonly string[];
  dataRepo: string | null;
  /** The app's path prompt, for "Other folder…"; absent hides that item. */
  prompt?: (opts: PromptOptions) => Promise<string | null>;
  /** The native folder chooser, offered as Browse… in that prompt. */
  browseFolder?: () => Promise<string | null>;
  onClose: () => void;
  /** Open Settings → Plugins, scrolled to a marketplace plugin when named. */
  onOpenPlugins?: (wanted?: string) => void;
  /** Opens an agent's own Settings section, for one that has it. */
  agentSettings?: AgentSettingsOpener;
  /** The user's home folder, so the session popover writes paths as ~/…. */
  homeDir?: string | null;
  /** "Open worktrees in Ghostty" is on: a worktree session's branch opens
      a Ghostty shell in the worktree (src/server/ghostty.ts). */
  ghostty?: boolean;
  /** The app's confirm dialog: closing the tab of a session at work asks
      first. Absent closes at once. */
  confirm?: (opts: ConfirmOptions) => Promise<boolean>;
  /** A code repository is open in place of the specs (specs/app/code-repo-mode
      .feature.md): `dataRepo` is that repository, and is named so. */
  codeRepoOpen?: boolean;
  /** The feature or file open in the main pane, relative to the open
      folder; null when neither is. It goes with a message unless removed
      (specs/agents/agent-pane.feature.md "The open feature or file goes
      with a message"). */
  current?: string | null;
}) {
  const store = useAgentChat();
  // One list for the pane: it stays as the tabs change.
  const [refState, setRefState] = useState<RefState>(() => ({ follow: readAgentFollow(), pinned: [] }));
  // Files kept from another folder name nothing in this one: a folder
  // switch drops them (specs/agents/agent-pane.feature.md "Switching
  // folders closes the other folder's sessions").
  useEffect(() => {
    setRefState((s) => (s.pinned.length ? { ...s, pinned: [] } : s));
  }, [dataRepo]);
  const refs: RefsControl = {
    current,
    state: refState,
    onChange: (next) => {
      if (next.follow !== refState.follow) writeAgentFollow(next.follow);
      setRefState(next);
    },
  };
  const session = store.activeId ? (store.sessions[store.activeId] ?? null) : null;
  const agent = session ? describeAgent(session.meta.agent, store.agents) : null;
  /** The agent picked on the new-session screen; null is the first usable. */
  const [draftAgentId, setDraftAgentId] = useState<string | null>(null);
  const draftAgent = pickedAgent(store.agents, draftAgentId);
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
  const folders = knownFolders(codeRepo, dataRepo, store.list, codeRepos);
  return (
    <aside
      className={`agent-pane${compact ? " overlay" : ""}`}
      aria-label="Coding agent"
    >
      <AgentHeader
        store={store}
        session={session}
        draftAgent={draftAgent}
        demo={demo}
        homeDir={homeDir}
        onClose={onClose}
        confirm={confirm}
      />
      {(agent ?? draftAgent) && <ConnectionWarning agent={(agent ?? draftAgent)!.id} />}
      {session && agent ? (
        <>
          <Transcript session={session} agent={agent} openSettings={agentSettings?.(agent.id)} />
          <Composer
            session={session}
            agent={agent}
            store={store}
            folders={folders}
            askFolder={askFolder}
            ghostty={ghostty}
            refs={refs}
          />
        </>
      ) : (
        <EmptyState
          // A folder picked for the last folder's new session is not this
          // one's: the screen starts afresh on a switch.
          key={dataRepo ?? ""}
          store={store}
          agentId={draftAgentId}
          onPickAgent={setDraftAgentId}
          demo={demo}
          codeRepo={codeRepo}
          dataRepo={dataRepo}
          codeRepoOpen={codeRepoOpen}
          folders={folders}
          askFolder={askFolder}
          onOpenPlugins={onOpenPlugins}
          agentSettings={agentSettings}
          refs={refs}
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

/** The folder a session works in, as the pane shows it: the folder picked
    for a worktree session, not the worktree. */
export function sessionFolder(m: Pick<ChatSessionMeta, "cwd" | "worktree">): string {
  return m.worktree?.folder ?? m.cwd;
}

/**
 * The folders the pane offers an agent: the code repo, the data repo, then
 * every other folder a session here has worked in, newest first.
 */
export function knownFolders(
  codeRepo: string | null,
  dataRepo: string | null,
  sessions: readonly ChatSessionMeta[],
  codeRepos: readonly string[] = [],
): string[] {
  const used = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(sessionFolder);
  const all = [codeRepo, ...codeRepos, dataRepo, ...used].filter((f): f is string => Boolean(f));
  return [...new Set(all.map(folderPath))];
}

/** The agent a new session starts on: the one picked, while it is usable,
    else the first usable agent. */
export function pickedAgent(all: readonly AgentDescriptor[], id: string | null): AgentDescriptor | null {
  const agents = usableAgents(all);
  return agents.find((a) => a.id === id) ?? agents[0] ?? null;
}

/**
 * The header's account chip — a plug for the API, a person for an account
 * (specs/agents/agent-pane.feature.md S13):
 * what the session's agent reported of its sign-in, else — no session yet,
 * or one still starting — what the agent says a new session would start
 * under (AgentChoices.account), which the pane loads for its model menus
 * anyway. An agent that can say neither yet shows nothing rather than a
 * guess.
 */
function AccountChip({ agent, account }: { agent: string; account?: ChatAccount }) {
  const choices = useAgentChoices(agent);
  const shown = account ?? choices?.account;
  if (!shown) return null;
  const kind = accountChipKind(shown);
  const Icon = kind === "api" ? Plug : CircleUserRound;
  return (
    <Tooltip label={accountChipDetail(shown)}>
      <span
        className="chip muted agent-account"
        data-kind={kind}
        data-billing={shown.billing}
        tabIndex={0}
        aria-label={`${accountChipWord(shown)}: ${shown.label}`}
      >
        <Icon size={14} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}

/**
 * The agent's API did not answer when the app last tried it — on a folder
 * switch, or here (specs/agents/agent-pane.feature.md S14): said under the
 * header, with or without a session, before a turn waits on it. Retry
 * tries again from the open folder; an answer takes the line away.
 */
export function ConnectionWarning({ agent }: { agent: string }) {
  const choices = useAgentChoices(agent);
  const [trying, setTrying] = useState(false);
  const connection = choices?.connection;
  if (!connection || connection.ok) return null;
  const retry = async () => {
    setTrying(true);
    try {
      const next = await agentChat.reconnect(agent);
      if (next?.connection?.ok) toast.success("The API answers again");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTrying(false);
    }
  };
  return (
    <div className="agent-connection" role="alert">
      <span className="agent-connection-text">{connection.detail}</span>
      <button type="button" className="btn btn-secondary" disabled={trying} onClick={() => void retry()}>
        {trying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

function AgentHeader({
  store,
  session,
  draftAgent,
  demo,
  homeDir,
  onClose,
  confirm,
}: {
  store: AgentChatStore;
  session: SessionState | null;
  /** The agent the new-session screen has picked, while no session is open. */
  draftAgent: AgentDescriptor | null;
  demo: boolean;
  homeDir: string | null;
  onClose: () => void;
  confirm?: (opts: ConfirmOptions) => Promise<boolean>;
}) {
  const meta = session?.meta ?? null;
  const agent = meta ? describeAgent(meta.agent, store.agents) : null;
  // The chip speaks for the open session's agent, else the one a new
  // session would start on.
  const chipAgent = meta ? agent : draftAgent;
  const fail = (e: Error) => toast.error(e.message);
  const busy = meta !== null && isBusy(meta.status);
  return (
    <div className="agent-head">
      <Bot size={16} aria-hidden="true" className="agent-head-icon" />
      {/* One header line, as in Claude Code: the session tabs sit here,
          each with its own dot, in place of a title. With nothing open the
          pane just says what it is. */}
      {store.list.length > 0 ? (
        <SessionTabs store={store} confirm={confirm} />
      ) : (
        <span className="agent-session-name">Coding agent</span>
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
      {/* The session popover (specs/agents/agent-pane.feature.md S10): how
          full the context window is, the folder and the branch. */}
      {meta && agent && <SessionRailButton key={meta.id} meta={meta} agent={agent} homeDir={homeDir} />}
      {/* An agent with an account: the plug or the person, always one of the two —
          with or without a session (specs/agents/agent-pane.feature.md S13). */}
      {chipAgent?.capabilities.hasAccount && <AccountChip agent={chipAgent.id} account={meta?.account} />}
      {meta && busy && agent?.capabilities.canInterrupt && (
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

/** What a session's tab says on hover: the agent, its state, its folder. */
export function sessionTabTitle(m: ChatSessionMeta, agents: readonly AgentDescriptor[]): string {
  const a = describeAgent(m.agent, agents);
  return `${m.name}\n${a.label} · ${statusLabel(m.status, a)} · ${sessionFolder(m)}${m.worktree ? ` · worktree on ${m.worktree.branch}` : ""}`;
}

/**
 * One tab per open session (specs/agents/agent-pane.feature.md "Each session
 * has its own tab, at most five") on the pane's header line, in the order
 * they started, then + for a new one. Every session in here runs on whether its tab is shown or not;
 * its dot says how it is doing. While the new-session screen is up it has a
 * tab of its own, with nothing to close. A tab whose agent is at work asks
 * before it closes, since closing ends the session.
 */
export function SessionTabs({
  store,
  confirm,
}: {
  store: AgentChatStore;
  confirm?: (opts: ConfirmOptions) => Promise<boolean>;
}) {
  const tabs = tabOrder(store.list);
  const drafting = store.activeId === null;
  const room = canOpenAnother(store);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const close = async (m: ChatSessionMeta) => {
    if (isBusy(m.status) && confirm) {
      const a = describeAgent(m.agent, store.agents);
      const ok = await confirm({
        title: "End this session?",
        body: `${a.label} is still working in “${m.name}”. Ending it stops the agent.`,
        confirmLabel: "End session",
        danger: true,
      });
      if (!ok) return;
    }
    await agentChat.end(m.id).catch((e: Error) => toast.error(e.message));
  };
  const focusTab = (id: string | undefined) => {
    if (!id) return;
    agentChat.setActive(id);
    refs.current.get(id)?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>, at: number) => {
    const m = tabs[at];
    if (!m) return;
    if (e.key === "ArrowRight") focusTab(tabs[(at + 1) % tabs.length]?.id);
    else if (e.key === "ArrowLeft") focusTab(tabs[(at - 1 + tabs.length) % tabs.length]?.id);
    else if (e.key === "Home") focusTab(tabs[0]?.id);
    else if (e.key === "End") focusTab(tabs[tabs.length - 1]?.id);
    else if (e.key === "Delete") void close(m);
    else if (e.key === "Enter" || e.key === " ") agentChat.setActive(m.id);
    else return;
    e.preventDefault();
  };
  const full = `At most ${MAX_OPEN_SESSIONS} sessions — close one to start another`;
  return (
    <>
      <div className="agent-tablist" role="tablist" aria-label="Sessions">
        {tabs.map((m, at) => {
          const selected = m.id === store.activeId;
          return (
            <div
              key={m.id}
              ref={(el) => {
                if (el) refs.current.set(m.id, el);
                else refs.current.delete(m.id);
              }}
              className="agent-tab"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              title={sessionTabTitle(m, store.agents)}
              data-status={m.status}
              onClick={() => agentChat.setActive(m.id)}
              onAuxClick={(e) => {
                // Middle-click closes, as a browser tab does.
                if (e.button === 1) {
                  e.preventDefault();
                  void close(m);
                }
              }}
              onKeyDown={(e) => onKey(e, at)}
            >
              <span className="agent-dot" data-status={m.status} aria-hidden="true" />
              <span className="agent-tab-name">{m.name}</span>
              <button
                type="button"
                className="agent-tab-close"
                aria-label={`Close ${m.name}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  void close(m);
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {drafting && (
          <div className="agent-tab draft" role="tab" aria-selected tabIndex={0}>
            <Plus size={12} aria-hidden="true" className="agent-tab-icon" />
            <span className="agent-tab-name">New session</span>
          </div>
        )}
      </div>
      <Tooltip label={room ? "New session" : full}>
        <button
          type="button"
          className="ibtn agent-tab-new"
          aria-label="New session"
          aria-disabled={!room}
          onClick={() => {
            if (room) agentChat.setActive(null);
          }}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </Tooltip>
    </>
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

/** The mode menu: one item per mode the agent declares, numbered from 1,
    the agent's default badged. */
export function modeItems(
  agent: AgentDescriptor,
  current: PermissionMode,
  onSelect: (mode: PermissionMode) => void,
): MenuItem[] {
  const start = agent.defaultPermissionMode;
  return agent.capabilities.permissionModes.map((m, i) => ({
    id: m,
    label:
      m === start ? (
        <>
          {MODE_LABEL[m]} <span className="menu-badge">Default</span>
        </>
      ) : (
        MODE_LABEL[m]
      ),
    description: modeDescription(m, agent),
    keys: String(i + 1),
    checked: m === current,
    onSelect: () => onSelect(m),
  }));
}

// --- The composer bar (specs/agents/agent-pane.feature.md "The composer bar
// picks the folder, model, effort and mode") ----------------------------------

/** What each effort level means, under its name in the menu. */
export const EFFORT_DESCRIPTION: Record<EffortLevel, string> = {
  low: "Quick answers, little thinking",
  medium: "Balanced speed and thinking",
  high: "Thinks things through",
  xhigh: "Longer thinking for hard problems",
  max: "The most thinking the model allows",
};

/** The menu row a model value stands for: by its value, or the id an alias resolves to. */
export function modelRow(choices: AgentChoices | null, model: string | null | undefined): AgentModelOption | undefined {
  if (!choices || !model) return undefined;
  const exact = choices.models.find((m) => m.value === model);
  if (exact) return exact;
  // Several aliases can stand for one id (Claude's "default" and "opus"):
  // the one new sessions start on wins, else the first.
  const resolved = choices.models.filter((m) => m.resolvedModel === model);
  return resolved.find((m) => m.value === choices.model) ?? resolved[0];
}

/** A model as the bar names it: its row's name, else the value, else "Default". */
export function modelLabel(choices: AgentChoices | null, model: string | null | undefined): string {
  return modelRow(choices, model)?.displayName ?? model ?? "Default model";
}

/**
 * The model menu: the agent's own default first (while no model is set),
 * then every model it offers, the current one checked and the one new
 * sessions start on badged.
 */
export function modelItems(
  choices: AgentChoices,
  current: string | null | undefined,
  agent: Pick<AgentDescriptor, "label">,
  onSelect: (model: string | null) => void,
): MenuItem[] {
  const currentRow = modelRow(choices, current);
  const defaultRow = modelRow(choices, choices.model);
  const items: MenuItem[] = choices.models.map((m, i) => ({
    id: `model:${m.value}`,
    label:
      m === defaultRow ? (
        <>
          {m.displayName} <span className="menu-badge">Default</span>
        </>
      ) : (
        m.displayName
      ),
    // A description that only repeats the name (a proxy's rows) is left off.
    ...(m.description && m.description !== m.displayName ? { description: m.description } : {}),
    ...(i < 9 ? { keys: String(i + 1) } : {}),
    checked: m === currentRow,
    onSelect: () => onSelect(m.value),
  }));
  // A model the agent reports that is not on its list still shows, checked.
  if (current && !currentRow) {
    items.unshift({ id: `model:${current}`, label: current, checked: true, onSelect: () => onSelect(current) });
  }
  if (choices.model === null) {
    items.unshift({
      id: "model:default",
      label: "Default model",
      description: `Whatever ${agent.label} picks on its own`,
      checked: !current,
      onSelect: () => onSelect(null),
    });
  }
  return items;
}

/** The levels a model takes: its row's, else every level (the agent
    lowers one its model does not take). */
export function effortsFor(choices: AgentChoices | null, model: string | null | undefined): readonly EffortLevel[] {
  return modelRow(choices, model ?? choices?.model)?.efforts ?? EFFORT_LEVELS;
}

/** The effort menu: the agent's own default, then each level the model takes. */
export function effortItems(
  efforts: readonly EffortLevel[],
  current: EffortLevel | null | undefined,
  agent: Pick<AgentDescriptor, "label">,
  onSelect: (effort: EffortLevel | null) => void,
): MenuItem[] {
  return [
    {
      id: "effort:default",
      label: "Default",
      description: `${agent.label} decides for the model`,
      checked: !current,
      onSelect: () => onSelect(null),
    },
    ...efforts.map((e, i) => ({
      id: `effort:${e}`,
      label: EFFORT_LABEL[e],
      description: EFFORT_DESCRIPTION[e],
      keys: String(i + 1),
      checked: e === current,
      onSelect: () => onSelect(e),
    })),
  ];
}

/** A session name from the first message: its first line, cut to fit the menu. */
export function nameFromMessage(text: string): string {
  const line = cleanLine(text.split("\n").find((l) => l.trim()) ?? "");
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/** One chip in the composer bar, with its menu opening above it. */
function BarPicker({
  name,
  text,
  icon,
  ariaLabel,
  tooltip,
  heading,
  items,
  disabled,
  align = "left",
  onOpen,
}: {
  name: string;
  text: ReactNode;
  icon?: ReactNode;
  ariaLabel: string;
  tooltip: string;
  heading: string;
  items: MenuItem[];
  disabled?: boolean;
  align?: "left" | "right";
  /** Called as the menu opens, to refresh what it lists. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-bar-picker" data-picker={name}>
      <Tooltip label={tooltip}>
        <button
          type="button"
          className="agent-bar-chip"
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => {
            if (!open) onOpen?.();
            setOpen((o) => !o);
          }}
        >
          {icon}
          <span className="agent-bar-chip-text">{text}</span>
          <ChevronDown size={12} aria-hidden="true" className="agent-bar-chevron" />
        </button>
      </Tooltip>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        label={ariaLabel}
        heading={heading}
        items={items}
        className={`agent-bar-menu agent-bar-menu-${align} agent-bar-menu-${name}`}
        containerSelector={`.agent-bar-picker[data-picker="${name}"]`}
      />
    </div>
  );
}

/** The folder chip: a folder's name, its path in the tooltip. */
function FolderPicker({
  folder,
  folders,
  askFolder,
  heading,
  disabled,
  onSelect,
}: {
  folder: string;
  folders: readonly string[];
  askFolder?: (initial: string) => Promise<string | null>;
  heading: string;
  disabled?: boolean;
  onSelect: (folder: string) => void;
}) {
  return (
    <BarPicker
      name="folder"
      text={basename(folder)}
      icon={<Folder size={13} aria-hidden="true" />}
      ariaLabel={`Folder: ${folder}`}
      tooltip={folder}
      heading={heading}
      items={folderItems(folders, folder, askFolder, onSelect)}
      disabled={disabled}
    />
  );
}

/**
 * The branch the folder has checked out, between the folder and the Worktree
 * box (specs/agents/agent-pane.feature.md "Footer cmponents"): a fact, not a
 * menu. Nothing for a folder that is in no git repo, or while that is asked.
 */
function FolderBranch({ info }: { info: FolderGitInfo | null }) {
  const branch = folderBranch(info);
  if (!branch) return null;
  return (
    <Tooltip label={branch.tooltip}>
      <span className="agent-bar-fact agent-bar-branch" aria-label={`Branch: ${branch.name}`} tabIndex={0}>
        <GitBranch size={12} aria-hidden="true" />
        <span className="agent-bar-chip-text">{branch.name}</span>
      </span>
    </Tooltip>
  );
}

/**
 * The Worktree checkbox beside the folder on the new-session screen, as in
 * Claude Desktop: checked, the session gets a git worktree of its own on a
 * new branch. Greyed out, with the reason, where the folder cannot have one.
 */
function WorktreeToggle({
  checked,
  info,
  onChange,
}: {
  checked: boolean;
  /** The folder's git facts; null while they load. */
  info: FolderGitInfo | null;
  onChange: (on: boolean) => void;
}) {
  const can = info?.canWorktree === true;
  // Named first: a tight bar shows the box with an icon, not the word.
  const tooltip = worktreeTooltip(info);
  return (
    <Tooltip label={tooltip}>
      <label className={`agent-bar-check${can ? "" : " is-disabled"}`}>
        <input
          type="checkbox"
          checked={checked && can}
          disabled={!can}
          aria-label="Worktree"
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        <GitBranch size={12} aria-hidden="true" className="agent-bar-check-icon" />
        <span className="agent-bar-check-text">Worktree</span>
      </label>
    </Tooltip>
  );
}

/**
 * A worktree session's branch, beside its folder: a fact, not a menu. With
 * "Open worktrees in Ghostty" on (specs/agents/agent-pane.feature.md "A
 * worktree session opens in a Ghostty shell") it is a button: a click opens
 * a Ghostty shell in the folder the agent works in, and what stops that —
 * Ghostty missing, the worktree gone — is toasted.
 */
function WorktreeBranch({
  worktree,
  onOpenShell,
}: {
  worktree: NonNullable<ChatSessionMeta["worktree"]>;
  /** Opens the worktree in Ghostty; absent leaves the branch a label. */
  onOpenShell?: () => void;
}) {
  const from = worktree.base ? ` off ${worktree.base}` : "";
  const facts = `branch ${worktree.branch}${from}`;
  const content = (
    <>
      <GitBranch size={12} aria-hidden="true" />
      <span className="agent-bar-chip-text">{worktree.branch}</span>
    </>
  );
  if (!onOpenShell) {
    return (
      <Tooltip label={`Worktree at ${worktree.path} · ${facts}`}>
        <span className="agent-bar-fact agent-bar-branch" aria-label={`Worktree branch: ${worktree.branch}`}>
          {content}
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={`Open a Ghostty shell in the worktree · ${worktree.cwd} · ${facts}`}>
      <button
        type="button"
        className="agent-bar-chip agent-bar-branch"
        aria-label={`Worktree branch: ${worktree.branch} — open in Ghostty`}
        onClick={onOpenShell}
      >
        {content}
      </button>
    </Tooltip>
  );
}

/** The model, effort and mode chips, right of the folder. */
function ModelEffortMode({
  agent,
  choices,
  model,
  effort,
  mode,
  canPickModel,
  disabled,
  onModel,
  onEffort,
  onMode,
}: {
  agent: AgentDescriptor;
  choices: AgentChoices | null;
  model: string | null | undefined;
  effort: EffortLevel | null | undefined;
  mode: PermissionMode;
  canPickModel: boolean;
  disabled: boolean;
  onModel: (model: string | null) => void;
  onEffort: (effort: EffortLevel | null) => void;
  onMode: (mode: PermissionMode) => void;
}) {
  const efforts = effortsFor(choices, model);
  return (
    <>
      {choices && canPickModel ? (
        <BarPicker
          name="model"
          text={modelLabel(choices, model)}
          ariaLabel={`Model: ${modelLabel(choices, model)}`}
          tooltip="Model — new sessions start on the one you pick"
          heading="Model"
          items={modelItems(choices, model, agent, onModel)}
          disabled={disabled}
          align="right"
          onOpen={() => void agentChat.loadChoices(agent.id).catch(() => undefined)}
        />
      ) : (
        model && (
          <Tooltip label={`${agent.label} runs on ${model}`}>
            <span className="agent-bar-fact" tabIndex={0}>
              {modelLabel(choices, model)}
            </span>
          </Tooltip>
        )
      )}
      {choices && agent.capabilities.effort && efforts.length > 0 && (
        <BarPicker
          name="effort"
          text={effort ? EFFORT_LABEL[effort] : "Effort"}
          ariaLabel={`Effort: ${effort ? EFFORT_LABEL[effort] : "default"}`}
          tooltip="How hard the model thinks — new sessions start at the one you pick"
          heading="Effort"
          items={effortItems(efforts, effort, agent, onEffort)}
          disabled={disabled}
          align="right"
        />
      )}
      {hasModes(agent) ? (
        <BarPicker
          name="mode"
          text={MODE_LABEL[mode]}
          ariaLabel={`Permission mode: ${MODE_LABEL[mode]}`}
          tooltip="Permission mode"
          heading="Mode"
          items={modeItems(agent, mode, onMode)}
          disabled={disabled}
          align="right"
        />
      ) : (
        // An agent with no permission protocol (Pi runs its own tools):
        // there is no mode to offer, and the bar says as much.
        <Tooltip label={agent.capabilities.noPermissionsNote ?? `${agent.label} has no permission modes`}>
          <span className="agent-bar-fact" tabIndex={0}>
            No permission gate
          </span>
        </Tooltip>
      )}
    </>
  );
}

/**
 * What the pane shows when no agent can start (specs/agents/agent-plugins
 * .feature.md "The pane offers to install an agent plugin"): agents come as
 * plugins, so the way out is Settings → Plugins — named plainly when there
 * is nothing, per offer when the marketplace has one, and with the
 * provider's own words when a plugin is there but its CLI is not — with the
 * way to its own Settings section when it has one, where it can be set up
 * (Claude: the email sign-in, which fetches Claude Code). Nothing installs
 * from here; the Plugins page has the consent flow.
 */
export function AgentEmptyGuide({
  agents,
  offers,
  onOpenPlugins,
  agentSettings,
}: {
  agents: readonly AgentDescriptor[];
  offers: readonly AgentOffer[];
  onOpenPlugins?: (wanted?: string) => void;
  agentSettings?: AgentSettingsOpener;
}) {
  const open = (wanted?: string) =>
    onOpenPlugins ? (
      <button type="button" className="primary-action" onClick={() => onOpenPlugins(wanted)}>
        <Puzzle size={14} aria-hidden="true" /> Open Plugins
      </button>
    ) : null;
  if (agents.length === 0 && offers.length === 0) {
    return (
      <div className="agent-empty" data-guide="none">
        <h3>Coding agent</h3>
        <p>Coding agents come as plugins. Install one from Settings → Plugins, and the pane will offer it here.</p>
        {open()}
      </div>
    );
  }
  return (
    <div className="agent-empty" data-guide="offers">
      <h3>Coding agent</h3>
      {agents.map((a) => {
        const settings = agentSettings?.(a.id);
        return (
          <p key={a.id} className="agent-guide-row">
            {a.missingMessage}
            {settings && (
              <>
                {" "}
                <button type="button" className="agent-folder-change" onClick={settings}>
                  Set up {a.label}
                </button>
              </>
            )}
          </p>
        );
      })}
      {offers.map((o) => (
        <p key={o.plugin} className="agent-guide-row">
          {o.cliFound ? (
            <>
              Install the {o.label} agent plugin to chat with {o.label} here.{" "}
              {onOpenPlugins && (
                <button type="button" className="agent-folder-change" onClick={() => onOpenPlugins(o.plugin)}>
                  Install the {o.label} agent plugin
                </button>
              )}
            </>
          ) : (
            <>
              The {o.label} agent plugin needs the <code>{o.cli}</code> command — install that first, then the
              plugin from Settings → Plugins.
            </>
          )}
        </p>
      ))}
      {open()}
    </div>
  );
}

function EmptyState({
  store,
  agentId,
  onPickAgent,
  demo,
  codeRepo,
  dataRepo,
  codeRepoOpen = false,
  folders,
  askFolder,
  onOpenPlugins,
  agentSettings,
  refs,
}: {
  store: AgentChatStore;
  /** The agent picked here (kept by the pane, so its header can name it); null is the first. */
  agentId: string | null;
  onPickAgent: (id: string) => void;
  demo: boolean;
  codeRepo: string | null;
  dataRepo: string | null;
  codeRepoOpen?: boolean;
  folders: readonly string[];
  askFolder?: (initial: string) => Promise<string | null>;
  onOpenPlugins?: (wanted?: string) => void;
  agentSettings?: AgentSettingsOpener;
  refs?: RefsControl;
}) {
  // Only the agents whose CLI is on PATH; with one, there is nothing to pick.
  const agents = usableAgents(store.agents);
  /** A folder picked here; null keeps the default (code repo, else data repo). */
  const [folder, setFolder] = useState<string | null>(null);
  /** A mode picked here; null is the agent's default. */
  const [mode, setMode] = useState<PermissionMode | null>(null);
  /** Whether the session gets a worktree: the last pick, kept on this device. */
  const [worktree, setWorktree] = useState(readAgentWorktree);
  /** A start held while the source-check dialog is open; null when none is. */
  const [pending, setPending] = useState<{ status: SourceStatus; text: string; images: ImageUpload[]; refs: string[] } | null>(null);
  const picked = pickedAgent(store.agents, agentId);
  const choices = useAgentChoices(picked?.id ?? null);
  const defaultDir = codeRepo ?? dataRepo;
  const workDir = folder ?? defaultDir;
  // The code repo a session start checks against its remote: the project's
  // code repo, or the repository open in code repository mode (which arrives
  // as `dataRepo`, nothing being synced there). Never a specifications folder.
  const checkedRepo = codeRepo ?? (codeRepoOpen ? dataRepo : null);
  const folderInfo = useFolderInfo(picked ? workDir : null);
  const inWorktree = worktree && folderInfo?.canWorktree === true;
  // Every open tab holds a slot; at the cap a new session waits for one to close.
  const room = canOpenAnother(store);
  if (!picked) {
    return (
      <AgentEmptyGuide
        agents={store.agents}
        offers={store.agentOffers}
        onOpenPlugins={onOpenPlugins}
        agentSettings={agentSettings}
      />
    );
  }
  const startMode = mode ?? picked.defaultPermissionMode;
  const fail = (e: Error) => toast.error(e.message);
  // A model or effort picked before the session is what the agent's next
  // sessions start on (the pick is the default, as it is mid-session).
  const saveDefault = (patch: { model?: string | null; effort?: EffortLevel | null }) =>
    void agentChat.saveDefaults(picked.id, patch).catch(fail);
  const doStart = (text: string, images: ImageUpload[], sentRefs: string[] = []) =>
    agentChat.createSession({
      name: nameFromMessage(text) || defaultSessionName(),
      agent: picked.id,
      prompt: text,
      ...(images.length ? { images } : {}),
      ...(sentRefs.length ? { refs: sentRefs } : {}),
      ...(folder && folder !== defaultDir ? { cwd: folder } : {}),
      ...(inWorktree ? { worktree: true } : {}),
      ...(hasModes(picked) ? { permissionMode: startMode } : {}),
      ...(choices?.model ? { model: choices.model } : {}),
      ...(choices?.effort && picked.capabilities.effort ? { effort: choices.effort } : {}),
    });
  // Before a session on the code repo (the app under development), check how its
  // branch stands against the remote of record so new work branches from the
  // right place (specs/agents/agent-plugins.feature.md "A coding session should
  // check that source is up to date"). A worktree session has no dialog: the
  // server itself brings main level with origin before the worktree branches
  // off it, or refuses and says why (src/server/agentWorktree.ts). The data
  // repo syncs on its own, so it is not checked here; a repository open in
  // code repository mode is (specs/app/code-repo-mode.feature.md).
  const start = async (text: string, images: ImageUpload[], sentRefs: string[] = []) => {
    if (workDir !== checkedRepo || !checkedRepo || inWorktree) {
      await doStart(text, images, sentRefs);
      return;
    }
    const status = await loadSourceStatus(checkedRepo);
    if (!sourceNeedsAttention(status)) {
      await doStart(text, images, sentRefs);
      return;
    }
    // Hold the message until the user answers the dialog.
    setPending({ status, text, images, refs: sentRefs });
  };
  const left = (
    <>
      {agents.length > 1 && (
        <BarPicker
          name="agent"
          text={picked.label}
          icon={<Bot size={13} aria-hidden="true" />}
          ariaLabel={`Agent: ${picked.label}`}
          tooltip="The coding agent this session runs"
          heading="Agent"
          items={agents.map((a) => ({
            id: `agent:${a.id}`,
            label: a.label,
            description: a.description,
            checked: a.id === picked.id,
            onSelect: () => {
              onPickAgent(a.id);
              setMode(null);
            },
          }))}
        />
      )}
      {workDir && (
        <FolderPicker
          folder={workDir}
          folders={folders}
          askFolder={askFolder}
          heading="Folder · where the agent works"
          onSelect={setFolder}
        />
      )}
      {workDir && <FolderBranch info={folderInfo} />}
      {workDir && (
        <WorktreeToggle
          checked={worktree}
          info={folderInfo}
          onChange={(on) => {
            setWorktree(on);
            writeAgentWorktree(on);
          }}
        />
      )}
    </>
  );
  const right = (
    <ModelEffortMode
      agent={picked}
      choices={choices}
      model={choices?.model}
      effort={choices?.effort}
      mode={startMode}
      canPickModel
      disabled={false}
      onModel={(model) => saveDefault({ model })}
      onEffort={(effort) => saveDefault({ effort })}
      onMode={setMode}
    />
  );
  return (
    <div className="agent-empty">
      <div className="agent-empty-intro">
        <h3>New {picked.label} session</h3>
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
            Your first message starts a live {picked.label} session, run by SpecDriven
            {workDir === codeRepo || (codeRepoOpen && workDir === dataRepo)
              ? " in the code repo"
              : workDir === dataRepo
                ? " in the data repo"
                : ""}
            {inWorktree ? ", in a git worktree of its own on a new branch" : ""}.
          </p>
        )}
        {!room && (
          <p className="agent-empty-full" role="status">
            {MAX_OPEN_SESSIONS} sessions are open — close one to start another.
          </p>
        )}
      </div>
      <ComposerBox
        listKey="new"
        commands={[]}
        placeholder={`Describe a task for ${picked.label}`}
        disabled={!room}
        canSend={room}
        autoFocus
        hint="Enter to start · Shift+Enter for a new line · ↑ for sent messages"
        refs={refs}
        left={left}
        right={right}
        imagesFrom={{ label: picked.label, canRead: picked.capabilities.images === true }}
        onSend={start}
      />
      {pending && checkedRepo && (
        <SourceCheckDialog
          status={pending.status}
          onClose={() => setPending(null)}
          onStartAnyway={() => {
            const held = pending;
            setPending(null);
            void doStart(held.text, held.images, held.refs).catch(fail);
          }}
          onRefresh={async (mode: RefreshMode) => {
            try {
              const result = await refreshSource(checkedRepo, mode);
              if (!result.ok) {
                toast.error(result.message);
                return false;
              }
            } catch (e) {
              fail(e as Error);
              return false;
            }
            const held = pending;
            setPending(null);
            void doStart(held.text, held.images, held.refs).catch(fail);
            return true;
          }}
        />
      )}
    </div>
  );
}

function Transcript({
  session,
  agent,
  openSettings,
}: {
  session: SessionState;
  agent: AgentDescriptor;
  openSettings?: () => void;
}) {
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
        <p className="agent-note">{statusLabel(session.meta.status, agent)}</p>
      )}
      {items.map((item) => (
        <TranscriptRow key={item.id} item={item} agent={agent} onAnswer={answer} openSettings={openSettings} />
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
  agent = describeAgent("claude"),
  onAnswer,
  openSettings,
}: {
  item: TranscriptItem;
  agent?: AgentDescriptor;
  onAnswer?: (answer: Answer) => void;
  /** The agent's own Settings section, offered under a sign-in failure. */
  openSettings?: () => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="agent-msg user">
          {item.images && item.images.length > 0 && <MessageImages images={item.images} />}
          {item.text}
          {item.refs && item.refs.length > 0 && (
            <div className="agent-msg-refs" aria-label="Context">
              {item.refs.map((path) => (
                <span key={path} title={path}>
                  <FileText size={11} aria-hidden="true" />
                  {refLabel(path)}
                </span>
              ))}
            </div>
          )}
        </div>
      );
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
      return <QuestionCard item={item} agent={agent} onAnswer={onAnswer} />;
    case "result": {
      // Why it failed is read from the result even when the reply already
      // said it and the footer repeats nothing (agentChat.ts `failure`).
      const loginHint =
        item.isError && /not logged in|no api key|unauthorized/i.test(item.failure ?? item.text ?? "");
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
          {loginHint && agent.loginHint && (
            <span className="agent-err-text">
              {agent.loginHint.text}
              {agent.loginHint.command && (
                <>
                  {" "}
                  <code>{agent.loginHint.command}</code>
                </>
              )}
              {openSettings && (
                <>
                  {" "}
                  <button type="button" className="agent-folder-change" onClick={openSettings}>
                    Open Settings
                  </button>
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

/** The images a message carried; one opens full size over the pane, and a
    click or Escape closes it. */
function MessageImages({ images }: { images: ChatImage[] }) {
  const [open, setOpen] = useState<ChatImage | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  return (
    <>
      <div className="agent-msg-images">
        {images.map((image, i) => (
          <button
            type="button"
            key={image.id}
            className="agent-msg-image"
            aria-label={`Open ${image.name ?? `image ${i + 1}`}`}
            onClick={() => setOpen(image)}
          >
            <img src={image.url} alt={image.name ?? `Pasted image ${i + 1}`} loading="lazy" />
          </button>
        ))}
      </div>
      {open && (
        <div className="agent-image-zoom" role="dialog" aria-label={open.name ?? "Pasted image"} onClick={() => setOpen(null)}>
          <img src={open.url} alt={open.name ?? "Pasted image"} />
        </div>
      )}
    </>
  );
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
  agent,
  onAnswer,
}: {
  item: Extract<TranscriptItem, { kind: "permission" }>;
  agent: AgentDescriptor;
  onAnswer?: (answer: Answer) => void;
}) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const spellCheck = useSpellCheck();
  const done = item.resolved;
  const who = agent.label;
  const remember = agent.capabilities.rememberPermissions;
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
            spellCheck={spellCheck}
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
          {item.suggestions.length > 0 && remember !== "none" && (
            <button
              type="button"
              title={
                remember === "session"
                  ? `Also allow this for the rest of the session, so ${who} stops asking for it`
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
  agent,
  onAnswer,
}: {
  item: Extract<TranscriptItem, { kind: "question" }>;
  agent: AgentDescriptor;
  onAnswer?: (answer: Answer) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const spellCheck = useSpellCheck();
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
    <div className="agent-card" role="group" aria-label={`${agent.label} has a question`}>
      <div className="agent-card-title">
        <CircleHelp size={14} aria-hidden="true" />
        {agent.label} has a question
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
            spellCheck={spellCheck}
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

/**
 * The message box both a session and the new-session screen use: the
 * textarea with its "/" popup, and the bar under it (`bar`), with Send at
 * its end. `onSend` gets the cleaned text; a rejection puts it back.
 */
/** The pane's context list, as a message box reads and changes it. */
export interface RefsControl {
  current: string | null;
  state: RefState;
  onChange: (next: RefState) => void;
}

export function ComposerBox({
  listKey,
  commands,
  placeholder,
  disabled,
  canSend,
  hint,
  left,
  right,
  autoFocus,
  imagesFrom,
  refs,
  onSend,
}: {
  listKey: string;
  commands: SessionState["commands"];
  placeholder: string;
  disabled: boolean;
  /** Whether a message may go now (the agent is not mid-turn). */
  canSend: boolean;
  hint: string;
  /** The bar's left side: the folder (and the agent, before a session). */
  left: ReactNode;
  /** The bar's right side, before Send: model, effort, mode. */
  right: ReactNode;
  autoFocus?: boolean;
  /** The agent that would read pasted images; null when it reads none, so
      a pasted image is refused with its name. */
  imagesFrom: { label: string; canRead: boolean };
  /** The files that go with the message; absent, none do. */
  refs?: RefsControl;
  onSend: (text: string, images: ImageUpload[], refs: string[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  // Sent messages, for Up and Down (specs/agents/agent-pane.feature.md "Up
  // and Down recall sent messages"), and where the box stands among them.
  const [entries, setEntries] = useState(readPromptHistory);
  const [cursor, setCursor] = useState(HISTORY_START);
  // The pane's own answer to /help, shown over the box until dismissed.
  const [help, setHelp] = useState(false);
  const all = withLocalCommands(commands);
  const context = refs && !disabled ? composeRefs(refs.current, refs.state) : null;
  // Pasted images (specs/agents/agent-pane.feature.md "Paste an image into
  // the message"), and how many are still being read.
  const [images, setImages] = useState<PendingImage[]>([]);
  const [reading, setReading] = useState(0);
  // Spell check (src/frontend/spellCheckPref.ts): a message is prose.
  const spellCheck = useSpellCheck();
  const [caret, setCaret] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const slash = filterCommands(all, draft, caret);
  const popup = slash.active && !dismissed && slash.items.length > 0;
  useEffect(() => {
    setSlashIndex(0);
  }, [slash.query]);
  // A recalled message is not a "/" being typed: its popup stays shut.
  const recalled = useRef(false);
  useEffect(() => {
    setDismissed(recalled.current);
    recalled.current = false;
  }, [draft]);
  // Grow with the text, up to a share of the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [draft]);
  const ready = canSend && reading === 0 && (draft.trim().length > 0 || images.length > 0);
  const send = async () => {
    // Blank lines around the message go; an indented first line (a code
    // block) keeps its indentation (specs/ui/ui.feature.md "User-entered
    // text is cleaned up").
    const text = cleanText(draft);
    // /help is the pane's own: it needs no agent, so it answers even
    // while one is mid-turn.
    if (isHelpCommand(text) && images.length === 0) {
      setDraft("");
      setCursor(HISTORY_START);
      setHelp(true);
      return;
    }
    if ((!text.trim() && images.length === 0) || !canSend || reading > 0) return;
    const sent = images;
    setDraft("");
    setImages([]);
    setHelp(false);
    setCursor(HISTORY_START);
    if (text.trim()) setEntries(pushPromptHistory(text));
    try {
      await onSend(text, sent.map(toUpload), context?.refs.map((r) => r.path) ?? []);
    } catch (e) {
      setDraft(text);
      setImages(sent);
      toast.error((e as Error).message);
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pastedImageFiles(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    if (!imagesFrom.canRead) {
      toast.error(`${imagesFrom.label} cannot read images — paste text instead`);
      return;
    }
    const room = MAX_IMAGES_PER_MESSAGE - images.length;
    if (room <= 0) {
      toast.error(`At most ${MAX_IMAGES_PER_MESSAGE} images go with one message`);
      return;
    }
    if (files.length > room) toast.error(`Only ${room} more image${room === 1 ? "" : "s"} fit this message`);
    for (const file of files.slice(0, room)) {
      setReading((n) => n + 1);
      prepareImage(file)
        .then((image) => setImages((list) => [...list, image].slice(0, MAX_IMAGES_PER_MESSAGE)))
        .catch((err: Error) => toast.error(err.message))
        .finally(() => setReading((n) => n - 1));
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
    if (e.key === "Escape" && help) {
      e.preventDefault();
      e.stopPropagation();
      setHelp(false);
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Only from the box's edge: inside a message of several lines the
      // arrows move the caret, as they always did. Down recalls nothing
      // until Up has (historyStep answers null).
      const el = e.currentTarget;
      const collapsed = el.selectionStart === el.selectionEnd;
      const up = e.key === "ArrowUp";
      const atEdge = up
        ? !draft.slice(0, el.selectionStart).includes("\n")
        : !draft.slice(el.selectionEnd).includes("\n");
      const step = collapsed && atEdge ? historyStep(entries, cursor, up ? "up" : "down", draft) : null;
      if (step) {
        e.preventDefault();
        recalled.current = true;
        setDraft(step.draft);
        setCursor(step.cursor);
        setCaret(step.draft.length);
        requestAnimationFrame(() => ref.current?.setSelectionRange(step.draft.length, step.draft.length));
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const listId = `agent-slash-${listKey}`;
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
      {help && !popup && (
        <div className="agent-help" role="note" aria-label="Commands">
          <div className="agent-help-head">
            <span>Commands</span>
            <button type="button" className="agent-help-close" aria-label="Close help" onClick={() => setHelp(false)}>
              <X size={12} aria-hidden="true" />
            </button>
          </div>
          <ul>
            {[...all]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => (
                <li key={c.name}>
                  <span className="agent-slash-name">/{c.name}</span>
                  {c.argumentHint && <span className="agent-slash-hint">{c.argumentHint}</span>}
                  {c.description && <span className="agent-help-desc">{c.description}</span>}
                </li>
              ))}
          </ul>
          {commands.length === 0 && <p>The agent's own commands are listed once a session has started.</p>}
          <p>Enter sends · Shift+Enter starts a new line · ↑ and ↓ recall sent messages · Esc closes this</p>
        </div>
      )}
      <div className="agent-composer-box" data-disabled={disabled || undefined}>
        {refs && context && (context.refs.length > 0 || context.offer !== null) && (
          <ul className="agent-refs" aria-label="Context">
            {context.refs.map(({ path, auto }) => {
              const label = refLabel(path);
              return (
                <li key={path} className="agent-ref" data-auto={auto || undefined}>
                  <FileText size={12} aria-hidden="true" />
                  <span className="agent-ref-name" title={auto ? `${path} — the open file, sent with your message` : path}>
                    {label}
                  </span>
                  {auto && (
                    <Tooltip label="Keep in context when you open something else">
                      <button
                        type="button"
                        className="agent-ref-btn"
                        aria-label={`Keep ${label} in context`}
                        onClick={() => refs.onChange({ ...refs.state, pinned: [...refs.state.pinned, path] })}
                      >
                        <Pin size={11} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  )}
                  <button
                    type="button"
                    className="agent-ref-btn"
                    aria-label={`Remove ${label} from context`}
                    onClick={() =>
                      refs.onChange({
                        // Removing the open file, pinned or not, stops following it.
                        follow: path === refs.current ? false : refs.state.follow,
                        pinned: refs.state.pinned.filter((p) => p !== path),
                      })
                    }
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
            {context.offer !== null && (
              <li>
                <button
                  type="button"
                  className="agent-ref agent-ref-offer"
                  aria-label={`Add ${refLabel(context.offer)} to context`}
                  title={context.offer}
                  onClick={() => refs.onChange({ ...refs.state, follow: true })}
                >
                  <Plus size={12} aria-hidden="true" />
                  <span className="agent-ref-name">{refLabel(context.offer)}</span>
                </button>
              </li>
            )}
          </ul>
        )}
        {(images.length > 0 || reading > 0) && (
          <ul className="agent-attachments" aria-label="Pasted images">
            {images.map((image, i) => (
              <li key={image.key} className="agent-attachment">
                <img src={image.previewUrl} alt={image.name ?? `Pasted image ${i + 1}`} />
                <button
                  type="button"
                  className="agent-attachment-remove"
                  aria-label={`Remove ${image.name ?? `pasted image ${i + 1}`}`}
                  onClick={() => setImages((list) => list.filter((x) => x.key !== image.key))}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </li>
            ))}
            {reading > 0 && <li className="agent-attachment" data-reading aria-label="Reading an image" />}
          </ul>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label="Message"
          aria-autocomplete="list"
          spellCheck={spellCheck}
          aria-controls={popup ? listId : undefined}
          aria-activedescendant={popup ? `${listId}-${slashIndex}` : undefined}
          onChange={(e) => {
            // Typing makes the text a new draft: Up starts from the newest again.
            setCursor(HISTORY_START);
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="agent-bar" role="toolbar" aria-label="Session options">
          <div className="agent-bar-side">{left}</div>
          <div className="agent-bar-side agent-bar-right">
            {right}
            <Tooltip label="Send" keys="Enter">
              <button
                type="button"
                className="agent-send"
                aria-label="Send"
                disabled={!ready}
                onClick={() => void send()}
              >
                <ArrowUp size={15} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      <div className="agent-composer-hint">{hint}</div>
    </div>
  );
}

/** A running session's composer: its folder, model, effort and mode in the bar. */
function Composer({
  session,
  agent,
  store,
  folders,
  askFolder,
  ghostty = false,
  refs,
}: {
  session: SessionState;
  agent: AgentDescriptor;
  store: AgentChatStore;
  folders: readonly string[];
  askFolder?: (initial: string) => Promise<string | null>;
  /** A worktree session's branch opens a Ghostty shell in the worktree. */
  ghostty?: boolean;
  refs?: RefsControl;
}) {
  const meta = session.meta;
  const id = meta.id;
  const status = meta.status;
  const who = agent.label;
  const final = isFinalStatus(status);
  const choices = useAgentChoices(final ? null : (agent?.id ?? null));
  const fail = (e: Error) => toast.error(e.message);
  const hint =
    status === "idle"
      ? "Enter to send · Shift+Enter for a new line · / for commands · ↑ for sent messages"
      : status === "starting"
        ? `${who} is starting…`
        : status === "running"
          ? `${who} is working — Stop to send something else`
          : status === "awaiting_input"
            ? `Answer ${who}'s request above`
            : "This session has ended — start a new one from the session menu";
  const shown = sessionFolder(meta);
  // A session in the folder itself names the branch the folder has checked
  // out, read again as its status changes: a turn may have switched it. A
  // worktree session names its own branch, which never changes.
  const folderInfo = useFolderInfo(meta.worktree ? null : meta.cwd, status);
  const left = (
    <>
      <FolderPicker
        folder={shown}
        folders={folders}
        askFolder={askFolder}
        heading="Folder · another one starts a new session there"
        onSelect={(cwd) => {
          if (folderPath(cwd) === folderPath(shown)) return;
          // A running agent cannot move: the new folder gets its own
          // session, same agent, mode, model, effort and worktree choice,
          // and this one stays listed.
          // A worktree only where the new folder can have one.
          void (meta.worktree ? loadFolderInfo(cwd) : Promise.resolve(null))
            .then((info) =>
              agentChat.createSession({
                name: defaultSessionName(),
                agent: meta.agent,
                cwd,
                ...(info?.canWorktree ? { worktree: true } : {}),
                ...(hasModes(agent) ? { permissionMode: meta.permissionMode } : {}),
                ...(meta.model ? { model: meta.model } : {}),
                ...(meta.effort ? { effort: meta.effort } : {}),
              }),
            )
            .catch(fail);
        }}
      />
      {meta.worktree ? (
        <WorktreeBranch
          worktree={meta.worktree}
          onOpenShell={ghostty ? () => void agentChat.openInGhostty(id).catch(fail) : undefined}
        />
      ) : (
        <FolderBranch info={folderInfo} />
      )}
    </>
  );
  const right = (
    <ModelEffortMode
      agent={agent}
      choices={choices}
      model={meta.model}
      effort={meta.effort}
      mode={meta.permissionMode}
      canPickModel={agent.capabilities.canChangeModelMidSession === true}
      disabled={status === "starting" || final}
      onModel={(m) => void agentChat.setModel(id, m).catch(fail)}
      onEffort={(e) => void agentChat.setEffort(id, e).catch(fail)}
      onMode={(m) => void agentChat.setMode(id, m).catch(fail)}
    />
  );
  return (
    <ComposerBox
      listKey={id}
      commands={session.commands}
      placeholder={final ? "Session ended" : `Message ${who}, or type / for a command`}
      disabled={final}
      canSend={status === "idle"}
      hint={hint}
      left={left}
      right={right}
      imagesFrom={{ label: who, canRead: agent.capabilities.images === true }}
      refs={refs}
      onSend={(text, images, sent) => agentChat.send(id, text, images, sent)}
    />
  );
}

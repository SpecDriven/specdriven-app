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
  ArrowUp,
  Folder,
  FolderOpen,
  Globe,
  PanelRightClose,
  Plus,
  Puzzle,
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
import { useSpellCheck } from "./spellCheckPref";
import { toast } from "./Toasts";
import { cleanLine, cleanText } from "../server/text";
import {
  agentChat,
  applyCommand,
  defaultSessionName,
  describeAgent,
  filterCommands,
  formatCost,
  formatDuration,
  hasModes,
  isFinalStatus,
  shouldFollow,
  usableAgents,
  useAgentChat,
  type AgentChatStore,
  type AgentChoices,
  type AgentDescriptor,
  type AgentModelOption,
  type AgentOffer,
  type ChatSessionMeta,
  type ChatStatus,
  type EffortLevel,
  type PermissionMode,
  type Question,
  type SessionState,
  type TranscriptItem,
} from "./agentChat";
import { EFFORT_LABEL, EFFORT_LEVELS } from "../server/agentTypes";

/**
 * The coding agent pane (specs/agents/agent-pane.feature.md): a live
 * coding agent chat inside SpecDriven for developers who have a CLI but not
 * Claude Code Desktop. Which agents there are is the plugins' business
 * (specs/agents/agent-plugins.feature.md): every branch in here reads the
 * agent's descriptor — its label, its modes, what it can do — and names
 * none. Header (session, work dir, status, permission mode, Stop, close), a
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
  dataRepo,
  prompt,
  browseFolder,
  onClose,
  onOpenPlugins,
  agentSettings,
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
  /** Open Settings → Plugins, scrolled to a marketplace plugin when named. */
  onOpenPlugins?: (wanted?: string) => void;
  /** Opens an agent's own Settings section, for one that has it. */
  agentSettings?: AgentSettingsOpener;
}) {
  const store = useAgentChat();
  const session = store.activeId ? (store.sessions[store.activeId] ?? null) : null;
  const agent = session ? describeAgent(session.meta.agent, store.agents) : null;
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
  const folders = knownFolders(codeRepo, dataRepo, store.list);
  return (
    <aside className={`agent-pane${compact ? " overlay" : ""}`} aria-label="Coding agent">
      <AgentHeader store={store} session={session} demo={demo} onClose={onClose} />
      {session && agent ? (
        <>
          <Transcript session={session} agent={agent} openSettings={agentSettings?.(agent.id)} />
          <Composer session={session} agent={agent} store={store} folders={folders} askFolder={askFolder} />
        </>
      ) : (
        <EmptyState
          store={store}
          demo={demo}
          codeRepo={codeRepo}
          dataRepo={dataRepo}
          folders={folders}
          askFolder={askFolder}
          onOpenPlugins={onOpenPlugins}
          agentSettings={agentSettings}
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
  onClose,
}: {
  store: AgentChatStore;
  session: SessionState | null;
  demo: boolean;
  onClose: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const meta = session?.meta ?? null;
  const agent = meta ? describeAgent(meta.agent, store.agents) : null;
  const fail = (e: Error) => toast.error(e.message);
  const items: MenuItem[] = [
    ...store.list.map((m) => {
      const a = describeAgent(m.agent, store.agents);
      return {
        id: m.id,
        label: m.name,
        checked: m.id === store.activeId,
        title: `${a.label} · ${statusLabel(m.status, a)} · ${m.cwd}`,
        onSelect: () => agentChat.setActive(m.id),
      };
    }),
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
      {meta && agent && (
        <span
          className="agent-dot"
          data-status={meta.status}
          role="img"
          aria-label={statusLabel(meta.status, agent)}
          title={statusLabel(meta.status, agent)}
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
      {/* An agent with an account: whether this session spends a plan or is
          billed per token, from the agent's own account answer. */}
      {meta?.account && agent?.capabilities.hasAccount && (
        <Tooltip label={meta.account.detail}>
          <span
            className="chip muted agent-account"
            data-billing={meta.account.billing}
            tabIndex={0}
            aria-label={`Billing: ${meta.account.label}`}
          >
            {meta.account.label}
          </span>
        </Tooltip>
      )}
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
    ...(m.description ? { description: m.description } : {}),
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

/** The agent's models and defaults, asked for once the bar shows it. */
function useChoices(store: AgentChatStore, agent: AgentDescriptor | null): AgentChoices | null {
  const id = agent?.id ?? null;
  const known = id !== null && id in store.choices;
  useEffect(() => {
    if (id && !known) void agentChat.loadChoices(id);
  }, [id, known]);
  return id ? (store.choices[id] ?? null) : null;
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
          onClick={() => setOpen((o) => !o)}
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
  demo,
  codeRepo,
  dataRepo,
  folders,
  askFolder,
  onOpenPlugins,
  agentSettings,
}: {
  store: AgentChatStore;
  demo: boolean;
  codeRepo: string | null;
  dataRepo: string | null;
  folders: readonly string[];
  askFolder?: (initial: string) => Promise<string | null>;
  onOpenPlugins?: (wanted?: string) => void;
  agentSettings?: AgentSettingsOpener;
}) {
  // Only the agents whose CLI is on PATH; with one, there is nothing to pick.
  const agents = usableAgents(store.agents);
  const [agentId, setAgentId] = useState<string | null>(null);
  /** A folder picked here; null keeps the default (code repo, else data repo). */
  const [folder, setFolder] = useState<string | null>(null);
  /** A mode picked here; null is the agent's default. */
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const picked = agents.find((a) => a.id === agentId) ?? agents[0] ?? null;
  const choices = useChoices(store, picked);
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
  const defaultDir = codeRepo ?? dataRepo;
  const workDir = folder ?? defaultDir;
  const startMode = mode ?? picked.defaultPermissionMode;
  const fail = (e: Error) => toast.error(e.message);
  // A model or effort picked before the session is what the agent's next
  // sessions start on (the pick is the default, as it is mid-session).
  const saveDefault = (patch: { model?: string | null; effort?: EffortLevel | null }) =>
    void agentChat.saveDefaults(picked.id, patch).catch(fail);
  const start = async (text: string) => {
    await agentChat.createSession({
      name: nameFromMessage(text) || defaultSessionName(),
      agent: picked.id,
      prompt: text,
      ...(folder && folder !== defaultDir ? { cwd: folder } : {}),
      ...(hasModes(picked) ? { permissionMode: startMode } : {}),
      ...(choices?.model ? { model: choices.model } : {}),
      ...(choices?.effort && picked.capabilities.effort ? { effort: choices.effort } : {}),
    });
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
              setAgentId(a.id);
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
            {workDir === codeRepo ? " in the code repo" : workDir === dataRepo ? " in the data repo" : ""}.
          </p>
        )}
      </div>
      <ComposerBox
        listKey="new"
        commands={[]}
        placeholder={`Describe a task for ${picked.label}`}
        disabled={false}
        canSend
        autoFocus
        hint="Enter to start · Shift+Enter for a new line"
        left={left}
        right={right}
        onSend={start}
      />
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
      return <QuestionCard item={item} agent={agent} onAnswer={onAnswer} />;
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
function ComposerBox({
  listKey,
  commands,
  placeholder,
  disabled,
  canSend,
  hint,
  left,
  right,
  autoFocus,
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
  onSend: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  // Spell check (src/frontend/spellCheckPref.ts): a message is prose.
  const spellCheck = useSpellCheck();
  const [caret, setCaret] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const slash = filterCommands(commands, draft, caret);
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
  const ready = canSend && draft.trim().length > 0;
  const send = async () => {
    // Blank lines around the message go; an indented first line (a code
    // block) keeps its indentation (specs/ui/ui.feature.md "User-entered
    // text is cleaned up").
    const text = cleanText(draft);
    if (!text.trim() || !canSend) return;
    setDraft("");
    try {
      await onSend(text);
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
      <div className="agent-composer-box" data-disabled={disabled || undefined}>
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
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={onKeyDown}
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
}: {
  session: SessionState;
  agent: AgentDescriptor;
  store: AgentChatStore;
  folders: readonly string[];
  askFolder?: (initial: string) => Promise<string | null>;
}) {
  const meta = session.meta;
  const id = meta.id;
  const status = meta.status;
  const who = agent.label;
  const final = isFinalStatus(status);
  const choices = useChoices(store, final ? null : agent);
  const fail = (e: Error) => toast.error(e.message);
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
  const left = (
    <FolderPicker
      folder={meta.cwd}
      folders={folders}
      askFolder={askFolder}
      heading="Folder · another one starts a new session there"
      onSelect={(cwd) => {
        if (folderPath(cwd) === folderPath(meta.cwd)) return;
        // A running agent cannot move: the new folder gets its own
        // session, same agent, mode, model and effort, and this one stays listed.
        void agentChat
          .createSession({
            name: defaultSessionName(),
            agent: meta.agent,
            cwd,
            ...(hasModes(agent) ? { permissionMode: meta.permissionMode } : {}),
            ...(meta.model ? { model: meta.model } : {}),
            ...(meta.effort ? { effort: meta.effort } : {}),
          })
          .catch(fail);
      }}
    />
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
      onSend={(text) => agentChat.send(id, text)}
    />
  );
}

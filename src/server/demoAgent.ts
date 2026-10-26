// Simulated coding agent for demo mode (roadmap/demo.md, "Demo App":
// "Launch Coding Session is a partial no-op … It may create pretend session
// output and results"). A public demo has no `claude` on PATH, installs no
// agent plugin and must never spawn anything — but the session is the point
// of the product. So in demo mode the demo registers this scripted stand-in
// under Claude's id (src/server/demo.ts), an AgentProvider like the ones
// the agent plugins bring (src/plugins/host/agents.ts).
//
// Everything downstream of this file is the production path: the events
// below go through the engine's AgentHost into the same event log, out over
// the same NDJSON stream, into the same transcript reducer. Only the agent
// is fake — and the pane says so, with the "Simulation…" watermark the
// client draws whenever it is in demo mode (src/frontend/AgentPane.tsx).
//
// Nothing here touches the filesystem, spawns a process or opens a socket.
// The tool rows are narration; the one permission card is real, raised
// through the host's own requestPermission, so a visitor sees the gate work.

import { randomUUID } from "node:crypto";
import type { AgentHost, AgentProvider, AgentSession, AgentStartOptions } from "../plugins/host/agents";
import { fromPlugin } from "../plugins/host/agents";
import type { PermissionMode, SlashCommandInfo } from "./agentTypes";

/** The model the header shows: obviously not a real one. */
export const SIMULATED_MODEL = "claude-simulated";
/** Stands in for the agent's version in the init note. */
export const SIMULATED_VERSION = "demo";

/** The "/" popup's contents — enough to show the popup works. */
export const SIMULATED_COMMANDS: readonly SlashCommandInfo[] = [
  { name: "compact", description: "Compact the conversation", argumentHint: "" },
  { name: "clear", description: "Clear the conversation", argumentHint: "" },
  { name: "review", description: "Review the changes so far", argumentHint: "[files]" },
];

/** The tools the init note lists. */
const SIMULATED_TOOLS = ["Read", "Grep", "Write", "Edit", "Bash"];

const ALL_MODES: readonly PermissionMode[] = ["auto", "default", "acceptEdits", "plan", "bypassPermissions"];

// --- Pacing -----------------------------------------------------------------
//
// A demo has to look like work happening without becoming a wait. These are
// the unscaled delays; setSimulationPace(0) collapses them, which is how the
// tests run the whole script in one tick.

/** Delay between text chunks — the typewriter. */
const TYPE_MS = 22;
/** Delay before a tool row appears, and again before its result. */
const TOOL_MS = 420;
/** Delay before the first token of a reply. */
const THINK_MS = 650;

let pace = 1;

/**
 * Scale every delay: 1 is the demo's own speed, 0 runs the script as fast as
 * the event loop allows (tests), 2 is half speed for a slow walk-through.
 * Returns the previous value, the setFolderChooser pattern.
 */
export function setSimulationPace(multiplier: number): number {
  const previous = pace;
  pace = Math.max(0, multiplier);
  return previous;
}

/** Sleep, cut short the moment the turn is interrupted or the session ends. */
function sleep(ms: number, signals: readonly AbortSignal[]): Promise<void> {
  const scaled = Math.round(ms * pace);
  if (scaled <= 0 || signals.some((s) => s.aborted)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      for (const s of signals) s.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, scaled);
    for (const s of signals) s.addEventListener("abort", done, { once: true });
  });
}

/** Text in chunks of a word or three, so the deltas look like generation. */
function chunks(text: string): string[] {
  const out: string[] = [];
  const words = text.split(/(\s+)/);
  for (let i = 0; i < words.length; i += 4) out.push(words.slice(i, i + 4).join(""));
  return out.filter((c) => c.length > 0);
}

// --- The script -------------------------------------------------------------

/** What the app asked for, read back out of the generated prompt. */
interface Brief {
  /** The session name from buildSessionPrompt's first line. */
  name: string;
  /** The `## Spec: <file>` headings, in order. */
  specs: string[];
}

/**
 * Parse the prompt src/server/agent.ts buildSessionPrompt wrote, so the
 * narration names the specs the visitor actually picked. A prompt typed into
 * the composer matches neither pattern and falls back to the text itself.
 */
export function readBrief(prompt: string): Brief {
  const name = /^SpecDriven code gen session: (.+)$/m.exec(prompt)?.[1]?.trim();
  const specs = [...prompt.matchAll(/^## Spec: (\S+)/gm)].map((m) => m[1]!);
  return { name: name || "this change", specs };
}

/** The stem of a spec path, as a sentence-ready phrase. */
function specTitle(file: string): string {
  const stem = file.split("/").pop()!.replace(/\.feature\.md$/, "").replace(/\.md$/, "");
  return stem.replace(/-/g, " ");
}

/** A plausible implementation path for a spec, for the write we propose. */
function targetFile(file: string): string {
  const parts = file.split("/");
  const stem = parts.pop()!.replace(/\.feature\.md$/, "").replace(/\.md$/, "");
  const camel = stem.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return `${["src", ...parts].join("/")}/${camel}.ts`;
}

/** The pretend contents of a spec read: enough lines to look like a file. */
function readOutput(file: string): string {
  return [
    `# ${specTitle(file).replace(/\b\w/g, (c) => c.toUpperCase())}`,
    "",
    "## Scenario @v1 [published]",
    "",
    "- **Given** the preconditions the spec names",
    "- **When** the behaviour is exercised",
    "- **Then** the outcome the spec requires holds",
    "",
    `(${file} — 48 lines)`,
  ].join("\n");
}

// --- The stand-in session ---------------------------------------------------

/**
 * An AgentSession that plays a script instead of running an agent. The
 * engine counts the turns and echoes the user's text; this side streams
 * the reply, narrates tool rows, raises the one permission card through the
 * host, and closes every turn with a result so the pane goes idle.
 */
class SimulatedSession implements AgentSession {
  private readonly sessionId = `sim-${randomUUID()}`;
  /** Aborted by interrupt(); a fresh one per turn. */
  private stop = new AbortController();
  private mode: PermissionMode;
  private turn = 0;

  constructor(private readonly opts: AgentStartOptions) {
    this.mode = opts.permissionMode;
  }

  private get host(): AgentHost {
    return this.opts.host;
  }

  /** The init note and the ready status, then the first turn when the app opened the session with a prompt. */
  begin(): void {
    this.host.note("info", "init", `Claude Code ${SIMULATED_VERSION} · ${SIMULATED_MODEL} · ${this.opts.cwd}`);
    this.host.ready({
      agentSessionId: this.sessionId,
      model: SIMULATED_MODEL,
      tools: SIMULATED_TOOLS,
      commands: [...SIMULATED_COMMANDS],
      permissionMode: this.mode,
    });
    if (this.opts.prompt) void this.play(this.opts.prompt);
  }

  send(text: string): Promise<void> {
    void this.play(text);
    return Promise.resolve();
  }

  interrupt(): Promise<void> {
    this.stop.abort();
    return Promise.resolve();
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    return Promise.resolve();
  }

  close(): void {
    this.stop.abort();
  }

  /** The session's own abort (end, shutdown) plus this turn's interrupt. */
  private get signals(): AbortSignal[] {
    return [this.opts.signal, this.stop.signal];
  }

  private get cancelled(): boolean {
    return this.signals.some((s) => s.aborted);
  }

  /** Streamed assistant text: the deltas, then the settled message that replaces them. */
  private async say(text: string): Promise<void> {
    const messageId = `msg_${randomUUID()}`;
    for (const chunk of chunks(text)) {
      if (this.cancelled) break;
      this.host.emit({ kind: "text_delta", messageId, index: 0, text: chunk });
      await sleep(TYPE_MS, this.signals);
    }
    this.host.emit({
      kind: "assistant",
      messageId,
      turn: this.host.turn(),
      blocks: [{ type: "text", text }],
      parentToolUseId: null,
    });
  }

  /** A tool row and the result that closes it — no tool actually runs. */
  private async useTool(name: string, input: Record<string, unknown>, output: string): Promise<void> {
    const toolUseId = `toolu_${randomUUID()}`;
    this.host.emit({
      kind: "assistant",
      messageId: `msg_${randomUUID()}`,
      turn: this.host.turn(),
      blocks: [{ type: "tool_use", id: toolUseId, name, input }],
      parentToolUseId: null,
    });
    await sleep(TOOL_MS, this.signals);
    this.host.emit({ kind: "tool_result", toolUseId, content: output, isError: false, parentToolUseId: null });
  }

  /**
   * The one real gate in the script: the host's own permission card, so a
   * genuine card goes up and the turn parks until the visitor answers. In
   * bypassPermissions mode it is an allow.
   */
  private async ask(name: string, input: Record<string, unknown>): Promise<boolean> {
    if (this.mode === "bypassPermissions" || this.cancelled) return !this.cancelled;
    const outcome = await this.host.requestPermission({ toolName: name, input, suggestions: [], signal: this.stop.signal });
    return outcome.decision.behavior === "allow" && !this.cancelled;
  }

  /** One scripted turn, always closed by a result so the pane goes idle. */
  private async play(prompt: string): Promise<void> {
    this.turn += 1;
    this.stop = new AbortController();
    this.host.turnStarted();
    const startedAt = Date.now();
    let denials = 0;
    await sleep(THINK_MS, this.signals);
    const brief = readBrief(prompt);
    // The long script only fits a session the app opened from a selection.
    // A chat started from the pane's own empty state, or any later message,
    // gets the short reply — there is no spec to narrate reading.
    if (this.turn === 1 && brief.specs.length > 0) {
      denials = await this.opening(brief);
    } else if (!this.cancelled) {
      await this.followUp(prompt);
    }
    if (this.opts.signal.aborted) return;
    const durationMs = Date.now() - startedAt;
    this.host.emit({
      kind: "result",
      turn: this.host.turn(),
      subtype: "success",
      isError: false,
      // A simulation: nobody was charged for it.
      costUsd: 0,
      durationMs,
      numTurns: this.turn,
      text: "",
      denials,
    });
    this.host.turnEnded();
  }

  /** The first turn: the prompt the app built from the selected specs. */
  private async opening({ name, specs }: Brief): Promise<number> {
    const spec = specs[0]!;
    const list = specs.length > 1 ? `${specs.length} specs` : specTitle(spec);
    await this.say(
      `I'll implement ${name}. Starting with ${list} — let me read the spec and see what the code already does.`,
    );
    if (this.cancelled) return 0;
    await this.useTool("Read", { file_path: spec }, readOutput(spec));
    if (this.cancelled) return 0;
    await sleep(TOOL_MS, this.signals);
    await this.useTool(
      "Grep",
      { pattern: specTitle(spec).split(" ")[0], output_mode: "files_with_matches" },
      "No matches found — this behaviour is not implemented yet.",
    );
    if (this.cancelled) return 0;
    const file = targetFile(spec);
    await this.say(
      `Nothing implements this yet, so I'll add it. The scenarios map cleanly onto one module with a case per rule; I'll write ${file} and wire the checks the spec's Then clauses name.`,
    );
    if (this.cancelled) return 0;
    const allowed = await this.ask("Write", {
      file_path: file,
      content: `// ${specTitle(spec)} — generated from ${spec}\n// (simulated: nothing is written to disk)\n`,
    });
    if (this.cancelled) return allowed ? 0 : 1;
    if (!allowed) {
      await this.say(
        `Understood — I'll leave ${file} alone. Tell me where this should live instead, or approve the write and I'll carry on.`,
      );
      return 1;
    }
    await this.useTool("Write", { file_path: file }, `Wrote ${file} (34 lines).`);
    if (this.cancelled) return 0;
    await this.say(
      `Done. ${file} covers every scenario in ${specTitle(spec)}; the Given/When/Then rules became one case each, and the tables in the spec are the fixtures. Next I'd add the tests its Automated tests lists name.`,
    );
    return 0;
  }

  /** Everything else: short, so the composer stays useful in a demo. */
  private async followUp(prompt: string): Promise<void> {
    const asked = prompt.trim().replace(/\s+/g, " ").slice(0, 80);
    await this.say(
      `This is a simulated session, so I can't really act on “${asked}” — but a live Claude Code session here would work in ${this.opts.cwd}, with the same transcript, tool rows and permission prompts you see above.`,
    );
  }
}

/**
 * The provider the demo registers (src/server/demo.ts): Claude's place and
 * modes, its CLI always "found", with the script in place of an agent.
 * Everything downstream — the event log, the permission cards — is the
 * production path.
 */
export const simulatedProvider: AgentProvider = fromPlugin(
  {
    id: "claude",
    label: "Claude",
    description: "Claude Code, with permission cards and its own commands — simulated in the demo",
    rank: 10,
    cli: "claude",
    available: () => true,
    missingMessage: "Claude CLI not found — install Claude Code and make sure `claude` is on PATH",
    capabilities: {
      permissionModes: ALL_MODES,
      canInterrupt: true,
      canChangeModeMidSession: true,
      hasAccount: false,
      rememberPermissions: "rule",
      oneShot: false,
    },
    defaultPermissionMode: "auto",
    start(opts) {
      const session = new SimulatedSession(opts);
      // Once the engine holds the session: the ready status and the first
      // turn then land on a session that can be typed into.
      queueMicrotask(() => session.begin());
      return Promise.resolve(session);
    },
  },
  "demo",
);

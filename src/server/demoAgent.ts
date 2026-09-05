// Simulated coding agent for demo mode (specs/roadmap/demo.md, "Demo App":
// "Launch Coding Session is a partial no-op … It may create pretend session
// output and results"). A public demo has no `claude` on PATH and must never
// spawn one, but the session is the point of the product — so demo mode fills
// the pane's own injection seam (setQueryFactory in src/server/agentChat.ts)
// with a scripted stand-in.
//
// Everything downstream of this file is the production path: the messages
// below go through mapSdkMessage into the same event log, out over the same
// NDJSON stream, into the same transcript reducer. Only the agent is fake —
// and the pane says so, with the "Simulation…" watermark the client draws
// whenever it is in demo mode (src/frontend/AgentPane.tsx).
//
// Nothing here touches the filesystem, spawns a process or opens a socket.
// The tool rows are narration; the one permission card is real, raised by
// calling the session's own canUseTool, so a visitor sees the gate work.

import { randomUUID } from "node:crypto";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, QueryFactory, QueryLike, SlashCommandInfo } from "./agentChat";

/** The model the header shows: obviously not a real one. */
export const SIMULATED_MODEL = "claude-simulated";
/** Stands in for claude_code_version in the init note. */
export const SIMULATED_VERSION = "demo";

/** The "/" popup's contents — enough to show the popup works. */
export const SIMULATED_COMMANDS: readonly SlashCommandInfo[] = [
  { name: "compact", description: "Compact the conversation", argumentHint: "" },
  { name: "clear", description: "Clear the conversation", argumentHint: "" },
  { name: "review", description: "Review the changes so far", argumentHint: "[files]" },
];

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
 * Returns the previous value, the setFolderChooser/setQueryFactory pattern.
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

// --- The stand-in query -----------------------------------------------------

/** The SDK's message shapes are wide; the script fills only what we read. */
const sdk = (m: unknown) => m as SDKMessage;

/** The text of a user message, whatever shape the content came in. */
function textOf(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("");
}

/**
 * A QueryLike (src/server/agentChat.ts) that plays a script instead of
 * running an agent. The generator loops over the incoming messages for as
 * long as the session lives: returning early would make pump() end the
 * session with "Claude exited."
 */
class SimulatedQuery implements QueryLike {
  private readonly sessionId = `sim-${randomUUID()}`;
  /** Aborted by interrupt(); a fresh one per turn. */
  private stop = new AbortController();
  private mode: PermissionMode;
  private turn = 0;

  constructor(
    private readonly prompt: AsyncIterable<SDKUserMessage>,
    private readonly options: Options,
  ) {
    this.mode = (options.permissionMode as PermissionMode | undefined) ?? "default";
  }

  interrupt(): Promise<unknown> {
    this.stop.abort();
    return Promise.resolve();
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    return Promise.resolve();
  }

  supportedCommands(): Promise<never[]> {
    // The pane maps these through commandInfo, which reads the same three
    // fields; the SlashCommand type carries more that nothing here needs.
    return Promise.resolve(SIMULATED_COMMANDS as unknown as never[]);
  }

  /** The session's own abort (end, shutdown) plus this turn's interrupt. */
  private get signals(): AbortSignal[] {
    const session = this.options.abortController?.signal;
    return session ? [session, this.stop.signal] : [this.stop.signal];
  }

  private get cancelled(): boolean {
    return this.signals.some((s) => s.aborted);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    yield this.init();
    for await (const message of this.prompt) {
      if (this.options.abortController?.signal.aborted) return;
      this.turn += 1;
      this.stop = new AbortController();
      yield* this.playTurn(textOf(message));
    }
  }

  private init(): SDKMessage {
    return sdk({
      type: "system",
      subtype: "init",
      apiKeySource: "none",
      claude_code_version: SIMULATED_VERSION,
      cwd: this.options.cwd ?? process.cwd(),
      tools: ["Read", "Grep", "Write", "Edit", "Bash"],
      mcp_servers: [],
      model: SIMULATED_MODEL,
      permissionMode: this.mode,
      slash_commands: SIMULATED_COMMANDS.map((c) => c.name),
      output_style: "default",
      skills: [],
      plugins: [],
      uuid: randomUUID(),
      session_id: this.sessionId,
    });
  }

  /** Streamed assistant text: message_start, deltas, then the settled block. */
  private async *say(text: string, extra: unknown[] = []): AsyncGenerator<SDKMessage> {
    const messageId = `msg_${randomUUID()}`;
    yield sdk({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: messageId, type: "message", role: "assistant", content: [] },
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: this.sessionId,
    });
    for (const chunk of chunks(text)) {
      if (this.cancelled) break;
      yield sdk({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: this.sessionId,
      });
      await sleep(TYPE_MS, this.signals);
    }
    yield sdk({
      type: "assistant",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: SIMULATED_MODEL,
        content: [{ type: "text", text }, ...extra],
        stop_reason: null,
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: this.sessionId,
    });
  }

  /** A tool row and the result that closes it — no tool actually runs. */
  private async *useTool(
    name: string,
    input: Record<string, unknown>,
    output: string,
  ): AsyncGenerator<SDKMessage> {
    const toolUseId = `toolu_${randomUUID()}`;
    yield sdk({
      type: "assistant",
      message: {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: SIMULATED_MODEL,
        content: [{ type: "tool_use", id: toolUseId, name, input }],
        stop_reason: null,
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: this.sessionId,
    });
    await sleep(TOOL_MS, this.signals);
    yield sdk({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: output, is_error: false }],
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: this.sessionId,
    });
  }

  /**
   * The one real gate in the script: the pane's own canUseTool, so a genuine
   * permission card goes up and the turn parks until the visitor answers.
   * Without one (bypassPermissions, or a session with no gate) it is an allow.
   */
  private async ask(name: string, input: Record<string, unknown>): Promise<boolean> {
    const canUseTool = this.options.canUseTool;
    if (!canUseTool || this.mode === "bypassPermissions" || this.cancelled) return !this.cancelled;
    const ctx = {
      signal: this.stop.signal,
      suggestions: [],
      toolUseID: `toolu_${randomUUID()}`,
    } as unknown as Parameters<NonNullable<Options["canUseTool"]>>[2];
    // A null verdict means the host declined to decide; treat it as a deny.
    const verdict = await canUseTool(name, input, ctx);
    return verdict?.behavior === "allow" && !this.cancelled;
  }

  /** One scripted turn, always closed by a result so the pane goes idle. */
  private async *playTurn(prompt: string): AsyncGenerator<SDKMessage> {
    const startedAt = Date.now();
    let denials = 0;
    await sleep(THINK_MS, this.signals);
    const brief = readBrief(prompt);
    // The long script only fits a session the app opened from a selection.
    // A chat started from the pane's own empty state, or any later message,
    // gets the short reply — there is no spec to narrate reading.
    if (this.turn === 1 && brief.specs.length > 0) {
      denials = yield* this.opening(brief);
    } else if (!this.cancelled) {
      yield* this.followUp(prompt);
    }
    yield this.result(Date.now() - startedAt, denials);
  }

  /** The first turn: the prompt the app built from the selected specs. */
  private async *opening({ name, specs }: Brief): AsyncGenerator<SDKMessage, number> {
    const spec = specs[0]!;
    const list = specs.length > 1 ? `${specs.length} specs` : specTitle(spec);
    yield* this.say(
      `I'll implement ${name}. Starting with ${list} — let me read the spec and see what the code already does.`,
    );
    if (this.cancelled) return 0;
    yield* this.useTool("Read", { file_path: spec }, readOutput(spec));
    if (this.cancelled) return 0;
    await sleep(TOOL_MS, this.signals);
    yield* this.useTool(
      "Grep",
      { pattern: specTitle(spec).split(" ")[0], output_mode: "files_with_matches" },
      "No matches found — this behaviour is not implemented yet.",
    );
    if (this.cancelled) return 0;
    const file = targetFile(spec);
    yield* this.say(
      `Nothing implements this yet, so I'll add it. The scenarios map cleanly onto one module with a case per rule; I'll write ${file} and wire the checks the spec's Then clauses name.`,
    );
    if (this.cancelled) return 0;
    const allowed = await this.ask("Write", {
      file_path: file,
      content: `// ${specTitle(spec)} — generated from ${spec}\n// (simulated: nothing is written to disk)\n`,
    });
    if (this.cancelled) return allowed ? 0 : 1;
    if (!allowed) {
      yield* this.say(
        `Understood — I'll leave ${file} alone. Tell me where this should live instead, or approve the write and I'll carry on.`,
      );
      return 1;
    }
    yield* this.useTool(
      "Write",
      { file_path: file },
      `Wrote ${file} (34 lines).`,
    );
    if (this.cancelled) return 0;
    yield* this.say(
      `Done. ${file} covers every scenario in ${specTitle(spec)}; the Given/When/Then rules became one case each, and the tables in the spec are the fixtures. Next I'd add the tests the spec's Tests table links to.`,
    );
    return 0;
  }

  /** Everything else: short, so the composer stays useful in a demo. */
  private async *followUp(prompt: string): AsyncGenerator<SDKMessage> {
    const asked = prompt.trim().replace(/\s+/g, " ").slice(0, 80);
    yield* this.say(
      `This is a simulated session, so I can't really act on “${asked}” — but a live Claude Code session here would work in ${this.options.cwd ?? "the repo"}, with the same transcript, tool rows and permission prompts you see above.`,
    );
  }

  private result(durationMs: number, denials: number): SDKMessage {
    return sdk({
      type: "result",
      subtype: "success",
      duration_ms: durationMs,
      duration_api_ms: Math.round(durationMs * 0.8),
      is_error: false,
      num_turns: this.turn,
      result: "",
      stop_reason: "end_turn",
      // A believable figure for a turn this size — and, being a simulation,
      // one nobody was charged for.
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: new Array(denials).fill({ tool_name: "Write" }),
      uuid: randomUUID(),
      session_id: this.sessionId,
    });
  }
}

/** The factory demo mode hands to setQueryFactory (src/server/demo.ts). */
export const simulatedQuery: QueryFactory = ({ prompt, options }) =>
  new SimulatedQuery(prompt, options);

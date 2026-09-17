// Estimate a task (specs/app/tasks.feature.md "Add task to Google Calendar"):
// how long it will take, asked of the developer's own `claude` CLI in one
// short turn — no tools, no session record, no permission to ask for — so
// the person has a number to confirm or correct before the event is made.
// Goes through the coding agent pane's query seam (src/server/agentChat.ts),
// so a test steers the answer and demo mode's scripted agent is kept out by
// the route, which never asks it. Node APIs only: this runs under Electron.

import type { Options, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_BIN, claudeAvailable } from "./agent";
import { InputQueue, currentQueryFactory, userMessage } from "./agentChat";
import { MAX_ESTIMATE_MINUTES } from "./calendar";
import type { MarkdownPage } from "./parser";
import { which } from "./run";

/** Why an estimate could not be had, with the HTTP status the route answers. */
export class EstimateError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The refusal when no `claude` is on PATH. */
export const ESTIMATE_CLI_MISSING = "Claude CLI not found on PATH";

/** How long Claude gets before the turn is abandoned. */
export const ESTIMATE_TIMEOUT_MS = 60_000;

/** The task's text is enough context; a novel of a task is cut here. */
const BODY_MAX = 4000;

const SYSTEM_PROMPT =
  "You estimate how long a small software or project task will take one person to accomplish. " +
  "Read the task and answer with a single realistic estimate in minutes — an integer from 1 to " +
  `${MAX_ESTIMATE_MINUTES}. Round to a sensible unit: 15, 30, 45, 60, 90, 120, 180, 240, 480 and so ` +
  "on. Do not explain, do not ask questions, do not use any tools.";

/** The one user turn: the task's name and text, and what to answer with. */
export function estimatePrompt(page: MarkdownPage): string {
  const body = page.body.trim();
  const text = body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}…` : body;
  return [
    `Task: ${page.name || "(untitled)"}`,
    "",
    text || "(no further description)",
    "",
    "Reply with only an integer number of minutes.",
  ].join("\n");
}

/** The first whole number in Claude's words, if any. */
function firstInteger(text: string): number | null {
  const m = text.match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** What Claude answered, as minutes, or null when it is not a usable number. */
export function minutesFromResult(result: SDKResultMessage): number | null {
  if (result.subtype !== "success" || result.is_error) return null;
  const structured = (result.structured_output as { minutes?: unknown } | undefined)?.minutes;
  const minutes = typeof structured === "number" ? structured : firstInteger(result.result);
  if (minutes === null || !Number.isInteger(minutes)) return null;
  return minutes >= 1 && minutes <= MAX_ESTIMATE_MINUTES ? minutes : null;
}

/** The options of the one short turn: what a test checks for. */
export function estimateOptions(
  cwd: string,
  abortController: AbortController,
): Options {
  // A dev server started from inside a Claude Code terminal inherits the
  // marker that makes a nested `claude` refuse to start (agentChat.ts).
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return {
    cwd,
    pathToClaudeCodeExecutable: which(CLAUDE_BIN) ?? undefined,
    maxTurns: 1,
    // No built-in tools at all: nothing to read, nothing to run, nothing to
    // ask permission for.
    tools: [],
    permissionMode: "default",
    systemPrompt: SYSTEM_PROMPT,
    // No CLAUDE.md, skills or hooks: the question is the whole context.
    settingSources: [],
    // Leaves nothing in ~/.claude/projects: this is not a session.
    persistSession: false,
    thinking: { type: "disabled" },
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { minutes: { type: "integer", minimum: 1, maximum: MAX_ESTIMATE_MINUTES } },
        required: ["minutes"],
      },
    },
    abortController,
    env,
  };
}

/**
 * Ask Claude once how long the task takes. Throws an EstimateError with the
 * status the route answers: 503 without a CLI, 502 when Claude fails or
 * answers with something other than a number.
 */
export async function estimateMinutes(
  page: MarkdownPage,
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<number> {
  if (!claudeAvailable()) throw new EstimateError(503, ESTIMATE_CLI_MISSING);
  const abortController = new AbortController();
  const prompt = new InputQueue<ReturnType<typeof userMessage>>();
  prompt.push(userMessage(estimatePrompt(page)));
  prompt.close();
  const timer = setTimeout(() => abortController.abort(), options.timeoutMs ?? ESTIMATE_TIMEOUT_MS);
  try {
    const query = await currentQueryFactory()({
      prompt,
      options: estimateOptions(cwd, abortController),
    });
    for await (const msg of query) {
      if (msg.type !== "result") continue;
      if (msg.subtype !== "success") {
        const detail = msg.errors?.join("; ") || msg.subtype;
        throw new EstimateError(502, `Claude could not estimate the task: ${detail}`);
      }
      // A turn the API refused (a bad token, a model that is not there) is a
      // "success" whose text is the error; say that rather than "not a number".
      if (msg.is_error) {
        const detail = msg.result.trim() || "the turn failed";
        throw new EstimateError(502, `Claude could not estimate the task: ${detail}`);
      }
      const minutes = minutesFromResult(msg);
      if (minutes === null) {
        throw new EstimateError(502, "Claude did not answer with a number of minutes");
      }
      return minutes;
    }
    throw new EstimateError(
      502,
      abortController.signal.aborted
        ? "Claude did not answer in time"
        : "Claude exited without an answer",
    );
  } catch (e) {
    if (e instanceof EstimateError) throw e;
    throw new EstimateError(502, `Claude could not estimate the task: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    // The streaming-input turn is over either way; nothing must linger.
    abortController.abort();
  }
}

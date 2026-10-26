// Estimate a task (specs/app/tasks.feature.md "Add task to Google Calendar"):
// how long it will take, asked of the developer's own `claude` CLI in one
// short turn — no tools, no session record, no permission to ask for — so
// the person has a number to confirm or correct before the event is made.
// Goes through an agent provider's one-shot turn (src/plugins/host/agents.ts
// — Claude's, which the test steers through its query seam), so demo mode's
// scripted agent is kept out by the route, which never asks it. Node APIs
// only: this runs under Electron.

import { agents } from "../plugins/host/agents";
import type { OneShotResult } from "../plugins/host/agents";
import { MAX_ESTIMATE_MINUTES } from "./calendar";
import type { MarkdownPage } from "./parser";

/** Why an estimate could not be had, with the HTTP status the route answers. */
export class EstimateError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The refusal when no agent answers one-shot turns here. */
export const ESTIMATE_CLI_MISSING = "No agent can estimate — install the Claude agent plugin";

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

/** The answer the agent is held to: one integer, minutes. */
export const ESTIMATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { minutes: { type: "integer", minimum: 1, maximum: MAX_ESTIMATE_MINUTES } },
  required: ["minutes"],
};

/** What the agent answered, as minutes, or null when it is not a usable number. */
export function minutesFromResult(result: Pick<OneShotResult, "text" | "structured" | "isError">): number | null {
  if (result.isError) return null;
  const structured = (result.structured as { minutes?: unknown } | undefined)?.minutes;
  const minutes = typeof structured === "number" ? structured : firstInteger(result.text);
  if (minutes === null || !Number.isInteger(minutes)) return null;
  return minutes >= 1 && minutes <= MAX_ESTIMATE_MINUTES ? minutes : null;
}

/**
 * Ask the agent once how long the task takes. Throws an EstimateError with
 * the status the route answers: 503 without an agent that can, 502 when the
 * agent fails or answers with something other than a number.
 */
export async function estimateMinutes(
  page: MarkdownPage,
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<number> {
  const provider = agents.oneShot("claude");
  if (!provider?.oneShot) throw new EstimateError(503, ESTIMATE_CLI_MISSING);
  const who = provider.label;
  try {
    const result = await provider.oneShot({
      cwd,
      systemPrompt: SYSTEM_PROMPT,
      prompt: estimatePrompt(page),
      schema: ESTIMATE_SCHEMA,
      timeoutMs: options.timeoutMs ?? ESTIMATE_TIMEOUT_MS,
    });
    // A turn the API refused (a bad token, a model that is not there) comes
    // back as an error whose text says why; say that rather than "not a number".
    if (result.isError) {
      throw new EstimateError(502, `${who} could not estimate the task: ${result.text.trim() || "the turn failed"}`);
    }
    const minutes = minutesFromResult(result);
    if (minutes === null) throw new EstimateError(502, `${who} did not answer with a number of minutes`);
    return minutes;
  } catch (e) {
    if (e instanceof EstimateError) throw e;
    throw new EstimateError(502, `${who} could not estimate the task: ${(e as Error).message}`);
  }
}

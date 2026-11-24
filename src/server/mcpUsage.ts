// How much each MCP server is used (specs/agents/agent-pane.feature.md "MCP
// servers before a session"): the app counts the MCP tool calls of the
// sessions it runs — every agent names such a tool `mcp__<server>__<tool>`
// — and keeps each session's count in its record, beside the settings
// file. The "MCP servers…" dialog sums the records of the sessions that
// worked in the folder it is about. Nothing is counted of sessions run
// elsewhere, or before the app began counting.
//
// Node APIs only (src/server/run.ts): this module also runs inside Electron.

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChatEventBody, McpServerUsage, McpToolCounts } from "./agentTypes";

const MCP_PREFIX = "mcp__";

/** Whether a tool is an MCP server's, by its name. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX) && name.length > MCP_PREFIX.length;
}

/** A server's name as it stands inside a tool's name: agents put an
    underscore where the name has a character a tool name cannot. */
export function mcpNameKey(server: string): string {
  return server.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Count one event of a session into its tool counts: an MCP tool the agent
 * calls is a call, and its result coming back as an error is an error.
 * `pending` remembers which call a result answers. True when the counts
 * changed.
 */
export function countMcpUse(
  counts: McpToolCounts,
  pending: Map<string, string>,
  event: ChatEventBody,
  at: string = new Date().toISOString(),
): boolean {
  if (event.kind === "assistant") {
    let changed = false;
    for (const block of event.blocks) {
      if (block.type !== "tool_use" || !isMcpToolName(block.name)) continue;
      const entry = (counts[block.name] ??= { calls: 0, errors: 0, lastAt: at });
      entry.calls += 1;
      entry.lastAt = at;
      pending.set(block.id, block.name);
      changed = true;
    }
    return changed;
  }
  if (event.kind === "tool_result") {
    const name = pending.get(event.toolUseId);
    if (name === undefined) return false;
    pending.delete(event.toolUseId);
    if (!event.isError) return false;
    counts[name]!.errors += 1;
    return true;
  }
  return false;
}

/** Tool counts read back from a record: only what has the right shape. */
export function mcpCountsOf(value: unknown): McpToolCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const counts: McpToolCounts = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isMcpToolName(name) || !raw || typeof raw !== "object") continue;
    const { calls, errors, lastAt } = raw as Record<string, unknown>;
    if (typeof calls !== "number" || !(calls > 0)) continue;
    counts[name] = {
      calls: Math.floor(calls),
      errors: typeof errors === "number" && errors > 0 ? Math.floor(errors) : 0,
      lastAt: typeof lastAt === "string" ? lastAt : "",
    };
  }
  return counts;
}

/** One session's count, as the sum takes it. */
export interface SessionMcpCounts {
  id: string;
  startedAt: string;
  counts: McpToolCounts;
}

/**
 * The sessions' counts summed by server, for the servers named. A tool's
 * name gives its server — the longest of the names that fits, so a server
 * named `a` never takes the calls of one named `a__b`. A server nobody
 * called has no entry.
 */
export function usageByServer(
  sessions: readonly SessionMcpCounts[],
  servers: readonly string[],
): Record<string, McpServerUsage> {
  const byPrefix = servers
    .map((name) => ({ name, prefix: `${MCP_PREFIX}${mcpNameKey(name)}__` }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const usage: Record<string, McpServerUsage> = {};
  for (const session of sessions) {
    const seen = new Set<string>();
    for (const [toolName, count] of Object.entries(session.counts)) {
      const server = byPrefix.find((s) => toolName.startsWith(s.prefix) && toolName.length > s.prefix.length);
      if (!server) continue;
      const entry = (usage[server.name] ??= { calls: 0, errors: 0, sessions: 0, tools: {} });
      entry.calls += count.calls;
      entry.errors += count.errors;
      if (count.lastAt && (!entry.lastAt || count.lastAt > entry.lastAt)) entry.lastAt = count.lastAt;
      const tool = (entry.tools[toolName.slice(server.prefix.length)] ??= { calls: 0, errors: 0 });
      tool.calls += count.calls;
      tool.errors += count.errors;
      if (!seen.has(server.name)) {
        seen.add(server.name);
        entry.sessions += 1;
      }
    }
  }
  return usage;
}

/** The folder a session record says it worked in: the one the pane
    picked, which for a session in a worktree is not where it ran. */
function recordFolder(record: Record<string, unknown>): string | null {
  const worktree = record.worktree as { folder?: unknown } | undefined;
  const folder = typeof worktree?.folder === "string" ? worktree.folder : record.cwd;
  return typeof folder === "string" && folder ? resolve(folder) : null;
}

/**
 * The counts the session records keep for one agent's sessions in one
 * folder, oldest first. Only records that carry a count at all — a session
 * from before the app counted says nothing, which is not "never used".
 * `live` are the open sessions' counts, which stand for their records: a
 * record is written when a turn ends, the count moves during it.
 */
export async function folderMcpCounts(
  sessionsDir: string,
  agent: string,
  folder: string,
  live: readonly (SessionMcpCounts & { agent: string; folder: string })[] = [],
): Promise<SessionMcpCounts[]> {
  const want = resolve(folder);
  const found = new Map<string, SessionMcpCounts>();
  let ids: string[] = [];
  try {
    ids = await readdir(sessionsDir);
  } catch {
    // No session was ever recorded.
  }
  await Promise.all(
    ids.map(async (id) => {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(await readFile(join(sessionsDir, id, "session.json"), "utf8")) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!record || typeof record !== "object" || record.agent !== agent || recordFolder(record) !== want) return;
      const counts = mcpCountsOf(record.mcpUsage);
      if (!counts) return;
      found.set(id, { id, startedAt: typeof record.startedAt === "string" ? record.startedAt : "", counts });
    }),
  );
  for (const session of live) {
    if (session.agent !== agent || resolve(session.folder) !== want) continue;
    found.set(session.id, { id: session.id, startedAt: session.startedAt, counts: session.counts });
  }
  return [...found.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
}

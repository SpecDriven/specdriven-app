// The "MCP servers…" dialog (specs/agents/agent-pane.feature.md "MCP
// servers before a session"): the MCP servers a new session of an agent
// would get in the folder the new-session screen has picked, asked of the
// agent with no session running. The list on the left turns a server on
// and off, signs in to it and connects it again, as the session popover's
// list does; the right side says everything about the one picked — where
// it is kept and how it is reached, what its tools take of the context
// window, how often the sessions run here called it — deletes it, or holds
// the form that adds one.
//
// The catalog is the agent's own answer at that moment
// (/api/agent/agents/:agent/mcp); the usage numbers are the app's count
// (src/server/mcpUsage.ts). The agent may keep a process running while the
// dialog is open; shutting it says so (…/mcp/release).

import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { checkMcpDraft } from "../server/agentTypes";
import type { McpManageCapability, McpScope, McpToolInfo, McpTransport } from "../server/agentTypes";
import { agentChat, formatPercent, formatTokens } from "./agentChat";
import type {
  AgentDescriptor,
  McpCatalog,
  McpServerAction,
  McpServerDetail,
  McpServerDraft,
  McpServerUsage,
} from "./agentChat";
import { backdropDismiss } from "./backdropDismiss";
import { abbreviatePath, mcpStatusWords, McpServerRow } from "./SessionRail";
import { toast } from "./Toasts";
import { useFocusTrap } from "./useFocusTrap";
import { openWebLink } from "./weblinks";

/** What the dialog asks of the server: agentChat's calls, or a test's. */
export interface McpCatalogApi {
  mcpCatalog(agent: string, cwd?: string): Promise<McpCatalog>;
  mcpCatalogAction(agent: string, server: string, action: McpServerAction, cwd?: string): Promise<McpCatalog>;
  addMcpServer(agent: string, server: McpServerDraft, cwd?: string): Promise<McpCatalog>;
  removeMcpServer(agent: string, name: string, cwd?: string): Promise<McpCatalog>;
  releaseMcp(agent: string, cwd?: string): Promise<void>;
}

// --- Words ---------------------------------------------------------------------

/** Where a server is kept, as the form's choice and the details say it. */
export const MCP_SCOPE_LABEL: Readonly<Record<McpScope, string>> = {
  local: "This folder only",
  user: "All my folders",
  project: "Shared with the repo",
};

const MCP_SCOPE_HINT: Readonly<Record<McpScope, string>> = {
  local: "Kept in your own settings, for sessions in this folder.",
  user: "Kept in your own settings, for sessions in every folder.",
  project:
    "Kept in a file in this folder that the repo commits (.mcp.json for Claude). Anything typed here, secrets included, goes into that file.",
};

/** Where a delete takes a server from, after "Delete <name> from …". */
const MCP_SCOPE_FROM: Readonly<Record<McpScope, string>> = {
  local: "this folder's settings",
  user: "your settings for all folders",
  project: "the file the repo shares",
};

export const MCP_TRANSPORT_LABEL: Readonly<Record<McpTransport, string>> = {
  stdio: "Command",
  http: "HTTP",
  sse: "SSE",
};

/** A server's kind in words; an agent's own word for one the form does not offer. */
function transportWords(transport: string | undefined): string | null {
  if (!transport) return null;
  if (transport === "stdio") return "Command (stdio)";
  if (transport === "http") return "HTTP";
  if (transport === "sse") return "SSE";
  return transport;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Nov 24, 2026" — the day a count goes back to. */
function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "Nov 24, 14:02" — when a server was last called. */
function formatMoment(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// --- Numbers ---------------------------------------------------------------------

/** What every listed server's tools take of the window together. */
export interface McpTotals {
  servers: number;
  tools: number;
  loaded: number;
  deferred: number;
}

export function mcpTotals(servers: readonly McpServerDetail[]): McpTotals {
  return servers.reduce<McpTotals>(
    (t, s) => ({
      servers: t.servers + 1,
      tools: t.tools + (s.toolList?.length ?? s.tools ?? 0),
      loaded: t.loaded + (s.context?.loaded ?? 0),
      deferred: t.deferred + (s.context?.deferred ?? 0),
    }),
    { servers: 0, tools: 0, loaded: 0, deferred: 0 },
  );
}

/** The one line under the title: how many servers and tools, and their cost. */
export function mcpTotalsLine(totals: McpTotals, contextWindow?: number): string {
  if (totals.servers === 0) return "No MCP servers";
  const parts = [count(totals.servers, "server"), count(totals.tools, "tool")];
  if (totals.loaded > 0) {
    const share = contextWindow ? ` (${formatPercent(totals.loaded, contextWindow)} of the window)` : "";
    parts.push(`${formatTokens(totals.loaded)} tokens in a new session${share}`);
  }
  if (totals.deferred > 0) parts.push(`${formatTokens(totals.deferred)} more once their tools load`);
  return parts.join(" · ");
}

/** One line of the tools table: a tool's cost beside how often it was called. */
export interface McpToolRow {
  name: string;
  tokens?: number;
  loaded?: boolean;
  calls: number;
  errors: number;
}

/**
 * A server's tools with their use: the tools it lists, the costliest
 * first, then any the count knows that it no longer lists (a server that
 * is off or failed lists none, yet its calls were counted).
 */
export function mcpToolRows(tools: readonly McpToolInfo[] | undefined, usage: McpServerUsage | undefined): McpToolRow[] {
  const used = usage?.tools ?? {};
  const rows: McpToolRow[] = (tools ?? []).map((t) => ({
    name: t.name,
    ...(typeof t.tokens === "number" ? { tokens: t.tokens } : {}),
    ...(typeof t.loaded === "boolean" ? { loaded: t.loaded } : {}),
    calls: used[t.name]?.calls ?? 0,
    errors: used[t.name]?.errors ?? 0,
  }));
  rows.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || a.name.localeCompare(b.name));
  const listed = new Set(rows.map((r) => r.name));
  const gone = Object.entries(used)
    .filter(([name]) => !listed.has(name))
    .map(([name, u]) => ({ name, calls: u.calls, errors: u.errors }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  return [...rows, ...gone];
}

// --- The form's text fields --------------------------------------------------------

/** One argument per line, as typed; empty lines are no argument. */
export function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Names and values, one pair per line, split at the first `separator`
 * (`=` for the environment, `:` for headers): the pairs, or the words of
 * what is wrong with a line.
 */
export function pairsOf(text: string, separator: "=" | ":"): Record<string, string> | string {
  const pairs: Record<string, string> = {};
  for (const line of linesOf(text)) {
    const at = line.indexOf(separator);
    const name = at < 0 ? "" : line.slice(0, at).trim();
    if (!name) return `"${line}" is not a name${separator === "=" ? "=value" : ": value"} pair`;
    pairs[name] = line.slice(at + 1).trim();
  }
  return pairs;
}

/** What the form holds, as typed. */
export interface McpDraftFields {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

/** The form as a draft the server takes, or the words of what is missing. */
export function draftOf(
  fields: McpDraftFields,
  can: McpManageCapability,
  taken: readonly string[],
): McpServerDraft | string {
  if (fields.transport === "stdio") {
    const env = pairsOf(fields.env, "=");
    if (typeof env === "string") return env;
    return checkMcpDraft(
      { name: fields.name, scope: fields.scope, transport: fields.transport, command: fields.command, args: linesOf(fields.args), env },
      can,
      taken,
    );
  }
  const headers = pairsOf(fields.headers, ":");
  if (typeof headers === "string") return headers;
  return checkMcpDraft(
    { name: fields.name, scope: fields.scope, transport: fields.transport, url: fields.url, headers },
    can,
    taken,
  );
}

// --- The dialog ----------------------------------------------------------------------

/** How long the list keeps asking after a sign-in was started. */
const MCP_WATCH_MS = 5 * 60_000;
const MCP_POLL_MS = 2000;

export function McpServersDialog({
  agent,
  folder,
  cwd,
  homeDir = null,
  onClose,
  api = agentChat,
}: {
  agent: AgentDescriptor;
  /** The folder the servers are for, as the title names it. */
  folder: string | null;
  /** The folder the new-session screen picked; absent, a session's default folder. */
  cwd?: string;
  homeDir?: string | null;
  onClose: () => void;
  api?: McpCatalogApi;
}) {
  const trapRef = useFocusTrap(true);
  const can = agent.capabilities.mcpManage;
  const [catalog, setCatalog] = useState<McpCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The server an action is running for. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Sign-in pages by server: shown as a link, for a browser that kept the window shut. */
  const [links, setLinks] = useState<Record<string, string>>({});
  /** Until when the list keeps asking for a sign-in's outcome. */
  const [watchUntil, setWatchUntil] = useState(0);
  const id = agent.id;

  const load = useCallback(
    () =>
      api.mcpCatalog(id, cwd).then(
        (next) => {
          setCatalog(next);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [api, id, cwd],
  );

  useEffect(() => {
    void load();
    // The agent may have kept a process running for the dialog.
    return () => void api.releaseMcp(id, cwd);
  }, [api, id, cwd, load]);

  const servers = catalog?.servers ?? null;
  const connecting = servers?.some((s) => s.status === "connecting") ?? false;
  const awaited = watchUntil > 0 && (servers?.some((s) => s.status === "needs-auth") ?? false);
  const polling = connecting || awaited;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      if (watchUntil > 0 && Date.now() > watchUntil) setWatchUntil(0);
      void load();
    }, MCP_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, watchUntil, load]);

  const act = (server: string, action: McpServerAction) => {
    setBusy(server);
    void api
      .mcpCatalogAction(id, server, action, cwd)
      .then((answer) => {
        setCatalog(answer);
        setError(null);
        if (action !== "authenticate") return;
        setWatchUntil(Date.now() + MCP_WATCH_MS);
        if (answer.url) {
          setLinks((l) => ({ ...l, [server]: answer.url! }));
          openWebLink(answer.url);
        }
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(null));
  };

  const add = async (draft: McpServerDraft) => {
    const next = await api.addMcpServer(id, draft, cwd);
    setCatalog(next);
    setError(null);
    setAdding(false);
    setPicked(draft.name);
  };

  const remove = async (name: string) => {
    setBusy(name);
    try {
      setCatalog(await api.removeMcpServer(id, name, cwd));
      setError(null);
      setPicked(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // The server picked, else the first: the details are never empty while
  // there is a server to speak of.
  const shown = servers?.find((s) => s.name === picked) ?? servers?.[0] ?? null;
  const totals = useMemo(() => (servers ? mcpTotalsLine(mcpTotals(servers), catalog?.contextWindow) : null), [servers, catalog?.contextWindow]);
  const where = folder ? abbreviatePath(folder, homeDir, 48) : null;

  return createPortal(
    <div
      className="dialog-backdrop"
      {...backdropDismiss(onClose)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="dialog mcp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="MCP servers"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mcp-dialog-head">
          <div className="mcp-dialog-title">
            <h3>MCP servers</h3>
            <p className="mcp-dialog-where" title={folder ?? undefined}>
              {[agent.label, where].filter(Boolean).join(" · ")}
            </p>
          </div>
          {can && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!catalog || adding}
              onClick={() => setAdding(true)}
            >
              <Plus size={14} aria-hidden="true" />
              Add server
            </button>
          )}
          <button type="button" className="ibtn" aria-label="Close" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <p className="mcp-dialog-totals" aria-live="polite">
          {totals ?? (error ? "" : "Asking the agent for its MCP servers…")}
        </p>
        {error && !catalog ? (
          <p className="error mcp-dialog-error" role="alert">
            {error}
          </p>
        ) : (
          <div className="mcp-dialog-body">
            <ul className="agent-mcp-list mcp-dialog-list" aria-label="Servers">
              {(servers ?? []).map((s) => (
                <McpServerRow
                  key={s.name}
                  server={s}
                  busy={busy === s.name}
                  link={links[s.name]}
                  onAction={act}
                  selected={!adding && shown?.name === s.name}
                  onSelect={(name) => {
                    setAdding(false);
                    setPicked(name);
                  }}
                />
              ))}
            </ul>
            <div className="mcp-dialog-detail">
              {adding && can ? (
                <McpAddForm
                  can={can}
                  taken={(servers ?? []).map((s) => s.name)}
                  onAdd={add}
                  onCancel={() => setAdding(false)}
                />
              ) : shown ? (
                <McpServerDetails
                  key={shown.name}
                  server={shown}
                  usage={catalog?.usage[shown.name]}
                  usageSince={catalog?.usageSince}
                  contextWindow={catalog?.contextWindow}
                  busy={busy === shown.name}
                  onDelete={() => void remove(shown.name)}
                />
              ) : servers ? (
                <p className="hint mcp-dialog-empty">
                  {agent.label} has no MCP servers for this folder.{can ? " Add server sets one up." : ""}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// --- One server's details -------------------------------------------------------------

/** The details pane: what the agent knows of the server, its tools with
    their cost and use, and Delete where the agent can delete it. */
export function McpServerDetails({
  server,
  usage,
  usageSince,
  contextWindow,
  busy = false,
  onDelete,
}: {
  server: McpServerDetail;
  usage?: McpServerUsage;
  /** When the oldest counted session started; absent while none was counted. */
  usageSince?: string;
  contextWindow?: number;
  busy?: boolean;
  onDelete: () => void;
}) {
  /** Delete asks once more, in place. */
  const [confirming, setConfirming] = useState(false);
  const facts: [string, string][] = [];
  // Where the agent can delete it from, else where the agent says it comes from.
  if (server.scope) facts.push(["Kept in", MCP_SCOPE_LABEL[server.scope]]);
  else if (server.source) facts.push(["From", server.source]);
  const kind = transportWords(server.transport);
  if (kind) facts.push(["Kind", kind]);
  if (server.command) facts.push(["Command", [server.command, ...(server.args ?? [])].join(" ")]);
  if (server.url) facts.push(["URL", server.url]);
  if (server.envNames?.length) facts.push(["Environment", server.envNames.join(", ")]);
  if (server.headerNames?.length) facts.push(["Headers", server.headerNames.join(", ")]);
  const itself = [server.serverName, server.version].filter(Boolean).join(" ");
  if (itself) facts.push(["Server", itself]);

  const loaded = server.context?.loaded ?? 0;
  const deferred = server.context?.deferred ?? 0;
  const rows = mcpToolRows(server.toolList, usage);
  const share = contextWindow && loaded > 0 ? Math.min(100, (100 * loaded) / contextWindow) : 0;

  return (
    <section className="mcp-detail" aria-label={`${server.name} details`} data-server={server.name}>
      <header className="mcp-detail-head">
        <h4>{server.name}</h4>
        <span className="mcp-detail-status" data-status={server.status}>
          {mcpStatusWords(server)}
        </span>
      </header>
      {server.status === "failed" && server.error && (
        <p className="error mcp-detail-error" role="alert">
          {server.error}
        </p>
      )}
      {facts.length > 0 && (
        <dl className="mcp-detail-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <h5>Context</h5>
      {server.context ? (
        <div className="mcp-detail-context">
          {contextWindow && loaded > 0 ? (
            <div
              className="mcp-detail-bar"
              role="img"
              aria-label={`${formatPercent(loaded, contextWindow)} of the context window`}
            >
              <span style={{ width: `${share}%` }} />
            </div>
          ) : null}
          <p>
            {loaded > 0
              ? `${formatTokens(loaded)} tokens in a new session${contextWindow ? ` · ${formatPercent(loaded, contextWindow)} of the window` : ""}`
              : "Nothing in a new session"}
            {deferred > 0 ? ` · ${formatTokens(deferred)} more once its tools load` : ""}
          </p>
        </div>
      ) : (
        <p className="hint">
          {server.status === "connected" ? "The agent did not say what its tools cost." : "Counted once the server is connected."}
        </p>
      )}

      <h5>Usage</h5>
      {usage ? (
        <p className="mcp-detail-usage">
          {count(usage.calls, "call")} in {count(usage.sessions, "session")}
          {usage.errors > 0 ? ` · ${count(usage.errors, "error")}` : ""}
          {usage.lastAt ? ` · last used ${formatMoment(usage.lastAt)}` : ""}
        </p>
      ) : (
        <p className="hint mcp-detail-usage">No calls counted yet.</p>
      )}
      <p className="hint mcp-detail-since">
        {usageSince
          ? `Counted in the sessions run here since ${formatDay(usageSince)}.`
          : "The app counts the calls of the sessions it runs in this folder, from now on."}
      </p>

      {rows.length > 0 && (
        <>
          <h5>Tools ({rows.length})</h5>
          <div className="mcp-detail-tools-scroll">
            <table className="mcp-detail-tools">
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col" className="num">
                    Tokens
                  </th>
                  <th scope="col" className="num">
                    Calls
                  </th>
                  <th scope="col" className="num">
                    Errors
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.name} data-tool={t.name}>
                    <td title={t.name}>{t.name}</td>
                    <td className="num">
                      {t.tokens === undefined ? "–" : formatTokens(t.tokens)}
                      {t.loaded === false ? <span className="mcp-detail-deferred"> on demand</span> : null}
                    </td>
                    <td className="num">{t.calls}</td>
                    <td className="num">{t.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {server.canDelete && (
        <div className="mcp-detail-actions">
          {confirming ? (
            <>
              <span className="mcp-detail-confirm">
                Delete {server.name}
                {server.scope ? ` from ${MCP_SCOPE_FROM[server.scope]}` : ""}?
              </span>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={onDelete}>
                Delete
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirming(true)}>
              Delete server…
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// --- The form that adds one --------------------------------------------------------------

export function McpAddForm({
  can,
  taken,
  onAdd,
  onCancel,
}: {
  can: McpManageCapability;
  /** The names the agent already lists. */
  taken: readonly string[];
  /** Rejects with the agent's words when it refuses the server. */
  onAdd: (draft: McpServerDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [fields, setFields] = useState<McpDraftFields>(() => ({
    name: "",
    scope: can.scopes[0] ?? "local",
    transport: can.transports[0] ?? "stdio",
    command: "",
    args: "",
    env: "",
    url: "",
    headers: "",
  }));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof McpDraftFields>(key: K, value: McpDraftFields[K]) => {
    setFields((f) => ({ ...f, [key]: value }));
    setProblem(null);
  };
  const stdio = fields.transport === "stdio";

  const submit = async () => {
    const draft = draftOf(fields, can, taken);
    if (typeof draft === "string") {
      setProblem(draft);
      return;
    }
    setSaving(true);
    try {
      await onAdd(draft);
    } catch (e) {
      setProblem((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <form
      className="mcp-add-form"
      aria-label="Add an MCP server"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h4>Add an MCP server</h4>
      <label className="mcp-add-field">
        <span>Name</span>
        <input
          type="text"
          name="mcp-name"
          value={fields.name}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="letters, numbers, - and _"
          onChange={(e) => set("name", e.target.value)}
        />
      </label>
      <fieldset className="mcp-add-choice">
        <legend>Where it is kept</legend>
        {can.scopes.map((scope) => (
          <label key={scope}>
            <input
              type="radio"
              name="mcp-scope"
              value={scope}
              checked={fields.scope === scope}
              onChange={() => set("scope", scope)}
            />
            <span>{MCP_SCOPE_LABEL[scope]}</span>
          </label>
        ))}
        <p className="hint" data-scope={fields.scope}>
          {MCP_SCOPE_HINT[fields.scope]}
        </p>
      </fieldset>
      <fieldset className="mcp-add-choice mcp-add-kind">
        <legend>Kind</legend>
        {can.transports.map((transport) => (
          <label key={transport}>
            <input
              type="radio"
              name="mcp-transport"
              value={transport}
              checked={fields.transport === transport}
              onChange={() => set("transport", transport)}
            />
            <span>{MCP_TRANSPORT_LABEL[transport]}</span>
          </label>
        ))}
      </fieldset>
      {stdio ? (
        <>
          <label className="mcp-add-field">
            <span>Command</span>
            <input
              type="text"
              name="mcp-command"
              value={fields.command}
              autoComplete="off"
              spellCheck={false}
              placeholder="npx"
              onChange={(e) => set("command", e.target.value)}
            />
          </label>
          <label className="mcp-add-field">
            <span>Arguments, one per line</span>
            <textarea
              name="mcp-args"
              rows={3}
              value={fields.args}
              spellCheck={false}
              placeholder={"-y\n@example/mcp-server"}
              onChange={(e) => set("args", e.target.value)}
            />
          </label>
          <label className="mcp-add-field">
            <span>Environment, NAME=value per line</span>
            <textarea
              name="mcp-env"
              rows={2}
              value={fields.env}
              spellCheck={false}
              placeholder="API_KEY=…"
              onChange={(e) => set("env", e.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <label className="mcp-add-field">
            <span>URL</span>
            <input
              type="text"
              name="mcp-url"
              value={fields.url}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/mcp"
              onChange={(e) => set("url", e.target.value)}
            />
          </label>
          <label className="mcp-add-field">
            <span>Headers, Name: value per line</span>
            <textarea
              name="mcp-headers"
              rows={2}
              value={fields.headers}
              spellCheck={false}
              placeholder="Authorization: Bearer …"
              onChange={(e) => set("headers", e.target.value)}
            />
          </label>
        </>
      )}
      {problem && (
        <p className="error mcp-add-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Adding…" : "Add server"}
        </button>
      </div>
    </form>
  );
}

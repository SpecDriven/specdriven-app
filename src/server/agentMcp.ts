// The MCP servers the core asks an agent to start beside itself
// (specs/external-links/confluence-wiki.feature.md "An agent session can
// read the wiki", specs/agents/agent-plugins.feature.md): today one, the
// Confluence server (src/mcp), offered while Confluence is switched on in
// Settings and a wiki token is saved. The
// provider runs the command however its agent takes MCP servers; the core
// only says what to run and where the tokens are.
//
// The web server points the command at its own source and the server at
// its own token file. The desktop app, which keeps tokens OS-encrypted and
// runs no bun, sets both (src/electron/main.ts): its bundle run as node, and
// a 0600 file it writes while it runs.

import { fileURLToPath } from "node:url";
import type { AgentMcpServer } from "./agentTypes";
import { confluenceTokenPath, listConfluenceTokens } from "./confluenceTokens";
import { isDemoMode } from "./demoMode";
import { isHostedMode } from "./hostedMode";
import { getAppRoot } from "./paths";
import { normalizeConfluenceEnabled, readState } from "./state";
import { CONFLUENCE_MCP_SERVER, CONFLUENCE_TOKENS_FILE_ENV } from "../mcp/confluenceTools";

/** How to start the Confluence server on this install. */
export interface McpLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const defaultLauncher = (): McpLaunch => ({
  command: process.execPath,
  args: [fileURLToPath(new URL("../mcp/confluence.ts", import.meta.url))],
});

let launcher: () => McpLaunch = defaultLauncher;
let tokensFile: () => Promise<string> = async () => confluenceTokenPath();

/** How the Confluence server is started here; null restores `bun src/mcp/confluence.ts`. */
export function setConfluenceMcpLauncher(fn: (() => McpLaunch) | null): void {
  launcher = fn ?? defaultLauncher;
}

/** Where the server finds the tokens; null restores the app's own token file. */
export function setConfluenceMcpTokensFile(fn: (() => Promise<string>) | null): void {
  tokensFile = fn ?? (async () => confluenceTokenPath());
}

/**
 * The servers a session starting now should have: none while Confluence is
 * switched off in Settings (specs/external-links/confluence-wiki.feature.md),
 * none without a wiki token, none in the demo or hosted app.
 */
export async function agentMcpServers(): Promise<AgentMcpServer[]> {
  if (isDemoMode() || isHostedMode()) return [];
  if (!normalizeConfluenceEnabled((await readState(getAppRoot())).confluenceEnabled)) return [];
  if ((await listConfluenceTokens()).length === 0) return [];
  const launch = launcher();
  return [
    {
      name: CONFLUENCE_MCP_SERVER,
      command: launch.command,
      args: [...launch.args],
      env: { ...launch.env, [CONFLUENCE_TOKENS_FILE_ENV]: await tokensFile() },
    },
  ];
}

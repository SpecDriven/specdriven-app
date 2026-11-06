// The Confluence MCP server as a process (specs/external-links/confluence-
// wiki.feature.md "An agent session can read the wiki"): `bun src/mcp/
// confluence.ts`, or the bundle the desktop app runs as node. Speaks MCP
// over stdio until the agent closes it.

import "./stdoutGuard";
import { runConfluenceMcpServer } from "./confluenceServer";

await runConfluenceMcpServer();

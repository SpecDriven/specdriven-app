// The Confluence MCP server (specs/external-links/confluence-wiki.feature.md
// "An agent session can read the wiki"): three read-only tools over the
// wikis the user saved a token for, served to any agent that speaks MCP —
// the Claude and Codex panes, a terminal Claude Code session. The tokens are
// read from a file on every call: the app's own token file, or the one the
// desktop app writes while it runs (SPECDRIVEN_CONFLUENCE_TOKENS_FILE), so
// a token saved mid-session counts at once and none is kept in memory
// longer than a call.
//
// Node APIs only: the desktop app runs the bundle as node.

import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { version } from "../../package.json";
import { ConfluenceError, getPageBody, listChildren, resolveParent, searchPages } from "../server/confluence";
import { confluenceTokenPath, parseConfluenceRecords } from "../server/confluenceTokens";
import { htmlToMarkdown } from "../server/html";
import {
  CONFLUENCE_MCP_SERVER,
  CONFLUENCE_TOKENS_FILE_ENV,
  ToolError,
  hitLines,
  pageRef,
  pageText,
  serverInstructions,
  wikiFor,
  type Wiki,
} from "./confluenceTools";

/** The token file the environment names, else the app's own. */
export function tokensFileFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env[CONFLUENCE_TOKENS_FILE_ENV] || confluenceTokenPath();
}

/** The wikis a token file holds right now; none when it is missing or corrupt. */
export async function readWikis(file: string): Promise<Wiki[]> {
  const raw = await readFile(file, "utf8").catch(() => "");
  return (parseConfluenceRecords(raw) ?? []).map(({ base, token }) => ({ base, token }));
}

export interface ConfluenceMcpOptions {
  /** Where the tokens are read from; default the environment's file, else the app's. */
  tokensFile?: string;
  /** The wikis, in place of the file (tests). */
  wikis?: () => Promise<Wiki[]>;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

/** A tool's answer: its text, or the refusal as text with isError — never a thrown error. */
async function answer(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (e) {
    const message = e instanceof ToolError || e instanceof ConfluenceError ? e.message : ((e as Error).message ?? String(e));
    return { ...text(message), isError: true };
  }
}

const pageArgs = {
  url: z.string().optional().describe("The page's link, e.g. https://wiki.acme.com/spaces/KEY/pages/123/Title"),
  id: z.string().optional().describe("The page's id, instead of a link"),
  base: z.string().optional().describe("The wiki's base url, with id, when several wikis are saved"),
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** The server, its tools registered; connect it to a transport to serve. */
export async function createConfluenceMcpServer(opts: ConfluenceMcpOptions = {}): Promise<McpServer> {
  const file = opts.tokensFile ?? tokensFileFromEnv();
  const wikis = opts.wikis ?? (() => readWikis(file));
  const server = new McpServer(
    { name: CONFLUENCE_MCP_SERVER, version },
    { instructions: serverInstructions(await wikis()) },
  );

  server.registerTool(
    "get_page",
    {
      title: "Read a Confluence page",
      description:
        "A Confluence page's title and body as markdown, by its link (url) or by its id. With id, pass base (the wiki's url) when several wikis are saved.",
      inputSchema: pageArgs,
      annotations: readOnly,
    },
    (args) =>
      answer(async () => {
        const { wiki, ref } = pageRef(await wikis(), args);
        const { id } = await resolveParent(wiki.base, wiki.token, ref);
        const page = await getPageBody(wiki.base, wiki.token, id);
        return pageText(page, htmlToMarkdown(page.html));
      }),
  );

  server.registerTool(
    "search_pages",
    {
      title: "Search Confluence pages",
      description:
        "The Confluence pages whose text matches a query (words, a phrase), as a list of links with each page's id and space. Narrow it to one space with space (its key).",
      inputSchema: {
        query: z.string().min(1).describe("Words or a phrase to find in page text"),
        space: z.string().optional().describe("A space key to search within"),
        base: z.string().optional().describe("The wiki's base url, when several wikis are saved"),
        limit: z.number().int().min(1).max(50).optional().describe("How many pages at most; default 10"),
      },
      annotations: readOnly,
    },
    (args) =>
      answer(async () => {
        const wiki = wikiFor(await wikis(), args.base);
        const hits = await searchPages(wiki.base, wiki.token, args.query, {
          ...(args.space ? { spaceKey: args.space } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        });
        return hitLines(hits, `No page on ${wiki.base} matches "${args.query}".`);
      }),
  );

  server.registerTool(
    "list_children",
    {
      title: "List a Confluence page's child pages",
      description: "The pages directly under a Confluence page, by the page's link (url) or id, as a list of links with each page's id and space.",
      inputSchema: {
        ...pageArgs,
        limit: z.number().int().min(1).max(200).optional().describe("How many pages at most; default 50"),
      },
      annotations: readOnly,
    },
    (args) =>
      answer(async () => {
        const { wiki, ref } = pageRef(await wikis(), args);
        const { id } = await resolveParent(wiki.base, wiki.token, ref);
        const hits = await listChildren(wiki.base, wiki.token, id, args.limit ? { limit: args.limit } : {});
        return hitLines(hits, `Page ${id} has no child pages.`);
      }),
  );

  return server;
}

/** Serve over stdio until the other end closes. */
export async function runConfluenceMcpServer(opts: ConfluenceMcpOptions = {}): Promise<void> {
  const server = await createConfluenceMcpServer(opts);
  await server.connect(new StdioServerTransport());
}

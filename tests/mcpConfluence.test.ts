// Automates specs/external-links/confluence-wiki.feature.md "An agent
// session can read the wiki" at the server's edge: the Confluence MCP server
// (src/mcp) over an in-memory transport and over stdio as an agent would
// start it, against a loopback wiki that answers as Server / Data Center
// 7.19 does. The pure helpers that pick a wiki and shape the text are
// covered on their own.

import { test, expect, beforeAll, afterAll, beforeEach, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConfluenceMcpServer, readWikis, tokensFileFromEnv } from "../src/mcp/confluenceServer";
import { confluenceTokenPath } from "../src/server/confluenceTokens";
import {
  CONFLUENCE_MCP_SERVER,
  CONFLUENCE_TOKENS_FILE_ENV,
  PAGE_TEXT_MAX,
  ToolError,
  hitLines,
  pageRef,
  pageText,
  serverInstructions,
  truncate,
  wikiFor,
} from "../src/mcp/confluenceTools";

const GOOD = "pat-good";

interface StubPage {
  id: string;
  title: string;
  spaceKey: string;
  parent?: string;
  html: string;
  by?: string;
  when?: string;
}

let server: ReturnType<typeof Bun.serve>;
let wiki: string;
let pages: Map<string, StubPage>;
let seen: string[];

function rawPage(p: StubPage, body = false) {
  const ancestors = [];
  for (let at = p.parent; at; at = pages.get(at)?.parent) ancestors.unshift({ id: at });
  return {
    id: p.id,
    type: "page",
    title: p.title,
    space: { key: p.spaceKey },
    version: { number: 3, ...(p.by ? { by: { displayName: p.by } } : {}), ...(p.when ? { when: p.when } : {}) },
    ancestors,
    ...(body ? { body: { export_view: { value: p.html, representation: "export_view" } } } : {}),
    _links: { base: wiki, webui: `/spaces/${p.spaceKey}/pages/${p.id}/${p.title.replace(/ /g, "+")}` },
  };
}

const problem = (status: number, message: string) => Response.json({ statusCode: status, message }, { status });

function stubConfluence(): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.pathname + url.search);
      if (req.headers.get("authorization") !== `Bearer ${GOOD}`) return problem(401, "Unauthorized");
      if (url.pathname === "/rest/api/user/current") return Response.json({ type: "known", username: "dv", displayName: "David V" });
      if (url.pathname === "/rest/api/content/search") {
        const cql = url.searchParams.get("cql") ?? "";
        const text = /text ~ "((?:[^"\\]|\\.)*)"/.exec(cql)?.[1]?.replace(/\\(.)/g, "$1").toLowerCase() ?? "";
        const space = /space="([^"]*)"/.exec(cql)?.[1];
        const limit = Number(url.searchParams.get("limit") ?? 25);
        const results = [...pages.values()]
          .filter((p) => (p.title + " " + p.html).toLowerCase().includes(text))
          .filter((p) => !space || p.spaceKey === space)
          .slice(0, limit)
          .map((p) => rawPage(p));
        return Response.json({ results, size: results.length });
      }
      const children = url.pathname.match(/^\/rest\/api\/content\/(\d+)\/child\/page$/);
      if (children) {
        if (!pages.has(children[1]!)) return problem(404, "No content found with id");
        const all = [...pages.values()].filter((p) => p.parent === children[1]);
        const start = Number(url.searchParams.get("start") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 25);
        const results = all.slice(start, start + limit).map((p) => rawPage(p));
        const more = start + limit < all.length;
        return Response.json({ results, size: results.length, _links: more ? { next: `/rest/api/content/${children[1]}/child/page?start=${start + limit}` } : {} });
      }
      const one = url.pathname.match(/^\/rest\/api\/content\/(\d+)$/);
      if (one) {
        const page = pages.get(one[1]!);
        if (!page) return problem(404, "No content found with id");
        return Response.json(rawPage(page, (url.searchParams.get("expand") ?? "").includes("body")));
      }
      if (url.pathname === "/rest/api/content") {
        const key = url.searchParams.get("spaceKey");
        const title = url.searchParams.get("title");
        const results = [...pages.values()].filter((p) => p.spaceKey === key && p.title === title).map((p) => rawPage(p));
        return Response.json({ results, size: results.length });
      }
      return problem(404, "Not found");
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

beforeAll(() => {
  wiki = stubConfluence();
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  seen = [];
  pages = new Map(
    [
      { id: "100", title: "Design", spaceKey: "DEV", html: "<h1>Overview</h1><p>The design of the <b>quote</b> flow.</p><ul><li>one</li><li>two</li></ul>", by: "Jane Doe", when: "2026-10-01T10:00:00.000Z" },
      { id: "101", title: "Quote API", spaceKey: "DEV", parent: "100", html: "<p>Endpoints for quotes.</p>" },
      { id: "102", title: "Quote UI", spaceKey: "DEV", parent: "100", html: "<p>Screens.</p>" },
      { id: "200", title: "Quotes FAQ", spaceKey: "HELP", html: "<p>Questions about quotes.</p>" },
    ].map((p) => [p.id, p] as const),
  );
});

const wikis = () => Promise.resolve([{ base: wiki, token: GOOD }]);

type ToolText = { content: { type: string; text?: string }[]; isError?: boolean };

/** A client talking to a fresh server in this process. */
async function connect(records = wikis): Promise<{ client: Client; call: (name: string, args: Record<string, unknown>) => Promise<ToolText> }> {
  const mcp = await createConfluenceMcpServer({ wikis: records });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return { client, call: (name, args) => client.callTool({ name, arguments: args }) as Promise<ToolText> };
}

const textOf = (r: ToolText) => r.content.map((c) => c.text ?? "").join("\n");

describe("picking the wiki and the page", () => {
  const a = { base: "https://wiki.a.com", token: "ta" };
  const b = { base: "https://wiki.b.com/confluence", token: "tb" };

  test("no token saved is said in so many words", () => {
    expect(() => wikiFor([])).toThrow(/No Confluence token is saved/);
  });

  test("one wiki needs no base; several do, and the message lists them", () => {
    expect(wikiFor([a])).toBe(a);
    expect(() => wikiFor([a, b])).toThrow(/pass base.*wiki\.a\.com, https:\/\/wiki\.b\.com\/confluence/);
    expect(wikiFor([a, b], "https://WIKI.B.com/confluence/")).toBe(b);
    expect(() => wikiFor([a, b], "https://other.com")).toThrow(/No token is saved for https:\/\/other\.com/);
  });

  test("a page url picks its wiki and names the page", () => {
    expect(pageRef([a, b], { url: "https://wiki.b.com/confluence/spaces/X/pages/42/Title" })).toEqual({
      wiki: b,
      ref: { base: b.base, spaceKey: "X", pageId: "42" },
    });
    expect(pageRef([a], { url: "https://wiki.a.com/display/X/Some+Title" }).ref).toEqual({ base: a.base, spaceKey: "X", title: "Some Title" });
    expect(() => pageRef([a], { url: "https://wiki.a.com/" })).toThrow(ToolError);
    expect(() => pageRef([a], { url: "https://other.com/spaces/X/pages/1/T" })).toThrow(/No token is saved for https:\/\/other\.com/);
  });

  test("an id names a page on the one wiki, or on base", () => {
    expect(pageRef([a], { id: "7" })).toEqual({ wiki: a, ref: { base: a.base, pageId: "7" } });
    expect(pageRef([a, b], { id: "7", base: b.base }).wiki).toBe(b);
    expect(() => pageRef([a, b], { id: "7" })).toThrow(/pass base/);
    expect(() => pageRef([a], { id: "seven" })).toThrow(/A page id is a number/);
    expect(() => pageRef([a], {})).toThrow(/Pass url .* or id/);
  });
});

describe("the text a tool hands back", () => {
  test("a long page is cut and says so", () => {
    const long = "x".repeat(PAGE_TEXT_MAX + 5);
    expect(truncate("short")).toBe("short");
    expect(truncate(long)).toBe(`${"x".repeat(PAGE_TEXT_MAX)}\n\n[Truncated: 60,000 of 60,005 characters shown.]`);
  });

  test("hits are a list of links, with who changed them when known", () => {
    expect(hitLines([], "none here")).toBe("none here");
    expect(
      hitLines(
        [
          { id: "1", title: "A", spaceKey: "S", url: "https://w/a", by: "Jane", when: "2026-10-01T10:00:00Z" },
          { id: "2", title: "B", spaceKey: "S", url: "https://w/b" },
        ],
        "",
      ),
    ).toBe("- [A](https://w/a) — id 1, space S, by Jane on 2026-10-01\n- [B](https://w/b) — id 2, space S");
  });

  test("a page says where it is before what it says", () => {
    expect(pageText({ id: "1", title: "T", url: "https://w/t", html: "", spaceKey: "S", version: 4 }, "body")).toBe(
      "# T\nurl: https://w/t\nid: 1 · space: S · version: 4\n\nbody",
    );
  });

  test("the instructions name the saved wikis, never a token", () => {
    const text = serverInstructions([{ base: "https://wiki.a.com", token: "secret" }]);
    expect(text).toContain("Saved wikis: https://wiki.a.com.");
    expect(text).not.toContain("secret");
    expect(serverInstructions([])).toContain("No wiki has a token saved yet");
  });
});

describe("the server in this process", () => {
  test("three read-only tools, under the server's name", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["get_page", "list_children", "search_pages"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toContain(`Saved wikis: ${wiki}.`);
    expect(CONFLUENCE_MCP_SERVER).toBe("specdriven-confluence");
  });

  test("get_page reads a page by its link as markdown", async () => {
    const { call } = await connect();
    const got = await call("get_page", { url: `${wiki}/spaces/DEV/pages/100/Design` });
    expect(got.isError).toBeFalsy();
    const text = textOf(got);
    expect(text).toContain("# Design");
    expect(text).toContain(`url: ${wiki}/spaces/DEV/pages/100/Design`);
    expect(text).toContain("id: 100 · space: DEV · version: 3");
    expect(text).toContain("The design of the **quote** flow.");
    expect(text).toContain("- one\n- two");
    expect(seen.some((p) => p.startsWith("/rest/api/content/100?expand=body.export_view"))).toBe(true);
  });

  test("get_page reads a page by id, and by its title url", async () => {
    const { call } = await connect();
    expect(textOf(await call("get_page", { id: "101" }))).toContain("Endpoints for quotes.");
    expect(textOf(await call("get_page", { url: `${wiki}/display/HELP/Quotes+FAQ` }))).toContain("Questions about quotes.");
  });

  test("a page Confluence has not is a refusal, not a crash", async () => {
    const { call } = await connect();
    const got = await call("get_page", { id: "999" });
    expect(got.isError).toBe(true);
    expect(textOf(got)).toMatch(/no page 999/);
    const bad = await call("get_page", { url: "https://elsewhere.com/spaces/X/pages/1/T" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("No token is saved for https://elsewhere.com");
  });

  test("a rejected token is said as Confluence's refusal", async () => {
    const { call } = await connect(() => Promise.resolve([{ base: wiki, token: "pat-stale" }]));
    const got = await call("get_page", { id: "100" });
    expect(got.isError).toBe(true);
    expect(textOf(got)).toContain("rejected the token");
  });

  test("search_pages finds pages by text, within a space when asked", async () => {
    const { call } = await connect();
    const all = textOf(await call("search_pages", { query: "quotes" }));
    expect(all).toContain(`- [Quote API](${wiki}/spaces/DEV/pages/101/Quote+API) — id 101, space DEV`);
    expect(all).toContain("- [Quotes FAQ](");
    const dev = textOf(await call("search_pages", { query: "quotes", space: "DEV", limit: 5 }));
    expect(dev).toContain("Quote API");
    expect(dev).not.toContain("Quotes FAQ");
    expect(decodeURIComponent(seen.at(-1)!)).toContain('cql=type=page AND text ~ "quotes" AND space="DEV"&limit=5');
    expect(textOf(await call("search_pages", { query: "nothing like this" }))).toBe(`No page on ${wiki} matches "nothing like this".`);
  });

  test("list_children lists the pages under a page, following Confluence's pages of results", async () => {
    const { call } = await connect();
    const text = textOf(await call("list_children", { url: `${wiki}/pages/viewpage.action?pageId=100` }));
    expect(text).toBe(
      [
        `- [Quote API](${wiki}/spaces/DEV/pages/101/Quote+API) — id 101, space DEV`,
        `- [Quote UI](${wiki}/spaces/DEV/pages/102/Quote+UI) — id 102, space DEV`,
      ].join("\n"),
    );
    expect(textOf(await call("list_children", { id: "101" }))).toBe("Page 101 has no child pages.");
    for (let i = 0; i < 120; i++) pages.set(`5${i}`, { id: `5${i}`, title: `Child ${i}`, spaceKey: "DEV", parent: "200", html: "" });
    const many = textOf(await call("list_children", { id: "200", limit: 150 }));
    expect(many.split("\n")).toHaveLength(120);
    expect(seen.filter((p) => p.startsWith("/rest/api/content/200/child/page")).length).toBe(2);
  });
});

describe("the token file", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "specdriven-mcp-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the environment names it, else the app's own file", () => {
    expect(tokensFileFromEnv({ [CONFLUENCE_TOKENS_FILE_ENV]: "/x/tokens.json" })).toBe("/x/tokens.json");
    expect(tokensFileFromEnv({})).toBe(confluenceTokenPath());
  });

  test("a missing or corrupt file is no wikis; a good one its records", async () => {
    expect(await readWikis(join(dir, "none.json"))).toEqual([]);
    await writeFile(join(dir, "bad.json"), "{");
    expect(await readWikis(join(dir, "bad.json"))).toEqual([]);
    await writeFile(join(dir, "ok.json"), JSON.stringify([{ base: "https://w", token: "t", user: "me" }]));
    expect(await readWikis(join(dir, "ok.json"))).toEqual([{ base: "https://w", token: "t" }]);
  });

  test("over stdio, as an agent starts it, the tokens come from the file the environment names", async () => {
    const file = join(dir, "tokens.json");
    await writeFile(file, JSON.stringify([{ base: wiki, token: GOOD, user: "David V" }]));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, "..", "src", "mcp", "confluence.ts")],
      env: { ...(process.env as Record<string, string>), [CONFLUENCE_TOKENS_FILE_ENV]: file },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["get_page", "list_children", "search_pages"]);
      const got = (await client.callTool({ name: "get_page", arguments: { id: "102" } })) as ToolText;
      expect(got.isError).toBeFalsy();
      expect(textOf(got)).toContain("Screens.");
      // A token saved while the server runs counts on the next call.
      await writeFile(file, "[]");
      const none = (await client.callTool({ name: "get_page", arguments: { id: "102" } })) as ToolText;
      expect(none.isError).toBe(true);
      expect(textOf(none)).toContain("No Confluence token is saved");
    } finally {
      await client.close();
    }
  }, 20_000);
});

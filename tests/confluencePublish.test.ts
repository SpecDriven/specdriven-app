// Automates specs/external-links/confluence-wiki.feature.md through the
// routes: a token per wiki kept on this device after Confluence accepts it,
// a feature published as a page under a parent page — created, then updated
// — and linked back from the feature. Confluence is a loopback stub that
// keeps its pages in memory, answers as Server / Data Center 7.19 does, and
// records what it was sent.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { createFeature, readFeature, readFeatureView, saveFeature } from "../src/server/features";
import { readState, writeState } from "../src/server/state";
import { setProjectionOptions, projectionOptions } from "../src/server/automerge/project";
import {
  confluenceToken,
  createConfluenceFileBackend,
  setConfluenceTokenBackend,
} from "../src/server/confluenceTokens";

const GOOD = "pat-good";
const ANON = "pat-anonymous";
const FILE = "specs/quote-policy.feature.md";

const SAMPLE = `# Quote Policy

Quotes for potential customers.

## Basic Quote @v1 [proposed]

- **Given** a potential customer has an account
- **Then** a quote is provided

## Declined Quote @v2 [published]

- **Given** the customer has no account
`;

interface StubPage {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  ancestors: string[];
  body: string;
}

let server: ReturnType<typeof Bun.serve>;
let wiki: string;
let pages: Map<string, StubPage>;
let nextId: number;
let seen: { method: string; path: string; auth: string | null; body: unknown }[];

function rawPage(p: StubPage) {
  return {
    id: p.id,
    type: "page",
    title: p.title,
    space: { key: p.spaceKey },
    version: { number: p.version },
    ancestors: p.ancestors.map((id) => ({ id })),
    _links: { base: wiki, webui: `/spaces/${p.spaceKey}/pages/${p.id}/${encodeURIComponent(p.title)}` },
  };
}

const problem = (status: number, message: string) => Response.json({ statusCode: status, message }, { status });

function ancestorsOf(parentId: string): string[] {
  const parent = pages.get(parentId);
  return parent ? [...parent.ancestors, parent.id] : [parentId];
}

function stubConfluence(): string {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      seen.push({ method: req.method, path: url.pathname + url.search, auth, body });
      if (url.pathname === "/rest/api/user/current") {
        if (auth === `Bearer ${ANON}`) return Response.json({ type: "anonymous", username: "anonymous" });
        if (auth !== `Bearer ${GOOD}`) return problem(401, "Unauthorized");
        return Response.json({ type: "known", username: "dvydra", displayName: "David V" });
      }
      if (auth !== `Bearer ${GOOD}`) return problem(401, "Unauthorized");
      if (url.pathname === "/rest/api/content" && req.method === "GET") {
        const key = url.searchParams.get("spaceKey");
        const title = url.searchParams.get("title");
        const results = [...pages.values()].filter((p) => p.spaceKey === key && p.title === title).map(rawPage);
        return Response.json({ results, size: results.length });
      }
      if (url.pathname === "/rest/api/content" && req.method === "POST") {
        const b = body as { title: string; space: { key: string }; ancestors: { id: string }[]; body: { storage: { value: string } } };
        if ([...pages.values()].some((p) => p.spaceKey === b.space.key && p.title === b.title)) {
          return problem(400, "A page with this title already exists");
        }
        const page: StubPage = {
          id: String(nextId++),
          title: b.title,
          spaceKey: b.space.key,
          version: 1,
          ancestors: ancestorsOf(b.ancestors[0]!.id),
          body: b.body.storage.value,
        };
        pages.set(page.id, page);
        return Response.json(rawPage(page));
      }
      const m = url.pathname.match(/^\/rest\/api\/content\/(\d+)$/);
      if (m) {
        const page = pages.get(m[1]!);
        if (!page) return problem(404, "No content found");
        if (req.method === "GET") return Response.json(rawPage(page));
        if (req.method === "PUT") {
          const b = body as { title: string; version: { number: number }; ancestors: { id: string }[]; body: { storage: { value: string } } };
          if (b.version.number !== page.version + 1) return problem(409, "Version must be incremented");
          Object.assign(page, {
            title: b.title,
            version: b.version.number,
            ancestors: ancestorsOf(b.ancestors[0]!.id),
            body: b.body.storage.value,
          });
          return Response.json(rawPage(page));
        }
      }
      return problem(404, "Not found");
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

let root: string;
let home: string;
let data: string;
const defaults = projectionOptions();
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const realHosted = process.env.SPECDRIVEN_HOSTED;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-confluence-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-confluence-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  setConfluenceTokenBackend(createConfluenceFileBackend(join(home, "confluence-tokens.json")));
  data = join(root, "data");
  await createFeature(data, "Quote Policy");
  await saveFeature(data, FILE, SAMPLE);
  await writeState({ dataRepo: data }, root);
  pages = new Map();
  nextId = 100;
  seen = [];
  wiki = stubConfluence();
  pages.set("1", { id: "1", title: "Specs", spaceKey: "ABC", version: 1, ancestors: [], body: "" });
  pages.set("2", { id: "2", title: "Archive", spaceKey: "ABC", version: 1, ancestors: [], body: "" });
});

afterEach(async () => {
  reloader.stop();
  server.stop(true);
  setProjectionOptions(defaults);
  setConfluenceTokenBackend(createConfluenceFileBackend());
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
    ["SPECDRIVEN_HOSTED", realHosted],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = (await handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  ))!;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const saveToken = (token = GOOD, base = wiki) => call("POST", "/api/confluence/tokens", { base, token });
const publish = (parentUrl: string, scope: string = "all") =>
  call("POST", `/api/features/${encodeURIComponent(FILE)}/confluence`, { parentUrl, scope });
const parentUrl = () => `${wiki}/spaces/ABC/pages/1/Specs`;

describe("Confluence tokens", () => {
  test("a token Confluence accepts is kept, owner-only, and listed without the token", async () => {
    const saved = await saveToken(GOOD, `${wiki}/spaces/ABC/pages/1/Specs`);
    expect(saved).toEqual({ status: 200, body: { base: wiki, user: "David V" } });
    expect(seen.at(-1)).toMatchObject({ path: "/rest/api/user/current", auth: `Bearer ${GOOD}` });
    const listed = await call("GET", "/api/confluence/tokens");
    expect(listed.body).toEqual({ tokens: [{ base: wiki, user: "David V" }] });
    expect(JSON.stringify(listed.body)).not.toContain(GOOD);
    expect((await stat(join(home, "confluence-tokens.json"))).mode & 0o777).toBe(0o600);
  });

  test("a token Confluence refuses, or answers as anonymous, is not kept", async () => {
    const bad = await saveToken("pat-wrong");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("did not accept this token");
    const anon = await saveToken(ANON);
    expect(anon.status).toBe(400);
    expect(anon.body.error).toContain("did not accept this token");
    expect(await confluenceToken(wiki)).toBeNull();
  });

  test("a blank token or a url that is no wiki is refused before Confluence is asked", async () => {
    expect((await saveToken("  ")).status).toBe(400);
    expect((await saveToken(GOOD, "wiki.acme.com")).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  test("a saved token replaces the wiki's last one, and can be removed", async () => {
    await saveToken();
    await saveToken(GOOD, `${wiki}/`);
    expect((await call("GET", "/api/confluence/tokens")).body.tokens).toHaveLength(1);
    const removed = await call("DELETE", "/api/confluence/tokens", { base: wiki });
    expect(removed.body).toEqual({ tokens: [] });
    expect(await confluenceToken(wiki)).toBeNull();
  });
});

describe("publishing a feature", () => {
  test("creates the page under the parent, links it from the feature and remembers the parent", async () => {
    await saveToken();
    const res = await publish(parentUrl());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "100", created: true, title: "Quote Policy", parentUrl: parentUrl() });
    const pageUrl = `${wiki}/spaces/ABC/pages/100/Quote%20Policy`;
    expect(res.body.url).toBe(pageUrl);

    const post = seen.find((r) => r.method === "POST")!;
    expect(post.auth).toBe(`Bearer ${GOOD}`);
    expect(post.body).toMatchObject({
      type: "page",
      title: "Quote Policy",
      space: { key: "ABC" },
      ancestors: [{ id: "1" }],
      body: { storage: { representation: "storage" } },
    });
    const xhtml = pages.get("100")!.body;
    expect(xhtml).toContain("<h2>Basic Quote</h2>");
    expect(xhtml).toContain("<h2>Declined Quote</h2>");

    const line = `[Confluence:100](${pageUrl})`;
    expect(await readFeature(data, FILE)).toContain(`# Quote Policy\n\n${line}\n\nQuotes for potential customers.`);
    expect((res.body.parsed as { confluence: unknown }).confluence).toEqual({ program: "Confluence", ticket: "100", url: pageUrl });
    expect((await readState(root)).confluenceParentUrl).toBe(parentUrl());
    const state = await call("GET", "/api/state");
    expect(state.body.confluenceParentUrl).toBe(parentUrl());
  });

  test("publishing again updates the page it links, as a new version", async () => {
    await saveToken();
    await publish(parentUrl());
    await saveFeature(data, FILE, (await readFeature(data, FILE))!.replace("is provided", "is emailed"));
    seen = [];
    const again = await publish(parentUrl());
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: "100", created: false });
    const put = seen.find((r) => r.method === "PUT")!;
    expect(put.path).toBe("/rest/api/content/100");
    expect(put.body).toMatchObject({ version: { number: 2 }, ancestors: [{ id: "1" }] });
    expect(seen.some((r) => r.method === "POST")).toBe(false);
    expect(pages.get("100")!.body).toContain("is emailed");
    expect(pages.size).toBe(3);
  });

  test("the linked page moves under a new parent", async () => {
    await saveToken();
    await publish(parentUrl());
    const moved = await publish(`${wiki}/pages/viewpage.action?pageId=2`);
    expect(moved.body).toMatchObject({ id: "100", created: false });
    expect(pages.get("100")!.ancestors).toEqual(["2"]);
  });

  test("a linked page that was deleted is found again by its title, or created anew", async () => {
    await saveToken();
    await publish(parentUrl());
    pages.delete("100");
    const res = await publish(parentUrl());
    expect(res.body).toMatchObject({ id: "101", created: true });
    expect(await readFeature(data, FILE)).toContain("[Confluence:101]");
  });

  test("a page of the same title under the parent is updated rather than duplicated", async () => {
    await saveToken();
    pages.set("50", { id: "50", title: "Quote Policy", spaceKey: "ABC", version: 4, ancestors: ["1"], body: "old" });
    const res = await publish(parentUrl());
    expect(res.body).toMatchObject({ id: "50", created: false });
    expect(pages.get("50")!.version).toBe(5);
  });

  test("a page of the same title elsewhere in the space is not taken over", async () => {
    await saveToken();
    pages.set("50", { id: "50", title: "Quote Policy", spaceKey: "ABC", version: 1, ancestors: ["2"], body: "theirs" });
    const res = await publish(parentUrl());
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already exists elsewhere in space ABC");
    expect(pages.get("50")!.body).toBe("theirs");
    expect(await readFeature(data, FILE)).not.toContain("[Confluence:");
  });

  test("a /display/ parent url is found by its title", async () => {
    await saveToken();
    const res = await publish(`${wiki}/display/ABC/Specs`);
    expect(res.status).toBe(200);
    expect(pages.get(String(res.body.id))!.ancestors).toEqual(["1"]);
    expect(seen.some((r) => r.path.startsWith("/rest/api/content?spaceKey=ABC&title=Specs"))).toBe(true);
  });

  test("published only leaves the proposed scenarios out of the page", async () => {
    await saveToken();
    await publish(parentUrl(), "published");
    const xhtml = pages.get("100")!.body;
    expect(xhtml).toContain("Declined Quote");
    expect(xhtml).not.toContain("Basic Quote");
  });

  test("with Publish external links off the file has no line, but the feature keeps the link", async () => {
    setProjectionOptions({ publishExternalLinks: false });
    await saveToken();
    await publish(parentUrl());
    expect(await readFeature(data, FILE)).not.toContain("[Confluence:");
    expect((await readFeatureView(data, FILE))!.parsed.confluence?.ticket).toBe("100");
  });

  test("what cannot be published says why", async () => {
    expect((await publish(parentUrl())).body.error).toContain("No Confluence token for");
    await saveToken();
    expect((await publish("https://wiki.acme.com/x/abc")).status).toBe(400);
    expect((await publish(parentUrl(), "some")).status).toBe(400);
    const missing = await publish(`${wiki}/spaces/ABC/pages/999/Gone`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain("no page 999");
    const unknown = await call("POST", `/api/features/${encodeURIComponent("specs/nope.feature.md")}/confluence`, {
      parentUrl: parentUrl(),
      scope: "all",
    });
    expect(unknown.status).toBe(404);
  });

  test("a token Confluence no longer accepts is reported as such", async () => {
    await saveToken();
    server.stop(true);
    const port = new URL(wiki).port;
    server = Bun.serve({ port: Number(port), fetch: () => problem(401, "Unauthorized") });
    const res = await publish(parentUrl());
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("save a new one in Settings");
  });

  test("the hosted app refuses Confluence altogether", async () => {
    process.env.SPECDRIVEN_HOSTED = "1";
    expect((await call("GET", "/api/confluence/tokens")).status).toBe(403);
    expect((await saveToken()).status).toBe(403);
    expect((await publish(parentUrl())).status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

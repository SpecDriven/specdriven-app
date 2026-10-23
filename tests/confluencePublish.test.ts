// Automates specs/external-links/confluence-wiki.feature.md through the
// routes: a token per wiki kept on this device after Confluence accepts it,
// a feature published as a page under a parent page — created, then updated
// — and linked back from the feature. Confluence is a loopback stub that
// keeps its pages in memory, answers as Server / Data Center 7.19 does, and
// records what it was sent.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { createFeature, readFeature, readFeatureView, saveConfluencePage, saveFeature } from "../src/server/features";
import { readState, writeState } from "../src/server/state";
import { queryLogs } from "../src/server/logs";
import { BODY_EXCERPT_CHARS, bodyExcerpt } from "../src/server/confluence";
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
  /** The current version's author, time and message, as Confluence keeps them. */
  by?: string;
  when?: string;
  message?: string;
  ancestors: string[];
  body: string;
}

let server: ReturnType<typeof Bun.serve>;
let wiki: string;
let pages: Map<string, StubPage>;
/** Attachments by page id: each file's bytes and content type under its name. */
let attachments: Map<string, Map<string, { bytes: Uint8Array; type: string }>>;
let nextId: number;
/** The next PUT finds the page a version on — someone saved it in between. */
let bumpOnPut = false;
let seen: { method: string; path: string; auth: string | null; body: unknown }[];

function rawPage(p: StubPage) {
  return {
    id: p.id,
    type: "page",
    title: p.title,
    space: { key: p.spaceKey },
    version: {
      number: p.version,
      ...(p.by ? { by: { type: "known", username: p.by.toLowerCase(), displayName: p.by } } : {}),
      ...(p.when ? { when: p.when } : {}),
      ...(p.message !== undefined ? { message: p.message } : {}),
    },
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
      const multipart = req.headers.get("content-type")?.startsWith("multipart/form-data") ?? false;
      const body = req.method === "GET" || multipart ? undefined : await req.json().catch(() => undefined);
      seen.push({ method: req.method, path: url.pathname + url.search, auth, body });
      const att = url.pathname.match(/^\/rest\/api\/content\/(\d+)\/child\/attachment$/);
      if (att && auth === `Bearer ${GOOD}`) {
        if (!pages.has(att[1]!)) return problem(404, "No content found");
        const held = attachments.get(att[1]!) ?? new Map();
        attachments.set(att[1]!, held);
        if (req.method === "GET") {
          const results = [...held.keys()].map((title, i) => ({ id: `att${i}`, type: "attachment", title }));
          return Response.json({ results, size: results.length, _links: {} });
        }
        if (req.method === "POST") {
          // Confluence refuses an upload without this header (XSRF check).
          if (req.headers.get("x-atlassian-token") !== "nocheck") return problem(403, "XSRF check failed");
          if (!multipart) return problem(400, "No file");
          const form = await req.formData();
          const files = form.getAll("file").filter((f): f is File => f instanceof File);
          const flags = form.getAll("minorEdit").length;
          if (flags !== 0 && flags !== files.length) {
            return problem(400, "Must have the same number of attachment files and minorEdits flag, or not have any minorEdits flags at all");
          }
          // Confluence refuses a new attachment under a name the page already has.
          if (files.some((f) => held.has(f.name))) {
            return problem(400, "Cannot add a new attachment with same file name as an existing attachment");
          }
          for (const file of files) {
            held.set(file.name, { bytes: new Uint8Array(await file.arrayBuffer()), type: file.type });
          }
          return Response.json({ results: [...held.keys()].map((title) => ({ title })) });
        }
      }
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
          const b = body as {
            title: string;
            version: { number: number; message?: string };
            ancestors: { id: string }[];
            body: { storage: { value: string } };
          };
          if (bumpOnPut) {
            bumpOnPut = false;
            page.version += 1;
          }
          if (b.version.number !== page.version + 1) return problem(409, "Version must be incremented");
          Object.assign(page, {
            title: b.title,
            version: b.version.number,
            by: "David V",
            when: new Date().toISOString(),
            message: b.version.message ?? "",
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
  attachments = new Map();
  nextId = 100;
  bumpOnPut = false;
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
const publish = (parentUrl: string, scope: string = "all", force?: boolean) =>
  call("POST", `/api/features/${encodeURIComponent(FILE)}/confluence`, {
    parentUrl,
    scope,
    ...(force === undefined ? {} : { force }),
  });
const parentUrl = () => `${wiki}/spaces/ABC/pages/1/Specs`;
/** The feature's Confluence record — page, version and parent — from its document. */
const recorded = async (file = FILE) => (await readFeatureView(data, file))!.parsed.confluencePage;
/** The page's version as the app last published it, from the feature's document. */
const recordedVersion = async () => {
  const page = await recorded();
  return page && { id: page.id, version: page.version };
};
/** Someone edits the page in Confluence itself: a new version by them, with no message. */
const EDITED_AT = "2026-10-21T15:04:05.000+0000";
function editedInConfluence(id: string, by = "Jane Doe") {
  const page = pages.get(id)!;
  Object.assign(page, { version: page.version + 1, by, when: EDITED_AT, message: "", body: `${page.body}<p>edited</p>` });
}

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
    expect(xhtml).toContain("</ac:link> · Basic Quote</h2>");
    expect(xhtml).toContain("</ac:link> · Declined Quote</h2>");

    const line = `[Confluence:100](${pageUrl})`;
    expect(await readFeature(data, FILE)).toContain(`# Quote Policy\n\n${line}\n\nQuotes for potential customers.`);
    expect((res.body.parsed as { confluence: unknown }).confluence).toEqual({ program: "Confluence", ticket: "100", url: pageUrl });
    // The parent is remembered in the feature's document only.
    expect((await recorded())?.parentUrl).toBe(parentUrl());
    expect(await readFeature(data, FILE)).not.toContain("/pages/1/");
    expect(await readState(root)).not.toHaveProperty("confluenceParentUrl");
    const state = await call("GET", "/api/state");
    expect(state.body).not.toHaveProperty("confluenceParentUrl");
  });

  test("each feature remembers the parent it was last published under", async () => {
    await saveToken();
    const other = "specs/claims.feature.md";
    await createFeature(data, "Claims", "# Claims\n\n## File a Claim @v1 [proposed]\n\n- **Given** a policy\n");
    const otherParent = `${wiki}/pages/viewpage.action?pageId=2`;
    await publish(parentUrl());
    const res = await call("POST", `/api/features/${encodeURIComponent(other)}/confluence`, {
      parentUrl: otherParent,
      scope: "all",
    });
    expect(res.status).toBe(200);
    expect((res.body.parsed as { confluencePage?: { parentUrl?: string } }).confluencePage?.parentUrl).toBe(otherParent);
    expect((await recorded())?.parentUrl).toBe(parentUrl());
    expect((await recorded(other))?.parentUrl).toBe(otherParent);
    // Publishing under a new parent replaces the one remembered.
    await publish(otherParent);
    expect((await recorded())?.parentUrl).toBe(otherParent);
    // Saving the file leaves the record alone.
    await saveFeature(data, FILE, (await readFeature(data, FILE))!.replace("is provided", "is emailed"));
    expect((await recorded())?.parentUrl).toBe(otherParent);
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

  test("with the Positive and negative scenarios setting on the page is split by polarity", async () => {
    await saveToken();
    await saveFeature(data, FILE, SAMPLE.replace("## Basic Quote @v1 [proposed]\n", "## Basic Quote @v1 [proposed]\n\n[negative]\n"));
    await publish(parentUrl());
    expect(pages.get("100")!.body).not.toContain("Negative");
    await writeState({ ...(await readState(root)), scenarioPolarity: true }, root);
    await publish(parentUrl());
    const xhtml = pages.get("100")!.body;
    expect(xhtml.indexOf(">Positive<")).toBeLessThan(xhtml.indexOf("Declined Quote"));
    expect(xhtml.indexOf("Declined Quote")).toBeLessThan(xhtml.indexOf(">Negative<"));
    expect(xhtml.indexOf(">Negative<")).toBeLessThan(xhtml.indexOf("Basic Quote"));
    expect(xhtml).toContain('<h1><span style="color: rgb(222,53,11);">Negative</span></h1>');
    expect(xhtml).not.toContain('ac:name="status"');
    // The parent is still remembered on the way.
    expect((await recorded())?.parentUrl).toBe(parentUrl());
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

  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  /** The name storeImage gives these bytes: the stem and the first 8 hex digits of their SHA-256. */
  const stored = (stem: string, bytes: Uint8Array) => `${stem}-${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}.png`;
  const uploads = () => seen.filter((r) => r.method === "POST" && r.path.endsWith("/child/attachment")).length;

  test("the images a page shows are uploaded as its attachments, once", async () => {
    await saveToken();
    const flow = stored("flow", PNG);
    await mkdir(join(data, ".images"), { recursive: true });
    await writeFile(join(data, ".images", flow), PNG);
    const images = `![the flow](/api/images/${flow})\n\n![gone](/api/images/gone-ffffffff.png)\n\n`;
    await saveFeature(data, FILE, SAMPLE.replace("## Basic", `${images}## Basic`));
    const res = await publish(parentUrl());
    expect(res.status).toBe(200);
    const xhtml = pages.get("100")!.body;
    expect(xhtml).toContain(`<ac:image ac:alt="the flow"><ri:attachment ri:filename="${flow}" /></ac:image>`);
    expect(xhtml).not.toContain("/api/images/");
    expect(attachments.get("100")!.get(flow)).toEqual({ bytes: PNG, type: "image/png" });
    // One the data repo does not hold cannot go up; the page is published anyway.
    expect(attachments.get("100")!.has("gone-ffffffff.png")).toBe(false);
    expect(res.body.warning).toContain("gone-ffffffff.png");
    expect(uploads()).toBe(1);
    // Published again, the attachment is already there — nothing is sent twice.
    await publish(parentUrl());
    expect(uploads()).toBe(1);
    expect(pages.get("100")!.version).toBe(2);
  });

  test("several images go up in one upload", async () => {
    await saveToken();
    const other = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
    const [flow, map] = [stored("flow", PNG), stored("map", other)];
    await mkdir(join(data, ".images"), { recursive: true });
    await writeFile(join(data, ".images", flow), PNG);
    await writeFile(join(data, ".images", map), other);
    const images = `![flow](/api/images/${flow})\n\n![map](/api/images/${map})\n\n`;
    await saveFeature(data, FILE, SAMPLE.replace("## Basic", `${images}## Basic`));
    const res = await publish(parentUrl());
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
    expect(uploads()).toBe(1);
    expect([...attachments.get("100")!.keys()].sort()).toEqual([flow, map].sort());
  });

  test("an image edited in place since it was stored is attached again under the name its bytes earn", async () => {
    await saveToken();
    const flow = stored("flow", PNG);
    await mkdir(join(data, ".images"), { recursive: true });
    await writeFile(join(data, ".images", flow), PNG);
    await saveFeature(data, FILE, SAMPLE.replace("## Basic", `![the flow](/api/images/${flow})\n\n## Basic`));
    expect((await publish(parentUrl())).status).toBe(200);
    expect(uploads()).toBe(1);
    // A touch-up saved over the file keeps its name in the repo, so the name
    // no longer says what the page's attachment holds: the page now refers
    // to the file by the name of its current bytes, uploaded alongside.
    const touched = new Uint8Array([...PNG, 9]);
    await writeFile(join(data, ".images", flow), touched);
    const res = await publish(parentUrl());
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
    const renamed = stored("flow", touched);
    expect(renamed).not.toBe(flow);
    const xhtml = pages.get("100")!.body;
    expect(xhtml).toContain(`<ri:attachment ri:filename="${renamed}" />`);
    expect(xhtml).not.toContain(`"${flow}"`);
    expect(attachments.get("100")!.get(renamed)).toEqual({ bytes: touched, type: "image/png" });
    expect(attachments.get("100")!.get(flow)).toEqual({ bytes: PNG, type: "image/png" });
    expect(uploads()).toBe(2);
    // Unchanged since, it is not sent again.
    await publish(parentUrl());
    expect(uploads()).toBe(2);
  });

  test("a page whose images cannot be attached is still published, with a warning", async () => {
    await saveToken();
    await mkdir(join(data, ".images"), { recursive: true });
    const flow = stored("flow", PNG);
    await writeFile(join(data, ".images", flow), PNG);
    await saveFeature(data, FILE, SAMPLE.replace("## Basic", `![flow](/api/images/${flow})\n\n## Basic`));
    const inner = server;
    server = Bun.serve({
      port: 0,
      fetch: (req) => (req.url.includes("/child/attachment") ? problem(500, "disk full") : inner.fetch(req)),
    });
    const base = `http://127.0.0.1:${server.port}`;
    await saveToken(GOOD, `${base}/spaces/ABC/pages/1/Specs`);
    const res = await publish(`${base}/spaces/ABC/pages/1/Specs`);
    inner.stop(true);
    expect(res.status).toBe(200);
    expect(pages.get("100")!.body).toContain("ri:attachment");
    expect(res.body.warning).toContain("images were not attached");
    expect(res.body.warning).toContain("disk full");
  });
});

// "Changes made in Confluence are not overwritten unnoticed": the page's
// version is recorded in the feature's document after each publish, and a
// page past it — changed in Confluence itself since — is left alone until
// the user says Publish anyway.
describe("a page changed in Confluence since the last publish", () => {
  test("publishing records the page's version in the feature's document", async () => {
    await saveToken();
    const first = await publish(parentUrl());
    expect(first.body).toMatchObject({ id: "100", version: 1 });
    expect(await recordedVersion()).toEqual({ id: "100", version: 1 });
    const again = await publish(parentUrl());
    expect(again.body).toMatchObject({ id: "100", version: 2, message: "page link unchanged" });
    expect(await recordedVersion()).toEqual({ id: "100", version: 2 });
    // The record is the document's alone: the file holds only the link line.
    expect(await readFeature(data, FILE)).not.toContain("version");
  });

  test("a page changed in Confluence since the last publish is not overwritten without confirmation", async () => {
    await saveToken();
    await publish(parentUrl());
    editedInConfluence("100");
    seen = [];
    const res = await publish(parentUrl());
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("changed in Confluence");
    expect(res.body.conflict).toEqual({
      pageId: "100",
      url: `${wiki}/spaces/ABC/pages/100/Quote%20Policy`,
      version: 2,
      lastVersion: 1,
      by: "Jane Doe",
      when: EDITED_AT,
    });
    expect(seen.some((r) => r.method === "PUT" || r.method === "POST")).toBe(false);
    expect(pages.get("100")!.body).toContain("<p>edited</p>");
    expect(await recordedVersion()).toEqual({ id: "100", version: 1 });
  });

  test("Publish anyway replaces the changes and records the new version", async () => {
    await saveToken();
    await publish(parentUrl());
    editedInConfluence("100");
    seen = [];
    const res = await publish(parentUrl(), "all", true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "100", created: false, version: 3 });
    const put = seen.find((r) => r.method === "PUT")!;
    expect(put.body).toMatchObject({ version: { number: 3 } });
    expect(pages.get("100")!.body).not.toContain("<p>edited</p>");
    expect(await recordedVersion()).toEqual({ id: "100", version: 3 });
  });

  test("a version recorded by a teammate's publish is no conflict", async () => {
    await saveToken();
    await publish(parentUrl());
    // A teammate published version 2 from their device; the record came
    // over with the data repo, as the page's version did in Confluence.
    Object.assign(pages.get("100")!, { version: 2, by: "Jane Doe", when: EDITED_AT, message: "Published from SpecDriven" });
    await saveConfluencePage(data, FILE, { id: "100", version: 2 });
    const res = await publish(parentUrl());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 3 });
    expect(await recordedVersion()).toEqual({ id: "100", version: 3 });
  });

  test("a page published before versions were recorded publishes and starts recording", async () => {
    await saveToken();
    // The feature links a page the app published before it kept versions,
    // since changed in Confluence: nothing to compare against, so it is
    // updated as before, and the record starts now.
    pages.set("100", {
      id: "100",
      title: "Quote Policy",
      spaceKey: "ABC",
      version: 3,
      by: "Jane Doe",
      when: EDITED_AT,
      ancestors: ["1"],
      body: "<p>old</p>",
    });
    await saveFeature(
      data,
      FILE,
      SAMPLE.replace("# Quote Policy\n", `# Quote Policy\n\n[Confluence:100](${wiki}/spaces/ABC/pages/100/Quote+Policy)\n`),
    );
    expect(await recordedVersion()).toBeUndefined();
    const res = await publish(parentUrl());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "100", created: false, version: 4 });
    expect(await recordedVersion()).toEqual({ id: "100", version: 4 });
  });

  test("the app's versions carry a message in the page history", async () => {
    await saveToken();
    await publish(parentUrl());
    await publish(parentUrl());
    const put = seen.find((r) => r.method === "PUT")!;
    expect(put.body).toMatchObject({ version: { number: 2, message: "Published from SpecDriven" } });
    expect(pages.get("100")!.message).toBe("Published from SpecDriven");
  });

  test("saving the file keeps the recorded version", async () => {
    await saveToken();
    await publish(parentUrl());
    await saveFeature(data, FILE, (await readFeature(data, FILE))!.replace("is provided", "is emailed"));
    expect(await recordedVersion()).toEqual({ id: "100", version: 1 });
  });

  test("a page changed between the version check and the update is reported, not replaced", async () => {
    await saveToken();
    await publish(parentUrl());
    // Confluence itself refuses a stale version number: the page moves on
    // just as the update arrives.
    bumpOnPut = true;
    seen = [];
    const res = await publish(parentUrl());
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("changed while it was being published");
    expect(res.body.conflict).toBeUndefined();
    expect(pages.get("100")!.version).toBe(2);
    expect(await recordedVersion()).toEqual({ id: "100", version: 1 });
  });
});

// A Confluence failure is never only a line in the dialog: the call that
// failed — the request, Confluence's status and its answer — goes back with
// the error for the dialog's detail box, and into the app's log under
// "confluence", where the Observability page shows it.
describe("a failed Confluence call", () => {
  const ERROR_PAGE = `<!DOCTYPE html><html><head><title>Oops</title><style>body{color:red}</style></head>
<body><h1>System Error</h1><p>java.lang.NullPointerException &amp; friends</p></body></html>`;

  /** Confluence answers creating a page with its HTML error page. */
  function failingCreate(): string {
    const inner = server;
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        req.method === "POST" && new URL(req.url).pathname === "/rest/api/content"
          ? new Response(ERROR_PAGE, { status: 500, headers: { "content-type": "text/html;charset=UTF-8" } })
          : inner.fetch(req),
    });
    const stop = server.stop.bind(server);
    server.stop = (force?: boolean) => {
      inner.stop(true);
      return stop(force);
    };
    return `http://127.0.0.1:${server.port}`;
  }

  test("answers the request, the status and Confluence's answer as details", async () => {
    const base = failingCreate();
    await saveToken(GOOD, `${base}/spaces/ABC/pages/1/Specs`);
    const res = await publish(`${base}/spaces/ABC/pages/1/Specs`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Confluence answered HTTP 500");
    const details = res.body.details as Record<string, unknown>;
    expect(details).toMatchObject({
      method: "POST",
      url: `${base}/rest/api/content`,
      status: 500,
      contentType: "text/html;charset=UTF-8",
    });
    // The error page reads as text: no markup, no stylesheet, entities decoded.
    expect(details.body).toBe("Oops\nSystem Error java.lang.NullPointerException & friends");
    expect(Number.isNaN(Date.parse(details.time as string))).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(GOOD);
  });

  test("is recorded in the log under confluence, with what Confluence answered", async () => {
    const base = failingCreate();
    await saveToken(GOOD, `${base}/spaces/ABC/pages/1/Specs`);
    await publish(`${base}/spaces/ABC/pages/1/Specs`);
    const { entries } = await queryLogs({ components: ["confluence"], q: base });
    const entry = entries.find((e) => e.message === "Confluence answered HTTP 500");
    expect(entry).toBeDefined();
    expect(entry!.level).toBe("error");
    expect(entry!.attributes).toMatchObject({
      "http.request.method": "POST",
      "url.full": `${base}/rest/api/content`,
      "http.response.status_code": "500",
    });
    expect(entry!.attributes["http.response.body"]).toContain("NullPointerException");
    expect(JSON.stringify(entries)).not.toContain(GOOD);
  });

  test("a refusal Confluence explains is logged as a warning", async () => {
    await saveToken();
    const res = await publish(`${wiki}/spaces/ABC/pages/404/Nowhere`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("no page 404");
    const { entries } = await queryLogs({ components: ["confluence"], q: `${wiki}/rest/api/content/404` });
    expect(entries[0]?.level).toBe("warn");
  });

  test("an unreachable wiki is logged with the network error, and no status", async () => {
    const base = failingCreate();
    await saveToken(GOOD, `${base}/spaces/ABC/pages/1/Specs`);
    server.stop(true);
    const res = await publish(`${base}/spaces/ABC/pages/1/Specs`);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain(`Could not reach Confluence at ${base}`);
    const details = res.body.details as Record<string, unknown>;
    expect(details.status).toBeUndefined();
    expect(details.cause).toBeTruthy();
    // Restart something for afterEach to stop.
    wiki = stubConfluence();
  });

  test("a long answer is cut to a readable length", () => {
    const cut = bodyExcerpt("x".repeat(BODY_EXCERPT_CHARS + 10), "application/json");
    expect(cut).toBe(`${"x".repeat(BODY_EXCERPT_CHARS)}… (10 more characters)`);
  });
});

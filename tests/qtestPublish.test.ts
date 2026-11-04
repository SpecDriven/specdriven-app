// Automates specs/external-links/qtest-test-cases.feature.md "A qTest token
// is kept per site on this device", "Create qTest test cases from a feature"
// and "Creating the test cases again updates them" through the routes: a
// token per site kept on this device after qTest accepts it, a feature's
// scenarios created as test cases of a module named after it under a parent
// module — created, then updated — and linked back from the feature. qTest
// is a loopback stub that keeps its modules and test cases in memory,
// answers as qTest Manager's API v3 does, and records what it was sent.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { createFeature, readFeature, readFeatureView, saveFeature } from "../src/server/features";
import { readState, writeState } from "../src/server/state";
import { setProjectionOptions, projectionOptions } from "../src/server/automerge/project";
import { createQtestFileBackend, qtestToken, setQtestTokenBackend } from "../src/server/qtestTokens";
import { queryLogs } from "../src/server/logs";

const GOOD = "tok-good";
const EMPTY = "tok-no-projects";
const FILE = "specs/quote-policy.feature.md";
const PROJECT = "12";

const SAMPLE = `# Quote Policy

Quotes for potential customers.

## Basic Quote @v1 [proposed]

- **Given** a potential customer has an account
- **When** they ask for a quote
- **Then** a quote is provided

## Declined Quote @v2 [published]

- **Given** the customer has no account
- **Then** no quote is provided
`;

interface StubModule {
  id: number;
  name: string;
  parent_id: number | null;
}

interface StubCase {
  id: number;
  name: string;
  parent_id: number;
  properties: unknown;
  test_steps: unknown;
  precondition?: string;
  description?: string;
  version: number;
}

interface StubRequirement {
  id: number;
  name: string;
}

let server: ReturnType<typeof Bun.serve>;
let site: string;
let modules: Map<number, StubModule>;
let cases: Map<number, StubCase>;
let requirements: Map<number, StubRequirement>;
/** The test cases linked to each requirement, as qTest's traceability keeps them. */
let reqLinks: Map<number, Set<number>>;
/** What the stub answers a search with, when not the requirements. */
let searchStatus: number | null;
/** What the stub answers a link call with, when it does not link. */
let linkStatus: number | null;
let nextId: number;
let seen: { method: string; path: string; auth: string | null; body: unknown }[];
/** Whether the stub has revoked every token since the test began. */
let revoked: boolean;
/** What the stub answers for the project's test case fields, when not the fields. */
let fieldsStatus: number | null;
/** What the stub answers a test case delete with, when it does not delete. */
let deleteStatus: number | null;

const problem = (status: number, message: string) => Response.json({ message }, { status });

const rawModule = (m: StubModule) => ({ id: m.id, pid: `MD-${m.id}`, name: m.name, parent_id: m.parent_id });
const rawCase = (c: StubCase) => ({
  id: c.id,
  pid: `TC-${c.id}`,
  parent_id: c.parent_id,
  name: c.name,
  web_url: `${site}/p/${PROJECT}/portal/project#tab=testdesign&object=1&id=${c.id}`,
});
const rawRequirement = (r: StubRequirement) => ({
  id: r.id,
  pid: `RQ-${r.id}`,
  name: r.name,
  web_url: `${site}/p/${PROJECT}/portal/project#tab=requirements&object=5&id=${r.id}`,
});
const rawLinks = (r: StubRequirement) => ({
  id: r.id,
  pid: `RQ-${r.id}`,
  objects: [...(reqLinks.get(r.id) ?? [])].map((id) => ({ id, pid: `TC-${id}`, link_type: "is_covered_by" })),
});

const FIELDS = [
  { id: -1, label: "Name", required: true, constrained: false },
  { id: -62, label: "Description", required: false, constrained: false },
  {
    id: 7310,
    label: "Status",
    required: true,
    constrained: true,
    allowed_values: [
      { value: 710, label: "New", is_default: true },
      { value: 711, label: "Baselined" },
    ],
  },
  {
    id: 501,
    label: "Type",
    required: true,
    constrained: true,
    allowed_values: [
      { value: 701, label: "Manual" },
      { value: 702, label: "Automation" },
    ],
  },
  { id: 502, label: "Priority", required: false, constrained: true, allowed_values: [{ value: 1, label: "High" }] },
];

function stubQtest(): string {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      seen.push({ method: req.method, path: url.pathname + url.search, auth, body });
      if (revoked) return problem(401, "Unauthorized");
      if (url.pathname === "/api/v3/projects") {
        if (auth === `bearer ${EMPTY}`) return Response.json([]);
        if (auth !== `bearer ${GOOD}`) return problem(401, "Unauthorized");
        return Response.json([{ id: Number(PROJECT), name: "Demo" }]);
      }
      if (auth !== `bearer ${GOOD}`) return problem(401, "Unauthorized");
      const p = `/api/v3/projects/${PROJECT}`;
      if (!url.pathname.startsWith(p)) return problem(404, "Project not found");
      const rest = url.pathname.slice(p.length);
      if (rest === "/settings/test-cases/fields") {
        return fieldsStatus ? problem(fieldsStatus, "No permission") : Response.json(FIELDS);
      }
      // qTest's Data Query: `'Name' ~ 'text'` is "name contains text".
      if (rest === "/search" && req.method === "POST") {
        if (searchStatus) return problem(searchStatus, "No permission");
        const b = body as { object_type?: string; query?: string };
        if (b.object_type !== "requirements") return problem(400, "Unsupported object type");
        const term = /~ '([^']*)'/.exec(b.query ?? "")?.[1]?.toLowerCase() ?? "";
        const items = [...requirements.values()].filter((r) => r.name.toLowerCase().includes(term)).map(rawRequirement);
        return Response.json({ page: 1, page_size: 100, total: items.length, items });
      }
      if (rest === "/linked-artifacts" && req.method === "GET") {
        if (url.searchParams.get("type") !== "requirements") return problem(400, "Unsupported type");
        const ids = url.searchParams.getAll("ids").map(Number);
        return Response.json(ids.flatMap((id) => (requirements.has(id) ? [rawLinks(requirements.get(id)!)] : [])));
      }
      const link = rest.match(/^\/requirements\/(\d+)\/link$/);
      if (link && req.method === "POST") {
        if (linkStatus) return problem(linkStatus, "Not allowed");
        if (url.searchParams.get("type") !== "test-cases") return problem(400, "Unsupported type");
        const r = requirements.get(Number(link[1]));
        if (!r) return problem(404, "Requirement not found");
        if (!Array.isArray(body) || !body.every((id) => typeof id === "number")) return problem(400, "Ids expected");
        const linked = reqLinks.get(r.id) ?? new Set<number>();
        // Like qTest, an id already linked or not a test case is passed over.
        for (const id of body as number[]) if (cases.has(id)) linked.add(id);
        reqLinks.set(r.id, linked);
        return Response.json([rawLinks(r)]);
      }
      if (rest === "/modules" || rest === "/modules/") {
        const parent = Number(url.searchParams.get("parentId"));
        if (req.method === "GET") {
          return Response.json([...modules.values()].filter((m) => m.parent_id === parent).map(rawModule));
        }
        if (req.method === "POST") {
          if (!modules.has(parent)) return problem(404, "Module not found");
          const b = body as { name?: string };
          if (!b?.name) return problem(400, "Name is required");
          const m: StubModule = { id: nextId++, name: b.name, parent_id: parent };
          modules.set(m.id, m);
          return Response.json(rawModule(m));
        }
      }
      const mod = rest.match(/^\/modules\/(\d+)$/);
      if (mod) {
        const m = modules.get(Number(mod[1]));
        if (!m) return problem(404, "Module not found");
        if (req.method === "GET") return Response.json(rawModule(m));
        if (req.method === "PUT") {
          const parent = url.searchParams.get("parentId");
          if (parent !== null) m.parent_id = Number(parent);
          const b = body as { name?: string };
          if (b?.name) m.name = b.name;
          return Response.json(rawModule(m));
        }
      }
      // The test cases directly under a module, a page at a time (20 unless asked).
      if (rest === "/test-cases" && req.method === "GET") {
        const parent = Number(url.searchParams.get("parentId"));
        const size = Number(url.searchParams.get("size") ?? 20);
        const page = Number(url.searchParams.get("page") ?? 1);
        const all = [...cases.values()].filter((c) => c.parent_id === parent).map(rawCase);
        return Response.json(all.slice((page - 1) * size, page * size));
      }
      if (rest === "/test-cases" && req.method === "POST") {
        const b = body as Partial<StubCase> & { properties?: unknown[] };
        if (!b.name) return problem(400, "Name is required");
        if (!Array.isArray(b.properties)) return problem(400, "properties is required");
        if (b.name.includes("REFUSED")) return problem(400, "Test case name is not allowed");
        const parent = b.parent_id ? Number(b.parent_id) : 0;
        if (!modules.has(parent)) return problem(404, "Module not found");
        const c: StubCase = {
          id: nextId++,
          name: b.name,
          parent_id: parent,
          properties: b.properties,
          test_steps: b.test_steps,
          precondition: b.precondition,
          description: b.description,
          version: 1,
        };
        cases.set(c.id, c);
        return Response.json(rawCase(c));
      }
      const tc = rest.match(/^\/test-cases\/(\d+)$/);
      if (tc) {
        const c = cases.get(Number(tc[1]));
        if (!c) return problem(404, "Test case not found");
        if (req.method === "GET") return Response.json(rawCase(c));
        if (req.method === "DELETE") {
          if (deleteStatus) return problem(deleteStatus, "No permission to delete");
          cases.delete(c.id);
          // Like qTest, a deleted test case answers with an empty body.
          return new Response(null, { status: 200 });
        }
        if (req.method === "PUT") {
          const b = body as Partial<StubCase>;
          Object.assign(c, {
            name: b.name ?? c.name,
            parent_id: b.parent_id ? Number(b.parent_id) : c.parent_id,
            test_steps: b.test_steps ?? c.test_steps,
            precondition: b.precondition ?? c.precondition,
            // Like qTest, properties sent replace those stored; none sent keeps them.
            properties: b.properties ?? c.properties,
            version: c.version + 1,
          });
          return Response.json(rawCase(c));
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
  root = await mkdtemp(join(tmpdir(), "specdriven-qtest-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-qtest-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  setQtestTokenBackend(createQtestFileBackend(join(home, "qtest-tokens.json")));
  data = join(root, "data");
  await createFeature(data, "Quote Policy");
  await saveFeature(data, FILE, SAMPLE);
  await writeState({ dataRepo: data }, root);
  modules = new Map();
  cases = new Map();
  requirements = new Map();
  reqLinks = new Map();
  nextId = 1000;
  seen = [];
  revoked = false;
  fieldsStatus = null;
  deleteStatus = null;
  searchStatus = null;
  linkStatus = null;
  site = stubQtest();
  modules.set(1, { id: 1, name: "Specs", parent_id: null });
  modules.set(2, { id: 2, name: "Archive", parent_id: null });
  // The requirement of the feature's Jira issue, and one whose name merely contains the key.
  requirements.set(300, { id: 300, name: "ACME-571 Create new UI" });
  requirements.set(301, { id: 301, name: "ACME-5710 Something else" });
});

afterEach(async () => {
  reloader.stop();
  server.stop(true);
  setProjectionOptions(defaults);
  setQtestTokenBackend(createQtestFileBackend());
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

const saveToken = (token = GOOD, base = site) => call("POST", "/api/qtest/tokens", { base, token });
const publish = (parentUrl: string, scope: string = "all") =>
  call("POST", `/api/features/${encodeURIComponent(FILE)}/qtest`, { parentUrl, scope });
const moduleUrl = (id: number | string) => `${site}/p/${PROJECT}/portal/project#tab=testdesign&object=0&id=${id}`;
const caseUrl = (id: number | string) => `${site}/p/${PROJECT}/portal/project#tab=testdesign&object=1&id=${id}`;
const posts = (path: string) => seen.filter((r) => r.method === "POST" && r.path.startsWith(path));
const requirementUrl = (id: number | string) => `${site}/p/${PROJECT}/portal/project#tab=requirements&object=5&id=${id}`;
const JIRA_LINE = "[Jira:ACME-571](https://acme.atlassian.net/browse/ACME-571)";
/** The sample feature linked to its Jira issue, the way the editor writes the line. */
const withJira = (text: string, line = JIRA_LINE) => text.replace("# Quote Policy\n", `# Quote Policy\n\n${line}\n`);
const NO_JIRA = "The feature has no Jira link, so its test cases were not tied to a qTest requirement.";

describe("qTest tokens", () => {
  test("a token qTest accepts is kept, owner-only, and listed without the token", async () => {
    const res = await saveToken();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ base: site, user: "1 project" });
    expect((await stat(join(home, "qtest-tokens.json"))).mode & 0o777).toBe(0o600);
    expect((await qtestToken(site))!.token).toBe(GOOD);
    const list = await call("GET", "/api/qtest/tokens");
    expect(list.body).toEqual({ tokens: [{ base: site, user: "1 project" }] });
  });

  test("a token qTest refuses, or that sees no project, is not kept", async () => {
    const bad = await saveToken("tok-bad");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("did not accept this token");
    const none = await saveToken(EMPTY);
    expect(none.status).toBe(400);
    expect(none.body.error).toContain("sees no qTest project");
    expect(await qtestToken(site)).toBeNull();
  });

  test("a blank token or a url that is no site is refused before qTest is asked", async () => {
    expect((await saveToken("  ")).status).toBe(400);
    expect((await saveToken(GOOD, "acme.qtestnet.com")).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  test("a token pasted with a leading Bearer is kept as the token alone", async () => {
    expect((await saveToken(` Bearer ${GOOD} `)).status).toBe(200);
    expect((await qtestToken(site))!.token).toBe(GOOD);
    expect((await saveToken(`bearer\t${GOOD}`)).status).toBe(200);
    expect((await qtestToken(site))!.token).toBe(GOOD);
    expect((await saveToken("Bearer ")).status).toBe(400);
  });

  test("a saved token replaces the site's last one, and can be removed", async () => {
    await saveToken();
    await saveToken(GOOD, moduleUrl(1));
    expect((await call("GET", "/api/qtest/tokens")).body.tokens).toHaveLength(1);
    const gone = await call("DELETE", "/api/qtest/tokens", { base: site });
    expect(gone.body).toEqual({ tokens: [] });
    expect(await qtestToken(site)).toBeNull();
  });
});

describe("creating a feature's test cases", () => {
  test("makes a module named after the feature under the parent, a test case per scenario, and links them back", async () => {
    await saveToken();
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      module: { id: "1000", pid: "MD-1000", url: moduleUrl(1000), created: true },
      created: 2,
      updated: 0,
      title: "Quote Policy",
      parentUrl: moduleUrl(1),
    });
    expect(res.body.cases).toEqual([
      { scenarioName: "Basic Quote", id: "1001", pid: "TC-1001", url: caseUrl(1001), created: true },
      { scenarioName: "Declined Quote", id: "1002", pid: "TC-1002", url: caseUrl(1002), created: true },
    ]);

    const module = posts("/api/v3/projects/12/modules")[0]!;
    expect(module.auth).toBe(`bearer ${GOOD}`);
    expect(module.path).toBe("/api/v3/projects/12/modules?parentId=1");
    expect(module.body).toEqual({ name: "Quote Policy" });
    const [first, second] = posts("/api/v3/projects/12/test-cases");
    expect(first!.body).toEqual({
      name: "S1: Basic Quote",
      description: "Scenario of the SpecDriven feature “Quote Policy” (specs/quote-policy.feature.md).",
      precondition: "Given a potential customer has an account",
      test_steps: [{ description: "When they ask for a quote", expected: "Then a quote is provided" }],
      parent_id: "1000",
      // Every required field at its default: Status's flagged default, Type's first value; Name is given directly.
      properties: [
        { field_id: 7310, field_value: 710 },
        { field_id: 501, field_value: 701 },
      ],
    });
    expect(second!.body).toMatchObject({
      name: "S2: Declined Quote",
      precondition: "Given the customer has no account",
      test_steps: [{ description: "Check the outcome", expected: "Then no quote is provided" }],
    });

    const file = (await readFeature(data, FILE))!;
    expect(file).toContain(`# Quote Policy\n\n[qTest:MD-1000](${moduleUrl(1000)})\n\nQuotes for potential customers.`);
    expect(file).toContain(`## S1: Basic Quote @v1 [proposed]\n\n[qTest:TC-1001](${caseUrl(1001)})\n`);
    expect(file).toContain(`## S2: Declined Quote @v2 [published]\n\n[qTest:TC-1002](${caseUrl(1002)})\n`);
    const parsed = res.body.parsed as { qtest: unknown; qtestModule: unknown; scenarios: { qtest: unknown }[] };
    expect(parsed.qtest).toEqual({ program: "qTest", ticket: "MD-1000", url: moduleUrl(1000) });
    expect(parsed.scenarios[1]!.qtest).toEqual({ program: "qTest", ticket: "TC-1002", url: caseUrl(1002) });
    expect((await readState(root)).qtestParentUrl).toBe(moduleUrl(1));
    expect((await call("GET", "/api/state")).body.qtestParentUrl).toBe(moduleUrl(1));
    // The module and its parent, kept with the feature for the next dialog.
    expect(parsed.qtestModule).toEqual({ id: "1000", parentUrl: moduleUrl(1) });
  });

  test("a feature published before offers the parent module it was published under, kept with the feature", async () => {
    await saveToken();
    await publish(moduleUrl(1));
    const recorded = async () => (await readFeatureView(data, FILE))!.parsed.qtestModule;
    expect(await recorded()).toEqual({ id: "1000", parentUrl: moduleUrl(1) });
    // Publishing again under another parent remembers that one, even with no link line to change.
    const again = await publish(moduleUrl(2));
    expect(again.body.message).toBe("test case links unchanged");
    expect((again.body.parsed as { qtestModule: unknown }).qtestModule).toEqual({ id: "1000", parentUrl: moduleUrl(2) });
    expect(await recorded()).toEqual({ id: "1000", parentUrl: moduleUrl(2) });
    // A module link changed by hand leaves the earlier module's parent unoffered.
    await saveFeature(data, FILE, (await readFeature(data, FILE))!.replace(`[qTest:MD-1000](${moduleUrl(1000)})`, `[qTest:MD-77](${moduleUrl(77)})`));
    expect(await recorded()).toBeUndefined();
  });

  test("creating them again updates the test cases the scenarios link, in the module the feature links", async () => {
    await saveToken();
    await publish(moduleUrl(1));
    await saveFeature(data, FILE, (await readFeature(data, FILE))!.replace("is provided", "is emailed"));
    seen = [];
    const again = await publish(moduleUrl(1));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ module: { id: "1000", created: false }, created: 0, updated: 2 });
    const puts = seen.filter((r) => r.method === "PUT");
    expect(puts.map((r) => r.path)).toEqual(["/api/v3/projects/12/test-cases/1001", "/api/v3/projects/12/test-cases/1002"]);
    expect(puts[0]!.body).toMatchObject({
      parent_id: "1000",
      test_steps: [{ description: "When they ask for a quote", expected: "Then a quote is emailed" }],
    });
    expect(seen.some((r) => r.method === "POST")).toBe(false);
    expect(modules.size).toBe(3);
    expect(cases.size).toBe(2);
    expect(cases.get(1001)!.version).toBe(2);
    expect(again.body.message).toBe("test case links unchanged");
  });

  test("creating them again leaves the test cases' properties alone, so a Status set in qTest stays", async () => {
    await saveToken();
    await publish(moduleUrl(1));
    // A tester moves the first test case's Status on from its default.
    const moved = [
      { field_id: 7310, field_value: 711 },
      { field_id: 501, field_value: 701 },
    ];
    cases.get(1001)!.properties = moved;
    seen = [];
    expect((await publish(moduleUrl(1))).body).toMatchObject({ created: 0, updated: 2 });
    for (const put of seen.filter((r) => r.method === "PUT")) expect(put.body).not.toHaveProperty("properties");
    expect(cases.get(1001)!.properties).toEqual(moved);
  });

  test("the linked module moves under a new parent; a deleted one is found by name, or made anew", async () => {
    await saveToken();
    await publish(moduleUrl(1));
    seen = [];
    expect((await publish(moduleUrl(2))).body).toMatchObject({ module: { id: "1000", created: false } });
    expect(seen.find((r) => r.method === "PUT")!.path).toBe("/api/v3/projects/12/modules/1000?parentId=2");
    expect(modules.get(1000)!.parent_id).toBe(2);

    modules.delete(1000);
    modules.set(50, { id: 50, name: "quote policy", parent_id: 2 });
    expect((await publish(moduleUrl(2))).body).toMatchObject({ module: { id: "50", created: false } });
    expect(cases.get(1001)!.parent_id).toBe(50);

    modules.delete(50);
    const made = await publish(moduleUrl(2));
    expect(made.body).toMatchObject({ module: { created: true }, created: 0, updated: 2 });
  });

  test("a scenario whose test case was deleted in qTest gets a new one", async () => {
    await saveToken();
    await publish(moduleUrl(1));
    cases.delete(1001);
    seen = [];
    const again = await publish(moduleUrl(1));
    expect(again.body).toMatchObject({ created: 1, updated: 1 });
    expect(posts("/api/v3/projects/12/test-cases")).toHaveLength(1);
    expect((await readFeature(data, FILE))!).toContain("[qTest:TC-1003]");
  });

  /** The sample with two drafts after it, so deleting the first draft (S3) renumbers the second to S3. */
  const FOUR = `${SAMPLE}
## Expired Quote @v1 [proposed]

- **Given** a quote older than 30 days
- **Then** it is expired

## Renewed Quote @v1 [proposed]

- **Given** an expired quote
- **When** the customer asks again
- **Then** a new quote is provided
`;
  const dropExpired = (text: string) => text.replace(/## S3: Expired Quote[\s\S]*?(?=## S4)/, "");
  const namesInModule = (id: number) =>
    [...cases.values()].filter((c) => c.parent_id === id).map((c) => c.name).sort();

  test("a scenario deleted from the feature has its test case deleted, so no two test cases share a number", async () => {
    await saveToken();
    await saveFeature(data, FILE, FOUR);
    await publish(moduleUrl(1));
    expect(namesInModule(1000)).toEqual([
      "S1: Basic Quote",
      "S2: Declined Quote",
      "S3: Expired Quote",
      "S4: Renewed Quote",
    ]);
    // A tester's own test case in the feature's module goes too: the module is the feature's scenarios.
    cases.set(5000, { id: 5000, name: "S9: Made by hand", parent_id: 1000, properties: [], test_steps: [], version: 1 });
    await saveFeature(data, FILE, dropExpired((await readFeature(data, FILE))!));
    seen = [];
    const again = await publish(moduleUrl(1));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: 0, updated: 3, deleted: 2 });
    expect(again.body.deletedCases).toEqual([
      { id: "1003", pid: "TC-1003", name: "S3: Expired Quote" },
      { id: "5000", pid: "TC-5000", name: "S9: Made by hand" },
    ]);
    expect(seen.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([
      "/api/v3/projects/12/test-cases/1003",
      "/api/v3/projects/12/test-cases/5000",
    ]);
    // The scenario that took S3 updated its own test case; nothing else is left under the number.
    expect(namesInModule(1000)).toEqual(["S1: Basic Quote", "S2: Declined Quote", "S3: Renewed Quote"]);
    expect(cases.get(1004)!.name).toBe("S3: Renewed Quote");
    expect(again.body.warning).toBe(NO_JIRA);
  });

  test("published only after all deletes the left-out scenario's test case, and its link goes", async () => {
    await saveToken();
    await publish(moduleUrl(1));
    const again = await publish(moduleUrl(1), "published");
    expect(again.body).toMatchObject({ created: 0, updated: 1, deleted: 1 });
    expect(cases.has(1001)).toBe(false);
    const file = (await readFeature(data, FILE))!;
    expect(file).not.toContain("TC-1001");
    expect(file).toContain("[qTest:TC-1002]");
    const view = (await readFeatureView(data, FILE))!.parsed;
    expect(view.scenarios[0]!.qtest).toBeUndefined();
  });

  test("every page of the module's test cases is read, so a module of many is emptied of leftovers", async () => {
    await saveToken();
    await publish(moduleUrl(1));
    for (let i = 0; i < 130; i++) {
      cases.set(6000 + i, { id: 6000 + i, name: `old ${i}`, parent_id: 1000, properties: [], test_steps: [], version: 1 });
    }
    seen = [];
    const again = await publish(moduleUrl(1));
    expect(again.body).toMatchObject({ updated: 2, deleted: 130 });
    expect(namesInModule(1000)).toEqual(["S1: Basic Quote", "S2: Declined Quote"]);
    expect(seen.filter((r) => r.method === "GET" && r.path.includes("/test-cases?")).map((r) => r.path)).toEqual([
      "/api/v3/projects/12/test-cases?parentId=1000&page=1&size=100&expandProps=false",
      "/api/v3/projects/12/test-cases?parentId=1000&page=2&size=100&expandProps=false",
    ]);
  });

  test("a delete qTest refuses is a warning; the test cases are still written and linked back", async () => {
    await saveToken();
    await saveFeature(data, FILE, FOUR);
    await publish(moduleUrl(1));
    await saveFeature(data, FILE, dropExpired((await readFeature(data, FILE))!));
    deleteStatus = 403;
    const again = await publish(moduleUrl(1));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ updated: 3, deleted: 0 });
    expect(again.body.warning).toContain(
      "The test case TC-1003, no longer a scenario of the feature, could not be deleted from the module: qTest refused the request",
    );
    expect(cases.has(1003)).toBe(true);
    expect((await readFeature(data, FILE))!).toContain("[qTest:TC-1004]");
  });

  test("a run that stops at a refused test case deletes nothing from the module", async () => {
    await saveToken();
    await publish(moduleUrl(1));
    cases.set(5000, { id: 5000, name: "S9: Left over", parent_id: 1000, properties: [], test_steps: [], version: 1 });
    await saveFeature(data, FILE, `${(await readFeature(data, FILE))!}
## REFUSED Quote @v1 [proposed]

- Then: nothing
`);
    seen = [];
    const again = await publish(moduleUrl(1));
    expect(again.body.failure).toBeDefined();
    expect(again.body).toMatchObject({ deleted: 0 });
    expect(seen.some((r) => r.method === "DELETE")).toBe(false);
    expect(cases.has(5000)).toBe(true);
  });

  test("published only leaves the proposed scenarios out, keeping the numbers the app shows", async () => {
    await saveToken();
    const res = await publish(moduleUrl(1), "published");
    expect(res.body.cases).toEqual([
      { scenarioName: "Declined Quote", id: "1001", pid: "TC-1001", url: caseUrl(1001), created: true },
    ]);
    expect(posts("/api/v3/projects/12/test-cases")[0]!.body).toMatchObject({ name: "S2: Declined Quote" });
    const view = (await readFeatureView(data, FILE))!.parsed;
    expect(view.scenarios[0]!.qtest).toBeUndefined();
    expect(view.scenarios[1]!.qtest).toMatchObject({ ticket: "TC-1001" });
  });

  test("a feature on a Confluence page links each test case to its scenario there, not to the file", async () => {
    await saveToken();
    const page = "https://wiki.acme.com/spaces/QA/pages/99/Quote+Policy";
    await saveFeature(data, FILE, SAMPLE.replace("# Quote Policy\n", `# Quote Policy\n\n[Confluence:99](${page})\n`));
    expect((await publish(moduleUrl(1))).status).toBe(200);
    const [first, second] = posts("/api/v3/projects/12/test-cases");
    expect((first!.body as { description: string }).description).toBe(
      `Scenario of the SpecDriven feature “Quote Policy” (<a href="${page}#QuotePolicy-S1">${page}#QuotePolicy-S1</a>).`,
    );
    expect((second!.body as { description: string }).description).toBe(
      `Scenario of the SpecDriven feature “Quote Policy” (<a href="${page}#QuotePolicy-S2">${page}#QuotePolicy-S2</a>).`,
    );
  });

  test("a test case qTest refuses stops the run, and what was written is still linked back", async () => {
    await saveToken();
    await saveFeature(data, FILE, `${SAMPLE}
## REFUSED Quote @v1 [proposed]

- Then: nothing
`);
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, updated: 0 });
    // The sample links no Jira issue; nothing else is amiss.
    expect(res.body.warning).toBe(NO_JIRA);
    const failure = res.body.failure as { scenarioName: string; message: string; details: Record<string, unknown> };
    expect(failure.scenarioName).toBe("REFUSED Quote");
    expect(failure.message).toBe(
      "2 of the test cases were written; “REFUSED Quote” was not: qTest answered HTTP 400: Test case name is not allowed",
    );
    // What qTest was sent and what it answered, for the dialog's detail box.
    expect(failure.details).toMatchObject({
      method: "POST",
      url: `${site}/api/v3/projects/12/test-cases`,
      status: 400,
    });
    expect(failure.details.requestBody).toContain('"name": "S3: REFUSED Quote"');
    expect(failure.details.body).toContain("Test case name is not allowed");
    const file = (await readFeature(data, FILE))!;
    expect(file).toContain("[qTest:TC-1001]");
    expect(file).toContain("[qTest:TC-1002]");
    expect(file).toContain("[qTest:MD-1000]");
    expect(file).not.toContain("TC-1003");
  });

  test("with Publish external links off the file has no line, but the feature keeps the links", async () => {
    setProjectionOptions({ publishExternalLinks: false });
    await saveToken();
    expect((await publish(moduleUrl(1))).status).toBe(200);
    expect((await readFeature(data, FILE))!).not.toContain("qTest:");
    const view = (await readFeatureView(data, FILE))!.parsed;
    expect(view.qtest).toMatchObject({ ticket: "MD-1000" });
    expect(view.scenarios[0]!.qtest).toMatchObject({ ticket: "TC-1001" });
  });

  test("what cannot be published says why", async () => {
    const noToken = await publish(moduleUrl(1));
    expect(noToken.status).toBe(401);
    expect(noToken.body.error).toContain("No qTest token");
    await saveToken();
    const notModule = await publish(caseUrl(5));
    expect(notModule.status).toBe(400);
    expect(notModule.body.error).toContain("Paste the parent module's url");
    expect((await publish(moduleUrl(1), "some")).status).toBe(400);
    const gone = await publish(moduleUrl(999));
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe("qTest has no module 999 in project 12, or the token cannot see it.");
    const missing = await call("POST", "/api/features/specs%2Fnope.feature.md/qtest", { parentUrl: moduleUrl(1) });
    expect(missing.status).toBe(404);
  });

  test("a token qTest no longer accepts is reported as such", async () => {
    await saveToken();
    revoked = true;
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("qTest rejected the token; save a new one in Settings → qTest.");
  });

  test("a token that cannot read the project's fields still makes the module and the test cases", async () => {
    await saveToken();
    fieldsStatus = 403;
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ module: { id: "1000", created: true }, created: 2 });
    expect(res.body.failure).toBeUndefined();
    expect(posts("/api/v3/projects/12/test-cases")[0]!.body).toMatchObject({ parent_id: "1000", properties: [] });
  });

  test("the fields are read before the module is made, so a failure there leaves none behind", async () => {
    await saveToken();
    fieldsStatus = 500;
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("qTest answered HTTP 500: No permission");
    expect(posts("/api/v3/projects/12/modules")).toHaveLength(0);
    expect(modules.size).toBe(2);
  });

  test("a feature with no Jira link gets its test cases, with a warning that no requirement covers them", async () => {
    await saveToken();
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, warning: NO_JIRA });
    expect(res.body.requirements).toBeUndefined();
    expect(seen.some((r) => r.path.includes("/search") || r.path.includes("/link"))).toBe(false);
  });

  test("the hosted app refuses qTest altogether", async () => {
    process.env.SPECDRIVEN_HOSTED = "1";
    expect((await call("GET", "/api/qtest/tokens")).status).toBe(403);
    expect((await saveToken()).status).toBe(403);
    expect((await publish(moduleUrl(1))).status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

// specs/external-links/qtest-test-cases.feature.md "Each test case is linked
// to the requirement of the feature's Jira issue": the requirement whose name
// starts with the feature's Jira key, found through qTest's search, covers
// every test case written — linked on the first publish, and on the next for
// any not yet linked. Not finding one is a warning, never a failure.
describe("linking the test cases to the Jira issue's requirement", () => {
  const search = () => seen.filter((r) => r.path === "/api/v3/projects/12/search?pageSize=100&page=1");
  const links = () => posts("/api/v3/projects/12/requirements/");

  test("publishing links every test case to the requirement whose name starts with the feature's Jira key", async () => {
    await saveToken();
    await saveFeature(data, FILE, withJira(SAMPLE));
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
    expect(res.body).toMatchObject({
      created: 2,
      requirements: [{ key: "ACME-571", id: "300", pid: "RQ-300", name: "ACME-571 Create new UI", url: requirementUrl(300), linked: 2, alreadyLinked: 0 }],
    });
    // Found with qTest's own query, before the module is made; "contains" is narrowed to "starts with" here.
    expect(search()).toHaveLength(1);
    expect(search()[0]!.body).toEqual({ object_type: "requirements", fields: ["*"], query: "'Name' ~ 'ACME-571'" });
    const moduleAt = seen.findIndex((r) => r.method === "POST" && r.path.startsWith("/api/v3/projects/12/modules"));
    expect(seen.findIndex((r) => r.path.includes("/search"))).toBeLessThan(moduleAt);
    expect(links()).toHaveLength(1);
    expect(links()[0]!.path).toBe("/api/v3/projects/12/requirements/300/link?type=test-cases");
    expect(links()[0]!.body).toEqual([1001, 1002]);
    expect([...reqLinks.get(300)!]).toEqual([1001, 1002]);
    expect(reqLinks.get(301)).toBeUndefined();
    // The requirement is not written into the feature: qTest keeps the link.
    expect((await readFeature(data, FILE))!).not.toContain("RQ-300");
  });

  test("publishing again links only the test cases not yet linked, and says so", async () => {
    await saveToken();
    await saveFeature(data, FILE, withJira(SAMPLE));
    await publish(moduleUrl(1));
    // A tester removed one link in qTest; the other stands.
    reqLinks.get(300)!.delete(1002);
    seen = [];
    const again = await publish(moduleUrl(1));
    expect(again.body).toMatchObject({ updated: 2, requirements: [{ pid: "RQ-300", linked: 1, alreadyLinked: 1 }] });
    expect(seen.map((r) => r.path)).toContain("/api/v3/projects/12/linked-artifacts?type=requirements&ids=300");
    expect(links()).toHaveLength(1);
    expect(links()[0]!.body).toEqual([1002]);
    seen = [];
    const third = await publish(moduleUrl(1));
    expect(third.body).toMatchObject({ requirements: [{ linked: 0, alreadyLinked: 2 }] });
    expect(links()).toHaveLength(0);
  });

  test("a key the link's url names serves as well, whatever the tool it was filed under", async () => {
    await saveToken();
    await saveFeature(data, FILE, withJira(SAMPLE, "[Other:tracker](https://acme.atlassian.net/browse/acme-571)"));
    const res = await publish(moduleUrl(1));
    expect(res.body).toMatchObject({ requirements: [{ pid: "RQ-300", linked: 2 }] });
    expect(search()[0]!.body).toMatchObject({ query: "'Name' ~ 'ACME-571'" });
  });

  test("no requirement starting with the key is a warning, and the test cases are written without one", async () => {
    await saveToken();
    await saveFeature(data, FILE, withJira(SAMPLE, "[Jira:ACME-9](https://acme.atlassian.net/browse/ACME-9)"));
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2 });
    expect(res.body.requirements).toBeUndefined();
    expect(res.body.warning).toBe('No qTest requirement in project 12 starts with "ACME-9"; the test cases were written without one.');
    expect(links()).toHaveLength(0);
    expect((await readFeature(data, FILE))!).toContain("[qTest:TC-1002]");
    // "ACME-5710 Something else" contains ACME-571 but does not start with it.
    requirements.delete(300);
    await saveFeature(data, FILE, withJira(SAMPLE));
    expect((await publish(moduleUrl(1))).body.warning).toContain('starts with "ACME-571"');
  });

  test("several requirements starting with the key link the first by id, and say so", async () => {
    await saveToken();
    requirements.set(299, { id: 299, name: "ACME-571: Create new UI (copy)" });
    await saveFeature(data, FILE, withJira(SAMPLE));
    const res = await publish(moduleUrl(1));
    expect(res.body).toMatchObject({ requirements: [{ pid: "RQ-299", linked: 2 }] });
    expect(res.body.warning).toBe(
      '2 qTest requirements start with "ACME-571"; the test cases were linked to RQ-299 “ACME-571: Create new UI (copy)”.',
    );
  });

  test("a search qTest refuses is a warning, not a failure; a refused test case mid-run still links the ones written", async () => {
    await saveToken();
    searchStatus = 403;
    await saveFeature(data, FILE, withJira(SAMPLE));
    const refused = await publish(moduleUrl(1));
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ created: 2 });
    expect(refused.body.warning).toBe(
      "The qTest requirement for ACME-571 could not be looked up (qTest refused the request — the token cannot write to this project: No permission); the test cases were written without one.",
    );
    expect(modules.size).toBe(3);

    searchStatus = null;
    // The feature as linked back, plus a scenario qTest will refuse.
    await saveFeature(data, FILE, `${(await readFeature(data, FILE))!}
## REFUSED Quote @v1 [proposed]

- Then: nothing
`);
    seen = [];
    const partial = await publish(moduleUrl(1));
    expect(partial.body).toMatchObject({ created: 0, updated: 2, requirements: [{ pid: "RQ-300", linked: 2 }] });
    expect((partial.body.failure as { scenarioName: string }).scenarioName).toBe("REFUSED Quote");
    expect(partial.body.warning).toBeUndefined();
    expect(links()[0]!.body).toEqual([1001, 1002]);
  });

  test("a link qTest refuses is a warning, and the test cases stay linked back from the feature", async () => {
    await saveToken();
    linkStatus = 403;
    await saveFeature(data, FILE, withJira(SAMPLE));
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, requirements: [{ pid: "RQ-300", linked: 0, alreadyLinked: 0 }] });
    expect(res.body.warning).toBe(
      "The test cases were written but could not be linked to requirement RQ-300: qTest refused the request — the token cannot write to this project: Not allowed",
    );
    expect(reqLinks.get(300)).toBeUndefined();
    expect((await readFeature(data, FILE))!).toContain("[qTest:TC-1002]");
    // Linked the next time, once the token may.
    linkStatus = null;
    seen = [];
    expect((await publish(moduleUrl(1))).body).toMatchObject({ requirements: [{ linked: 2, alreadyLinked: 0 }] });
    expect(links()[0]!.body).toEqual([1001, 1002]);
  });

  // specs/external-links/project-management-jira-linear-etc.feature.md
  // "Several tickets on a feature": every ticket's requirement counts.
  const TWO = `${JIRA_LINE}\n[Jira:ACME-600](https://acme.atlassian.net/browse/ACME-600)`;

  test("with several tickets, each key's requirement is found and every test case is linked to each of them", async () => {
    await saveToken();
    requirements.set(310, { id: 310, name: "ACME-600 Checkout" });
    await saveFeature(data, FILE, withJira(SAMPLE, TWO));
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
    expect(res.body).toMatchObject({
      created: 2,
      requirements: [
        { key: "ACME-571", pid: "RQ-300", linked: 2, alreadyLinked: 0 },
        { key: "ACME-600", pid: "RQ-310", linked: 2, alreadyLinked: 0 },
      ],
    });
    // One search per key, in the tickets' order, all before the module is made.
    expect(search().map((r) => (r.body as { query: string }).query)).toEqual(["'Name' ~ 'ACME-571'", "'Name' ~ 'ACME-600'"]);
    const moduleAt = seen.findIndex((r) => r.method === "POST" && r.path.startsWith("/api/v3/projects/12/modules"));
    expect(seen.filter((r) => r.path.includes("/search")).every(() => true)).toBe(true);
    expect(seen.map((r, i) => (r.path.includes("/search") ? i : -1)).filter((i) => i >= 0).every((i) => i < moduleAt)).toBe(true);
    expect(links().map((r) => r.path)).toEqual([
      "/api/v3/projects/12/requirements/300/link?type=test-cases",
      "/api/v3/projects/12/requirements/310/link?type=test-cases",
    ]);
    expect([...reqLinks.get(300)!]).toEqual([1001, 1002]);
    expect([...reqLinks.get(310)!]).toEqual([1001, 1002]);
    // Publishing again links nothing new to either.
    seen = [];
    const again = await publish(moduleUrl(1));
    expect(again.body).toMatchObject({
      requirements: [
        { pid: "RQ-300", linked: 0, alreadyLinked: 2 },
        { pid: "RQ-310", linked: 0, alreadyLinked: 2 },
      ],
    });
    expect(links()).toHaveLength(0);
  });

  test("a key with no requirement is a warning while the other ticket's requirement still links; a refused search names the keys left", async () => {
    await saveToken();
    await saveFeature(data, FILE, withJira(SAMPLE, `${JIRA_LINE}\n[Jira:ACME-9](https://acme.atlassian.net/browse/ACME-9)`));
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, requirements: [{ key: "ACME-571", pid: "RQ-300", linked: 2 }] });
    expect(res.body.requirements).toHaveLength(1);
    expect(res.body.warning).toBe('No qTest requirement in project 12 starts with "ACME-9".');
    expect([...reqLinks.get(300)!]).toEqual([1001, 1002]);

    searchStatus = 403;
    seen = [];
    await saveFeature(data, FILE, withJira(SAMPLE, TWO));
    const refused = await publish(moduleUrl(1));
    expect(refused.status).toBe(200);
    expect(refused.body.requirements).toBeUndefined();
    expect(refused.body.warning).toBe(
      "The qTest requirements for ACME-571, ACME-600 could not be looked up (qTest refused the request — the token cannot write to this project: No permission); the test cases were written without one.",
    );
    expect(search()).toHaveLength(1);
  });
});

// specs/external-links/qtest-test-cases.feature.md "Every call to qTest is
// logged, and a failure shows what qTest answered".
describe("observability", () => {
  test("every call to qTest is logged under qtest, with both bodies and never the token", async () => {
    await saveToken();
    await publish(moduleUrl(1));
    const { entries } = await queryLogs({ components: ["qtest"], q: site, limit: 500 });
    const lines = entries.map((e) => e.message);
    expect(lines).toContain(`GET ${site}/api/v3/projects → 200`);
    expect(lines).toContain(`GET ${site}/api/v3/projects/12/settings/test-cases/fields → 200`);
    const created = entries.filter((e) => e.message === `POST ${site}/api/v3/projects/12/test-cases → 200`);
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(created[0]!.level).toBe("info");
    expect(created[0]!.attributes).toMatchObject({
      "http.request.method": "POST",
      "url.full": `${site}/api/v3/projects/12/test-cases`,
      "http.response.status_code": "200",
    });
    expect(created[0]!.attributes["http.request.body"]).toContain("Quote");
    expect(created[0]!.attributes["http.response.body"]).toContain("TC-");
    expect(Number(created[0]!.attributes["duration_ms"])).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(entries)).not.toContain(GOOD);
  });

  test("a failure answers the request and qTest's answer as details, and is logged as a warning", async () => {
    await saveToken();
    const gone = await publish(moduleUrl(999));
    expect(gone.status).toBe(404);
    expect(gone.body.details).toMatchObject({
      method: "GET",
      url: `${site}/api/v3/projects/12/modules/999`,
      status: 404,
      contentType: expect.stringContaining("json"),
    });
    expect((gone.body.details as { body: string }).body).toContain("Module not found");
    expect(JSON.stringify(gone.body)).not.toContain(GOOD);
    const { entries } = await queryLogs({ components: ["qtest"], q: `${site}/api/v3/projects/12/modules/999` });
    expect(entries[0]).toMatchObject({ level: "warn", message: "qTest reports no such project, module or test case, or the token cannot see it." });
  });

  test("a token qTest refuses comes back with what qTest answered", async () => {
    const bad = await saveToken("tok-bad");
    expect(bad.status).toBe(400);
    expect(bad.body.details).toMatchObject({ method: "GET", url: `${site}/api/v3/projects`, status: 401 });
    expect(JSON.stringify(bad.body)).not.toContain("tok-bad");
  });

  test("an unreachable site is logged as an error with the network error, and no status", async () => {
    await saveToken();
    server.stop(true);
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(502);
    expect(res.body.error).toContain(`Could not reach qTest at ${site}`);
    const details = res.body.details as Record<string, unknown>;
    expect(details.status).toBeUndefined();
    expect(details.cause).toBeTruthy();
    const { entries } = await queryLogs({ components: ["qtest"], q: "Could not reach qTest" });
    expect(entries[0]?.level).toBe("error");
    // Restart something for afterEach to stop.
    site = stubQtest();
  });
});

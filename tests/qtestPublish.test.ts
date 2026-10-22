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

let server: ReturnType<typeof Bun.serve>;
let site: string;
let modules: Map<number, StubModule>;
let cases: Map<number, StubCase>;
let nextId: number;
let seen: { method: string; path: string; auth: string | null; body: unknown }[];
/** Whether the stub has revoked every token since the test began. */
let revoked: boolean;

const problem = (status: number, message: string) => Response.json({ message }, { status });

const rawModule = (m: StubModule) => ({ id: m.id, pid: `MD-${m.id}`, name: m.name, parent_id: m.parent_id });
const rawCase = (c: StubCase) => ({
  id: c.id,
  pid: `TC-${c.id}`,
  parent_id: c.parent_id,
  name: c.name,
  web_url: `${site}/p/${PROJECT}/portal/project#tab=testdesign&object=1&id=${c.id}`,
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
      if (rest === "/settings/test-cases/fields") return Response.json(FIELDS);
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
        if (req.method === "PUT") {
          const b = body as Partial<StubCase>;
          Object.assign(c, {
            name: b.name ?? c.name,
            parent_id: b.parent_id ? Number(b.parent_id) : c.parent_id,
            test_steps: b.test_steps ?? c.test_steps,
            precondition: b.precondition ?? c.precondition,
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
  nextId = 1000;
  seen = [];
  revoked = false;
  site = stubQtest();
  modules.set(1, { id: 1, name: "Specs", parent_id: null });
  modules.set(2, { id: 2, name: "Archive", parent_id: null });
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
const moduleUrl = (id: number | string) => `${site}/p/${PROJECT}/portal/project#tab=testdesign&object=2&id=${id}`;
const caseUrl = (id: number | string) => `${site}/p/${PROJECT}/portal/project#tab=testdesign&object=1&id=${id}`;
const posts = (path: string) => seen.filter((r) => r.method === "POST" && r.path.startsWith(path));

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
    const parsed = res.body.parsed as { qtest: unknown; scenarios: { qtest: unknown }[] };
    expect(parsed.qtest).toEqual({ program: "qTest", ticket: "MD-1000", url: moduleUrl(1000) });
    expect(parsed.scenarios[1]!.qtest).toEqual({ program: "qTest", ticket: "TC-1002", url: caseUrl(1002) });
    expect((await readState(root)).qtestParentUrl).toBe(moduleUrl(1));
    expect((await call("GET", "/api/state")).body.qtestParentUrl).toBe(moduleUrl(1));
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

  test("a test case qTest refuses stops the run, and what was written is still linked back", async () => {
    await saveToken();
    await saveFeature(data, FILE, `${SAMPLE}
## REFUSED Quote @v1 [proposed]

- Then: nothing
`);
    const res = await publish(moduleUrl(1));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, updated: 0 });
    expect(res.body.warning).toBe(
      "2 of the test cases were written; “REFUSED Quote” was not: qTest answered HTTP 400: Test case name is not allowed",
    );
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

  test("the hosted app refuses qTest altogether", async () => {
    process.env.SPECDRIVEN_HOSTED = "1";
    expect((await call("GET", "/api/qtest/tokens")).status).toBe(403);
    expect((await saveToken()).status).toBe(403);
    expect((await publish(moduleUrl(1))).status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

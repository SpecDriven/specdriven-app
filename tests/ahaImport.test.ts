// Automates specs/external-links/aha-import.feature.md through the routes:
// an API key per Aha! site kept on this device after Aha! accepts it, a
// feature imported from its Aha! url — name and description from Aha!, the
// requirements as scenarios — the feature and each scenario linking their
// Aha! record on the document, and what cannot be imported saying why. Aha!
// is a loopback stub that answers as the v1 REST API does and records what
// it was sent.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { readFeature, readFeatureView } from "../src/server/features";
import { readState, writeState } from "../src/server/state";
import { ahaToken, createAhaFileBackend, setAhaTokenBackend } from "../src/server/ahaTokens";
import { planAhaImport } from "../src/server/ahaImport";
import type { AhaFeature } from "../src/server/aha";

const GOOD = "key-good";
const NOBODY = "key-nobody";

let server: ReturnType<typeof Bun.serve>;
let site: string;
let seen: { method: string; path: string; auth: string | null }[];
/** Whether the stub has revoked every key since the test began. */
let revoked: boolean;

const problem = (status: number, error: string) => Response.json({ error }, { status });

/** APP-123 as `GET /features/APP-123?fields=*` answers it, requirements inline. */
const feature = () => ({
  feature: {
    id: "6776881149489380599",
    reference_num: "APP-123",
    name: "Quote Policy",
    description: {
      body: '<p>Quotes for <strong>potential</strong> customers.</p><ul><li>Fast</li><li>Fair</li></ul><p><a href="https://acme.aha.io/attachments/1">Mock: see this</a></p>',
      attachments: [],
    },
    url: `${site}/features/APP-123`,
    resource: `${site}/api/v1/features/APP-123`,
    workflow_status: { id: "1", name: "In design" },
    release: { id: "2", name: "2026.4" },
    tags: ["quotes"],
    assigned_to_user: { name: "Pat Example" },
    requirements: [
      {
        id: "1",
        reference_num: "APP-123-1",
        name: "Basic Quote",
        description: { body: "<p>Given a potential customer has an account<br>Then a quote is provided</p>" },
        url: `${site}/requirements/APP-123-1`,
      },
      {
        id: "2",
        reference_num: "APP-123-2",
        name: "Declined Quote",
        description: { body: "<p>Given the customer has no account</p><p>Then no quote is provided</p>" },
        url: `${site}/requirements/APP-123-2`,
      },
    ],
  },
});

/** APP-124 lists its requirements without their descriptions; the requirements endpoint has them. */
const slimFeature = () => ({
  feature: {
    reference_num: "APP-124",
    name: "Renewals",
    description: { body: "<p>Renew on time.</p>" },
    url: `${site}/features/APP-124`,
    requirements: [{ reference_num: "APP-124-1", name: "Reminder", url: `${site}/requirements/APP-124-1` }],
  },
});

function stubAha(): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      seen.push({ method: req.method, path: url.pathname + url.search, auth });
      if (revoked) return problem(401, "Unauthorized");
      if (url.pathname === "/api/v1/me") {
        if (auth === `Bearer ${NOBODY}`) return Response.json({ user: null });
        if (auth !== `Bearer ${GOOD}`) return problem(401, "Unauthorized");
        return Response.json({ user: { id: "1", name: "Pat Example", email: "pat@acme.com" } });
      }
      if (auth !== `Bearer ${GOOD}`) return problem(401, "Unauthorized");
      if (url.pathname === "/api/v1/features/APP-123") return Response.json(feature());
      if (url.pathname === "/api/v1/features/APP-124") return Response.json(slimFeature());
      if (url.pathname === "/api/v1/features/APP-124/requirements") {
        return Response.json({
          requirements: [
            {
              reference_num: "APP-124-1",
              name: "Reminder",
              description: { body: "<p>A reminder goes out.</p>" },
              url: `${site}/requirements/APP-124-1`,
            },
          ],
          pagination: { total_records: 1, total_pages: 1, current_page: 1 },
        });
      }
      return problem(404, "Not found");
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const realHosted = process.env.SPECDRIVEN_HOSTED;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-aha-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-aha-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  setAhaTokenBackend(createAhaFileBackend(join(home, "aha-tokens.json")));
  data = join(root, "data");
  await writeState({ dataRepo: data }, root);
  seen = [];
  revoked = false;
  site = stubAha();
});

afterEach(async () => {
  reloader.stop();
  server.stop(true);
  setAhaTokenBackend(createAhaFileBackend());
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

const saveKey = (token = GOOD, base = site) => call("POST", "/api/aha/tokens", { base, token });
const importFrom = (url: string, extra: Record<string, unknown> = {}) =>
  call("POST", "/api/aha/import", { url, ...extra });

describe("Aha! API keys", () => {
  test("a key Aha! accepts is kept, owner-only, and listed without the key", async () => {
    const res = await saveKey();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ base: site, user: "Pat Example" });
    expect((await stat(join(home, "aha-tokens.json"))).mode & 0o777).toBe(0o600);
    expect((await ahaToken(site))!.token).toBe(GOOD);
    const list = await call("GET", "/api/aha/tokens");
    expect(list.body).toEqual({ tokens: [{ base: site, user: "Pat Example" }] });
  });

  test("a key Aha! refuses, or that signs in as nobody, is not kept", async () => {
    const bad = await saveKey("key-bad");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("did not accept this API key");
    const none = await saveKey(NOBODY);
    expect(none.status).toBe(400);
    expect(none.body.error).toContain("did not accept this API key");
    expect(await ahaToken(site)).toBeNull();
  });

  test("a blank key or a url that is no site is refused before Aha! is asked", async () => {
    expect((await saveKey("  ")).status).toBe(400);
    expect((await saveKey(GOOD, "acme.aha.io")).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  test("a saved key replaces the site's last one, and can be removed", async () => {
    await saveKey();
    await saveKey(GOOD, `${site}/features/APP-1`);
    expect((await call("GET", "/api/aha/tokens")).body.tokens).toHaveLength(1);
    const gone = await call("DELETE", "/api/aha/tokens", { base: site });
    expect(gone.body).toEqual({ tokens: [] });
    expect(await ahaToken(site)).toBeNull();
  });
});

describe("importing a feature from Aha!", () => {
  test("creates the feature in the chosen folder from the Aha! record, its requirements as scenarios", async () => {
    await saveKey();
    const res = await importFrom(`${site}/features/APP-123`, { folder: "billing" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      fileName: "specs/billing/quote-policy.feature.md",
      title: "Quote Policy",
      url: `${site}/features/APP-123`,
      reference: "APP-123",
      scenarios: 2,
      ahaLinks: true,
    });
    const view = (await readFeatureView(data, "specs/billing/quote-policy.feature.md"))!;
    expect(view.parsed.name).toBe("Quote Policy");
    expect(view.parsed.description).toContain(
      `_Imported from Aha! [APP-123](${site}/features/APP-123) — In design, release "2026.4"._`,
    );
    expect(view.parsed.description).toContain("Quotes for **potential** customers.");
    expect(view.parsed.description).toContain("- Fast\n- Fair");
    expect(view.parsed.scenarios.map((s) => [s.name, s.version, s.status])).toEqual([
      ["Basic Quote", 1, "proposed"],
      ["Declined Quote", 1, "proposed"],
    ]);
    expect(view.parsed.scenarios[0]!.body).toContain("Given a potential customer has an account");
    expect(view.parsed.scenarios[0]!.body).toContain("Then a quote is provided");
    // The file is the parser's input: no ticket line, nothing lifted out of the description.
    expect(view.parsed.link).toBeUndefined();
    expect(view.parsed.description).toContain("\\[Mock: see this](https://acme.aha.io/attachments/1)");
  });

  test("the feature links its Aha! record and each scenario its requirement, on the document only", async () => {
    await saveKey();
    await importFrom(`${site}/features/APP-123`);
    const file = "specs/quote-policy.feature.md";
    const view = (await readFeatureView(data, file))!;
    expect(view.parsed.aha).toEqual([{ url: `${site}/features/APP-123`, title: "APP-123" }]);
    expect(view.parsed.scenarios.map((s) => s.aha)).toEqual([
      [{ url: `${site}/requirements/APP-123-1`, title: "APP-123-1" }],
      [{ url: `${site}/requirements/APP-123-2`, title: "APP-123-2" }],
    ]);
    const content = (await readFeature(data, file))!;
    expect(content).not.toContain("/requirements/APP-123-1");
    expect(content).toContain("## S1: Basic Quote @v1 [proposed]");
    expect((await readState(root)).ahaLinks).toBe(true);
  });

  test("description only leaves the requirements out", async () => {
    await saveKey();
    const res = await importFrom(`${site}/features/APP-123`, { scope: "description" });
    expect(res.status).toBe(201);
    expect(res.body.scenarios).toBe(0);
    const view = (await readFeatureView(data, "specs/quote-policy.feature.md"))!;
    expect(view.parsed.scenarios).toEqual([]);
    expect(view.parsed.aha).toHaveLength(1);
    expect((await importFrom(`${site}/features/APP-123`, { scope: "both" })).status).toBe(400);
  });

  test("a bare reference number is read against the site named with it", async () => {
    await saveKey();
    const res = await importFrom("app-123", { base: site });
    expect(res.status).toBe(201);
    expect(res.body.fileName).toBe("specs/quote-policy.feature.md");
    expect(seen.map((r) => r.path)).toContain("/api/v1/features/APP-123?fields=*");
  });

  test("requirements the feature answer lists without descriptions are read from their own endpoint", async () => {
    await saveKey();
    const res = await importFrom(`${site}/features/APP-124`);
    expect(res.status).toBe(201);
    expect(seen.map((r) => r.path)).toContain("/api/v1/features/APP-124/requirements?fields=*&per_page=200&page=1");
    const view = (await readFeatureView(data, "specs/renewals.feature.md"))!;
    expect(view.parsed.scenarios).toHaveLength(1);
    expect(view.parsed.scenarios[0]!.body).toContain("A reminder goes out.");
  });

  test("what cannot be imported says why", async () => {
    const noUrl = await importFrom("");
    expect(noUrl.status).toBe(400);
    expect(noUrl.body.error).toContain("Paste an Aha! feature url");
    const epic = await importFrom(`${site}/epics/APP-E-1`);
    expect(epic.status).toBe(400);
    expect(epic.body.error).toContain("Only Aha! features can be imported");
    const noKey = await importFrom(`${site}/features/APP-123`);
    expect(noKey.status).toBe(401);
    expect(noKey.body.error).toBe(`No Aha! API key for ${site} — add one in Settings → Aha!`);
    expect(seen).toHaveLength(0);
    await saveKey();
    const missing = await importFrom(`${site}/features/APP-404`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Aha! has no such record, or the key cannot see it.");
    expect((await importFrom(`${site}/features/APP-123`)).status).toBe(201);
    const again = await importFrom(`${site}/features/APP-123`);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      error: "Already imported as specs/quote-policy.feature.md — open it instead.",
      fileName: "specs/quote-policy.feature.md",
    });
  });

  test("a key Aha! no longer accepts is reported as such", async () => {
    await saveKey();
    revoked = true;
    const res = await importFrom(`${site}/features/APP-123`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Aha! rejected the API key; save a new one in Settings → Aha!.");
  });

  test("the hosted app refuses Aha! altogether", async () => {
    process.env.SPECDRIVEN_HOSTED = "1";
    expect((await call("GET", "/api/aha/tokens")).status).toBe(403);
    expect((await saveKey()).status).toBe(403);
    expect((await call("DELETE", "/api/aha/tokens", { base: site })).status).toBe(403);
    expect((await importFrom(`${site}/features/APP-123`)).status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe("what an Aha! feature becomes", () => {
  const base: AhaFeature = {
    referenceNum: "APP-9",
    name: "Login / Signup\n  flow",
    description: "",
    url: "https://acme.aha.io/features/APP-9",
    status: "",
    release: "",
    requirements: [],
  };

  test("a name is one line with no folder separator; an empty one is the reference number", () => {
    expect(planAhaImport(base, "requirements").name).toBe("Login - Signup flow");
    expect(planAhaImport({ ...base, name: "  " }, "requirements").name).toBe("APP-9");
    expect(planAhaImport(base, "requirements").text).toBe(
      "# Login - Signup flow\n\n_Imported from Aha! [APP-9](https://acme.aha.io/features/APP-9)._\n",
    );
  });

  test("a requirement's name loses what the heading syntax would misread, and repeats are told apart", () => {
    const req = (name: string, n: number) => ({
      referenceNum: `APP-9-${n}`,
      name,
      description: "",
      url: `https://acme.aha.io/requirements/APP-9-${n}`,
    });
    const plan = planAhaImport(
      { ...base, requirements: [req("S3: Sign in @v2 [published]", 1), req("Sign in", 2), req("  ", 3)] },
      "requirements",
    );
    expect(plan.scenarioLinks.map((s) => s.name)).toEqual(["Sign in", "Sign in (2)", "Requirement APP-9-3"]);
    expect(plan.text).toContain("## Sign in @v1 [proposed]\n\n## Sign in (2) @v1 [proposed]\n\n## Requirement APP-9-3 @v1 [proposed]\n");
    expect(plan.scenarioLinks[0]!.link).toEqual({ url: "https://acme.aha.io/requirements/APP-9-1", title: "APP-9-1" });
  });

  test("a description keeps nothing the feature parser would lift out of it", () => {
    const plan = planAhaImport(
      {
        ...base,
        description: '<p><a href="https://acme.aha.io/x">Note: read this</a></p><h3>Tests</h3><p>None yet.</p>',
      },
      "description",
    );
    expect(plan.text).toContain("\\[Note: read this](https://acme.aha.io/x)\n\n#### Tests\n\nNone yet.\n");
  });

  test("the status and release ride on the import line when Aha! gives them", () => {
    const plan = planAhaImport({ ...base, status: "Ready to develop", release: "Q4" }, "description");
    expect(plan.text).toContain('_Imported from Aha! [APP-9](https://acme.aha.io/features/APP-9) — Ready to develop, release "Q4"._');
    expect(planAhaImport({ ...base, status: "Shipped" }, "description").text).toContain("— Shipped._");
  });
});

// Automates specs/external-links/jira-wiki-import.feature.md through the
// routes: a token per Jira site kept on this device after Jira accepts it,
// the issues and pages read and handed to an agent plugin's one-shot turn
// for a title and scenarios, and the review step's create. Jira and
// Confluence are one loopback stub answering as Server / Data Center do;
// the agent is a fake provider that records what it was asked.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents } from "../src/plugins/host/agents";
import type { OneShotRequest, OneShotResult } from "../src/plugins/host/agents";
import { handleApi, reloader } from "../src/server/api";
import { createConfluenceFileBackend, setConfluenceTokenBackend } from "../src/server/confluenceTokens";
import { createFeature } from "../src/server/features";
import { createJiraFileBackend, jiraToken, setJiraTokenBackend } from "../src/server/jiraTokens";
import { IMPORT_AGENT_MISSING } from "../src/server/jiraWikiImport";
import { writeState } from "../src/server/state";
import { fakeProvider } from "./helpers/fakeAgent";

const GOOD = "pat-good";
const NOBODY = "pat-nobody";

let server: ReturnType<typeof Bun.serve>;
let site: string;
let seen: { method: string; path: string; auth: string | null }[];

const problem = (status: number, message: string) => Response.json({ errorMessages: [message] }, { status });

const issue = (key: string) => ({
  key,
  fields: {
    summary: `${key} summary`,
    issuetype: { name: "Story" },
    status: { name: "Open" },
    labels: ["quotes"],
    subtasks: [{ key: `${key}-sub`, fields: { summary: "Sub-task summary" } }],
    customfield_10100: "raw acceptance",
    comment: { comments: [{ author: { name: "pat", displayName: "Pat Example" }, body: "raw comment" }] },
  },
  renderedFields: {
    description: "<p>The <b>description</b> of the issue.</p>",
    customfield_10100: "<ul><li>Acceptance one</li></ul>",
    customfield_10200: "2026-10-29",
    comment: {
      comments: [{ author: { name: "pat", displayName: "Pat Example" }, body: "<p>A rendered comment.</p>" }],
    },
  },
  names: { customfield_10100: "Acceptance Criteria", customfield_10200: "Target date" },
});

function stub(): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      seen.push({ method: req.method, path: url.pathname + url.search, auth });
      if (url.pathname === "/rest/api/2/myself") {
        if (auth === `Bearer ${NOBODY}`) return Response.json({ displayName: "" });
        if (auth !== `Bearer ${GOOD}`) return problem(401, "Unauthorized");
        return Response.json({ name: "dvydra", key: "dvydra", displayName: "David V" });
      }
      if (url.pathname === "/rest/api/user/current") {
        if (auth !== `Bearer ${GOOD}`) return problem(401, "Unauthorized");
        return Response.json({ type: "known", username: "dvydra", displayName: "David V" });
      }
      if (auth !== `Bearer ${GOOD}`) return problem(401, "Unauthorized");
      const key = url.pathname.match(/^\/rest\/api\/2\/issue\/([A-Z]+-\d+)$/)?.[1];
      if (key) {
        if (key === "ABC-404") return problem(404, "Issue Does Not Exist");
        return Response.json(issue(key));
      }
      if (url.pathname === "/rest/api/content/55") {
        return Response.json({
          id: "55",
          title: "Quote Policy",
          space: { key: "ABC" },
          version: { number: 3 },
          ancestors: [],
          body: { export_view: { value: "<h1>Quotes</h1><p>Quotes are <em>free</em>.</p>" } },
          _links: { base: site, webui: "/spaces/ABC/pages/55/Quote+Policy" },
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
let asked: OneShotRequest[];
let answer: OneShotResult | Error;
let dispose: (() => void) | null;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const realHosted = process.env.SPECDRIVEN_HOSTED;
const realDemo = process.env.DEMO_MODE;

const proposal = (over: Record<string, unknown> = {}) => ({
  title: "Quote Policy",
  scenarios: [
    { name: "Basic quote", body: "- Given: an account\n- Then: a quote", sources: ["ABC-1"] },
    { name: "Declined quote", body: "- Given: no account\n- Then: no quote", sources: ["Quote Policy"] },
  ],
  more: [] as string[],
  ...over,
});
const success = (structured: unknown): OneShotResult => ({ text: JSON.stringify(structured), structured, isError: false });

function registerAgent(id: string, rank: number, label = id) {
  const { provider } = fakeProvider({
    id,
    label,
    rank,
    missingMessage: `${label} CLI not found`,
    capabilities: { oneShot: true },
    oneShot: async (req) => {
      asked.push(req);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return agents.register(provider);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-jira-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-jira-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  delete process.env.DEMO_MODE;
  setJiraTokenBackend(createJiraFileBackend(join(home, "jira-tokens.json")));
  setConfluenceTokenBackend(createConfluenceFileBackend(join(home, "confluence-tokens.json")));
  data = join(root, "data");
  await createFeature(data, "Seed");
  await writeState({ dataRepo: data }, root);
  seen = [];
  asked = [];
  answer = success(proposal());
  site = stub();
  dispose = registerAgent("claude", 10, "Claude");
});

afterEach(async () => {
  reloader.stop();
  server.stop(true);
  dispose?.();
  dispose = null;
  setJiraTokenBackend(createJiraFileBackend());
  setConfluenceTokenBackend(createConfluenceFileBackend());
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
    ["SPECDRIVEN_HOSTED", realHosted],
    ["DEMO_MODE", realDemo],
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

const saveToken = (token = GOOD, base = site) => call("POST", "/api/jira/tokens", { base, token });
const saveWikiToken = () => call("POST", "/api/confluence/tokens", { base: site, token: GOOD });
const issueUrl = (key: string) => `${site}/browse/${key}`;
const pageUrl = () => `${site}/spaces/ABC/pages/55/Quote+Policy`;
const propose = (sources: string[], extra: Record<string, unknown> = {}) =>
  call("POST", "/api/import/propose", { sources, ...extra });

describe("a Jira token", () => {
  test("a token Jira accepts is kept, owner-only, and listed without the token", async () => {
    const res = await saveToken();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ base: site, user: "David V" });
    expect(seen.map((s) => s.path)).toEqual(["/rest/api/2/myself"]);
    expect((await jiraToken(site))?.token).toBe(GOOD);
    const mode = (await stat(join(home, "jira-tokens.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    const list = await call("GET", "/api/jira/tokens");
    expect(list.body).toEqual({ tokens: [{ base: site, user: "David V" }] });
    expect(JSON.stringify(list.body)).not.toContain(GOOD);
  });

  test("a token Jira refuses, or that names nobody, is not kept", async () => {
    const refused = await saveToken("pat-wrong");
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/did not accept this token/);
    const nobody = await saveToken(NOBODY);
    expect(nobody.status).toBe(400);
    expect(nobody.body.error).toMatch(/did not accept this token/);
    expect(await jiraToken(site)).toBeNull();
  });

  test("a blank token or a url that is no site is refused before Jira is asked", async () => {
    expect((await saveToken("   ")).status).toBe(400);
    expect((await saveToken(GOOD, "not a url")).status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("a saved token replaces the site's last one, and can be removed", async () => {
    await saveToken("pat-old".replace("old", "good"));
    await saveToken(GOOD);
    expect((await call("GET", "/api/jira/tokens")).body.tokens).toHaveLength(1);
    const gone = await call("DELETE", "/api/jira/tokens", { base: site });
    expect(gone.body).toEqual({ tokens: [] });
    expect(await jiraToken(site)).toBeNull();
  });
});

describe("proposing a feature", () => {
  test("refuses more than five of a kind, an unknown url, and a site without a token", async () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => issueUrl(`ABC-${n}`));
    expect((await propose(six)).body.error).toMatch(/At most 5 Jira/);
    expect((await propose([])).status).toBe(400);
    const odd = await propose(["https://acme.aha.io/features/APP-1"]);
    expect(odd.status).toBe(400);
    expect(odd.body.error).toMatch(/Not a Jira issue or Confluence page url/);
    const noToken = await propose([issueUrl("ABC-1")]);
    expect(noToken.status).toBe(401);
    expect(noToken.body.error).toMatch(/No Jira token for/);
    const noWiki = await propose([pageUrl()]);
    expect(noWiki.status).toBe(401);
    expect(noWiki.body.error).toMatch(/No Confluence token for/);
    expect(asked).toEqual([]);
  });

  test("needs an agent that answers one-shot turns", async () => {
    await saveToken();
    dispose?.();
    dispose = null;
    const res = await propose([issueUrl("ABC-1")]);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(IMPORT_AGENT_MISSING);
  });

  test("reads the issues and the page as markdown into one turn, and answers the proposal", async () => {
    await saveToken();
    await saveWikiToken();
    const res = await propose([issueUrl("ABC-1"), issueUrl("ABC-2"), pageUrl()]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...proposal(),
      agent: "Claude",
      sources: [
        { kind: "jira", url: issueUrl("ABC-1"), title: "ABC-1" },
        { kind: "jira", url: issueUrl("ABC-2"), title: "ABC-2" },
        { kind: "wiki", url: `${site}/spaces/ABC/pages/55/Quote+Policy`, title: "Quote Policy" },
      ],
    });
    expect(seen.filter((s) => s.path.startsWith("/rest/api/2/issue/")).map((s) => s.path)).toEqual([
      "/rest/api/2/issue/ABC-1?expand=renderedFields,names",
      "/rest/api/2/issue/ABC-2?expand=renderedFields,names",
    ]);
    expect(seen.some((s) => s.path.startsWith("/rest/api/content/55?expand=body.export_view"))).toBe(true);
    expect(asked).toHaveLength(1);
    const { prompt, systemPrompt, schema, cwd } = asked[0]!;
    expect(cwd).toBe(data);
    expect(systemPrompt).toMatch(/Given/);
    expect(schema).toMatchObject({ required: ["title", "scenarios", "more"] });
    expect(prompt).toContain("### Source 1: Jira issue ABC-1");
    expect(prompt).toContain("Summary: ABC-1 summary");
    expect(prompt).toContain("Type: Story · Status: Open · Labels: quotes");
    expect(prompt).toContain("Description:\nThe **description** of the issue.");
    expect(prompt).toContain("Acceptance Criteria:\n- Acceptance one");
    expect(prompt).not.toContain("Target date");
    expect(prompt).toContain("Sub-tasks:\n- ABC-1-sub Sub-task summary");
    expect(prompt).toContain("Comments:\nPat Example: A rendered comment.");
    expect(prompt).not.toContain("raw comment");
    expect(prompt).toContain("### Source 3: Confluence page “Quote Policy”");
    expect(prompt).toContain("### Quotes\n\nQuotes are _free_.");
  });

  test("asks the chosen agent, and passes the names already shown", async () => {
    await saveToken();
    const codex = registerAgent("codex", 20, "Codex");
    try {
      const res = await propose([issueUrl("ABC-1")], { agent: "codex", exclude: ["Basic quote", "Declined quote"] });
      expect(res.status).toBe(200);
      expect(res.body.agent).toBe("Codex");
      expect(asked[0]!.prompt).toContain("do not repeat them");
      expect(asked[0]!.prompt).toContain("- Basic quote\n- Declined quote");
      const byRank = await propose([issueUrl("ABC-1")]);
      expect(byRank.body.agent).toBe("Claude");
    } finally {
      codex();
    }
  });

  test("the model asked for reaches the agent; none leaves the agent's own; an odd name is refused", async () => {
    await saveToken();
    const res = await propose([issueUrl("ABC-1")], { model: " claude-sonnet-4-6 " });
    expect(res.status).toBe(200);
    expect(asked[0]!.model).toBe("claude-sonnet-4-6");
    await propose([issueUrl("ABC-1")], { model: "" });
    expect("model" in asked[1]!).toBe(false);
    const bad = await propose([issueUrl("ABC-1")], { model: "--dangerously-skip" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("Not a model name");
    expect(asked).toHaveLength(2);
  });

  test("a text-only JSON answer parses too; a failed turn or an odd answer says who could not", async () => {
    await saveToken();
    answer = { text: `Sure:\n${JSON.stringify(proposal({ more: ["Renewal"] }))}`, isError: false };
    const text = await propose([issueUrl("ABC-1")]);
    expect(text.status).toBe(200);
    expect(text.body.more).toEqual(["Renewal"]);
    answer = { text: "Not signed in", isError: true };
    const failed = await propose([issueUrl("ABC-1")]);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("Claude could not read the sources: Not signed in");
    answer = { text: "Forty-two.", isError: false };
    const odd = await propose([issueUrl("ABC-1")]);
    expect(odd.status).toBe(502);
    expect(odd.body.error).toBe("Claude did not answer with a title and scenarios");
    answer = new Error("spawn failed");
    expect((await propose([issueUrl("ABC-1")])).body.error).toBe("Claude could not read the sources: spawn failed");
  });

  test("what Jira or Confluence refuses says which url", async () => {
    await saveToken();
    const missing = await propose([issueUrl("ABC-404")]);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain(issueUrl("ABC-404"));
    expect(missing.body.error).toMatch(/no such issue/);
    expect(asked).toEqual([]);
  });
});

describe("creating the feature", () => {
  const create = (body: Record<string, unknown>) => call("POST", "/api/import/create", body);
  const kept = {
    title: "Quote Policy",
    scenarios: proposal().scenarios,
    sources: [
      { kind: "jira", url: "https://jira.acme.com/browse/ABC-1", title: "ABC-1" },
      { kind: "wiki", url: "https://wiki.acme.com/pages/55", title: "Quote Policy" },
    ],
  };

  test("writes the kept scenarios as proposed into the folder, naming the sources", async () => {
    const res = await create({ folder: "billing", ...kept });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ fileName: "specs/billing/quote-policy.feature.md", title: "Quote Policy", scenarios: 2 });
    const text = await readFile(join(data, "specs/billing/quote-policy.feature.md"), "utf8");
    expect(text).toContain("# Quote Policy\n\n_Imported from Jira [ABC-1](https://jira.acme.com/browse/ABC-1) and Confluence [Quote Policy](https://wiki.acme.com/pages/55)._");
    expect(text).toContain("## S1: Basic quote @v1 [proposed]\n\n- Given: an account\n- Then: a quote\n\n_From ABC-1._");
    expect(text).toContain("## S2: Declined quote @v1 [proposed]");
  });

  test("a feature already there is reported, not replaced; a title or scenarios are needed", async () => {
    await create({ folder: "", ...kept });
    const again = await create({ folder: "", ...kept });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      error: "Already there as specs/quote-policy.feature.md — open it instead.",
      fileName: "specs/quote-policy.feature.md",
    });
    expect((await create({ ...kept, title: " " })).status).toBe(400);
    expect((await create({ ...kept, scenarios: [] })).status).toBe(400);
  });
});

describe("where there is no device", () => {
  test("the hosted app refuses Jira and the import altogether", async () => {
    process.env.SPECDRIVEN_HOSTED = "1";
    for (const [method, path] of [
      ["GET", "/api/jira/tokens"],
      ["POST", "/api/jira/tokens"],
      ["DELETE", "/api/jira/tokens"],
      ["POST", "/api/import/propose"],
      ["POST", "/api/import/create"],
    ] as const) {
      const res = await call(method, path, {});
      expect(res.status).toBe(403);
    }
    expect(seen).toEqual([]);
  });

  test("demo mode refuses the import", async () => {
    process.env.DEMO_MODE = "1";
    const res = await propose([issueUrl("ABC-1")]);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/demo mode/);
    expect((await call("POST", "/api/import/create", {})).status).toBe(403);
  });
});

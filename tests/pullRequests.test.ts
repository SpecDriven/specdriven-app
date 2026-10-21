// Automates specs/external-links/related-pull-requests.feature.md on the
// server: pull request links live on the feature's Automerge document — at
// the feature level and per scenario — and never in the `.feature.md`; the
// editor's view folds them in; every markdown-driven write leaves them
// alone; the title is read from GitHub through a stub on loopback.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "@automerge/automerge";
import { handleApi, reloader } from "../src/server/api";
import {
  createFeature,
  publishFeature,
  readFeature,
  readFeatureView,
  renameFeature,
  saveFeature,
  savePullRequests,
} from "../src/server/features";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { docToFeature, projectFeature } from "../src/server/automerge/project";
import { importFeatureDoc, reconcile, setPullRequests } from "../src/server/automerge/reconcile";
import { threeWayFeature } from "../src/server/automerge/merge";
import { importDrift } from "../src/server/automerge/driftSync";
import { parseFeature, serializeFeature } from "../src/server/parser";
import {
  isPullRequestUrl,
  parsePullRequestUrl,
  pullRequestLabel,
  pullRequestNumber,
  validPullRequests,
} from "../src/server/pullRequests";
import { getPullRequest } from "../src/server/issues";
import { signOut } from "../src/server/auth";
import { writeState } from "../src/server/state";
import { createFileBackend, saveToken, setTokenBackend } from "../src/server/tokenStore";

const PR1 = { url: "https://github.com/acme/repo/pull/12", title: "Quote engine" };
const PR2 = { url: "https://github.com/acme/repo/pull/34", title: "Quote emails" };
const FILE = "specs/quote-policy.feature.md";

const SAMPLE = `# Quote Policy

Quotes for potential customers.

## Basic Quote @v1 [proposed]

- **Given** a potential customer has an account
- **Then** a quote is provided

## Declined Quote @v2 [proposed]

- **Given** the customer has no account
`;

// What the app writes: the same text with each scenario numbered by its
// position (parser.ts `S<n>:`); parsing either form gives the same feature.
const WRITTEN = SAMPLE.replace("## Basic Quote", "## S1: Basic Quote").replace(
  "## Declined Quote",
  "## S2: Declined Quote",
);

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-prs-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-prs-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  await createFeature(data, "Quote Policy");
  await saveFeature(data, FILE, SAMPLE);
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const BASIC = { name: "Basic Quote", version: 1 };
const docPrs = async () => docToFeature((await loadFeatureDoc(data, FILE))!.doc);

// --- the url ----------------------------------------------------------------

describe("a pull request url", () => {
  test("a GitHub pull request url is taken apart; anything else is not", () => {
    expect(parsePullRequestUrl(PR1.url)).toEqual({ owner: "acme", repo: "repo", number: 12 });
    expect(parsePullRequestUrl(" https://github.com/acme/repo/pull/12/files ")).toEqual({
      owner: "acme",
      repo: "repo",
      number: 12,
    });
    expect(parsePullRequestUrl("https://github.com/acme/repo/issues/12")).toBeNull();
    expect(parsePullRequestUrl("https://gitlab.com/acme/repo/-/merge_requests/5")).toBeNull();
  });

  test("any http(s) url may be linked, nothing else", () => {
    expect(isPullRequestUrl(PR1.url)).toBe(true);
    expect(isPullRequestUrl("https://gitlab.com/acme/repo/-/merge_requests/5")).toBe(true);
    expect(isPullRequestUrl("javascript:alert(1)")).toBe(false);
    expect(isPullRequestUrl("acme/repo#12")).toBe(false);
    expect(isPullRequestUrl("")).toBe(false);
  });

  test("the number is read from GitHub and GitLab urls alike", () => {
    expect(pullRequestNumber(PR1.url)).toBe(12);
    expect(pullRequestNumber("https://gitlab.com/acme/repo/-/merge_requests/5")).toBe(5);
    expect(pullRequestNumber("https://bitbucket.org/acme/repo/pull-requests/7/")).toBe(7);
    expect(pullRequestNumber("https://example.com/changes")).toBeNull();
  });

  test("the label is #n and the title, and never empty", () => {
    expect(pullRequestLabel(PR1)).toBe("#12 Quote engine");
    expect(pullRequestLabel({ url: PR1.url, title: "" })).toBe("#12");
    expect(pullRequestLabel({ url: "https://example.com/changes", title: "" })).toBe(
      "example.com/changes",
    );
    expect(pullRequestLabel({ url: "https://example.com/changes", title: "A change" })).toBe(
      "A change",
    );
    expect(pullRequestLabel({ url: "not a url", title: "" })).toBe("not a url");
  });

  test("the route accepts only rows with an http(s) url and a string title", () => {
    expect(validPullRequests([PR1, { url: " https://x.example/1 " }])).toEqual([
      PR1,
      { url: "https://x.example/1", title: "" },
    ]);
    expect(validPullRequests([{ url: PR1.url, title: "  Fix   totals " }])).toEqual([
      { url: PR1.url, title: "Fix totals" },
    ]);
    expect(validPullRequests([{ url: "javascript:alert(1)", title: "" }])).toBeNull();
    expect(validPullRequests([{ url: PR1.url, title: 3 }])).toBeNull();
    expect(validPullRequests("nope")).toBeNull();
    expect(validPullRequests([])).toEqual([]);
  });
});

// --- the document operation ---------------------------------------------------

describe("setPullRequests on the document", () => {
  const fresh = () => importFeatureDoc(parseFeature(SAMPLE));

  test("links a scenario by name and version, and by its document id", () => {
    const doc = fresh();
    const byName = setPullRequests(doc, BASIC, [PR1])!;
    expect(byName.specs[0]!.prs).toEqual([PR1]);
    const id = byName.specs[0]!.id;
    const byId = setPullRequests(byName, { name: "renamed", version: 9, id }, [PR1, PR2])!;
    expect(byId.specs[0]!.prs).toEqual([PR1, PR2]);
    expect(byId.specs[1]!.prs).toBeUndefined();
  });

  test("a scenario not in the document is null; the feature itself is target null", () => {
    const doc = fresh();
    expect(setPullRequests(doc, { name: "Nope", version: 1 }, [PR1])).toBeNull();
    const next = setPullRequests(doc, null, [PR1])!;
    expect(next.prs).toEqual([PR1]);
    expect(next.specs.every((s) => s.prs === undefined)).toBe(true);
  });

  test("the list is brought to the target by url — removed, retitled, appended", () => {
    let doc = setPullRequests(fresh(), BASIC, [PR1, PR2])!;
    doc = setPullRequests(doc, BASIC, [{ ...PR2, title: "Quote e-mails" }, { url: "https://x.example/3", title: "" }])!;
    expect(doc.specs[0]!.prs).toEqual([
      { url: PR2.url, title: "Quote e-mails" },
      { url: "https://x.example/3", title: "" },
    ]);
    doc = setPullRequests(doc, BASIC, [])!;
    expect(doc.specs[0]!.prs).toEqual([]);
    expect(docToFeature(doc).scenarios[0]!.prs).toBeUndefined();
  });

  test("two peers linking different pull requests concurrently end with both", () => {
    const base = setPullRequests(fresh(), BASIC, [])!;
    const a = setPullRequests(A.clone(base), BASIC, [PR1])!;
    const b = setPullRequests(A.clone(base), BASIC, [PR2])!;
    const merged = A.merge(a, b);
    const urls = merged.specs[0]!.prs!.map((p) => p.url).sort();
    expect(urls).toEqual([PR1.url, PR2.url].sort());
    // And the other way round agrees.
    const other = A.merge(A.clone(b), a);
    expect(other.specs[0]!.prs!.map((p) => p.url).sort()).toEqual(urls);
  });

  test("the projection never carries them", () => {
    const doc = setPullRequests(setPullRequests(fresh(), BASIC, [PR1])!, null, [PR2])!;
    expect(projectFeature(doc)).toBe(projectFeature(fresh()));
    expect(projectFeature(doc)).not.toContain("pull/");
    expect(serializeFeature(docToFeature(doc))).not.toContain("pull/");
  });
});

// --- through the feature module -----------------------------------------------

describe("savePullRequests", () => {
  test("the document holds the links, the file does not, the editor sees them", async () => {
    const before = (await readFeature(data, FILE))!;
    const saved = await savePullRequests(data, FILE, BASIC, [PR1, PR2]);
    expect(saved.status).toBe("saved");
    expect(saved.parsed.scenarios[0]!.prs).toEqual([PR1, PR2]);
    expect(saved.content).toBe(before);
    expect(await readFeature(data, FILE)).toBe(before);
    const view = (await readFeatureView(data, FILE))!;
    expect(view.parsed.scenarios[0]!.prs).toEqual([PR1, PR2]);
    expect(view.parsed.scenarios[1]!.prs).toBeUndefined();
    expect(view.content).toBe(before);
  });

  test("the feature's own links, the same way", async () => {
    await savePullRequests(data, FILE, null, [PR1]);
    const view = (await readFeatureView(data, FILE))!;
    expect(view.parsed.prs).toEqual([PR1]);
    expect(view.parsed.scenarios.every((s) => s.prs === undefined)).toBe(true);
    expect(await readFeature(data, FILE)).toBe(WRITTEN);
  });

  test("a scenario the document lacks is refused", async () => {
    await expect(savePullRequests(data, FILE, { name: "Nope", version: 1 }, [PR1])).rejects.toThrow(
      'Scenario "Nope" @v1 not found',
    );
  });

  test("a feature from before documents gets one minted first", async () => {
    await Bun.write(join(data, "specs/old.feature.md"), "# Old\n\n## S @v1 [proposed]\n\nbody\n");
    expect(await loadFeatureDoc(data, "specs/old.feature.md")).toBeNull();
    const saved = await savePullRequests(data, "specs/old.feature.md", { name: "S", version: 1 }, [PR1]);
    expect(saved.parsed.scenarios[0]!.prs).toEqual([PR1]);
    expect(await readFeature(data, "specs/old.feature.md")).toBe("# Old\n\n## S @v1 [proposed]\n\nbody\n");
  });

  test("a draft scenario can carry links, and the editor's view shows them", async () => {
    await saveFeature(data, FILE, SAMPLE + "\n## Sketch @v1 [draft]\n\nsoon\n");
    await savePullRequests(data, FILE, { name: "Sketch", version: 1 }, [PR2]);
    const view = (await readFeatureView(data, FILE))!;
    const sketch = view.parsed.scenarios.find((s) => s.name === "Sketch")!;
    expect(sketch.status).toBe("draft");
    expect(sketch.prs).toEqual([PR2]);
    expect(await readFeature(data, FILE)).not.toContain("Sketch");
  });
});

describe("the links survive everything the markdown does", () => {
  beforeEach(async () => {
    await savePullRequests(data, FILE, BASIC, [PR1]);
    await savePullRequests(data, FILE, null, [PR2]);
  });

  test("a save that edits the body, and one that renames the scenario by id", async () => {
    const edited = SAMPLE.replace("is provided", "is emailed");
    const saved = await saveFeature(data, FILE, edited);
    expect(saved.parsed.scenarios[0]!.prs).toEqual([PR1]);
    expect(saved.parsed.prs).toEqual([PR2]);
    const id = saved.parsed.scenarios[0]!.id!;
    const renamed = edited.replace("## Basic Quote @v1", "## Simple Quote @v1");
    const again = await saveFeature(data, FILE, renamed, { name: "Simple Quote", version: 1, id });
    const simple = again.parsed.scenarios.find((s) => s.name === "Simple Quote")!;
    expect(simple.prs).toEqual([PR1]);
    expect(again.parsed.scenarios).toHaveLength(2);
  });

  test("publishing", async () => {
    await publishFeature(data, FILE, (await readFeature(data, FILE))!, BASIC);
    const view = (await readFeatureView(data, FILE))!;
    expect(view.parsed.scenarios[0]!.status).toBe("published");
    expect(view.parsed.scenarios[0]!.prs).toEqual([PR1]);
    expect(view.parsed.prs).toEqual([PR2]);
  });

  test("renaming the feature", async () => {
    await renameFeature(data, FILE, "Quote Policy 2");
    const view = (await readFeatureView(data, FILE))!;
    expect(view.parsed.name).toBe("Quote Policy 2");
    expect(view.parsed.scenarios[0]!.prs).toEqual([PR1]);
    expect(view.parsed.prs).toEqual([PR2]);
  });

  test("an outside edit absorbed as drift", async () => {
    await Bun.write(join(data, FILE), SAMPLE.replace("is provided", "is mailed"));
    expect(await importDrift(data)).toContain("absorbed 1");
    // Absorbed, and written back in the app's form: the scenarios numbered.
    expect(await readFeature(data, FILE)).toBe(WRITTEN.replace("is provided", "is mailed"));
    const view = (await readFeatureView(data, FILE))!;
    expect(view.parsed.scenarios[0]!.prs).toEqual([PR1]);
    expect(view.parsed.prs).toEqual([PR2]);
  });

  test("a three-way merge reconciled into the document", async () => {
    const loaded = (await loadFeatureDoc(data, FILE))!;
    const base = parseFeature(SAMPLE);
    const theirs = parseFeature(SAMPLE.replace("no account", "no account yet"));
    const merged = threeWayFeature(base, docToFeature(loaded.doc), theirs);
    if (!merged.ok) throw new Error(merged.conflict);
    const next = reconcile(loaded.doc, merged.feature);
    expect(next.specs[0]!.prs).toEqual([PR1]);
    expect(next.prs).toEqual([PR2]);
    expect(next.specs[1]!.body).toContain("no account yet");
  });

  test("a scenario deleted from the feature takes its links with it", async () => {
    const without = parseFeature(SAMPLE);
    without.scenarios = without.scenarios.filter((s) => s.name !== "Basic Quote");
    await saveFeature(data, FILE, serializeFeature(without));
    const feature = await docPrs();
    expect(feature.scenarios.map((s) => s.name)).toEqual(["Declined Quote"]);
    expect(feature.prs).toEqual([PR2]);
  });
});

// --- the routes ---------------------------------------------------------------

describe("PUT /api/features/:file/pull-requests", () => {
  const put = (body: unknown) =>
    handleApi(
      new Request(`http://localhost/api/features/${encodeURIComponent(FILE)}/pull-requests`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  beforeEach(async () => {
    await writeState({ dataRepo: data }, root);
  });

  test("links a scenario, then the feature, answering with the editor's view", async () => {
    const res = (await put({ scenario: { ...BASIC }, prs: [PR1] }))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parsed: { prs?: unknown; scenarios: { prs?: unknown }[] } };
    expect(body.parsed.scenarios[0]!.prs).toEqual([PR1]);
    const feature = (await put({ prs: [PR2] }))!;
    expect(feature.status).toBe(200);
    expect(((await feature.json()) as { parsed: { prs?: unknown } }).parsed.prs).toEqual([PR2]);
    expect(await readFeature(data, FILE)).toBe(WRITTEN);
  });

  test("a bad list, a half-named scenario and an unknown scenario are 400s", async () => {
    expect((await put({ prs: [{ url: "javascript:alert(1)", title: "" }] }))!.status).toBe(400);
    expect((await put({ prs: "no" }))!.status).toBe(400);
    expect((await put({ scenario: { name: "Basic Quote" }, prs: [PR1] }))!.status).toBe(400);
    const missing = (await put({ scenario: { name: "Nope", version: 1 }, prs: [PR1] }))!;
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain("not found");
  });
});

describe("GET /api/pull-request reads the title from GitHub", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let answers: Record<string, { status?: number; body: unknown }> = {};
  let seen: { path: string; auth: string | null }[] = [];
  const savedApi = process.env.SPECDRIVEN_GITHUB_API_URL;
  const savedPath = process.env.PATH;
  const savedDemo = process.env.DEMO_MODE;

  beforeEach(() => {
    setTokenBackend(createFileBackend(join(home, "token.json")));
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, auth: req.headers.get("authorization") });
        const answer = answers[url.pathname];
        if (!answer) return Response.json({ message: "Not Found" }, { status: 404 });
        return Response.json(answer.body, { status: answer.status ?? 200 });
      },
    });
    process.env.SPECDRIVEN_GITHUB_API_URL = `http://127.0.0.1:${server.port}`;
    // An empty PATH keeps the machine's gh (and its token) out of the test.
    process.env.PATH = "";
    delete process.env.DEMO_MODE;
    answers = {};
    seen = [];
  });

  afterEach(async () => {
    await signOut();
    server?.stop(true);
    server = null;
    setTokenBackend(createFileBackend());
    if (savedApi === undefined) delete process.env.SPECDRIVEN_GITHUB_API_URL;
    else process.env.SPECDRIVEN_GITHUB_API_URL = savedApi;
    process.env.PATH = savedPath ?? "";
    if (savedDemo === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = savedDemo;
  });

  const lookup = (url: string) =>
    handleApi(new Request(`http://localhost/api/pull-request?url=${encodeURIComponent(url)}`));

  test("the pull request endpoint is asked, with the sign-in token, and the state is read", async () => {
    await saveToken({ token: "tok-123", login: "octo", name: null, email: null, id: 1 });
    answers["/repos/acme/repo/pulls/12"] = {
      body: { number: 12, title: "Quote engine", state: "open", draft: false, merged_at: null },
    };
    const res = (await lookup(PR1.url))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 12, title: "Quote engine", state: "open" });
    expect(seen).toEqual([{ path: "/repos/acme/repo/pulls/12", auth: "Bearer tok-123" }]);
  });

  test("merged, closed and draft are told apart", async () => {
    answers["/repos/acme/repo/pulls/1"] = { body: { number: 1, title: "m", state: "closed", merged_at: "2026-09-01T00:00:00Z" } };
    answers["/repos/acme/repo/pulls/2"] = { body: { number: 2, title: "c", state: "closed", merged_at: null } };
    answers["/repos/acme/repo/pulls/3"] = { body: { number: 3, title: "d", state: "open", draft: true } };
    expect((await getPullRequest("acme", "repo", 1)).state).toBe("merged");
    expect((await getPullRequest("acme", "repo", 2)).state).toBe("closed");
    expect((await getPullRequest("acme", "repo", 3)).state).toBe("draft");
  });

  test("no such pull request is a 200 with a reason, so the link can still be added", async () => {
    const res = (await lookup("https://github.com/acme/repo/pull/99"))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: null; reason: string };
    expect(body.title).toBeNull();
    expect(body.reason).toContain("no such repository");
  });

  test("a url that is not a GitHub pull request is a 400", async () => {
    expect((await lookup("https://github.com/acme/repo/issues/12"))!.status).toBe(400);
    expect((await lookup("https://gitlab.com/acme/repo/-/merge_requests/5"))!.status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("demo mode never asks GitHub", async () => {
    process.env.DEMO_MODE = "1";
    const res = (await lookup(PR1.url))!;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reason: string }).reason).toContain("demo mode");
    expect(seen).toEqual([]);
  });
});

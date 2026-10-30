// Tricentis qTest Manager REST client (specs/external-links/qtest-test-cases
// .feature.md "Create qTest test cases from a feature"), API v3:
// https://docs.tricentis.com/qtest-saas/content/apis/apis/test_case_apis.htm
//
// Every call carries a bearer token. A feature's scenarios are published as
// test cases of one module named after the feature, under the parent module
// the user names: each test case created the first time and updated after
// that — found by the test case its scenario already links.

import type { Feature, Scenario } from "./parser";
import { scenarioNumbers } from "./parser";
import { scenarioToTestCase, type TestCaseDraft } from "./qtestSteps";
import { moduleWebUrl, onQtestBase, testCaseIdFromUrl, testCaseWebUrl } from "./qtestUrl";
import { bodyExcerpt, failureAttributes, type FailureDetails } from "./httpFailure";
import { getLogger } from "./telemetry";

const log = getLogger("qtest");

/** What went wrong on the wire, for the dialog's detail box and the log. */
export type QtestFailureDetails = FailureDetails;

/** A failed qTest call, with the HTTP status so the route can pass it on. */
export class QtestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: QtestFailureDetails,
  ) {
    super(message);
  }
}

interface Init {
  method?: string;
  json?: unknown;
}

/** A body as the log and the detail box show it: JSON indented, the rest as bodyExcerpt reads it. */
function readable(text: string, contentType = ""): string {
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    try {
      return bodyExcerpt(JSON.stringify(JSON.parse(text), null, 2), "application/json");
    } catch {
      // not JSON after all
    }
  }
  return bodyExcerpt(text, contentType);
}

/**
 * Every exchange with qTest goes into the app's log under the "qtest"
 * component (the Observability page): the request and qTest's answer, both
 * bodies included, never the token. An answered call is info; a failure is
 * logged with the error the dialog shows — server errors and an unreachable
 * site as errors, refusals qTest explains (401, 403, 404, 400…) as warnings.
 */
function logExchange(details: QtestFailureDetails, started: number, error?: QtestError): void {
  const attributes = { ...failureAttributes(details), duration_ms: Math.round(performance.now() - started) };
  if (!error) {
    log.info(`${details.method} ${details.url} → ${details.status}`, attributes);
    return;
  }
  const serious = details.status === undefined || details.status >= 500;
  log[serious ? "error" : "warn"](error.message, attributes);
}

/**
 * One request to a qTest site's REST API, with the token and headers it
 * wants: qTest's answer as text with the details of the exchange, or a
 * QtestError carrying them.
 */
export async function qtestRequest(
  base: string,
  path: string,
  token: string,
  init: Init = {},
): Promise<{ text: string; details: QtestFailureDetails }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "SpecDriven",
    Authorization: `bearer ${token}`,
  };
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  const method = init.method ?? "GET";
  const url = `${base}${path}`;
  const sent = init.json !== undefined ? JSON.stringify(init.json) : undefined;
  const request = { method, url, ...(sent ? { requestBody: readable(sent, "application/json") } : {}) };
  const started = performance.now();
  const fail = (error: QtestError): QtestError => {
    logExchange(error.details!, started, error);
    return error;
  };
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: sent, redirect: "manual" });
  } catch (e) {
    const cause = (e as Error).message;
    throw fail(
      new QtestError(`Could not reach qTest at ${base}: ${cause}`, 502, {
        ...request,
        cause,
        time: new Date().toISOString(),
      }),
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text().catch(() => "");
  const details: QtestFailureDetails = {
    ...request,
    status: res.status,
    ...(res.statusText ? { statusText: res.statusText } : {}),
    ...(contentType ? { contentType } : {}),
    ...(text ? { body: readable(text, contentType) } : {}),
    time: new Date().toISOString(),
  };
  if (res.status >= 300 && res.status < 400) {
    // A redirect from the REST API is a sign-in page or SSO, never data.
    throw fail(
      new QtestError("qTest redirected the request — check the site url, and that the token is an API token", 401, {
        ...details,
        location: res.headers.get("location") ?? undefined,
      }),
    );
  }
  if (!res.ok) throw fail(describeFailure(res.status, text, details));
  logExchange(details, started);
  return { text, details };
}

async function qtest<T>(base: string, path: string, token: string, init: Init = {}): Promise<T> {
  const { text, details } = await qtestRequest(base, path, token, init);
  try {
    return JSON.parse(text) as T;
  } catch {
    const error = new QtestError("qTest answered with something that is not JSON — check the site url", 502, details);
    log.error(error.message, failureAttributes(details));
    throw error;
  }
}

/** A qTest failure as one sentence the dialog can show, with the status and details kept. */
function describeFailure(status: number, text: string, details: QtestFailureDetails): QtestError {
  const err = (message: string, code: number) => new QtestError(message, code, details);
  let detail: string | undefined;
  try {
    detail = (JSON.parse(text) as { message?: string } | null)?.message;
  } catch {
    // Not JSON (an HTML error page, say): the detail box shows the body.
  }
  if (status === 401) {
    return err("qTest rejected the token; save a new one in Settings → qTest.", 401);
  }
  if (status === 403) {
    return err(`qTest refused the request — the token cannot write to this project${detail ? `: ${detail}` : ""}`, 403);
  }
  if (status === 404) {
    return err("qTest reports no such project, module or test case, or the token cannot see it.", 404);
  }
  return err(`qTest answered HTTP ${status}${detail ? `: ${detail}` : ""}`, 502);
}

// --- Shapes ------------------------------------------------------------------------

interface RawProject {
  id: number;
  name?: string;
}

interface RawModule {
  id: number;
  pid?: string;
  name: string;
  parent_id?: number | null;
}

interface RawField {
  id: number;
  label?: string;
  required?: boolean;
  constrained?: boolean;
  allowed_values?: { value: number | string; label?: string; is_default?: boolean }[];
}

interface RawTestCase {
  id: number;
  pid?: string;
  parent_id?: number;
  web_url?: string;
}

/** A field-value pair as qTest's test case API takes it. */
export interface Property {
  field_id: number;
  field_value: number | string;
}

/** A module as the publish flow needs it. */
export interface ModuleInfo {
  id: string;
  pid: string;
  name: string;
  parentId: string | null;
  url: string;
}

/** A test case as the publish flow needs it. */
export interface TestCaseInfo {
  id: string;
  pid: string;
  url: string;
}

function moduleInfo(base: string, projectId: string, raw: RawModule): ModuleInfo {
  return {
    id: String(raw.id),
    pid: raw.pid ?? `MD-${raw.id}`,
    name: raw.name,
    parentId: raw.parent_id === null || raw.parent_id === undefined ? null : String(raw.parent_id),
    url: moduleWebUrl(base, projectId, String(raw.id)),
  };
}

function testCaseInfo(base: string, projectId: string, raw: RawTestCase): TestCaseInfo {
  return {
    id: String(raw.id),
    pid: raw.pid ?? `TC-${raw.id}`,
    url: raw.web_url && /^https?:\/\//.test(raw.web_url) ? raw.web_url : testCaseWebUrl(base, projectId, String(raw.id)),
  };
}

const project = (projectId: string) => `/api/v3/projects/${encodeURIComponent(projectId)}`;

// --- Calls -------------------------------------------------------------------------

/**
 * What a token can see, or a 401 QtestError: the projects it lists. qTest
 * answers an unknown token with 401, so the list itself is the check; a
 * token that sees no project at all is refused too, since nothing could be
 * published with it.
 */
export async function validateToken(base: string, token: string): Promise<{ user: string }> {
  const refused = (details?: QtestFailureDetails) =>
    new QtestError("qTest did not accept this token — check it and its expiry", 401, details);
  let projects: RawProject[];
  try {
    projects = await qtest<RawProject[]>(base, "/api/v3/projects", token);
  } catch (e) {
    throw e instanceof QtestError && e.status === 401 ? refused(e.details) : e;
  }
  if (!Array.isArray(projects)) throw refused();
  if (projects.length === 0) throw new QtestError("The token sees no qTest project, so nothing could be published with it", 403);
  return { user: `${projects.length} project${projects.length === 1 ? "" : "s"}` };
}

/** A module by id, or null when qTest has none (a deleted module). */
export async function getModule(base: string, token: string, projectId: string, id: string): Promise<ModuleInfo | null> {
  try {
    const raw = await qtest<RawModule>(base, `${project(projectId)}/modules/${encodeURIComponent(id)}`, token);
    return moduleInfo(base, projectId, raw);
  } catch (e) {
    if (e instanceof QtestError && e.status === 404) return null;
    throw e;
  }
}

/** The modules right under a parent module. */
export async function listChildModules(
  base: string,
  token: string,
  projectId: string,
  parentId: string,
): Promise<ModuleInfo[]> {
  const raw = await qtest<RawModule[]>(base, `${project(projectId)}/modules?parentId=${encodeURIComponent(parentId)}`, token);
  return (Array.isArray(raw) ? raw : []).map((m) => moduleInfo(base, projectId, m));
}

/** A new module under a parent. */
export async function createModule(
  base: string,
  token: string,
  projectId: string,
  parentId: string,
  name: string,
): Promise<ModuleInfo> {
  const raw = await qtest<RawModule>(base, `${project(projectId)}/modules?parentId=${encodeURIComponent(parentId)}`, token, {
    method: "POST",
    json: { name },
  });
  return moduleInfo(base, projectId, raw);
}

/** Move a module under another parent, keeping its name. */
export async function moveModule(
  base: string,
  token: string,
  projectId: string,
  module: ModuleInfo,
  parentId: string,
): Promise<ModuleInfo> {
  const raw = await qtest<RawModule>(
    base,
    `${project(projectId)}/modules/${encodeURIComponent(module.id)}?parentId=${encodeURIComponent(parentId)}`,
    token,
    { method: "PUT", json: { name: module.name } },
  );
  return moduleInfo(base, projectId, raw);
}

// The fields a test case is given directly rather than as properties.
const DIRECT_FIELDS = new Set(["name", "description", "precondition"]);

/**
 * The properties a new test case must carry: every required field of the
 * project's test cases, at its default value — the allowed value flagged as
 * default, else the first allowed one, else blank. Field ids differ per
 * project, so they are read, never assumed. Reading them takes the right to
 * see the project's settings, which a tester's token often lacks: refused
 * that (403), the test cases go without, and qTest names any field it misses.
 */
export async function requiredProperties(base: string, token: string, projectId: string): Promise<Property[]> {
  let fields: RawField[];
  try {
    fields = await qtest<RawField[]>(base, `${project(projectId)}/settings/test-cases/fields`, token);
  } catch (e) {
    if (e instanceof QtestError && e.status === 403) return [];
    throw e;
  }
  return (Array.isArray(fields) ? fields : []).flatMap((f) => {
    if (!f.required || DIRECT_FIELDS.has((f.label ?? "").trim().toLowerCase())) return [];
    const values = f.allowed_values ?? [];
    const pick = values.find((v) => v.is_default) ?? values[0];
    return [{ field_id: f.id, field_value: pick ? pick.value : "" }];
  });
}

/** A test case by id, or null when qTest has none (a deleted test case). */
export async function getTestCase(
  base: string,
  token: string,
  projectId: string,
  id: string,
): Promise<TestCaseInfo | null> {
  try {
    const raw = await qtest<RawTestCase>(base, `${project(projectId)}/test-cases/${encodeURIComponent(id)}`, token);
    return testCaseInfo(base, projectId, raw);
  } catch (e) {
    if (e instanceof QtestError && e.status === 404) return null;
    throw e;
  }
}

interface TestCaseFields extends TestCaseDraft {
  parent_id: string;
  properties: Property[];
}

export async function createTestCase(
  base: string,
  token: string,
  projectId: string,
  fields: TestCaseFields,
): Promise<TestCaseInfo> {
  const raw = await qtest<RawTestCase>(base, `${project(projectId)}/test-cases`, token, { method: "POST", json: fields });
  return testCaseInfo(base, projectId, raw);
}

/** A new version of a test case; naming the parent moves it there when it sat elsewhere. */
export async function updateTestCase(
  base: string,
  token: string,
  projectId: string,
  id: string,
  fields: TestCaseFields,
): Promise<TestCaseInfo> {
  const raw = await qtest<RawTestCase>(base, `${project(projectId)}/test-cases/${encodeURIComponent(id)}`, token, {
    method: "PUT",
    json: fields,
  });
  return testCaseInfo(base, projectId, raw);
}

// --- Publishing a feature ------------------------------------------------------------

/** One scenario's test case after a publish. */
export interface PublishedCase {
  /** The scenario's index in the feature, so the route can link it back. */
  index: number;
  scenarioName: string;
  id: string;
  pid: string;
  url: string;
  created: boolean;
}

export interface PublishResult {
  module: ModuleInfo & { created: boolean };
  cases: PublishedCase[];
  /** The scenario whose test case could not be written, when one could not. */
  failed?: { index: number; scenarioName: string; error: string; details?: QtestFailureDetails };
}

/**
 * The feature's module under the parent: the one the feature already links
 * (`existingModuleId`) when it still exists — moved under the parent when it
 * sat elsewhere — else the child of the parent with the feature's name, else
 * a new one.
 */
async function featureModule(p: {
  base: string;
  token: string;
  projectId: string;
  parentId: string;
  name: string;
  existingModuleId?: string;
}): Promise<ModuleInfo & { created: boolean }> {
  if (p.existingModuleId) {
    const linked = await getModule(p.base, p.token, p.projectId, p.existingModuleId);
    if (linked) {
      if (linked.parentId === p.parentId) return { ...linked, created: false };
      return { ...(await moveModule(p.base, p.token, p.projectId, linked, p.parentId)), created: false };
    }
  }
  const same = (await listChildModules(p.base, p.token, p.projectId, p.parentId)).find(
    (m) => m.name.trim().toLowerCase() === p.name.trim().toLowerCase(),
  );
  if (same) return { ...same, created: false };
  return { ...(await createModule(p.base, p.token, p.projectId, p.parentId, p.name)), created: true };
}

/** The test case a scenario already links on this site, by its numeric id, if any. */
function linkedTestCaseId(scenario: Scenario, base: string): string | null {
  const link = scenario.qtest;
  if (!link || !onQtestBase(link.url, base)) return null;
  return testCaseIdFromUrl(link.url);
}

/**
 * Publish a feature's scenarios as test cases: one module named after the
 * feature under the parent, one test case per scenario in scope. A scenario
 * whose link names a test case still in qTest is updated there (and moved
 * into the module when it sat elsewhere); any other gets a new one. Stops
 * at the first test case qTest refuses, reporting it with what was done —
 * the route links those back so a second run carries on from there.
 */
export async function publishFeatureTestCases(p: {
  base: string;
  token: string;
  projectId: string;
  parentModuleId: string;
  feature: Feature;
  file: string;
  title: string;
  scope: "all" | "published";
  existingModuleId?: string;
}): Promise<PublishResult> {
  let parent: ModuleInfo;
  try {
    const raw = await qtest<RawModule>(
      p.base,
      `${project(p.projectId)}/modules/${encodeURIComponent(p.parentModuleId)}`,
      p.token,
    );
    parent = moduleInfo(p.base, p.projectId, raw);
  } catch (e) {
    if (!(e instanceof QtestError && e.status === 404)) throw e;
    throw new QtestError(
      `qTest has no module ${p.parentModuleId} in project ${p.projectId}, or the token cannot see it.`,
      404,
      e.details,
    );
  }
  // Read before anything is written, so a failure here leaves no empty module behind.
  const properties = await requiredProperties(p.base, p.token, p.projectId);
  const module = await featureModule({
    base: p.base,
    token: p.token,
    projectId: p.projectId,
    parentId: parent.id,
    name: p.title,
    existingModuleId: p.existingModuleId,
  });
  const numbers = scenarioNumbers(p.feature.scenarios);
  // The feature's Confluence page is titled the way this module is named
  // (the publish route's rule), which its anchors' fragments are built from.
  const page = p.feature.confluence;
  const source = { featureName: p.title, file: p.file, ...(page ? { confluencePage: { url: page.url, title: p.title } } : {}) };
  const cases: PublishedCase[] = [];
  for (const [index, scenario] of p.feature.scenarios.entries()) {
    if (p.scope === "published" && scenario.status !== "published") continue;
    const draft = scenarioToTestCase(scenario, numbers[index] ?? null, source);
    const fields: TestCaseFields = { ...draft, parent_id: module.id, properties };
    try {
      const linkedId = linkedTestCaseId(scenario, p.base);
      const existing = linkedId ? await getTestCase(p.base, p.token, p.projectId, linkedId) : null;
      const written = existing
        ? await updateTestCase(p.base, p.token, p.projectId, existing.id, fields)
        : await createTestCase(p.base, p.token, p.projectId, fields);
      cases.push({ index, scenarioName: scenario.name, ...written, created: !existing });
    } catch (e) {
      const error = e instanceof QtestError ? e.message : (e as Error).message;
      const details = e instanceof QtestError ? e.details : undefined;
      return { module, cases, failed: { index, scenarioName: scenario.name, error, ...(details ? { details } : {}) } };
    }
  }
  return { module, cases };
}

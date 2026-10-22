// Aha! REST client (specs/external-links/aha-import.feature.md "Import a
// feature by its url"), API v1: https://www.aha.io/api
//
// Every call carries the user's API key as a bearer token. The import reads
// one feature — its name, description and requirements — and nothing is
// written to Aha!. Descriptions come back as HTML; src/server/ahaImport.ts
// turns them into the markdown the spec editor reads.

import { ahaRecordUrl } from "./ahaUrl";

/** A failed Aha! call, with the HTTP status so the route can pass it on. */
export class AhaError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** One request to an Aha! site's REST API, with the key and headers it wants. */
export async function ahaRequest(base: string, path: string, key: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "SpecDriven",
        Authorization: `Bearer ${key}`,
      },
      redirect: "manual",
    });
  } catch (e) {
    throw new AhaError(`Could not reach Aha! at ${base}: ${(e as Error).message}`, 502);
  }
  if (res.status >= 300 && res.status < 400) {
    // A redirect from the REST API is a sign-in page or SSO, never data.
    throw new AhaError("Aha! redirected the request — check the site url, and that the key is an API key", 401);
  }
  if (!res.ok) throw await describeFailure(res);
  return res;
}

async function aha<T>(base: string, path: string, key: string): Promise<T> {
  const res = await ahaRequest(base, path, key);
  try {
    return (await res.json()) as T;
  } catch {
    throw new AhaError("Aha! answered with something that is not JSON — check the site url", 502);
  }
}

/** An Aha! failure as one sentence the dialog can show, with the status kept. */
async function describeFailure(res: Response): Promise<AhaError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  const detail = [body?.error, body?.message].find((d): d is string => typeof d === "string" && d.length > 0);
  if (res.status === 401) {
    return new AhaError("Aha! rejected the API key; save a new one in Settings → Aha!.", 401);
  }
  if (res.status === 403) {
    return new AhaError(`Aha! refused the request — the key cannot see this record${detail ? `: ${detail}` : ""}`, 403);
  }
  if (res.status === 404) {
    return new AhaError("Aha! has no such record, or the key cannot see it.", 404);
  }
  if (res.status === 429) {
    return new AhaError("Aha! is rate-limiting this key; try again in a minute.", 429);
  }
  return new AhaError(`Aha! answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`, 502);
}

// --- Shapes ------------------------------------------------------------------------

interface RawDescription {
  body?: string | null;
}

interface RawRequirement {
  id?: number | string;
  reference_num?: string;
  name?: string;
  description?: RawDescription | null;
  url?: string;
}

interface RawFeature {
  id?: number | string;
  reference_num?: string;
  name?: string;
  description?: RawDescription | null;
  url?: string;
  workflow_status?: { name?: string } | null;
  release?: { name?: string } | null;
  requirements?: RawRequirement[] | null;
}

interface RawPagination {
  current_page?: number;
  total_pages?: number;
}

/** A requirement as the import needs it. */
export interface AhaRequirement {
  referenceNum: string;
  name: string;
  /** The description as Aha! holds it: HTML. */
  description: string;
  url: string;
}

/** A feature as the import needs it. */
export interface AhaFeature {
  referenceNum: string;
  name: string;
  /** The description as Aha! holds it: HTML. */
  description: string;
  url: string;
  /** The workflow status's name ("In design"), or "". */
  status: string;
  /** The release's name, or "". */
  release: string;
  requirements: AhaRequirement[];
}

function requirementInfo(base: string, raw: RawRequirement, fallbackRef: string): AhaRequirement {
  const referenceNum = raw.reference_num ?? fallbackRef;
  return {
    referenceNum,
    name: raw.name ?? "",
    description: raw.description?.body ?? "",
    url: raw.url ?? ahaRecordUrl(base, "requirement", referenceNum),
  };
}

/**
 * Check an API key against the site before it is kept: Aha! tells who it
 * signs in as. A key Aha! refuses, or that answers as nobody, is an error.
 */
export async function validateAhaKey(base: string, key: string): Promise<{ user: string }> {
  const refused = new AhaError("Aha! did not accept this API key — check it, and the site url", 401);
  let me: { user?: { name?: string; email?: string } | null };
  try {
    me = await aha(base, "/me", key);
  } catch (e) {
    throw e instanceof AhaError && e.status === 401 ? refused : e;
  }
  const user = me?.user?.name?.trim() || me?.user?.email?.trim();
  if (!user) throw refused;
  return { user };
}

/**
 * One feature with its requirements. The feature answer lists the
 * requirements, but not always with their descriptions; those are read from
 * the requirements endpoint when any is missing, page by page.
 */
export async function getAhaFeature(base: string, key: string, ref: string): Promise<AhaFeature> {
  const { feature } = await aha<{ feature?: RawFeature }>(base, `/features/${encodeURIComponent(ref)}?fields=*`, key);
  if (!feature || typeof feature !== "object") {
    throw new AhaError("Aha! answered without a feature — check the url", 502);
  }
  const referenceNum = feature.reference_num ?? ref;
  let requirements = (feature.requirements ?? []).map((r, i) => requirementInfo(base, r, `${referenceNum}-${i + 1}`));
  if (requirements.some((r, i) => (feature.requirements?.[i]?.description ?? null) === null)) {
    requirements = await getAhaRequirements(base, key, referenceNum);
  }
  return {
    referenceNum,
    name: feature.name ?? referenceNum,
    description: feature.description?.body ?? "",
    url: feature.url ?? ahaRecordUrl(base, "feature", referenceNum),
    status: feature.workflow_status?.name ?? "",
    release: feature.release?.name ?? "",
    requirements,
  };
}

/** A feature's requirements, every page of them. */
export async function getAhaRequirements(base: string, key: string, ref: string): Promise<AhaRequirement[]> {
  const out: AhaRequirement[] = [];
  for (let page = 1; page <= 20; page++) {
    const answer = await aha<{ requirements?: RawRequirement[]; pagination?: RawPagination }>(
      base,
      `/features/${encodeURIComponent(ref)}/requirements?fields=*&per_page=200&page=${page}`,
      key,
    );
    for (const raw of answer.requirements ?? []) out.push(requirementInfo(base, raw, `${ref}-${out.length + 1}`));
    if ((answer.pagination?.total_pages ?? 1) <= page) break;
  }
  return out;
}

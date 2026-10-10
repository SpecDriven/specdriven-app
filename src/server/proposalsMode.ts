// Spec-proposals mode (specs/app/spec-proposals.feature.md): the app runs as a
// public service where anyone signed in with GitHub proposes specs into one
// spec repository — a new feature, or a new scenario on an existing one —
// committed straight to its default branch as `[proposed]`. Nothing else
// changes anything: no editing, publishing, deleting, settings, plugins or
// agents (src/server/proposals/gate.ts). Every push goes out with one bot
// token; the visitor authors the commit and signs the scenario.
//
// Kept apart from src/server/proposals/ for the same reason as demoMode.ts:
// modules that only need to ask "is this the proposals service?" must not
// import the service and close a cycle through the API.

/** A GitHub repository as the service names it. */
export interface ProposalsRepo {
  owner: string;
  name: string;
  /** Canonical https url — what the data repo setting holds. */
  url: string;
}

const REPO_RE = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** `owner/name` or its https url; null for anything else. */
export function parseProposalsRepo(input: string): ProposalsRepo | null {
  const m = input.trim().match(REPO_RE);
  if (!m) return null;
  const [, owner, name] = m;
  if ([owner, name].some((s) => s === "." || s === "..")) return null;
  return { owner: owner!, name: name!, url: `https://github.com/${owner}/${name}` };
}

export function isProposalsMode(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.SPECDRIVEN_PROPOSALS;
  return v === "1" || v === "true";
}

/** What every route outside the proposals service answers there. */
export const PROPOSALS_REFUSAL = "This service only accepts spec proposals";

export const DEFAULT_PROPOSALS_REPO = "SpecDriven/specs-specdriven";
export const DEFAULT_PER_DAY = 5;
export const DEFAULT_GLOBAL_PER_DAY = 100;

export interface ProposalsConfig {
  /** The spec repository proposals are committed to. */
  repo: ProposalsRepo;
  /** The token every push goes out with — contents:write on `repo` only. */
  botToken: string;
  /** Proposals one GitHub account may make per UTC day (contributors are exempt). */
  perDay: number;
  /** Proposals the whole service accepts per UTC day — the backstop for throwaway accounts. */
  globalPerDay: number;
  /** The service's public origin; the GitHub callback is built from it, never from Host. */
  publicUrl: string;
  /** The service's database (sessions, quota, audit log). */
  dbPath: string;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number, not "${raw}"`);
  return n;
}

/**
 * The service's settings, read once at start. A missing secret is a startup
 * failure, not a service that half works: without the bot token nothing can
 * be pushed, and without the public url the GitHub callback has nowhere to go.
 */
export function readProposalsConfig(env: Record<string, string | undefined> = process.env): ProposalsConfig {
  const repoName = env.SPECDRIVEN_PROPOSALS_REPO?.trim() || DEFAULT_PROPOSALS_REPO;
  const repo = parseProposalsRepo(repoName);
  if (!repo) throw new Error(`SPECDRIVEN_PROPOSALS_REPO must name a GitHub repository (owner/name), not "${repoName}"`);
  const botToken = env.SPECDRIVEN_PROPOSALS_BOT_TOKEN?.trim();
  if (!botToken) throw new Error("SPECDRIVEN_PROPOSALS_BOT_TOKEN is required in proposals mode");
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!publicUrl || !/^https?:\/\//.test(publicUrl)) {
    throw new Error("PUBLIC_URL is required in proposals mode (e.g. https://propose.specdriven.app)");
  }
  return {
    repo,
    botToken,
    perDay: positiveInt(env.SPECDRIVEN_PROPOSALS_PER_DAY, DEFAULT_PER_DAY, "SPECDRIVEN_PROPOSALS_PER_DAY"),
    globalPerDay: positiveInt(
      env.SPECDRIVEN_PROPOSALS_GLOBAL_PER_DAY,
      DEFAULT_GLOBAL_PER_DAY,
      "SPECDRIVEN_PROPOSALS_GLOBAL_PER_DAY",
    ),
    publicUrl,
    dbPath: env.SPECDRIVEN_PROPOSALS_DB?.trim() || `${env.SPECDRIVEN_DATA_DIR?.trim() || "/data"}/proposals.db`,
  };
}

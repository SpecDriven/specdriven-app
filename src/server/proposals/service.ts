// The proposals themselves (specs/app/spec-proposals.feature.md): a signed-in
// visitor adds one scenario — to an existing feature, or as the first
// scenario of a new one — and it lands on the spec repo's default branch as
// `@v1 [proposed]`, authored by the visitor and pushed with the bot token.
//
// Add-only is enforced by construction, not by inspecting an edit: the
// visitor never sends a feature text, only a name and a body, and the server
// builds the text itself from what is on the remote right now. The result is
// then checked against what was there (assertAppendOnly) before anything is
// committed, so no path — a heading smuggled into a body, a name that
// collides, the projection reformatting something — can change, remove or
// publish an existing scenario.
//
// One proposal at a time: every write runs under one lock, starting from a
// clone reset to the remote, so concurrent visitors and pushes from people
// working in the repo directly never interleave. A push the remote rejects
// (someone pushed in between) is retried from a fresh reset.

import type { Database } from "bun:sqlite";
import { actAs } from "../actingAs";
import { docDirRel } from "../automerge/store";
import { createFeature, listFolders, readFeature, saveFeature, slugify } from "../features";
import { commitAndPush } from "../git";
import type { GitRun } from "../git/cli";
import { parseFeature, serializeFeature, type Feature, type Scenario } from "../parser";
import { getLogger } from "../telemetry";
import { cleanLine } from "../text";
import type { TokenRecord } from "../tokenStore";
import { recordProposal, type ProposerRow } from "./db";

const log = getLogger("proposals");

export const MAX_NAME = 120;
export const MAX_BODY = 8 * 1024;
export const MAX_DESCRIPTION = 4 * 1024;
const PUSH_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A refusal the visitor should see, with the HTTP status it answers. */
export class ProposalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type ProposalInput =
  | { kind: "scenario"; file: string; name: string; body: string }
  | {
      kind: "feature";
      folder: string;
      name: string;
      description: string;
      scenario: { name: string; body: string };
    };

export interface ProposalResult {
  file: string;
  scenario: string;
  commit: string;
}

/** A body as stored: line endings normalized, trailing whitespace off each line, trimmed. */
function normalizeBody(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

function checkName(raw: unknown, what: string): string {
  if (typeof raw !== "string") throw new ProposalError(`${what} is required`, 400);
  const name = cleanLine(raw);
  if (!name) throw new ProposalError(`${what} is required`, 400);
  if (name.length > MAX_NAME) throw new ProposalError(`${what} is longer than ${MAX_NAME} characters`, 400);
  return name;
}

function checkText(raw: unknown, what: string, max: number, required: boolean): string {
  if (raw !== undefined && typeof raw !== "string") throw new ProposalError(`${what} must be text`, 400);
  const text = normalizeBody((raw as string | undefined) ?? "");
  if (required && !text) throw new ProposalError(`${what} is required`, 400);
  if (text.length > max) throw new ProposalError(`${what} is longer than ${max} characters`, 400);
  // A heading would end the scenario (or the description) and start
  // another one the server did not build.
  if (/^\s{0,3}#/m.test(text)) {
    throw new ProposalError(`${what} cannot contain markdown headings (lines starting with #)`, 400);
  }
  return text;
}

/** The scenario a proposal adds: always `@v1 [proposed]`, never signed in the text. */
export function proposedScenario(name: unknown, body: unknown): Scenario {
  return {
    name: checkName(name, "Scenario name"),
    version: 1,
    status: "proposed",
    body: checkText(body, "Scenario", MAX_BODY, true),
    tests: [],
  };
}

/**
 * Whether markdown carries a scenario exactly as built — nothing in the
 * name or body was read back as something else (a version chip, a status,
 * a `**Created by:**` line that would sign it as someone other than the
 * visitor, a ticket or qTest link, a test link, a feature flag or attribute line).
 */
function sameScenario(parsed: Scenario | undefined, built: Scenario): boolean {
  return (
    parsed !== undefined &&
    parsed.name === built.name &&
    parsed.version === 1 &&
    parsed.status === "proposed" &&
    parsed.body === built.body &&
    parsed.tests.length === 0 &&
    !parsed.link &&
    !parsed.qtest &&
    !parsed.flags &&
    !parsed.attributes &&
    !parsed.createdBy &&
    !parsed.updatedBy
  );
}

/** A feature text with the scenario appended; refused when it would not read back as built. */
export function appendScenario(text: string, scenario: Scenario): string {
  const feature = parseFeature(text);
  if (feature.scenarios.some((s) => s.name.toLowerCase() === scenario.name.toLowerCase())) {
    throw new ProposalError(`This feature already has a scenario named "${scenario.name}"`, 409);
  }
  const next = serializeFeature({ ...feature, scenarios: [...feature.scenarios, scenario] });
  const back = parseFeature(next);
  // The new scenario comes last, but it is found by name all the same: a
  // feature file from before the scenario numbers reads back in name order.
  const added = back.scenarios.filter((s) => s.name === scenario.name);
  if (back.scenarios.length !== feature.scenarios.length + 1 || added.length !== 1 || !sameScenario(added[0], scenario)) {
    throw new ProposalError("The scenario's name or text would not read back as written — simplify it", 400);
  }
  return next;
}

/** The text of a new feature holding one proposed scenario. */
export function newFeatureText(name: unknown, description: unknown, scenario: Scenario): { name: string; text: string } {
  const featureName = checkName(name, "Feature name");
  // A slash would make folders (createFeature reads `a/b` as folder a).
  if (featureName.includes("/")) throw new ProposalError("The feature name cannot contain /", 400);
  if (!slugify(featureName)) throw new ProposalError("The feature name needs letters or digits", 400);
  const desc = checkText(description, "Description", MAX_DESCRIPTION, false);
  const text = serializeFeature({ name: featureName, description: desc, scenarios: [scenario] });
  const back = parseFeature(text);
  if (
    back.name !== featureName ||
    back.description !== desc ||
    back.assigned ||
    back.link ||
    back.qtest ||
    back.flags ||
    back.attributes ||
    back.createdBy ||
    back.updatedBy ||
    back.scenarios.length !== 1 ||
    !sameScenario(back.scenarios[0], scenario)
  ) {
    throw new ProposalError("The feature's name or text would not read back as written — simplify it", 400);
  }
  return { name: featureName, text };
}

/**
 * The backstop: what was written holds everything that was there, unchanged,
 * plus exactly the one proposed scenario.
 */
export function assertAppendOnly(before: Feature, after: Feature, added: Scenario): void {
  const fail = (why: string) => {
    throw new ProposalError(`Refused: the proposal would ${why}`, 409);
  };
  if (after.name !== before.name) fail("rename the feature");
  if (after.description !== before.description) fail("change the feature's description");
  if (after.scenarios.length !== before.scenarios.length + 1) fail("change more than one scenario");
  for (const old of before.scenarios) {
    const now = after.scenarios.find((s) => s.name === old.name && s.version === old.version);
    if (!now || now.status !== old.status || now.body !== old.body) {
      fail(`change the existing scenario "${old.name}"`);
    }
  }
  const fresh = after.scenarios.find((s) => !before.scenarios.some((o) => o.name === s.name && o.version === s.version));
  if (!fresh || fresh.name !== added.name || fresh.status !== "proposed" || fresh.body !== added.body) {
    fail("add something other than the proposed scenario");
  }
}

/** The UTC day a time falls on, as its first millisecond. */
export function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

export interface Quota {
  /** Proposals this account made today (UTC). */
  used: number;
  /** Its daily allowance; null for a contributor, who has none. */
  limit: number | null;
  /** When today's allowance resets (next UTC midnight), ms since the epoch. */
  resetsAt: number;
}

export interface ServiceOptions {
  db: Database;
  /** The spec repo's clone, as the app resolves its data repo. */
  dataDir: () => Promise<string>;
  /** Git in the clone, credentialed the way getAuth says (actAs). */
  git: GitRun;
  /** The bot's own record — the identity the clone is reset and refreshed as. */
  bot: TokenRecord;
  perDay: number;
  globalPerDay: number;
  /** Whether a GitHub account can write to the spec repo (a contributor). */
  isContributor: (user: ProposerRow) => Promise<boolean>;
  now?: () => number;
}

export class ProposalService {
  private turn: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly opts: ServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Run fn after every write queued before it, and before any queued after. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.turn.then(fn, fn);
    this.turn = run.catch(() => {});
    return run;
  }

  private countSince(userId: string | null, since: number): number {
    const row = (
      userId === null
        ? this.opts.db.query("SELECT COUNT(*) AS n FROM proposals WHERE created_at >= ?").get(since)
        : this.opts.db
            .query("SELECT COUNT(*) AS n FROM proposals WHERE user_id = ? AND created_at >= ?")
            .get(userId, since)
    ) as { n: number };
    return row.n;
  }

  /** Today's use of an account's allowance. */
  quota(user: ProposerRow, contributor: boolean): Quota {
    const day = utcDayStart(this.now());
    return {
      used: this.countSince(user.id, day),
      limit: contributor ? null : this.opts.perDay,
      resetsAt: day + DAY_MS,
    };
  }

  /** The record a visitor's commit goes out as: the bot's token, the visitor's name. */
  private visitorRecord(user: ProposerRow): TokenRecord {
    return {
      token: this.opts.bot.token,
      login: user.login,
      name: user.name || user.login,
      email: user.email,
      id: Number(user.id),
      host: this.opts.bot.host,
    };
  }

  private async branch(dir: string): Promise<string> {
    const res = await this.opts.git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    const name = res.stdout.trim();
    if (res.exitCode !== 0 || !name || name === "HEAD") throw new Error("The spec repo clone has no branch checked out");
    return name;
  }

  /** Make the clone exactly the remote's default branch: fetched, reset, cleaned. */
  private async resetToOrigin(dir: string): Promise<string> {
    const branch = await this.branch(dir);
    for (const args of [
      ["fetch", "origin", branch],
      ["reset", "--hard", `origin/${branch}`],
      ["clean", "-fd"],
    ]) {
      const res = await this.opts.git(dir, ...args);
      if (res.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${(res.stderr + res.stdout).trim()}`);
    }
    return branch;
  }

  /** Bring the clone up to date with the remote, between proposals. */
  resync(): Promise<void> {
    return this.locked(() =>
      actAs(this.opts.bot, async () => {
        await this.resetToOrigin(await this.opts.dataDir());
      }),
    );
  }

  /** The head commit, once it is on the remote; null when the push did not land. */
  private async pushedHead(dir: string, branch: string, before: string): Promise<string | null> {
    const head = (await this.opts.git(dir, "rev-parse", "HEAD")).stdout.trim();
    if (!head || head === before) return null;
    const ahead = await this.opts.git(dir, "rev-list", "--count", `origin/${branch}..HEAD`);
    return ahead.exitCode === 0 && ahead.stdout.trim() === "0" ? head : null;
  }

  /** Validate, write, commit and push one proposal for a signed-in visitor. */
  async propose(user: ProposerRow, input: ProposalInput): Promise<ProposalResult> {
    if (user.bannedAt) throw new ProposalError("This account cannot propose specs", 403);
    // Everything that can be refused without the repo is refused before the lock.
    const scenario =
      input.kind === "scenario"
        ? proposedScenario(input.name, input.body)
        : proposedScenario(input.scenario?.name, input.scenario?.body);
    const feature = input.kind === "feature" ? newFeatureText(input.name, input.description, scenario) : null;
    const contributor = await this.opts.isContributor(user);

    return this.locked(async () => {
      const day = utcDayStart(this.now());
      if (!contributor && this.countSince(user.id, day) >= this.opts.perDay) {
        throw new ProposalError(
          `You have made today's ${this.opts.perDay} proposals — the allowance resets at 00:00 UTC`,
          429,
        );
      }
      if (this.countSince(null, day) >= this.opts.globalPerDay) {
        throw new ProposalError("The service has taken all the proposals it accepts today — try again tomorrow", 429);
      }
      const dir = await this.opts.dataDir();
      const trailer = `\n\nProposed-by: @${user.login} (GitHub id ${user.id}) via the spec proposals service`;
      let lastFailure = "";
      for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
        const { branch, before } = await actAs(this.opts.bot, async () => {
          const branch = await this.resetToOrigin(dir);
          return { branch, before: (await this.opts.git(dir, "rev-parse", "HEAD")).stdout.trim() };
        });
        const file = await actAs(this.visitorRecord(user), () =>
          feature ? this.writeFeature(dir, input as Extract<ProposalInput, { kind: "feature" }>, feature, trailer) : this.writeScenario(dir, input as Extract<ProposalInput, { kind: "scenario" }>, scenario, trailer),
        );
        const commit = await actAs(this.opts.bot, () => this.pushedHead(dir, branch, before));
        if (commit) {
          recordProposal(
            this.opts.db,
            { userId: user.id, file, scenario: scenario.name, newFeature: feature !== null, commit },
            this.now(),
          );
          log.info(`@${user.login} proposed "${scenario.name}" in ${file} (${commit.slice(0, 7)})`);
          return { file, scenario: scenario.name, commit };
        }
        lastFailure = `attempt ${attempt} did not reach the remote`;
        log.warn(`proposal by @${user.login} to ${file}: ${lastFailure}; retrying from the remote`);
      }
      // Leave nothing half-done in the clone for the next proposal.
      await actAs(this.opts.bot, () => this.resetToOrigin(dir)).catch(() => {});
      throw new ProposalError(`The proposal could not be pushed (${lastFailure}) — try again in a minute`, 503);
    });
  }

  private async writeScenario(
    dir: string,
    input: Extract<ProposalInput, { kind: "scenario" }>,
    scenario: Scenario,
    trailer: string,
  ): Promise<string> {
    const file = typeof input.file === "string" ? input.file : "";
    let text: string | null;
    try {
      text = await readFeature(dir, file);
    } catch {
      text = null; // not a feature file path at all
    }
    if (text === null) throw new ProposalError(`No feature at ${file}`, 404);
    const before = parseFeature(text);
    await saveFeature(dir, file, appendScenario(text, scenario));
    const written = await readFeature(dir, file);
    assertAppendOnly(before, parseFeature(written ?? ""), scenario);
    await commitAndPush(dir, [file, docDirRel(file)], `Propose scenario "${scenario.name}" in ${before.name}${trailer}`);
    return file;
  }

  private async writeFeature(
    dir: string,
    input: Extract<ProposalInput, { kind: "feature" }>,
    feature: { name: string; text: string },
    trailer: string,
  ): Promise<string> {
    const folder = typeof input.folder === "string" ? input.folder.trim().replace(/^\/+|\/+$/g, "") : "";
    const within = folder === "specs" || folder === "" ? "specs" : folder.startsWith("specs/") ? folder : `specs/${folder}`;
    if (within !== "specs" && !(await listFolders(dir)).includes(within)) {
      throw new ProposalError(`There is no folder ${within} — propose into one that exists`, 400);
    }
    try {
      return await createFeature(dir, `${within}/${feature.name}`, feature.text, (name) => `Propose feature "${name}"${trailer}`);
    } catch (e) {
      const message = (e as Error).message;
      if (/already exists/.test(message)) {
        throw new ProposalError(`A feature named "${feature.name}" already exists in ${within} — add your scenario to it`, 409);
      }
      throw e;
    }
  }
}

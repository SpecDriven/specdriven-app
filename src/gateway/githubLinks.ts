// Who is who on GitHub, and the tokens made for them
// (docs/hosted-tenant-isolation.md "Step 3"). Two small things beside the
// app itself (githubApp.ts):
//
//   GithubLinks  each person's GitHub account, as they proved it on the
//                account page: an id and a login, and no secret. It is all
//                the gateway keeps for GitHub.
//   RepoTokens   the tokens the app makes for a person's worker, one per
//                repository, each kept while its hour lasts and handed out
//                again until it is nearly over. A worker someone has taken
//                over can ask as often as it likes: what reaches GitHub is
//                counted, for that person and for everyone together, and a
//                refusal is remembered for a minute. The count is the
//                person's, not the worker's: stopping a worker and starting
//                another does not begin it again.

import type { Database } from "bun:sqlite";
import { GithubRefusal, repoName, type GithubIdentity, type RepoToken } from "./githubApp";

export interface GithubLink extends GithubIdentity {
  linkedAt: number;
}

export class GithubLinks {
  constructor(
    private db: Database,
    private now: () => number = Date.now,
  ) {}

  get(userId: string): GithubLink | null {
    const row = this.db
      .query("SELECT github_id AS id, login, name, email, linked_at AS linkedAt FROM github_links WHERE user_id = ?")
      .get(userId) as GithubLink | null;
    return row ?? null;
  }

  /** The account a GitHub id is connected to, if any: one GitHub account, one person here. */
  ownerOf(githubId: number): string | null {
    const row = this.db.query("SELECT user_id AS userId FROM github_links WHERE github_id = ?").get(githubId) as { userId: string } | null;
    return row?.userId ?? null;
  }

  /** Throws when the GitHub account is another person's here already (ownerOf). */
  set(userId: string, who: GithubIdentity): void {
    this.db
      .query(
        `INSERT INTO github_links (user_id, github_id, login, name, email, linked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET github_id = excluded.github_id, login = excluded.login,
           name = excluded.name, email = excluded.email, linked_at = excluded.linked_at`,
      )
      .run(userId, who.id, who.login, who.name, who.email, this.now());
  }

  /** Whether there was a link to remove. */
  delete(userId: string): boolean {
    return this.db.query("DELETE FROM github_links WHERE user_id = ?").run(userId).changes > 0;
  }
}

/** A token is handed out again while it has this long left; git's longest command must fit. */
export const TOKEN_FRESH_MS = 15 * 60_000;
/** A refusal stands this long before GitHub is asked again. */
export const REFUSAL_MS = 60_000;
/** How many times one person's worker may make the gateway ask GitHub, in ten minutes. */
export const ASKS_PER_WINDOW = 30;
export const ASK_WINDOW_MS = 10 * 60_000;
/**
 * And everyone's workers together, in the same ten minutes: the app's own
 * allowance at GitHub is one, shared by every person. It takes several
 * accounts asking flat out to reach it.
 */
export const ASKS_PER_WINDOW_ALL = 200;
/** How long a stop waits for GitHub to take the revocations before going on. */
const REVOKE_WAIT_MS = 5_000;

/** The part of the app the tokens come from (githubApp.ts). */
export interface TokenSource {
  repositoryToken(who: Pick<GithubIdentity, "id" | "login">, repo: string): Promise<RepoToken>;
  revoke(token: string): Promise<void>;
}

interface Held {
  tokens: Map<string, RepoToken>;
  refused: Map<string, { until: number; refusal: GithubRefusal }>;
  making: Map<string, Promise<RepoToken>>;
}

export class RepoTokens {
  private held = new Map<string, Held>();
  /** When GitHub was asked for each person, oldest first. Kept past a worker's stop. */
  private asked = new Map<string, number[]>();
  private askedAll: number[] = [];
  /** Revocations GitHub has not answered yet. */
  private revoking = new Set<Promise<void>>();

  constructor(
    private app: TokenSource,
    private links: Pick<GithubLinks, "get">,
    private now: () => number = Date.now,
  ) {}

  /** The person's GitHub account, when they have connected one. */
  identity(userId: string): GithubLink | null {
    return this.links.get(userId);
  }

  /** A token for `repo` for this person's worker; a GithubRefusal says why there is none. */
  async tokenFor(userId: string, repo: unknown): Promise<RepoToken> {
    const name = repoName(repo);
    if (!name) throw new GithubRefusal("no-access", "That is not a GitHub repository");
    const who = this.links.get(userId);
    if (!who) throw new GithubRefusal("not-connected", "GitHub is not connected: connect it on your account page");
    const key = name.toLowerCase();
    const held = this.of(userId);

    const kept = held.tokens.get(key);
    if (kept && kept.expiresAt - this.now() >= TOKEN_FRESH_MS) return kept;
    const refused = held.refused.get(key);
    if (refused && refused.until > this.now()) throw refused.refusal;
    const making = held.making.get(key);
    if (making) return making;

    this.count(userId);

    const made = this.app.repositoryToken({ id: who.id, login: who.login }, name).then(
      (token) => {
        // Forgotten in the meantime (a stop, a disconnect): this one is not to be used.
        if (this.held.get(userId) !== held) {
          this.revoke(token.token);
          throw new GithubRefusal("unavailable", "The workspace was stopped");
        }
        if (kept) this.revoke(kept.token);
        held.tokens.set(key, token);
        held.refused.delete(key);
        return token;
      },
      (e: unknown) => {
        const refusal = e instanceof GithubRefusal ? e : new GithubRefusal("unavailable", (e as Error).message);
        // GitHub being out of reach is not an answer about the repository.
        if (refusal.reason !== "unavailable") {
          held.refused.set(key, { until: this.now() + REFUSAL_MS, refusal });
          // The person may no longer reach it: the token from before ends now.
          if (kept && held.tokens.get(key) === kept) {
            held.tokens.delete(key);
            this.revoke(kept.token);
          }
        }
        throw refusal;
      },
    );
    held.making.set(key, made);
    void made.catch(() => {}).finally(() => held.making.delete(key));
    return made;
  }

  /**
   * Count one more question to GitHub for this person, or refuse it: one
   * person's worker gets so many in ten minutes, and so do all together.
   */
  private count(userId: string): void {
    const recent = (times: number[]) => times.filter((at) => this.now() - at < ASK_WINDOW_MS);
    const mine = recent(this.asked.get(userId) ?? []);
    this.askedAll = recent(this.askedAll);
    if (mine.length >= ASKS_PER_WINDOW || this.askedAll.length >= ASKS_PER_WINDOW_ALL) {
      this.asked.set(userId, mine);
      throw new GithubRefusal("too-many", "Too many repositories were asked for — wait a few minutes");
    }
    mine.push(this.now());
    this.asked.set(userId, mine);
    this.askedAll.push(this.now());
    // People who have not asked for a while are not kept count of.
    if (this.asked.size > 10_000) {
      for (const [id, times] of this.asked) if (recent(times).length === 0) this.asked.delete(id);
    }
  }

  private revoke(token: string): void {
    const done = this.app.revoke(token).catch(() => {});
    this.revoking.add(done);
    void done.finally(() => this.revoking.delete(done));
  }

  /**
   * End every token made for a person's worker: it stopped, or the person
   * disconnected GitHub. Their next worker starts with none — but with the
   * same count of questions asked.
   */
  forget(userId: string): void {
    const held = this.held.get(userId);
    if (!held) return;
    this.held.delete(userId);
    for (const token of held.tokens.values()) this.revoke(token.token);
  }

  /** Settles when GitHub has answered every revocation so far, or after a few seconds: for a shutdown. */
  async settled(): Promise<void> {
    await Promise.race([Promise.all([...this.revoking]), new Promise((done) => setTimeout(done, REVOKE_WAIT_MS))]);
  }

  private of(userId: string): Held {
    let held = this.held.get(userId);
    if (!held) {
      held = { tokens: new Map(), refused: new Map(), making: new Map() };
      this.held.set(userId, held);
    }
    return held;
  }
}

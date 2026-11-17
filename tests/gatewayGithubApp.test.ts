// The hosted service's GitHub App (src/gateway/githubApp.ts,
// src/gateway/githubLinks.ts; docs/hosted-tenant-isolation.md "Step 3"):
// what the gateway asks GitHub, in which order and as whom — against a
// stand-in GitHub that records every call — and what it keeps of the
// answers: who a person is, and never a token past its hour.

import { beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { exportSnapshot, importSnapshot } from "../src/gateway/datastore";
import { openDatabase } from "../src/gateway/db";
import {
  APP_CLIENT_ID_ENV,
  APP_CLIENT_SECRET_ENV,
  APP_PRIVATE_KEY_ENV,
  GithubApp,
  GithubRefusal,
  parsePrivateKey,
  readGithubAppConfig,
  repoName,
  type RepoToken,
} from "../src/gateway/githubApp";
import { statelessToken } from "./helpers/githubTokens";
import { ASK_WINDOW_MS, ASKS_PER_WINDOW, ASKS_PER_WINDOW_ALL, GithubLinks, REFUSAL_MS, RepoTokens, TOKEN_FRESH_MS } from "../src/gateway/githubLinks";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** The key as GitHub hands it out: a PKCS#1 PEM file. */
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

const NOW = Date.parse("2026-11-15T12:00:00Z");
const OCTO = { id: 42, login: "octo" };

interface Call {
  method: string;
  path: string;
  auth: string;
  body: Record<string, unknown> | null;
}

/** A stand-in GitHub: one installation, on acme/specs, and what each person may do there. */
function standIn(
  opts: {
    access?: Record<string, { id: number; permission: string }>;
    installed?: string[];
    /** Repositories that answer with a redirect: renamed or moved. */
    moved?: string[];
    /** What GitHub says a minted token is for; absent, it does not say. */
    mintedFor?: { id: number; full_name: string };
  } = {},
) {
  const calls: Call[] = [];
  const access = opts.access ?? { octo: { id: 42, permission: "write" } };
  const installed = opts.installed ?? ["acme/specs"];
  let minted = 0;
  const revoked: string[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      auth: headers.get("authorization") ?? "",
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const route = `${call.method} ${url.pathname}`;
    const json = (data: unknown, status = 200) => Response.json(data, { status });

    if (route === "POST /login/oauth/access_token") {
      return call.body?.code === "good-code" && call.body.client_secret === "shh"
        ? json({ access_token: "ghu_signin", refresh_token: "ghr_never_kept" })
        : json({ error: "bad_verification_code" });
    }
    if (route === "GET /user") return json({ id: 42, login: "octo", name: "Octo Cat", email: null });
    if (route === "DELETE /applications/Iv1.client/token") return new Response(null, { status: 204 });
    if (route === "GET /app") return json({ slug: "specdriven", html_url: "https://github.com/apps/specdriven" });

    const installation = url.pathname.match(/^\/repos\/(.+\/.+)\/installation$/);
    if (installation && opts.moved?.includes(installation[1]!)) {
      // fetch is told not to follow it: this is what it then sees.
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 301, headers: { Location: "https://api.github.test/repositories/1/installation" } });
    }
    if (installation) return installed.includes(installation[1]!) ? json({ id: 7 }) : json({ message: "Not Found" }, 404);
    if (route === "POST /app/installations/7/access_tokens") {
      const repositories = opts.mintedFor ? { repositories: [opts.mintedFor] } : {};
      return json({ token: statelessToken(++minted), expires_at: new Date(NOW + 60 * 60_000).toISOString(), ...repositories }, 201);
    }
    const permission = url.pathname.match(/^\/repos\/acme\/specs\/collaborators\/([^/]+)\/permission$/);
    if (permission) {
      const who = access[decodeURIComponent(permission[1]!)];
      return who ? json({ permission: who.permission, user: { id: who.id, login: permission[1] } }) : json({ message: "Not Found" }, 404);
    }
    if (route === "DELETE /installation/token") {
      revoked.push(call.auth.replace("Bearer ", ""));
      return new Response(null, { status: 204 });
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  const app = new GithubApp(
    { clientId: "Iv1.client", clientSecret: "shh", privateKey },
    { fetch: fetchStub, now: () => NOW, apiBase: "https://api.github.test", webBase: "https://github.test" },
  );
  return { app, calls, revoked };
}

describe("the app's settings", () => {
  test("none of the three variables means no app; some of them is a mistake that stops the start", () => {
    expect(readGithubAppConfig({})).toBeNull();
    expect(() => readGithubAppConfig({ [APP_CLIENT_ID_ENV]: "Iv1.client" })).toThrow(/missing: .*SECRET.*PRIVATE_KEY/);
    const config = readGithubAppConfig({ [APP_CLIENT_ID_ENV]: " Iv1.client ", [APP_CLIENT_SECRET_ENV]: "shh", [APP_PRIVATE_KEY_ENV]: PEM });
    expect(config?.clientId).toBe("Iv1.client");
  });

  test("the private key is read as the file, with its line ends escaped, or in base64", () => {
    for (const form of [PEM, PEM.trim().replace(/\n/g, "\\n"), Buffer.from(PEM).toString("base64")]) {
      expect(parsePrivateKey(form).asymmetricKeyType).toBe("rsa");
    }
    expect(() => parsePrivateKey("not a key")).toThrow(/not a private key/);
  });

  test("a repository's name is owner/name and nothing that names another path", () => {
    expect(repoName("acme/specs")).toBe("acme/specs");
    expect(repoName("/acme/specs.git/")).toBe("acme/specs");
    for (const bad of ["acme", "acme/specs/extra", "../specs", "acme/..", "acme/sp ecs", "acme/specs?x=1", 7, null]) {
      expect(repoName(bad)).toBeNull();
    }
  });
});

describe("what the app asks GitHub", () => {
  test("its own word is signed with the private key, for nine minutes, in the app's name", () => {
    const { app } = standIn();
    const [header, payload, signature] = app.jwt().split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as { iat: number; exp: number; iss: string };
    expect(claims.iss).toBe("Iv1.client");
    expect(claims.iat).toBe(NOW / 1000 - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    const signed = verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url"));
    expect(signed).toBe(true);
  });

  test("a sign-in says who the person is, and its token is revoked at once", async () => {
    const { app, calls } = standIn();
    const who = await app.identify("good-code", "https://account.example.com/auth/github/callback");
    expect(who).toEqual({ id: 42, login: "octo", name: "Octo Cat", email: "42+octo@users.noreply.github.com" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /login/oauth/access_token",
      "GET /user",
      "DELETE /applications/Iv1.client/token",
    ]);
    expect(calls[2]!.body).toEqual({ access_token: "ghu_signin" });
    expect(calls[2]!.auth).toBe(`Basic ${Buffer.from("Iv1.client:shh").toString("base64")}`);
    await expect(app.identify("stolen-code", "https://account.example.com/auth/github/callback")).rejects.toThrow(/bad_verification_code/);
  });

  test("where the app is installed comes from GitHub's own description of it", async () => {
    const { app, calls } = standIn();
    expect(await app.installUrl()).toBe("https://github.com/apps/specdriven/installations/new");
    await app.installUrl();
    expect(calls.length).toBe(1);
    expect(app.authorizeUrl("st.ate", "https://a.example/cb")).toBe(
      "https://github.test/login/oauth/authorize?client_id=Iv1.client&redirect_uri=https%3A%2F%2Fa.example%2Fcb&state=st.ate",
    );
  });

  test("a token is for one repository, to write it when the person may write it there", async () => {
    const { app, calls, revoked } = standIn();
    const token = await app.repositoryToken(OCTO, "acme/specs");
    expect(token).toEqual({ token: statelessToken(2), expiresAt: NOW + 60 * 60_000, write: true });
    const mints = calls.filter((c) => c.path === "/app/installations/7/access_tokens");
    // The first can only ask what the person may do; the second is the one handed out.
    expect(mints.map((c) => c.body)).toEqual([
      { repositories: ["specs"], permissions: { metadata: "read" } },
      { repositories: ["specs"], permissions: { contents: "write", metadata: "read" } },
    ]);
    const asked = calls.find((c) => c.path.includes("/collaborators/"))!;
    expect(asked.path).toBe("/repos/acme/specs/collaborators/octo/permission");
    expect(asked.auth).toBe(`Bearer ${statelessToken(1)}`);
    await Bun.sleep(0);
    expect(revoked).toEqual([statelessToken(1)]);
  });

  test("the token handed out is for the repository GitHub named, by its id, and never for another", async () => {
    const named = standIn({ mintedFor: { id: 99, full_name: "Acme/Specs" } });
    expect((await named.app.repositoryToken(OCTO, "acme/specs")).token).toBe(statelessToken(2));
    expect(named.calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { repositories: ["specs"], permissions: { metadata: "read" } },
      { repository_ids: [99], permissions: { contents: "write", metadata: "read" } },
    ]);

    // GitHub answering for some other repository: nothing is handed on, and what it made is ended.
    const other = standIn({ mintedFor: { id: 5, full_name: "acme/other" } });
    const refused = (await other.app.repositoryToken(OCTO, "acme/specs").catch((e) => e)) as GithubRefusal;
    expect(refused.reason).toBe("unavailable");
    await Bun.sleep(0);
    expect(other.revoked).toEqual([statelessToken(1)]);

    // A repository that was renamed or moved answers with a redirect, which is not followed.
    const moved = standIn({ moved: ["acme/specs"] });
    const gone = (await moved.app.repositoryToken(OCTO, "acme/specs").catch((e) => e)) as GithubRefusal;
    expect(gone.reason).toBe("not-installed");
    expect(moved.calls.length).toBe(1);
  });

  test("a refusal says the same whether the app is not installed or the person has no access", async () => {
    const { app } = standIn({ access: { octo: { id: 42, permission: "none" } } });
    const absent = (await app.repositoryToken(OCTO, "acme/secret-project").catch((e) => e)) as GithubRefusal;
    const closed = (await app.repositoryToken(OCTO, "acme/specs").catch((e) => e)) as GithubRefusal;
    // Told apart, the two would say which private repositories exist.
    expect(absent.message.replace("acme/secret-project", "R")).toBe(closed.message.replace("acme/specs", "R"));
    expect(absent.message).toContain("must be installed on it, and @octo must have access");
  });

  test("a person who can only read gets a token that can only read", async () => {
    const { app, calls } = standIn({ access: { octo: { id: 42, permission: "read" } } });
    expect((await app.repositoryToken(OCTO, "acme/specs")).write).toBe(false);
    expect(calls.filter((c) => c.method === "POST").at(-1)!.body).toEqual({
      repositories: ["specs"],
      permissions: { contents: "read", metadata: "read" },
    });
  });

  test("no token where the app is not installed, the person has no access, or the login is now someone else's", async () => {
    const refusal = async (made: Promise<RepoToken>) => ((await made.catch((e) => e)) as GithubRefusal).reason;
    const { app, calls } = standIn({ access: { octo: { id: 42, permission: "none" }, renamed: { id: 99, permission: "admin" } } });
    expect(await refusal(app.repositoryToken(OCTO, "acme/other"))).toBe("not-installed");
    expect(await refusal(app.repositoryToken(OCTO, "acme/specs"))).toBe("no-access");
    expect(await refusal(app.repositoryToken({ id: 42, login: "stranger" }, "acme/specs"))).toBe("no-access");
    // The login "renamed" has admin there, but it is not account 42's login any more.
    expect(await refusal(app.repositoryToken({ id: 42, login: "renamed" }, "acme/specs"))).toBe("no-access");
    expect(await refusal(app.repositoryToken(OCTO, "acme/../x"))).toBe("no-access");
    // Not one token that can touch contents was asked for.
    expect(calls.filter((c) => c.method === "POST" && JSON.stringify(c.body).includes("contents"))).toEqual([]);
  });
});

describe("what the gateway keeps", () => {
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let db: ReturnType<typeof openDatabase>;
  let links: GithubLinks;
  let now: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.query("INSERT INTO users (id, email, created_at) VALUES (?, 'a@example.com', 0)").run(USER);
    now = NOW;
    links = new GithubLinks(db, () => now);
  });

  /** Tokens from a counter instead of GitHub: what was asked, and what was revoked. */
  function source(answer?: (repo: string) => RepoToken | GithubRefusal) {
    const asked: string[] = [];
    const revoked: string[] = [];
    const tokens = new RepoTokens(
      {
        repositoryToken: async (_who, repo) => {
          asked.push(repo);
          const made = answer?.(repo) ?? { token: `t${asked.length}`, expiresAt: now + 60 * 60_000, write: true };
          if (made instanceof GithubRefusal) throw made;
          return made;
        },
        revoke: async (token) => void revoked.push(token),
      },
      links,
      () => now,
    );
    return { tokens, asked, revoked };
  }

  test("who a person is on GitHub is kept without a secret, goes to the datastore and comes back", () => {
    expect(links.get(USER)).toBeNull();
    links.set(USER, { id: 42, login: "octo", name: "Octo Cat", email: "octo@example.com" });
    links.set(USER, { id: 42, login: "octo-renamed", name: null, email: "octo@example.com" });
    expect(links.get(USER)).toEqual({ id: 42, login: "octo-renamed", name: null, email: "octo@example.com", linkedAt: NOW });

    const snapshot = exportSnapshot(db);
    expect(JSON.parse(snapshot["github-links.json"]!)).toEqual([
      { user_id: USER, github_id: 42, login: "octo-renamed", name: null, email: "octo@example.com", linked_at: NOW },
    ]);
    const fresh = openDatabase(":memory:");
    importSnapshot(fresh, snapshot);
    expect(new GithubLinks(fresh).get(USER)?.login).toBe("octo-renamed");
    // A snapshot from before the links has no such file, and still loads.
    const { "github-links.json": _, ...older } = snapshot;
    importSnapshot(openDatabase(":memory:"), older);

    expect(links.delete(USER)).toBe(true);
    expect(links.get(USER)).toBeNull();
  });

  test("no token for a person who has not connected GitHub", async () => {
    const { tokens, asked } = source();
    const refused = (await tokens.tokenFor(USER, "acme/specs").catch((e) => e)) as GithubRefusal;
    expect(refused.reason).toBe("not-connected");
    expect(asked).toEqual([]);
  });

  test("a token is handed out again until its hour is nearly over, then a new one is made and the old one ended", async () => {
    links.set(USER, { ...OCTO, name: null, email: "o@example.com" });
    const { tokens, asked, revoked } = source();
    const first = await tokens.tokenFor(USER, "acme/specs");
    expect((await tokens.tokenFor(USER, "Acme/Specs.git")).token).toBe(first.token);
    now += 60 * 60_000 - TOKEN_FRESH_MS;
    expect((await tokens.tokenFor(USER, "acme/specs")).token).toBe(first.token);
    now += 1;
    const second = await tokens.tokenFor(USER, "acme/specs");
    expect(second.token).not.toBe(first.token);
    expect(asked).toEqual(["acme/specs", "acme/specs"]);
    expect(revoked).toEqual([first.token]);
  });

  test("asking twice at once asks GitHub once", async () => {
    links.set(USER, { ...OCTO, name: null, email: "o@example.com" });
    const { tokens, asked } = source();
    const [a, b] = await Promise.all([tokens.tokenFor(USER, "acme/specs"), tokens.tokenFor(USER, "acme/specs")]);
    expect(a.token).toBe(b.token);
    expect(asked.length).toBe(1);
  });

  test("a refusal stands for a minute, and a worker cannot make the gateway ask GitHub without end", async () => {
    links.set(USER, { ...OCTO, name: null, email: "o@example.com" });
    const { tokens, asked } = source(() => new GithubRefusal("not-installed", "not there"));
    await expect(tokens.tokenFor(USER, "acme/a")).rejects.toThrow("not there");
    await expect(tokens.tokenFor(USER, "acme/a")).rejects.toThrow("not there");
    expect(asked.length).toBe(1);
    now += REFUSAL_MS;
    await expect(tokens.tokenFor(USER, "acme/a")).rejects.toThrow("not there");
    expect(asked.length).toBe(2);

    for (let i = 0; asked.length < ASKS_PER_WINDOW; i++) await tokens.tokenFor(USER, `acme/r${i}`).catch(() => {});
    const over = (await tokens.tokenFor(USER, "acme/one-more").catch((e) => e)) as GithubRefusal;
    expect(over.reason).toBe("too-many");
    expect(asked.length).toBe(ASKS_PER_WINDOW);
    expect(asked).not.toContain("acme/one-more");
    // Stopping the worker and starting another does not begin the count again.
    tokens.forget(USER);
    expect(((await tokens.tokenFor(USER, "acme/after-a-restart").catch((e) => e)) as GithubRefusal).reason).toBe("too-many");
    expect(asked.length).toBe(ASKS_PER_WINDOW);
    // Ten minutes on, it does.
    now += ASK_WINDOW_MS;
    await tokens.tokenFor(USER, "acme/one-more").catch(() => {});
    expect(asked).toContain("acme/one-more");
  });

  test("everyone's workers together can ask GitHub only so often", async () => {
    const { tokens, asked } = source();
    const people: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `${String(i).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
      db.query("INSERT INTO users (id, email, created_at) VALUES (?, ?, 0)").run(id, `p${i}@example.com`);
      links.set(id, { id: 100 + i, login: `p${i}`, name: null, email: "p@example.com" });
      people.push(id);
    }
    let refused = 0;
    for (const id of people) {
      for (let n = 0; n < ASKS_PER_WINDOW; n++) {
        const made = await tokens.tokenFor(id, `acme/r${n}`).catch((e) => e as GithubRefusal);
        if (made instanceof GithubRefusal) refused++;
      }
    }
    expect(asked.length).toBe(ASKS_PER_WINDOW_ALL);
    expect(refused).toBe(10 * ASKS_PER_WINDOW - ASKS_PER_WINDOW_ALL);
  });

  test("a token whose repository the person can no longer reach is ended when that is found out", async () => {
    links.set(USER, { ...OCTO, name: null, email: "o@example.com" });
    let open = true;
    const { tokens, revoked } = source((repo) =>
      open ? { token: "first", expiresAt: now + 60 * 60_000, write: true } : new GithubRefusal("no-access", `no way to ${repo}`),
    );
    expect((await tokens.tokenFor(USER, "acme/specs")).token).toBe("first");
    // Its hour is nearly over, and by now the person was taken off the repository.
    now += 60 * 60_000 - TOKEN_FRESH_MS + 1;
    open = false;
    await expect(tokens.tokenFor(USER, "acme/specs")).rejects.toThrow("no way");
    expect(revoked).toEqual(["first"]);
    // And a shutdown waits for GitHub to have taken the revocations.
    await tokens.settled();
  });

  test("when a worker stops, the tokens it was given end, and one still being made is never handed out", async () => {
    links.set(USER, { ...OCTO, name: null, email: "o@example.com" });
    const { tokens, revoked } = source();
    const a = await tokens.tokenFor(USER, "acme/a");
    const b = await tokens.tokenFor(USER, "acme/b");
    const late = tokens.tokenFor(USER, "acme/c");
    tokens.forget(USER);
    expect(revoked.sort()).toEqual([a.token, b.token].sort());
    const refused = (await late.catch((e) => e)) as GithubRefusal;
    expect(refused).toBeInstanceOf(GithubRefusal);
    expect(revoked.length).toBe(3);
    // The next worker starts from nothing.
    expect((await tokens.tokenFor(USER, "acme/a")).token).not.toBe(a.token);
  });
});

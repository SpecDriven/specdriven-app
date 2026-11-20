// A sync server of its own for each data repository (src/server/automerge/
// repoSyncServer.ts, specs/datastore/automerge-store.feature.md): how the app
// turns the Settings address into this repository's, and what it will and
// will not do with the user's GitHub token on the way.

import { test, expect } from "bun:test";
import {
  SyncAccessError,
  isPerRepoSyncUrl,
  renewDelayMs,
  resolveSyncAddress,
  retryDelayMs,
  withoutPass,
  type SyncAddressDeps,
} from "../src/server/automerge/repoSyncServer";
import { handle, type RouteDeps } from "../cloudflare/sync-server/src/routes";
import type { GitHubRepo } from "../src/server/repo";

const SPECS: GitHubRepo = { url: "https://github.com/Acme/Specs", host: "github.com", owner: "Acme", name: "Specs" };

interface Asked {
  url: string;
  method: string;
  authorization: string | null;
}

/** The app's side, against a sync server that answers the way `server` says. */
function deps(
  server: (asked: Asked) => Response | Promise<Response>,
  over: Partial<SyncAddressDeps> = {},
): { deps: SyncAddressDeps; asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    deps: {
      repoOf: async () => SPECS,
      tokenFor: async () => "tok-writer",
      fetch: async (url, init) => {
        const one = {
          url,
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("authorization"),
        };
        asked.push(one);
        return server(one);
      },
      ...over,
    },
  };
}

const about = (githubHost = "github.com") => Response.json({ githubHost, ticketSeconds: 3600 });

/** A server that checks github.com and hands out the pass "PASS". */
const willing = (asked: Asked) =>
  asked.url.endsWith("/.well-known/specdriven-sync") ? about() : Response.json({ ticket: "PASS", expiresAt: 5000 });

async function refusal(work: Promise<unknown>): Promise<SyncAccessError> {
  try {
    await work;
  } catch (e) {
    expect(e).toBeInstanceOf(SyncAccessError);
    return e as SyncAccessError;
  }
  throw new Error("expected a refusal");
}

test("a plain sync server address is dialled as it is, and no GitHub access goes anywhere", async () => {
  const { deps: d, asked } = deps(willing);
  expect(isPerRepoSyncUrl("wss://sync.automerge.org")).toBe(false);
  expect(await resolveSyncAddress("wss://sync.automerge.org", "/data", d)).toEqual({
    url: "wss://sync.automerge.org",
    expiresAt: null,
  });
  expect(asked).toEqual([]);
});

test("an address with {repo} becomes the data repository's own server, opened with a pass", async () => {
  const { deps: d, asked } = deps(willing);
  expect(isPerRepoSyncUrl("wss://sync.example.com/{repo}")).toBe(true);
  const address = await resolveSyncAddress("wss://sync.example.com/{repo}", "/data", d);
  expect(address).toEqual({ url: "wss://sync.example.com/Acme/Specs?ticket=PASS", expiresAt: 5_000_000 });
  // First which GitHub the server checks, with no token; only then the token.
  expect(asked).toEqual([
    { url: "https://sync.example.com/.well-known/specdriven-sync", method: "GET", authorization: null },
    { url: "https://sync.example.com/Acme/Specs/ticket", method: "POST", authorization: "Bearer tok-writer" },
  ]);
  // What goes in the log names the server, not the pass.
  expect(withoutPass(address.url)).toBe("wss://sync.example.com/Acme/Specs");
});

test("the GitHub token is not sent to a server that checks another GitHub", async () => {
  const { deps: d, asked } = deps(() => about("github.example-corp.test"));
  const e = await refusal(resolveSyncAddress("wss://sync.example.com/{repo}", "/data", d));
  expect(e.message).toContain("github.example-corp.test");
  expect(e.final).toBe(true);
  expect(asked.map((a) => a.authorization)).toEqual([null]);
});

test("the GitHub token is not sent over an unencrypted connection, except to this machine", async () => {
  const { deps: d, asked } = deps(willing);
  const e = await refusal(resolveSyncAddress("ws://sync.example.com/{repo}", "/data", d));
  expect(e.message).toContain("wss://");
  expect(asked).toEqual([]);
  // A server under development on this machine is the one exception.
  const local = await resolveSyncAddress("ws://127.0.0.1:8787/{repo}", "/data", d);
  expect(local.url).toBe("ws://127.0.0.1:8787/Acme/Specs?ticket=PASS");
  expect(asked[1]!.url).toBe("http://127.0.0.1:8787/Acme/Specs/ticket");
});

test("a data folder with no GitHub repository, or no sign-in, has no sync server to go to", async () => {
  const noRepo = deps(willing, { repoOf: async () => null });
  const e1 = await refusal(resolveSyncAddress("wss://sync.example.com/{repo}", "/data", noRepo.deps));
  expect(e1.message).toContain("no GitHub repository");
  expect(noRepo.asked).toEqual([]);

  const signedOut = deps(willing, { tokenFor: async () => null });
  const e2 = await refusal(resolveSyncAddress("wss://sync.example.com/{repo}", "/data", signedOut.deps));
  expect(e2.message).toContain("sign in to github.com");
  expect(e2.final).toBe(true);
  // Asked which GitHub it checks; never for a pass.
  expect(signedOut.asked.map((a) => a.method)).toEqual(["GET"]);
});

test("a no from the sync server is final and in its own words, an unreachable one is tried again", async () => {
  const refused = deps((asked) =>
    asked.method === "GET"
      ? about()
      : Response.json({ error: "Write access to the repository is required" }, { status: 403 }),
  );
  const no = await refusal(resolveSyncAddress("wss://sync.example.com/{repo}", "/data", refused.deps));
  expect(no.message).toBe("the sync server said: Write access to the repository is required");
  expect(no.final).toBe(true);

  const down = deps(() => Promise.reject(new Error("connect ECONNREFUSED")));
  const later = await refusal(resolveSyncAddress("wss://sync.example.com/{repo}", "/data", down.deps));
  expect(later.message).toContain("could not be reached");
  expect(later.final).toBe(false);

  const other = deps(() => new Response("<html>hello</html>"));
  const notOurs = await refusal(resolveSyncAddress("wss://sync.example.com/{repo}", "/data", other.deps));
  expect(notOurs.message).toContain("does not answer as a SpecDriven sync server");
});

test("a sync server that could not be reached is asked again in a minute, one that said no is not", async () => {
  const down = deps(() => Promise.reject(new Error("connect ECONNREFUSED")));
  const unreachable = await refusal(resolveSyncAddress("wss://sync.example.com/{repo}", "/data", down.deps));
  expect(retryDelayMs(unreachable)).toBe(60_000);
  // Anything unforeseen is worth another try too.
  expect(retryDelayMs(new Error("socket hang up"))).toBe(60_000);

  const refused = deps((asked) =>
    asked.method === "GET" ? about() : Response.json({ error: "Write access to the repository is required" }, { status: 403 }),
  );
  const no = await refusal(resolveSyncAddress("wss://sync.example.com/{repo}", "/data", refused.deps));
  // Only a change the user makes gets a different answer: not asked again by itself.
  expect(retryDelayMs(no)).toBeNull();
});

test("a pass is renewed well before it runs out, and never in a hurry", () => {
  // An hour's pass: renewed with twelve minutes to spare.
  expect(renewDelayMs(3_600_000, 0)).toBe(2_880_000);
  // A very short one: not sooner than ten seconds.
  expect(renewDelayMs(5_000, 0)).toBe(10_000);
  expect(renewDelayMs(1_000, 9_000)).toBe(10_000);
});

test("the pass the app is given opens the sync server's socket for that repository alone", async () => {
  // The app's side and the server's routes, joined: only GitHub is played.
  const connected: string[] = [];
  const server: RouteDeps = {
    secret: "server-secret",
    githubHost: "github.com",
    githubApi: "https://api.github.test",
    ticketSeconds: 3600,
    now: () => Date.now(),
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Headers(init?.headers).get("authorization") === "Bearer tok-writer"
        ? Response.json({ permissions: { push: true } })
        : Response.json({ permissions: { push: false, pull: true } })) as typeof fetch,
    connect: async (key) => {
      connected.push(key);
      return new Response("connected");
    },
  };
  const viaRoutes: SyncAddressDeps["fetch"] = (url, init) => handle(new Request(url, init), server);

  const writer = await resolveSyncAddress("wss://sync.example.com/{repo}", "/data", {
    repoOf: async () => SPECS,
    tokenFor: async () => "tok-writer",
    fetch: viaRoutes,
  });
  const open = (url: string) =>
    handle(new Request(url.replace(/^wss:/, "https:"), { headers: { upgrade: "websocket" } }), server);
  expect(await (await open(writer.url)).text()).toBe("connected");
  expect(connected).toEqual(["github.com/acme/specs"]);
  expect((await open(writer.url.replace("/Acme/Specs", "/Acme/Payroll"))).status).toBe(401);

  // Someone who can only read the repository gets no pass at all.
  const reader = await refusal(
    resolveSyncAddress("wss://sync.example.com/{repo}", "/data", {
      repoOf: async () => SPECS,
      tokenFor: async () => "tok-reader",
      fetch: viaRoutes,
    }),
  );
  expect(reader.message).toBe("the sync server said: Write access to the repository is required");
});

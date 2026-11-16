// specs/app/hosted-app.feature.md "A worker is confined to its own folder
// and one way out": the outbound proxy the gateway runs for its workers
// (src/gateway/egress.ts) lets a connection through to the hosts on its
// list — GitHub — and refuses every other.

import { afterAll, beforeAll, expect, test } from "bun:test";
import net from "node:net";
import { egressTargets, startEgressProxy, type EgressProxy } from "../src/gateway/egress";

let proxy: EgressProxy;
let refused: string[];
/** A stand-in GitHub over plain http, and a host that is not on the list. */
let github: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let seen: string[];

beforeAll(async () => {
  seen = [];
  refused = [];
  const answer = (name: string) => (req: Request) => {
    seen.push(`${name} ${req.method} ${new URL(req.url).pathname}${new URL(req.url).search} proxy-auth=${req.headers.get("proxy-authorization")}`);
    return new Response(`${name} says hello`);
  };
  github = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: answer("github") });
  other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: answer("other") });
  proxy = await startEgressProxy(egressTargets({ SPECDRIVEN_GITHUB_URL: `http://127.0.0.1:${github.port}` }), (line) => refused.push(line));
});

afterAll(async () => {
  await proxy.close();
  github.stop(true);
  other.stop(true);
});

/** Send one request's bytes to the proxy and read until it closes or `until` shows up. */
function speak(bytes: string, until?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, "127.0.0.1");
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk;
      if (until && answer.includes(until)) {
        socket.destroy();
        resolve(answer);
      }
    });
    socket.on("close", () => resolve(answer));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(bytes));
  });
}

test("workers may reach GitHub and its API, a stand-in the environment names, and what the operator adds", () => {
  expect([...egressTargets({})].sort()).toEqual(["api.github.com:443", "github.com:443"]);
  const more = egressTargets({
    SPECDRIVEN_GITHUB_URL: "http://127.0.0.1:4001",
    SPECDRIVEN_GITHUB_API_URL: "http://localhost:4002/api/v3",
    SPECDRIVEN_WORKER_EGRESS_HOSTS: " otel.example.com:4318, Uploads.GitHub.com ,, not a host ",
  });
  expect([...more].sort()).toEqual([
    "127.0.0.1:4001",
    "api.github.com:443",
    "github.com:443",
    "localhost:4002",
    "otel.example.com:4318",
    "uploads.github.com:443",
  ]);
});

test("a tunnel to a host on the list is opened, and bytes pass both ways", async () => {
  const answer = await speak(
    `CONNECT 127.0.0.1:${github.port} HTTP/1.1\r\nHost: 127.0.0.1:${github.port}\r\n\r\nGET /acme/specs.git/info/refs HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
  );
  expect(answer).toStartWith("HTTP/1.1 200 Connection Established\r\n\r\n");
  expect(answer).toContain("github says hello");
  expect(seen.at(-1)).toStartWith("github GET /acme/specs.git/info/refs");
});

test("a tunnel anywhere else is refused, and the refusal is logged", async () => {
  seen.length = 0;
  for (const where of [`127.0.0.1:${other.port}`, "evil.example:443", "github.com:22", "169.254.169.254:80", `localhost:${github.port}`]) {
    const answer = await speak(`CONNECT ${where} HTTP/1.1\r\nHost: ${where}\r\n\r\n`);
    expect([where, answer.split("\r\n")[0]]).toEqual([where, "HTTP/1.1 403 Forbidden"]);
  }
  expect(seen).toEqual([]);
  expect(refused.some((line) => line.includes("evil.example:443") && line.includes("refused"))).toBe(true);
  // A name a worker made up to spoil the log is cut down to plain characters.
  const before = refused.length;
  await speak(`CONNECT evil\u001b[31m.example:443 HTTP/1.1\r\n\r\n`);
  expect(refused.length).toBe(before + 1);
  expect(refused.at(-1)).not.toContain("\u001b");
});

test("a plain http request goes through to a host on the list, one request a connection, and nowhere else", async () => {
  seen.length = 0;
  const viaProxy = await fetch(`http://127.0.0.1:${github.port}/acme/specs?x=1`, { proxy: `http://127.0.0.1:${proxy.port}` });
  expect(viaProxy.status).toBe(200);
  expect(await viaProxy.text()).toBe("github says hello");
  expect(seen).toEqual(["github GET /acme/specs?x=1 proxy-auth=null"]);

  const elsewhere = await fetch(`http://127.0.0.1:${other.port}/secrets`, { proxy: `http://127.0.0.1:${proxy.port}` });
  expect(elsewhere.status).toBe(403);
  expect(await elsewhere.text()).toContain("GitHub only");
  expect(seen.length).toBe(1);

  // What is meant for the proxy stays with it, and each request is checked again.
  const answer = await speak(
    `GET http://127.0.0.1:${github.port}/one HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Basic c2VjcmV0\r\nProxy-Connection: keep-alive\r\n\r\n`,
  );
  expect(answer).toContain("github says hello");
  expect(seen.at(-1)).toBe("github GET /one proxy-auth=null");
});

test("what is not a proxy request is turned away", async () => {
  expect((await speak("GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")).split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");
  expect((await speak("hello there\r\n\r\n")).split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");
  expect((await speak("GET https://github.com/ HTTP/1.1\r\n\r\n")).split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");
  expect((await speak(`GET http://x/ HTTP/1.1\r\nX: ${"y".repeat(20_000)}`)).split("\r\n")[0]).toBe("HTTP/1.1 431 Request Header Fields Too Large");
});

// The gateway serves everybody, and every connection here costs it file
// descriptors: a worker that opens them and says nothing is cut off.
test("the proxy holds a limited number of connections at once, and closes one it refused", async () => {
  const held: net.Socket[] = [];
  const opened = (socket: net.Socket) =>
    new Promise<boolean>((resolve) => {
      socket.once("close", () => resolve(false));
      // Still open a moment after connecting: it was let in.
      socket.once("connect", () => setTimeout(() => resolve(!socket.destroyed), 150));
      socket.once("error", () => resolve(false));
    });
  try {
    const results: Promise<boolean>[] = [];
    for (let i = 0; i < 300; i++) {
      const socket = net.connect(proxy.port, "127.0.0.1");
      held.push(socket);
      results.push(opened(socket));
    }
    const letIn = (await Promise.all(results)).filter(Boolean).length;
    expect(letIn).toBeGreaterThan(200);
    expect(letIn).toBeLessThanOrEqual(256);
  } finally {
    for (const socket of held) socket.destroy();
  }
  await Bun.sleep(100);
  // Room again once they are gone, and a refusal ends its connection by itself.
  const refusal = await speak("CONNECT evil.example:443 HTTP/1.1\r\n\r\n");
  expect(refusal).toStartWith("HTTP/1.1 403 Forbidden");
});

// The app's own requests and git both go where HTTPS_PROXY points
// (src/gateway/workers.ts workerEnv): a real git against the stand-in.
test("git, told of the proxy through its environment, reaches the stand-in through it and nothing else", async () => {
  seen.length = 0;
  const git = (url: string) =>
    Bun.spawn(["git", "ls-remote", url], {
      env: {
        PATH: process.env.PATH,
        http_proxy: `http://127.0.0.1:${proxy.port}`,
        https_proxy: `http://127.0.0.1:${proxy.port}`,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: "/nonexistent",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
  const allowed = git(`http://127.0.0.1:${github.port}/acme/specs.git`);
  await allowed.exited;
  // The stand-in is no git server, but git's request arrived, through the proxy.
  expect(seen.some((line) => line.startsWith("github GET /acme/specs.git/info/refs"))).toBe(true);

  const count = seen.length;
  const elsewhere = git(`http://127.0.0.1:${other.port}/acme/specs.git`);
  expect(await elsewhere.exited).not.toBe(0);
  expect(await new Response(elsewhere.stderr).text()).toMatch(/403/);
  expect(seen.length).toBe(count);
}, 30_000);

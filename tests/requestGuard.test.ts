// The web server's trust boundary (src/server/requestGuard.ts,
// docs/ARCHITECTURE.md "Local trust boundary"): loopback-only binding, the
// DNS-rebinding Host check, the cross-origin check on writes and the JSON /
// multipart body rule — as a pure function, and over a real socket.

import { test, expect, describe, afterEach } from "bun:test";
import { networkInterfaces } from "node:os";
import { allowedHosts, listenHostname, rejectRequest } from "../src/server/requestGuard";

function req(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { host: "localhost:3000", ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

describe("listenHostname", () => {
  test("binds loopback by default", () => {
    expect(listenHostname({})).toBe("127.0.0.1");
  });

  test("SPECDRIVEN_HOST opens it up, plain HOST does not", () => {
    expect(listenHostname({ SPECDRIVEN_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(listenHostname({ HOST: "my-laptop.local" })).toBe("127.0.0.1");
    expect(listenHostname({ SPECDRIVEN_HOST: "  " })).toBe("127.0.0.1");
  });
});

describe("allowedHosts", () => {
  test("parses the comma-separated list, lowercased", () => {
    expect(allowedHosts({ SPECDRIVEN_ALLOWED_HOSTS: " Demo.Example.com , box:8080,," })).toEqual([
      "demo.example.com",
      "box:8080",
    ]);
    expect(allowedHosts({})).toEqual([]);
  });
});

describe("Host check (DNS rebinding)", () => {
  test("loopback names pass, with or without a port", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST", "app.localhost:3000"]) {
      expect(rejectRequest(req("GET", "/api/state", { host }))).toBeNull();
    }
  });

  test("a foreign host is refused, reads included", async () => {
    const res = rejectRequest(req("GET", "/api/state", { host: "evil.test" }));
    expect(res?.status).toBe(403);
    expect(((await res!.json()) as { error: string }).error).toContain("evil.test");
    expect(rejectRequest(req("GET", "/api/state", { host: "192.168.4.44:3000" }))?.status).toBe(403);
    expect(rejectRequest(req("GET", "/api/state", { host: "localhost.evil.test" }))?.status).toBe(403);
  });

  test("SPECDRIVEN_ALLOWED_HOSTS admits named hosts, '*' admits any", () => {
    const demo = req("GET", "/api/state", { host: "demo.example.com" });
    expect(rejectRequest(demo, ["demo.example.com"])).toBeNull();
    expect(rejectRequest(req("GET", "/", { host: "box:8080" }), ["box:8080"])).toBeNull();
    expect(rejectRequest(req("GET", "/", { host: "box:9090" }), ["box:8080"])?.status).toBe(403);
    expect(rejectRequest(req("GET", "/", { host: "anything.test" }), ["*"])).toBeNull();
  });
});

describe("cross-origin writes (CSRF)", () => {
  const json = { "content-type": "application/json" };

  test("a write from another website is refused, even as text/plain", () => {
    const attack = req(
      "POST",
      "/api/agent/chat",
      { origin: "https://example.com", "content-type": "text/plain" },
      '{"prompt":"rm -rf ~","permissionMode":"bypassPermissions"}',
    );
    expect(rejectRequest(attack)?.status).toBe(403);
    expect(rejectRequest(req("PUT", "/api/state", { origin: "http://evil.test", ...json }, "{}"))?.status).toBe(403);
    expect(rejectRequest(req("DELETE", "/api/folders/x", { origin: "null" }))?.status).toBe(403);
  });

  test("a write from a page on another loopback port is refused", () => {
    expect(rejectRequest(req("POST", "/api/folders", { origin: "http://localhost:5173", ...json }, "{}"))?.status).toBe(403);
  });

  test("a write from the app's own origin passes", () => {
    expect(rejectRequest(req("POST", "/api/folders", { origin: "http://localhost:3000", ...json }, "{}"))).toBeNull();
    // Behind a TLS-terminating proxy the page is https, the request http.
    const proxied = req("POST", "/api/folders", { host: "demo.example.com", origin: "https://demo.example.com", ...json }, "{}");
    expect(rejectRequest(proxied, ["demo.example.com"])).toBeNull();
  });

  test("without Origin, Sec-Fetch-Site decides; neither header is a non-browser client", () => {
    expect(rejectRequest(req("POST", "/api/folders", { "sec-fetch-site": "cross-site", ...json }, "{}"))?.status).toBe(403);
    expect(rejectRequest(req("POST", "/api/folders", { "sec-fetch-site": "same-origin", ...json }, "{}"))).toBeNull();
    expect(rejectRequest(req("POST", "/api/folders", json, "{}"))).toBeNull();
  });

  test("reads are not origin-checked", () => {
    expect(rejectRequest(req("GET", "/api/features", { origin: "https://example.com" }))).toBeNull();
  });
});

describe("body types", () => {
  test("a write body must be JSON or multipart", () => {
    expect(rejectRequest(req("POST", "/api/folders", { "content-type": "text/plain" }, "{}"))?.status).toBe(415);
    expect(
      rejectRequest(req("POST", "/api/folders", { "content-type": "application/x-www-form-urlencoded" }, "a=b"))?.status,
    ).toBe(415);
    expect(rejectRequest(req("POST", "/api/folders", {}, "{}"))?.status).toBe(415);
    expect(rejectRequest(req("POST", "/api/folders", { "content-type": "application/json; charset=utf-8" }, "{}"))).toBeNull();
  });

  test("a file upload passes", () => {
    const form = new FormData();
    form.set("file", new File(["png"], "a.png", { type: "image/png" }));
    const upload = new Request("http://localhost:3000/api/images", {
      method: "POST",
      headers: { host: "localhost:3000" },
      body: form,
    });
    expect(rejectRequest(upload)).toBeNull();
  });

  test("a write without a body passes", () => {
    expect(rejectRequest(req("POST", "/api/reload"))).toBeNull();
    expect(rejectRequest(req("POST", "/api/reload", { "content-length": "0" }))).toBeNull();
  });
});

describe("over a real socket", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  function serve(): ReturnType<typeof Bun.serve> {
    server = Bun.serve({
      port: 0,
      hostname: listenHostname({}),
      fetch: (r) => rejectRequest(r) ?? Response.json({ ok: true }),
    });
    return server;
  }

  /** Whether a GET reaches the url in time (a firewall may drop, not refuse). */
  const reaches = (url: string, timeoutMs = 1000) =>
    fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).then(
      () => true,
      () => false,
    );

  test("the default binding refuses the machine's network address", async () => {
    const s = serve();
    expect(await reaches(`http://127.0.0.1:${s.port}/api/state`)).toBe(true);
    expect(await reaches(`http://localhost:${s.port}/api/state`)).toBe(true);
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return; // no network interface to probe on this machine
    // Control: a server bound to every interface answers there, so a miss
    // below is the binding, not the network.
    const open = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response("ok") });
    try {
      if (!(await reaches(`http://${lan.address}:${open.port}/`))) return;
    } finally {
      open.stop(true);
    }
    // Where a firewall drops rather than refuses, a miss is only ever a
    // timeout, so it is kept short: the control above shows a server bound to
    // this address answers in milliseconds.
    expect(await reaches(`http://${lan.address}:${s.port}/api/state`, 200)).toBe(false);
  });

  test("curl-style probes from the security report are refused", async () => {
    const s = serve();
    const base = `http://127.0.0.1:${s.port}`;
    const forged = await fetch(`${base}/api/state`, { headers: { host: "evil.test" } });
    expect(forged.status).toBe(403);
    const csrf = await fetch(`${base}/api/folders`, {
      method: "POST",
      headers: { origin: "https://example.com", "content-type": "text/plain" },
      body: "{}",
    });
    expect(csrf.status).toBe(403);
    const same = await fetch(`${base}/api/folders`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: "{}",
    });
    expect(same.status).toBe(200);
  });
});

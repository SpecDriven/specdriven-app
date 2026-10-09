// The hosted image's entry point in DEMO_MODE (src/gateway/demo.ts): railway.json
// builds every service with Dockerfile.hosted, so a demo service starts the
// gateway's entry point — which must run the public demo, not ask for a login,
// and must not demand the hosted-mode variables.

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoCommand, demoEnv } from "../src/gateway/demo";

test("the demo gets Dockerfile's settings unless they are set already", () => {
  const env = demoEnv({ DEMO_MODE: "1", SPECDRIVEN_ROOT: "/x" });
  expect(env.SPECDRIVEN_ROOT).toBe("/x");
  expect(env.SPECDRIVEN_HOST).toBe("0.0.0.0");
  expect(env.SPECDRIVEN_ALLOWED_HOSTS).toBe("*");
  expect(env.SPECDRIVEN_LOG_FILE).toBe("0");
});

test("as root the demo drops to the bun user when the image has one", () => {
  expect(demoCommand(false, "/usr/bin/setpriv", true)[0]).toBe(process.execPath);
  const asRoot = demoCommand(true, "/usr/bin/setpriv", true);
  expect(asRoot.slice(0, 2)).toEqual(["/usr/bin/setpriv", "--reuid=bun"]);
  expect(asRoot.at(-1)).toEndWith(join("src", "index.ts"));
  expect(demoCommand(true, null, true)[0]).toBe(process.execPath);
  expect(demoCommand(true, "/usr/bin/setpriv", false)[0]).toBe(process.execPath);
});

const root = await mkdtemp(join(tmpdir(), "gateway-demo-"));
let proc: ReturnType<typeof Bun.spawn> | undefined;
afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  await rm(root, { recursive: true, force: true });
});

test("DEMO_MODE on the gateway's entry point serves the demo, with no hosted variables", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ["PUBLIC_URL", "RESEND_API_KEY", "MAIL_FROM", "SPECDRIVEN_MASTER_KEY"]) delete env[k];
  proc = Bun.spawn([process.execPath, "src/gateway/index.ts"], {
    env: { ...env, DEMO_MODE: "1", PORT: String(port), SPECDRIVEN_ROOT: root, SPECDRIVEN_HOST: "127.0.0.1" },
    stdout: "ignore",
    stderr: "pipe",
  });
  let res: Response | undefined;
  for (let i = 0; i < 100 && !res; i++) {
    res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" }).catch(() => undefined);
    if (!res) await Bun.sleep(100);
  }
  expect(res?.status).toBe(200);
  expect(res!.headers.get("location")).toBeNull();
  expect(await res!.text()).not.toContain("Sign in");
  // railway.json's health check, under the platform's own Host name.
  const health = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { Host: "healthcheck.railway.app" } });
  expect(health.status).toBe(200);
}, 20_000);

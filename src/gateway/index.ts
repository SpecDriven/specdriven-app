// The hosted gateway (docs/deployment-railway.md): `bun src/gateway/index.ts`
// on Railway, or `bun run dev:hosted` locally. It signs users in, keeps their
// secrets, and runs one app server per user behind itself.
//
//   bun src/gateway/index.ts genkey   prints a fresh SPECDRIVEN_MASTER_KEY

import { join } from "node:path";
import { consoleMailer, resendMailer } from "./mail";
import { buildAssets } from "./assets";
import { loadAppShell } from "./appShell";
import { readConfig } from "./config";
import { generateMasterKey, loadKeyring } from "./crypto";
import { openDatabase } from "./db";
import { RateLimiter } from "./rateLimit";
import { SecretStore } from "./secrets";
import { createGateway } from "./server";
import { workerIsolation, WorkerPool } from "./workers";

if (process.argv[2] === "genkey") {
  console.log(generateMasterKey());
  process.exit(0);
}

const config = readConfig();
// Everything the gateway writes — the database first — is its own alone.
process.umask(0o077);
const db = openDatabase(join(config.dataDir, "app.db"));
const keyring = await loadKeyring(process.env, config.production);
const secrets = new SecretStore(db, keyring);
const resealed = await secrets.reseal();
if (resealed) console.log(`re-sealed ${resealed} secrets under the current master key`);

const mailer = config.resendApiKey ? resendMailer(config.resendApiKey, config.mailFrom) : consoleMailer();
if (!config.resendApiKey) console.warn("RESEND_API_KEY is not set — emails are printed here instead of sent");

const isolate = workerIsolation();
if (!isolate) {
  const say = config.production ? console.error : console.warn;
  say("Workers run as the gateway's own user: run as root with setpriv installed to give each user a uid of their own");
}

const workers = new WorkerPool({
  dataDir: config.dataDir,
  entry: config.workerEntry,
  idleMs: config.workerIdleMinutes * 60_000,
  secrets: (userId) => secrets.values(userId),
  // Called only once requests flow, after `gateway` below exists.
  emailOf: (userId) => gateway.accounts.emailOf(userId),
  osUid: isolate ? (userId) => gateway.accounts.osUid(userId) : undefined,
});
workers.startSweeper();

const gateway = createGateway({
  db,
  secrets,
  mailer,
  workers,
  assets: await buildAssets(config.production),
  appShell: await loadAppShell({ production: config.production, distDir: process.env.SPECDRIVEN_APP_DIST }),
  production: config.production,
  publicUrl: config.publicUrl,
  signupAllowlist: config.signupAllowlist,
});

// Expired sessions and old rate-limit windows, hourly.
const limiter = new RateLimiter(db);
setInterval(() => {
  gateway.sessions.sweep();
  limiter.sweep();
}, 60 * 60_000).unref();

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  // Long syncs and server-sent events pass through; 255s is Bun's maximum.
  idleTimeout: 255,
  fetch: (req, srv) => gateway.fetch(req, srv),
});

console.log(`SpecDriven gateway on ${config.publicUrl ?? server.url} (data in ${config.dataDir})`);

// A redeploy sends SIGTERM: stop the workers (each pushes nothing half-way —
// saved work is on the volume and syncs on the next start), then exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await server.stop(true);
    await workers.stopAll();
    db.close();
    process.exit(0);
  });
}

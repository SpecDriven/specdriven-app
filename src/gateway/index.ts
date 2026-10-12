// The hosted gateway (docs/deployment-railway.md): `bun src/gateway/index.ts`
// on Railway, or `bun run dev:hosted` locally. It signs users in, keeps their
// secrets, and runs one app server per user behind itself.
//
//   bun src/gateway/index.ts genkey   prints a fresh SPECDRIVEN_MASTER_KEY

import { join } from "node:path";
import { consoleMailer, resendMailer } from "./mail";
import { ensureOriginalAdmin, ORIGINAL_ADMIN } from "./admin";
import { buildAssets } from "./assets";
import { loadAppShell } from "./appShell";
import { readConfig } from "./config";
import { generateMasterKey, loadKeyring } from "./crypto";
import { Datastore, datastoreGit, readDatastoreConfig } from "./datastore";
import { openDatabase } from "./db";
import { RateLimiter } from "./rateLimit";
import { SecretStore } from "./secrets";
import { runDemo } from "./demo";
import { runProposals } from "./proposals";
import { createGateway } from "./server";
import { workerIsolation, WorkerPool } from "./workers";
import { isDemoMode } from "../server/demoMode";
import { isProposalsMode } from "../server/proposalsMode";

if (process.argv[2] === "genkey") {
  console.log(generateMasterKey());
  process.exit(0);
}

// A DEMO_MODE service built from this image is the public demo, not the gateway.
if (isDemoMode()) await runDemo();
// A SPECDRIVEN_PROPOSALS service is the public spec-proposals service (proposals.ts).
if (isProposalsMode()) await runProposals();

const config = readConfig();
// Everything the gateway writes — the database first — is its own alone.
process.umask(0o077);
const db = openDatabase(join(config.dataDir, "app.db"));
// The accounts' copy in GitHub (datastore.ts): read before anything else, so
// a redeploy without the volume starts with everyone's accounts. A repo that
// cannot be read stops the start instead of letting an empty list be pushed.
const datastoreConfig = readDatastoreConfig();
let datastore: Datastore | null = null;
if (datastoreConfig) {
  datastore = new Datastore({
    db,
    dataDir: config.dataDir,
    repo: datastoreConfig.repo,
    git: datastoreGit(datastoreConfig.token),
  });
  const { imported } = await datastore.restore().catch((e: Error) => {
    throw new Error(`The datastore ${datastoreConfig.repo} could not be read: ${e.message}`);
  });
  if (imported) console.log(`restored ${imported} accounts from ${datastoreConfig.repo}`);
  datastore.start();
} else {
  const say = config.production ? console.error : console.warn;
  say("SPECDRIVEN_DATASTORE_TOKEN is not set — accounts live only in app.db on this volume");
}
// The first admin (admin.ts), only once the repo's accounts are in, so a
// fresh volume takes its admins from there rather than making a new one.
if (ensureOriginalAdmin(db)) console.log(`${ORIGINAL_ADMIN} is now the admin`);
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
// saved work is on the volume and syncs on the next start), push the
// accounts' last changes, then exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await server.stop(true);
    await workers.stopAll();
    if (datastore) {
      datastore.stop();
      await datastore.save({ force: true }).catch((e: Error) => console.error(`datastore save failed: ${e.message}`));
    }
    db.close();
    process.exit(0);
  });
}

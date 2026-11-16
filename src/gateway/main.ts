// The hosted gateway itself (docs/deployment-railway.md): it signs users in,
// keeps their secrets, and puts each user's own app server behind itself.
//
// In the hosted image it is started by the spawner (spawnerMain.ts) as a
// uid that is not root, and asks the spawner over a socket for everything
// that takes root: a worker started as its person's uid, stopped, reported
// on (docs/hosted-tenant-isolation.md "Step 2"). Elsewhere — development,
// `bun run dev:hosted` — it is the only process and its workers share its
// user.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { consoleMailer, resendMailer } from "./mail";
import { ensureOriginalAdmin, ORIGINAL_ADMIN } from "./admin";
import { readAppCspMode } from "./appCsp";
import { buildAssets } from "./assets";
import { loadAppShell } from "./appShell";
import type { GatewayConfig } from "./config";
import { loadKeyring } from "./crypto";
import { Datastore, datastoreGit, readDatastoreConfig } from "./datastore";
import { openDatabase } from "./db";
import { egressTargets, startEgressProxy, type EgressProxy } from "./egress";
import { GithubApp, readGithubAppConfig } from "./githubApp";
import { GithubLinks, RepoTokens } from "./githubLinks";
import { readWorkerLimits } from "./limits";
import { RateLimiter } from "./rateLimit";
import { RecentRepos } from "./repos";
import { SecretStore } from "./secrets";
import { createGateway } from "./server";
import { workerSandbox } from "./spawnerMain";
import { connectSpawner, SPAWNER_KEY_ENV, SPAWNER_SOCKET_ENV } from "./spawnerSocket";
import { prepareVolume } from "./volume";
import { WorkerPool } from "./workers";

export async function runGateway(config: GatewayConfig): Promise<void> {
  // Everything the gateway writes — the database first — is its own alone.
  process.umask(0o077);

  // The spawner, where one started this process. Its socket and key are
  // this process's alone: nothing it starts inherits them.
  const spawnerSocket = process.env[SPAWNER_SOCKET_ENV];
  const spawnerKey = process.env[SPAWNER_KEY_ENV];
  delete process.env[SPAWNER_SOCKET_ENV];
  delete process.env[SPAWNER_KEY_ENV];
  const spawner = spawnerSocket && spawnerKey ? await connectSpawner(spawnerSocket, spawnerKey) : null;
  if (spawner) {
    void spawner.closed.then(() => {
      console.error("The spawner is gone: the gateway can start no worker, and stops");
      process.exit(1);
    });
    if (process.env.HOME) await mkdir(process.env.HOME, { recursive: true });
  } else {
    await prepareVolume(config.dataDir, null);
    const say = config.production ? console.error : console.warn;
    say("Workers run as the gateway's own user: run as root with setpriv installed to give each user a uid of their own");
  }

  const db = openDatabase(join(config.stateDir, "app.db"));
  // The accounts' copy in GitHub (datastore.ts): read before anything else, so
  // a redeploy without the volume starts with everyone's accounts. A repo that
  // cannot be read stops the start instead of letting an empty list be pushed.
  const datastoreConfig = readDatastoreConfig();
  let datastore: Datastore | null = null;
  if (datastoreConfig) {
    datastore = new Datastore({
      db,
      dataDir: config.stateDir,
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

  if (config.production && !config.accountUrl) {
    console.error("ACCOUNT_URL is not set — the account and admin pages share the app's host (docs/deployment-railway.md)");
  }

  // The workers' one way out (egress.ts), where they are confined to it.
  let egress: EgressProxy | null = null;
  if (spawner && workerSandbox()) {
    const allowed = egressTargets();
    egress = await startEgressProxy(allowed);
    console.log(`workers reach ${[...allowed].join(", ")} through 127.0.0.1:${egress.port}, and nothing else`);
  }

  // GitHub through the service's own app (githubApp.ts): a person connects
  // their account, and their worker is handed an hour's token for one
  // repository when its git asks. Without it, people paste a token that
  // lasts months and sits in the worker's environment.
  const githubConfig = readGithubAppConfig();
  const githubApp = githubConfig ? new GithubApp(githubConfig) : null;
  const githubLinks = new GithubLinks(db);
  const repoTokens = githubApp ? new RepoTokens(githubApp, githubLinks) : null;
  if (!githubApp) {
    const say = config.production ? console.error : console.warn;
    say("SPECDRIVEN_GITHUB_APP_* is not set — people paste a personal access token, kept sealed and handed to their worker");
  }

  const workers = new WorkerPool({
    dataDir: config.dataDir,
    entry: config.workerEntry,
    idleMs: config.workerIdleMinutes * 60_000,
    // What one worker may use of the container the others share (limits.ts).
    limits: readWorkerLimits(),
    secrets: (userId) => secrets.values(userId),
    // Called only once requests flow, after `gateway` below exists.
    emailOf: (userId) => gateway.accounts.emailOf(userId),
    // A uid of its own for each person's worker, where a spawner can give one.
    osUid: spawner ? (userId) => gateway.accounts.osUid(userId) : undefined,
    spawner: spawner ?? undefined,
    egressPort: egress?.port ?? null,
    github: repoTokens ?? undefined,
    // Kept in app.db, and so in the datastore: the next sign-in after a
    // redeploy opens the repo the user had open (repos.ts).
    repos: new RecentRepos(db),
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
    accountUrl: config.accountUrl,
    appCsp: readAppCspMode(),
    github: githubApp ? { app: githubApp, links: githubLinks } : null,
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

  const where = config.accountUrl ? `${config.publicUrl}, accounts on ${config.accountUrl}` : (config.publicUrl ?? server.url);
  console.log(`SpecDriven gateway on ${where} (data in ${config.dataDir})`);

  // A redeploy sends SIGTERM: stop the workers (each pushes nothing half-way —
  // saved work is on the volume and syncs on the next start), push the
  // accounts' last changes, then exit.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      await server.stop(true);
      await workers.stopAll().catch((e: Error) => console.error(`stopping the workers failed: ${e.message}`));
      // The tokens the workers were given are ended at GitHub before the gateway goes.
      await repoTokens?.settled();
      await egress?.close();
      if (datastore) {
        datastore.stop();
        await datastore.save({ force: true }).catch((e: Error) => console.error(`datastore save failed: ${e.message}`));
      }
      db.close();
      process.exit(0);
    });
  }
}

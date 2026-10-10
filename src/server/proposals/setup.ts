// Starting the proposals service (SPECDRIVEN_PROPOSALS=1, src/index.ts): read
// its settings, prove the bot token works, clone the spec repo with it, and
// wire the service behind the HTTP surface. Everything it writes — the
// clone, the database, the app's own settings and logs — lives under
// SPECDRIVEN_ROOT (default /data/proposals, the Railway volume).
//
// The bot is the process-wide sign-in here (a fixed token backend), so the
// clone and every refresh run as the bot; a proposal swaps in the visitor's
// identity for its own write (actingAs.ts). The app's startup sync and
// reload cron never run in this mode — only the service's lock commits.

import { join } from "node:path";
import { fetchIdentity } from "../auth";
import { setFolderChooser } from "../folderChooser";
import { setGitEngine } from "../git";
import { appContext, subprocessRun } from "../git/cli";
import { getAppRoot } from "../paths";
import { readProposalsConfig, type ProposalsConfig } from "../proposalsMode";
import { resolveDataRepo } from "../repo";
import { getLogger } from "../telemetry";
import { setTokenBackend, type TokenBackend, type TokenRecord } from "../tokenStore";
import { openProposalsDatabase } from "./db";
import { createProposalsApi, type ProposalsApi } from "./server";
import { ProposalService } from "./service";

const log = getLogger("proposals");

/** How often the clone is brought up to date between proposals. */
export const RESYNC_MS = 60_000;

/** The bot as the app's only sign-in: loaded, never saved over or cleared. */
function botBackend(bot: TokenRecord): TokenBackend {
  const refuse = async () => {
    throw new Error("The proposals service signs in as its bot only");
  };
  return { load: async () => bot, save: refuse, clear: refuse };
}

export interface StartedProposals {
  api: ProposalsApi;
  config: ProposalsConfig;
  service: ProposalService;
  stop(): void;
}

export async function startProposals(env: Record<string, string | undefined> = process.env): Promise<StartedProposals> {
  const config = readProposalsConfig(env);
  process.env.SPECDRIVEN_ROOT ||= "/data/proposals";
  process.env.SPECDRIVEN_HOME ||= join(getAppRoot(), "home");
  process.env.SPECDRIVEN_REPOS_DIR ||= join(getAppRoot(), "repos");
  setFolderChooser(null);
  // The system git binary, credentialed per command from getAuth.
  setGitEngine("cli");

  const bot = await fetchIdentity(config.botToken).catch((e: Error) => {
    throw new Error(`SPECDRIVEN_PROPOSALS_BOT_TOKEN does not work: ${e.message}`);
  });
  setTokenBackend(botBackend(bot));

  const db = openProposalsDatabase(config.dbPath);
  const dataDir = () => resolveDataRepo(config.repo.url, getAppRoot());
  // The service and the API each need the other: the service asks the API's
  // cached contributor check, the API hands proposals to the service.
  let api: ProposalsApi | null = null;
  const service = new ProposalService({
    db,
    dataDir,
    git: subprocessRun(appContext),
    bot,
    perDay: config.perDay,
    globalPerDay: config.globalPerDay,
    isContributor: (user) => api!.isContributor(user),
  });
  api = createProposalsApi({ db, config, service, dataDir });

  // Clone (first start) and reset to the remote before the first request.
  await dataDir();
  await service.resync();
  const resync = setInterval(() => {
    service.resync().catch((e: Error) => log.warn(`resync failed: ${e.message}`));
  }, RESYNC_MS);
  resync.unref?.();
  const sweep = setInterval(() => {
    api!.sessions.sweep();
    api!.limiter.sweep();
  }, 60 * 60_000);
  sweep.unref?.();
  log.info(`proposals service for ${config.repo.url} as @${bot.login}`);
  console.log(`Spec proposals for ${config.repo.url}, pushed as @${bot.login}`);

  return {
    api,
    config,
    service,
    stop() {
      clearInterval(resync);
      clearInterval(sweep);
      db.close();
    },
  };
}

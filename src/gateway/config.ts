// The hosted gateway's configuration (docs/deployment-railway.md), read once
// from the environment at start. Production refuses to start without the
// pieces security rests on — the master key, the public url its email links
// and cookies are bound to, and a real mail service — rather than quietly
// running with a weaker stand-in.

import { join, resolve } from "node:path";
import { stateDirOf } from "./volume";

type Env = Record<string, string | undefined>;

export interface GatewayConfig {
  production: boolean;
  port: number;
  /** The volume: the gateway's folder and every user's folders. */
  dataDir: string;
  /** The gateway's own folder on the volume (volume.ts): the database and the datastore's clone. */
  stateDir: string;
  /** e.g. https://specs.example.com — where the app is served; the Host check uses it. */
  publicUrl: string | null;
  /**
   * e.g. https://account.specs.example.com — a host of its own for sign-in,
   * the account page, the admin page and /auth/* (server.ts). Unset, they
   * share the app's host.
   */
  accountUrl: string | null;
  /** Resend API key; unset outside production means the console mailer. */
  resendApiKey: string | null;
  mailFrom: string;
  /** Minutes a worker may sit unused before it is stopped. */
  workerIdleMinutes: number;
  /** The worker entry point: the app's own server (src/index.ts). */
  workerEntry: string;
}

export function readConfig(env: Env = process.env): GatewayConfig {
  const production = env.NODE_ENV === "production";
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, "") || null;
  const accountUrl = env.ACCOUNT_URL?.trim().replace(/\/+$/, "") || null;
  const dataDir = resolve(env.SPECDRIVEN_DATA_DIR?.trim() || "/data");
  const config: GatewayConfig = {
    production,
    port: Number(env.PORT) || 3000,
    dataDir,
    stateDir: stateDirOf(dataDir),
    publicUrl,
    accountUrl,
    resendApiKey: env.RESEND_API_KEY?.trim() || null,
    mailFrom: env.MAIL_FROM?.trim() || "SpecDriven <no-reply@localhost>",
    workerIdleMinutes: Number(env.SPECDRIVEN_WORKER_IDLE_MINUTES) || 30,
    workerEntry: join(import.meta.dir, "..", "index.ts"),
  };
  if (production) {
    const missing: string[] = [];
    if (!publicUrl) missing.push("PUBLIC_URL");
    if (!config.resendApiKey) missing.push("RESEND_API_KEY");
    if (!env.MAIL_FROM?.trim()) missing.push("MAIL_FROM");
    if (!env.SPECDRIVEN_MASTER_KEY?.trim()) missing.push("SPECDRIVEN_MASTER_KEY");
    if (missing.length) throw new Error(`Missing required variables: ${missing.join(", ")}`);
    if (!publicUrl!.startsWith("https://")) throw new Error("PUBLIC_URL must be an https:// url");
    if (accountUrl && !accountUrl.startsWith("https://")) throw new Error("ACCOUNT_URL must be an https:// url");
  }
  if (accountUrl) {
    // Two hosts, or the account pages are not apart from the app at all.
    if (!publicUrl) throw new Error("ACCOUNT_URL needs PUBLIC_URL: the app and the account pages each get a host");
    if (new URL(accountUrl).host === new URL(publicUrl).host) {
      throw new Error("ACCOUNT_URL must name another host than PUBLIC_URL");
    }
  }
  return config;
}

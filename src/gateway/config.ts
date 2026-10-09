// The hosted gateway's configuration (docs/deployment-railway.md), read once
// from the environment at start. Production refuses to start without the
// pieces security rests on — the master key, the public url its email links
// and cookies are bound to, and a real mail service — rather than quietly
// running with a weaker stand-in.

import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

export interface GatewayConfig {
  production: boolean;
  /** DEMO_MODE: the required hosted-mode variables are not enforced. */
  demo: boolean;
  port: number;
  /** The volume: the database and every user's folders. */
  dataDir: string;
  /** e.g. https://specs.example.com — email links and the Host check use it. */
  publicUrl: string | null;
  /** Emails (`a@b.c`) and domains (`@b.c`) that may sign up without an invite. */
  signupAllowlist: string[];
  /** Resend API key; unset outside production means the console mailer. */
  resendApiKey: string | null;
  mailFrom: string;
  /** Minutes a worker may sit unused before it is stopped. */
  workerIdleMinutes: number;
  /** The worker entry point: the app's own server (src/index.ts). */
  workerEntry: string;
}

function isDemoMode(env: Env): boolean {
  const v = env.DEMO_MODE;
  return v === "1" || v === "true";
}

export function readConfig(env: Env = process.env): GatewayConfig {
  const production = env.NODE_ENV === "production";
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, "") || null;
  const config: GatewayConfig = {
    production,
    demo: isDemoMode(env),
    port: Number(env.PORT) || 3000,
    dataDir: resolve(env.SPECDRIVEN_DATA_DIR?.trim() || "/data"),
    publicUrl,
    signupAllowlist: parseAllowlist(env.SPECDRIVEN_SIGNUP_ALLOWLIST),
    resendApiKey: env.RESEND_API_KEY?.trim() || null,
    mailFrom: env.MAIL_FROM?.trim() || "SpecDriven <no-reply@localhost>",
    workerIdleMinutes: Number(env.SPECDRIVEN_WORKER_IDLE_MINUTES) || 30,
    workerEntry: join(import.meta.dir, "..", "index.ts"),
  };
  // The demo is ephemeral and sends no mail: only hosted mode needs these.
  if (production && !isDemoMode(env)) {
    const missing: string[] = [];
    if (!publicUrl) missing.push("PUBLIC_URL");
    if (!config.resendApiKey) missing.push("RESEND_API_KEY");
    if (!env.MAIL_FROM?.trim()) missing.push("MAIL_FROM");
    if (!env.SPECDRIVEN_MASTER_KEY?.trim()) missing.push("SPECDRIVEN_MASTER_KEY");
    if (missing.length) throw new Error(`Missing required variables: ${missing.join(", ")}`);
    if (!publicUrl!.startsWith("https://")) throw new Error("PUBLIC_URL must be an https:// url");
  }
  return config;
}

export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether the allowlist lets this email sign up on its own. */
export function allowlisted(email: string, allowlist: string[]): boolean {
  const lower = email.toLowerCase();
  const domain = lower.slice(lower.lastIndexOf("@"));
  return allowlist.includes(lower) || allowlist.includes(domain);
}

// The remote agents' API keys a hosted worker was started with
// (src/server/hostedMode.ts). The user stores them on the gateway's account
// page, encrypted at rest (src/gateway/secrets.ts); the gateway decrypts them
// and passes each one to that user's worker alone, as
// SPECDRIVEN_AGENT_KEY_<NAME>. Remote-agent integrations read them here.

export const AGENT_KEY_PREFIX = "SPECDRIVEN_AGENT_KEY_";

/** A key's name as an environment variable suffix: "openai-prod" → "OPENAI_PROD". */
export function agentKeyEnvName(name: string): string {
  return AGENT_KEY_PREFIX + name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** Every agent key the worker was given, by env suffix ("OPENAI_PROD" → key). */
export function agentKeys(env: Record<string, string | undefined> = process.env): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(AGENT_KEY_PREFIX) && value) keys.set(name.slice(AGENT_KEY_PREFIX.length), value);
  }
  return keys;
}

/** One agent key by the name it was stored under, or null when there is none. */
export function agentKey(name: string, env: Record<string, string | undefined> = process.env): string | null {
  return env[agentKeyEnvName(name)] || null;
}

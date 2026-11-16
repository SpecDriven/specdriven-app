// A hosted worker's GitHub tokens (docs/hosted-tenant-isolation.md "Step
// 3"). Where the hosted service has a GitHub App of its own, a worker holds
// no token at all: when git is about to talk to a repository it asks the
// gateway, over a socket only this worker can open, and gets one that lasts
// an hour and reaches that repository alone (src/gateway/tokenSocket.ts).
// The gateway decides whether there is one to give; what this side says is
// only which repository.
//
// Kept free of the app's other modules: git's credential helper
// (git/hostedCredential.ts) is a process of its own and loads this alone.

import net from "node:net";

/** Where a hosted worker asks for tokens; set by its gateway (src/gateway/workers.ts). */
export const TOKEN_SOCKET_ENV = "SPECDRIVEN_GITHUB_TOKEN_SOCKET";
/** Whose GitHub account the worker commits as: `{id, login, name, email}` as JSON. */
export const IDENTITY_ENV = "SPECDRIVEN_GITHUB_IDENTITY";
/** Set when the hosted service makes its tokens through its GitHub App, connected or not. */
export const GITHUB_APP_ENV = "SPECDRIVEN_GITHUB_APP";

type Env = Record<string, string | undefined>;

export function tokenSocket(env: Env = process.env): string | null {
  return env[TOKEN_SOCKET_ENV]?.trim() || null;
}

/** Whether this worker's GitHub goes through the service's app rather than a pasted token. */
export function usesGithubApp(env: Env = process.env): boolean {
  return env[GITHUB_APP_ENV] === "1";
}

/**
 * `owner/name` from a repository url's path, as git hands it to a
 * credential helper (`owner/name.git`) or as a request's url carries it
 * (`/owner/name.git/info/refs`); null when the path names no repository.
 */
export function repoOfPath(path: string | undefined): string | null {
  const [owner, name] = (path ?? "").replace(/^\/+/, "").split("/");
  const bare = name?.replace(/\.git$/i, "");
  return owner && bare ? `${owner}/${bare}` : null;
}

export interface GatewayToken {
  token: string;
  /** When it stops working, in milliseconds. */
  expiresAt: number;
}

/** The socket is made a moment after the worker starts; this long is waited for it. */
const SOCKET_WAIT_MS = 5_000;
const ANSWER_TIMEOUT_MS = 40_000;

function askOnce(socketPath: string, repo: string): Promise<GatewayToken> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let text = "";
    const fail = (e: Error) => {
      socket.destroy();
      reject(e);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(ANSWER_TIMEOUT_MS, () => fail(new Error("The gateway did not answer")));
    socket.on("error", fail);
    socket.on("connect", () => socket.write(JSON.stringify({ repo }) + "\n"));
    socket.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 16_384) fail(new Error("The gateway's answer is not one"));
    });
    socket.on("close", () => {
      try {
        const answer = JSON.parse(text.slice(0, text.indexOf("\n") >>> 0)) as { token?: unknown; expiresAt?: unknown; error?: unknown };
        if (typeof answer.token === "string" && answer.token && typeof answer.expiresAt === "number") {
          return resolve({ token: answer.token, expiresAt: answer.expiresAt });
        }
        reject(new Error(typeof answer.error === "string" ? answer.error : "The gateway gave no token"));
      } catch {
        reject(new Error("The gateway gave no token"));
      }
    });
  });
}

/** A token for `repo` (`owner/name`) from the gateway, or a thrown reason there is none. */
export async function askGateway(socketPath: string, repo: string, waitMs = SOCKET_WAIT_MS): Promise<GatewayToken> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await askOnce(socketPath, repo);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== "ENOENT" && code !== "ECONNREFUSED") || Date.now() >= deadline) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

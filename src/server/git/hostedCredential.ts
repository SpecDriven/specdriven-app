// Git's credential helper in a hosted worker whose service has a GitHub App
// (docs/hosted-tenant-isolation.md "Step 3"). Git runs it when a remote
// asks who is calling, and tells it the repository on its input; it asks
// the gateway for that repository's token (../hostedToken.ts) and answers
// git. The token goes from the gateway to git through this process and is
// nowhere else in the worker: not in its environment, not on disk.
//
//   git … -c credential.<host>.helper='!bun hostedCredential.ts' -c credential.<host>.useHttpPath=true
//
// With no token to give it says why on its error output, which lands in
// git's own, and answers nothing: git then fails as it does with no
// credential at all.

import { askGateway, repoOfPath, tokenSocket } from "../hostedToken";

/** What git gets back for a `get`: the lines of its credential protocol, or none. */
export async function credentialFor(input: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const fields = new Map<string, string>();
  for (const line of input.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const socket = tokenSocket(env);
  const repo = repoOfPath(fields.get("path"));
  if (!socket || !repo) return "";
  const { token, expiresAt } = await askGateway(socket, repo);
  return `username=x-access-token\npassword=${token}\npassword_expiry_utc=${Math.floor(expiresAt / 1000)}\n`;
}

if (import.meta.main) {
  // `store` and `erase` have nothing to do: nothing is kept here.
  if (process.argv[2] === "get") {
    try {
      process.stdout.write(await credentialFor(await Bun.stdin.text()));
    } catch (e) {
      process.stderr.write(`SpecDriven: ${(e as Error).message}\n`);
    }
  }
  process.exit(0);
}

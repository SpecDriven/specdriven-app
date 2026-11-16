// Stands in for the gateway's half of a worker's token socket
// (tests/gatewayTokenSocket.test.ts): run as the gateway's uid, it listens
// where the spawner made room for it and answers one fixed token to the
// worker uid it is told — exactly what the gateway's own process does.
//
//   bun tokenServer.ts <socket path> <worker uid>

import { serveTokens } from "../../src/gateway/tokenSocket";

const [path, uid] = process.argv.slice(2);
await serveTokens({
  path: path!,
  uid: Number(uid),
  answer: async (repo) => ({ token: `token-for-${repo}`, expiresAt: Date.now() + 3_600_000, write: true }),
});
console.log("listening");

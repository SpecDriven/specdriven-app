# Deployment modes

Besides the single-user desktop and web app, the same code base runs in
three other modes, each switched on by an environment variable. The Railway
setup for the hosted ones is in [deployment-railway.md](deployment-railway.md).

## Demo mode

`DEMO_MODE=1` (`bun run demo`) runs the app as a public, self-resetting demo
of the checked-in `demo-data/` dataset (a snapshot of the specs-insurance
repo, refreshed with `cp -R ../specs-insurance demo-data && rm -rf demo-data/.git`):

- Every page load copies `demo-data/` to a fresh working directory under
  `SPECDRIVEN_ROOT` (default `/tmp/specdriven-demo`) — editing works in full,
  and a browser refresh returns the demo to the default dataset. The snapshot
  itself is never written.
- The copy has no `.git`, so every git operation takes the existing
  plain-directory path: saves land locally, pull/push are skipped, and nothing
  talks to GitHub. Sign-in, the folder picker, and data-directory changes are
  refused server-side (403/501) and hidden in the UI.
- All state — settings, token file, logs — is confined under the demo root
  (`SPECDRIVEN_HOME` is pointed inside it), away from `~/.specdriven`.

[Dockerfile](../Dockerfile) deploys it as a container; everything is
ephemeral, so no volume is needed. Keep it to one machine — each machine
holds an independent demo copy. On Railway, `railway.json` builds every
service with `Dockerfile.hosted`: set `DEMO_MODE=1` on the demo service and
its entry point runs this demo instead of the sign-in gateway, with no
hosted-mode variables required (`src/gateway/demo.ts`).

## Hosted (multi-user)

`bun run start:hosted` runs the hosted gateway (`src/gateway`): email and
password sign-in with password recovery by email (Resend), each user's
GitHub token and agent API keys encrypted at rest, and one app server per
user in its own folder. Local agents and plugin installs are off there.
`Dockerfile.hosted` and `railway.json` deploy it on Railway with a volume at
`/data`. With `SPECDRIVEN_DATASTORE_TOKEN` set, the accounts are also
mirrored into a private GitHub repo, so they survive a redeploy. See
[deployment-railway.md](deployment-railway.md). `bun run dev:hosted` runs it
locally with emails printed to the console.

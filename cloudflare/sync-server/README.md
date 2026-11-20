# SpecDriven sync server for Cloudflare

A live-sync server for the SpecDriven app that runs on Cloudflare: one
Worker in front, and behind it a separate sync server for every data
repository — a Durable Object with its own Automerge repo and its own
storage. Only people who can push to a repository on GitHub can use that
repository's server.

It speaks the same WebSocket protocol as `wss://sync.automerge.org`, so the
app connects with its ordinary sync client. Git stays the source of record;
this only makes edits travel between running apps within moments.

## Set it up

You need a Cloudflare account. Durable Objects with SQLite storage are
available on the free plan.

```sh
cd cloudflare/sync-server
bun install
bunx wrangler login
openssl rand -base64 32 | bunx wrangler secret put TICKET_SECRET
bunx wrangler deploy
```

`deploy` prints the Worker's address, for example
`https://specdriven-sync.<your-account>.workers.dev`. In the app, under
Settings → Live sync server, each person enters that address with `wss://`
and `{repo}` where the repository goes:

```
wss://specdriven-sync.<your-account>.workers.dev/{repo}
```

The app replaces `{repo}` with the owner and name of the data repository's
GitHub origin, so one address serves every data repository and each gets its
own server.

## Who gets in

1. The app asks the server which GitHub it checks against
   (`GET /.well-known/specdriven-sync`). If that is not the GitHub the data
   repository is on, the app stops there.
2. The app sends the user's GitHub token, once, over HTTPS
   (`POST /<owner>/<name>/ticket`). The Worker asks GitHub what that token may
   do in the repository and keeps nothing.
3. If GitHub says the token can push, the Worker answers with a pass for
   that one repository, good for an hour. Read access is not enough.
4. The app opens the WebSocket with the pass (`GET /<owner>/<name>?ticket=…`)
   and renews the pass before it runs out. A connection is closed when the
   pass it was opened with runs out, so someone who lost write access is out
   within the hour.

The pass is signed with `TICKET_SECRET`. Changing the secret turns every
outstanding pass away; the apps ask for new ones by themselves.

## Settings

In `wrangler.jsonc`:

| Name | Default | What it is |
| --- | --- | --- |
| `GITHUB_HOST` | `github.com` | The GitHub whose repositories this server serves |
| `GITHUB_API_URL` | `https://api.github.com` | That GitHub's REST API |
| `TICKET_SECONDS` | `3600` | How long a pass lasts |

A GitHub Enterprise server works when Cloudflare can reach its API: set both
names (the API is usually `https://<host>/api/v3`). One deployment checks
against one GitHub.

## Where the documents are

Each repository's documents are in the SQLite database of its own Durable
Object: durable, private to that object, limited to 10 GB per repository,
with thirty days of point-in-time recovery. The object runs while a peer is
connected and stops when the last one leaves; the documents stay, and the
next peer to connect finds them. No R2 bucket is involved.

Losing this storage loses nothing for good: every app holds its repository's
documents and offers them again when it connects, and git has them all.

## Good to know

- An object stays in memory, and is billed for it, for as long as at least
  one app is connected to that repository. Hibernating between messages
  would lower that and is not done yet.
- A repository's server holds every document a peer has asked about in
  memory (128 MB per object). Spec repositories are far below that.
- Checked so far only with `wrangler dev` on a developer's machine and a
  stand-in for GitHub's API; not yet deployed to Cloudflare, and not yet
  checked against GitHub itself.

## Work on it

```sh
bunx wrangler dev          # the Worker on this machine
bun run typecheck          # the Cloudflare half, against the Workers types
```

Everything but `src/worker.ts` runs in the app's own test suite
(`tests/syncServer.test.ts`, `tests/repoSyncServer.test.ts`), including a
room talking to the app's sync client over a real WebSocket. For a local
run, give `wrangler dev` a `TICKET_SECRET` in a `.dev.vars` file, and enter
`ws://127.0.0.1:8787/{repo}` in the app's Settings: the app sends a GitHub
token over an unencrypted connection only to this machine.

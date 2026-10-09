# Hosted SpecDriven on Railway

SpecDriven is a single-user app: one settings file, one GitHub token, one data
repo. The hosted setup keeps it that way and puts a small **gateway** in front.
The gateway signs people in with email and password, keeps each person's
secrets encrypted, and runs **one app server (a worker) per person**. Each
worker has its own folders and its own credentials.

```
Browser ──HTTPS──▶ Railway edge ──▶ gateway (src/gateway, :$PORT)
                                      │  /login /signup /forgot /set-password /account
                                      │  /auth/* API, session cookie → user
                                      │  the app's frontend (built once, /_app/*)
                                      ▼
                     worker per user = bun src/index.ts, SPECDRIVEN_HOSTED=1
                     unix socket /data/users/<id>/run/app.sock
                     HOME, settings, clones under /data/users/<id>/
                     env: that user's GitHub token and agent keys only
```

- **Starting and stopping workers.** The gateway starts a person's worker on
  their first request. It stops the worker after 30 idle minutes
  (`SPECDRIVEN_WORKER_IDLE_MINUTES`) and restarts it whenever that person
  changes a secret. A worker serves only the API, using roughly 85–140 MB. The
  gateway serves the frontend, built once in the image, so workers never
  bundle it.
- **Hosted mode in the worker** (`src/server/hostedMode.ts`) turns off
  everything that would run code or reach outside the person's folder:
  - local coding agents (Claude, Pi, Codex, Claude Desktop) and task
    estimates;
  - plugin installs, plugin folders and marketplaces (only built-in plugins
    run);
  - the native folder chooser, IntelliJ, and the GitHub CLI engine;
  - local-path data repos (only `https://github.com/…` urls are accepted);
  - the websocket sync server;
  - the app's own GitHub sign-in, which the account page replaces.
- **Isolation between users.** Each worker runs as a Linux uid of its own
  (200000 and up, kept in the database), started through `setpriv` with no
  supplementary groups and `no_new_privs`. Its folder `/data/users/<id>`
  belongs to that uid with mode 0700; `/data` and `/data/users` are 0711,
  so a worker can pass through to its own folder but can't list the others;
  and `app.db` is root-only (0600).
  - This is what makes the folders separate. A user controls their data
    repo's contents, symlinks included, so a link to another user's folder,
    to the database or to `/proc/<gateway>/environ` (where the master key
    is) is refused by the kernel, not by convention.
  - Separate uids need the gateway to run as root with `setpriv` installed,
    as in the image. Elsewhere (development, tests) the workers share the
    gateway's user and the gateway logs a warning.
  - Hosted mode still runs no user-supplied code. Running agents or plugins
    would need more than a uid: a container or sandbox per person.

## Credential storage

| What | How it is stored | Where |
|---|---|---|
| Password | argon2id hash (`Bun.password`), per-hash salt. At least 12 characters, common passwords refused | `users.password_hash` in `/data/app.db` |
| Session | 32 random bytes in an `HttpOnly; Secure; SameSite=Lax` `__Host-` cookie. The database keeps only its SHA-256. Expires after 14 idle days and 30 days at most | `sessions` |
| Email links (sign-up, reset) | 32 random bytes in the link's `#fragment`, so the token never reaches a server log or a `Referer` header. Stored as SHA-256, single use; sign-up links last 24 h, reset links 30 min | `email_tokens` |
| GitHub token, agent API keys | AES-256-GCM with a fresh IV per secret. The owner's id and the secret's name are bound in as associated data | `secrets` |
| Master key | 32 random bytes, a **Railway variable**, never on the volume | `SPECDRIVEN_MASTER_KEY` |

A copy of the volume, or a backup of it, reveals no secret without the master
key.

The browser can only write secrets: the account page shows each one's name,
its last four characters and, for GitHub, the account the token belongs to.
Secrets are decrypted only in the gateway, when it starts that person's
worker. They reach the worker as environment variables:

- the GitHub token as `SPECDRIVEN_GITHUB_TOKEN_RECORD`, read through
  `createEnvBackend` in `src/server/tokenStore.ts`;
- each agent key as `SPECDRIVEN_AGENT_KEY_<NAME>`, read through
  `src/server/agentKeys.ts`.

The worker's environment is built from scratch, so the master key and the
Resend key never reach it.

**Why a server-side master key and not one derived from the password?** A key
derived from the password would make the data unreadable to the server, but
it has two costs: a password reset would destroy every stored secret, and the
background git sync could not run while the person is signed out.

**Rotating the master key:**

1. Generate a new key with `bun src/gateway/index.ts genkey`.
2. Move the current key to `SPECDRIVEN_MASTER_KEYS_PREVIOUS` (comma-separated)
   and set the new key as `SPECDRIVEN_MASTER_KEY`. Redeploy; at start the
   gateway re-encrypts every secret under the new key.
3. On a later deploy, remove the old key.

**GitHub token.** Ask people for a
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
limited to their specs repository, with **Contents: read and write**, plus
**Issues** and **Pull requests** if they use those tabs. When the token is
saved, the gateway checks it with GitHub (`GET /user`) and stores the login,
name and email as the commit identity.

## Sign-up and password recovery

1. **Sign up** (`/signup`): the person enters an email address. If it is on
   `SPECDRIVEN_SIGNUP_ALLOWLIST` or was invited from someone's account page,
   the gateway emails a link that chooses the first password. An account has
   no password until that link is used, so nobody can claim an address they
   cannot read.
2. **Forgot password** (`/forgot`): the answer is the same "check your
   email" whether or not the account exists, and the email is sent in the
   background so response time doesn't tell either. The reset link works
   once, for 30 minutes, and asking again retires older links.
3. **Choosing a password** (`/set-password#token=…`): the page takes the
   token out of the address bar. A link is used up only once a password is
   accepted; a refused password leaves it valid for another try. Saving the
   password then:
   - ends every session of that account and restarts its worker;
   - after a reset, emails a "your password was changed" notice;
   - signs this browser in.
4. **Changing the password** (`/account`) needs the current password and
   likewise ends the other sessions.
5. **Rate limits**, kept in the database so a restart doesn't reset them:

   | Action | Limit per address (or account) | Limit per IP |
   |---|---|---|
   | Sign-in attempts | 10 per 15 min | 30 per 15 min |
   | Sign-up requests | 3 per hour | 10 per hour |
   | Forgot-password requests | 5 per hour | 20 per hour |
   | Password-change attempts | 10 per hour per account | — |
   | Secret changes | 60 per hour per account | — |
   | Invites | 20 per hour per account | — |

Every write, the `/auth/*` API included, passes the app's own Host, Origin
and Content-Type checks (`src/server/requestGuard.ts`), with `PUBLIC_URL`'s
host as the allowed host. Gateway pages are sent with a strict CSP,
`frame-ancestors 'none'` and `no-store`; every response gets HSTS and
`nosniff`.

## Deploying on Railway

1. **Create a service from this repository.** `railway.json` points Railway at
   `Dockerfile.hosted` and the `/healthz` health check.
2. **Add a volume mounted at `/data`.** It holds `app.db` and every user's
   folders. A service with a volume runs as a single replica, and a redeploy
   has a short gap while the volume moves to the new container. That suits a
   small team. Railway mounts volumes as root. The gateway runs as root, which
   it needs in order to give each worker its own uid; the workers do not.
3. **Set the variables:**

   | Variable | Value |
   |---|---|
   | `SPECDRIVEN_MASTER_KEY` | output of `bun src/gateway/index.ts genkey` — keep a copy in your password manager; without it the stored secrets are lost |
   | `PUBLIC_URL` | `https://specs.example.com` (or the `*.up.railway.app` domain) — email links and the Host check use it |
   | `RESEND_API_KEY` | from [resend.com](https://resend.com), with your sending domain verified |
   | `MAIL_FROM` | e.g. `SpecDriven <no-reply@specs.example.com>` on that verified domain |
   | `SPECDRIVEN_SIGNUP_ALLOWLIST` | who may sign up without an invite: `you@example.com,@yourcompany.com` |
   | `SPECDRIVEN_WORKER_IDLE_MINUTES` | optional, default 30 |

   `PORT` comes from Railway. In production the gateway refuses to start
   without the first four variables.
4. **Add a domain** (Settings → Networking). Railway terminates TLS.
5. **Deploy, then sign up** with an allowlisted address. Open **Account &
   tokens**, paste the GitHub token, and enter your specs repository's url
   on the first-run screen.

**Limits to know:**

- Railway cuts HTTP requests off at 15 minutes. The app's long-lived streams
  (plugin events) reconnect on their own.
- The gateway's idle timeout is 255 s, and the worker's is 60 s per request.

**Backups:** Railway volume backups cover the accounts and the encrypted
secrets. The specs themselves live in GitHub, and each worker pushes saved
work on its sync tick.

## Running it locally

```sh
bun run dev:hosted          # gateway on :3000, data in ./.hosted-data
SPECDRIVEN_SIGNUP_ALLOWLIST=you@example.com bun run dev:hosted
```

When no variables are set:

- emails are printed to the console instead of being sent;
- a throwaway master key is used, so stored secrets don't survive a restart;
- the frontend is bundled in memory at start.

## Code map

| File | Role |
|---|---|
| `src/gateway/index.ts` | entry: config, database, keyring, workers, `Bun.serve` |
| `src/gateway/server.ts` | routing: pages, `/auth/*`, the session check, proxying |
| `src/gateway/accounts.ts` | sign-up, login, reset and change password, invites |
| `src/gateway/sessions.ts`, `rateLimit.ts` | cookies and sessions; fixed-window limits |
| `src/gateway/crypto.ts`, `secrets.ts` | AES-GCM keyring and the per-user secret store |
| `src/gateway/workers.ts`, `proxy.ts` | the per-user worker pool and the streaming proxy |
| `src/gateway/appShell.ts`, `assets.ts`, `pages/` | the app's frontend and the gateway's own pages |
| `src/gateway/mail.ts` | Resend client and email texts |
| `src/server/hostedMode.ts` | what a hosted worker refuses |
| `src/server/agentKeys.ts` | agent keys for future remote-agent integrations |

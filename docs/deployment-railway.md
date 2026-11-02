# Hosted SpecDriven on Railway

SpecDriven is a single-user app: one settings file, one GitHub token, one data
repo. The hosted setup keeps it that way and puts a small **gateway** in front.
The gateway signs people in with email and password, keeps each person's
secrets encrypted, and runs **one app server (a worker) per person**. Each
worker has its own folders and its own credentials.

```
Browser ──HTTPS──▶ Railway edge ──▶ gateway (src/gateway, :$PORT)
                                      │  /login /signup /forgot /set-password /account /admin
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

## Datastore

The accounts are also mirrored into a private GitHub repository, by default
[SpecDriven/hosted-app](https://github.com/SpecDriven/hosted-app), so a
redeploy that loses the volume still knows everyone (`src/gateway/datastore.ts`).

- **What goes in:** one JSON file per table: `users.json` (password hashes,
  roles and `os_uid`), `allowed-emails.json`, `secrets.json` (still AES-GCM
  ciphertext, in base64), `repos.json` (each user's recent data repos, GitHub
  urls only, the open one first), and `sessions.json` (the session hash, owner,
  created and expiry times only; no IP address, user agent or last-seen
  time). Email links and rate-limit counters stay behind. A repo saved before
  the roles is still read: its accounts are users, its `invites.json` becomes
  the allowed emails, and the next save replaces it with `allowed-emails.json`.
- **On start:** the gateway clones the repo into `/data/datastore` (root-only,
  like `app.db`). If `app.db` has no accounts, it is filled from the repo. If it
  already has accounts, the volume survived and is newer, so its copy is pushed
  over the repo's.
- **While running:** every 30 s, a change worth keeping (sign-up, password,
  secret, allowed email, role, recent repos, sign-in, sign-out) is committed
  as "Save accounts" and pushed. A session's sliding expiry alone is not pushed.
- **Recent repos** (`src/gateway/repos.ts`): the gateway reads them from each
  running worker's settings file every minute and when the worker stops. A
  worker that starts with no settings file (its folder was on the lost
  volume) gets one naming them, the most recent open, so the next sign-in
  goes straight to that repo instead of asking for its url. A settings file
  that is already there is never overwritten, and symlinks are not followed.
- **On SIGTERM** (every redeploy): one last forced push, so everything is in
  the repo before the container goes.
- **When the repo can't be read**, the gateway refuses to start rather than
  start with no accounts and push that list over the real one.
- **The master key must stay the same** across redeploys, or the secrets in the
  repo no longer open. Rotate it with `SPECDRIVEN_MASTER_KEYS_PREVIOUS` as
  usual. The re-sealed secrets are pushed on the next save.

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

1. **Sign up** (`/signup`): the person enters an email address. If an admin
   has allowed it, or its whole domain (see below), the gateway emails a link
   that chooses the first password. An account has no password until that
   link is used, so nobody can claim an address they cannot read.
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
   | Admin changes | 120 per hour per account | — |

## Admins and the allowed emails

Every account has a role, **admin** or **user** (`src/gateway/admin.ts`).
Users use the app. Admins also get **Admin** next to **Settings** in the
user menu, which opens `/admin`:

- **Allowed emails:** who may create an account, as an address
  (`name@example.com`) or a whole domain (`@example.com`). Adding an address
  can email it an invitation to the sign-up page. The list decides sign-up
  only: taking an address off it stops new sign-ups, while an account
  already made stays.
- **Users:** every account, with its role. An admin makes another account an
  admin, or an admin a user, and the change applies on that person's next
  request. The last admin can't stop being one, so there is always one.

Only admins can open `/admin` or call `/auth/admin/*`; for anyone else they
answer 403.

**The first admin** is `ORIGINAL_ADMIN` in `src/gateway/admin.ts`
(`david@vydra.net`), with a password chosen for it and kept there only as
its argon2id hash. When the gateway starts on a database with no admin,
after the [datastore](#datastore) restore, it makes that account the admin
with that password, creating it if needed, or replacing its password and
ending its sessions if it exists. This happens once: from then on there is
always an admin. Change that password on the account page after the first
sign-in. A fork that runs its own gateway sets its own address and password
hash there.

Every write, the `/auth/*` API included, passes the app's own Host, Origin
and Content-Type checks (`src/server/requestGuard.ts`), with `PUBLIC_URL`'s
host as the allowed host. A GET or HEAD for any other host, such as the
service's `*.up.railway.app` domain, is redirected (301) to the same path on
`PUBLIC_URL`; any other request for it is refused. Gateway pages are sent
with a strict CSP, `frame-ancestors 'none'` and `no-store`; every response
gets HSTS and `nosniff`.

## Deploying on Railway

1. **Create a service from this repository.** `railway.json` points Railway at
   `Dockerfile.hosted` and the `/healthz` health check. It applies to every
   service built from this repository: a service with `DEMO_MODE=1` runs the
   public demo from the same image instead of the gateway, needs none of the
   variables below and no volume (`src/gateway/demo.ts`); so does one with
   `SPECDRIVEN_READONLY=1`, the [public read-only site](#public-read-only-site).
2. **Add a volume mounted at `/data`.** It holds `app.db` and every user's
   folders. A service with a volume runs as a single replica, and a redeploy
   has a short gap while the volume moves to the new container. That suits a
   small team. Railway mounts volumes as root. The gateway runs as root, which
   it needs in order to give each worker its own uid; the workers do not.
3. **Set the variables:**

   | Variable | Value |
   |---|---|
   | `SPECDRIVEN_MASTER_KEY` | output of `bun src/gateway/index.ts genkey` — keep a copy in your password manager; without it the stored secrets are lost |
   | `PUBLIC_URL` | `https://specs.example.com` (or the `*.up.railway.app` domain) — email links and the Host check use it, and page loads on any other host redirect to it |
   | `RESEND_API_KEY` | from [resend.com](https://resend.com), with your sending domain verified |
   | `MAIL_FROM` | e.g. `SpecDriven <no-reply@specs.example.com>` on that verified domain |
   | `SPECDRIVEN_WORKER_IDLE_MINUTES` | optional, default 30 |
   | `SPECDRIVEN_DATASTORE_TOKEN` | a GitHub token that can read and write the [datastore](#datastore) repo: a fine-grained token with resource owner **SpecDriven**, access to `hosted-app` only, and the **Contents: Read and write** permission. Unset, accounts live only on the volume |
   | `SPECDRIVEN_DATASTORE_REPO` | optional, default `https://github.com/SpecDriven/hosted-app` |

   `PORT` comes from Railway. In production the gateway refuses to start
   without the first four variables.
4. **Add a domain** (Settings → Networking). Railway terminates TLS. For a
   domain whose DNS is on Cloudflare, see
   [Custom domains on Cloudflare](#custom-domains-on-cloudflare).
5. **Deploy, then sign in** as the [first admin](#admins-and-the-allowed-emails)
   and change its password on the account page. Open **Admin** to allow the
   addresses and domains that may sign up. Open **Account & tokens**, paste
   the GitHub token, and enter your specs repository's url on the first-run
   screen.

**Limits to know:**

- Railway cuts HTTP requests off at 15 minutes. The app's long-lived streams
  (plugin events) reconnect on their own.
- The gateway's idle timeout is 255 s, and the worker's is 60 s per request.

**Backups:** the [datastore](#datastore) repo holds the accounts and the
encrypted secrets, and its history is a backup in itself. Railway volume
backups cover them as well. The specs themselves live in GitHub, and each
worker pushes saved work on its sync tick.

## Custom domains on Cloudflare

The services run under `specdriven.app`, whose DNS is on Cloudflare:

| Service | Domain | Railway domain |
|---|---|---|
| gateway | `private.specdriven.app` | `specdriven-app.up.railway.app` |
| demo (`DEMO_MODE=1`) | `demo.specdriven.app` | `specdrivenapp-demo.up.railway.app` |
| read-only site (`SPECDRIVEN_READONLY=1`) | `specs.specdriven.app` | assigned when the service is created |

1. **In Railway**, on the service: Settings → Networking → Public Networking →
   **+ Custom Domain**. Enter the domain, and the port the service's
   `*.up.railway.app` domain already uses. Railway shows two records to add: a
   CNAME, and a TXT named `_railway-verify.<subdomain>`. Copy both with the
   copy button, because the text on screen can be cut off. The CNAME target
   may differ from the `*.up.railway.app` domain.
2. **In Cloudflare**, `specdriven.app` → DNS → Records, add both, for example
   for the demo:

   | Type | Name | Content | Proxy status |
   |---|---|---|---|
   | CNAME | `demo` | the CNAME target from Railway | DNS only (grey cloud) |
   | TXT | `_railway-verify.demo` | the TXT value from Railway | — |

3. **Wait for the green check** next to the domain in Railway. Railway
   verifies the domain only once the TXT record is there as well as the
   CNAME, then issues the certificate itself.
4. **On the gateway, set `PUBLIC_URL`** to the new domain
   (`https://private.specdriven.app`) and redeploy. The gateway serves only
   `PUBLIC_URL`'s host and redirects page loads on any other host to it
   (`src/gateway/server.ts`), so:
   - until then, opening the new domain redirects to the old one;
   - from then on, opening a page on the `*.up.railway.app` domain redirects
     to the same page on the new one, and other requests there are refused.
     `/healthz` answers on every host, so Railway's health check still
     passes;
   - everyone signs in again, since the `__Host-` session cookie belongs to
     one host;
   - email links sent before the switch still work: they redirect, and the
     browser keeps the link's `#token`.

   The demo answers any host (`SPECDRIVEN_ALLOWED_HOSTS` defaults to `*` in
   `src/gateway/demo.ts`) and needs no variable.

**Leave Cloudflare's proxy off.** The gateway takes the rightmost
`X-Forwarded-For` entry as the client's address, for the per-address
[rate limits](#sign-up-and-password-recovery). Behind Cloudflare's proxy that
entry is a Cloudflare server's address, so many people would share one limit.
For the demo, which has no sign-in, the proxy is harmless; if you turn it on,
set SSL/TLS to **Full**. Flexible loops on redirects, and Full (strict) can
keep Railway from issuing the certificate. The mode applies to the whole
`specdriven.app` zone.

**When a domain stays on "Waiting for DNS update":** check that the TXT value
matches Railway's exactly, that no CAA record shuts out Let's Encrypt, and
that the proxy is off. Removing the domain in Railway and adding it again,
with the right port, fixes some cases.

**Mail:** `MAIL_FROM` can stay as it is. To send from an `@specdriven.app`
address, verify `specdriven.app` in Resend and add the records it gives in
Cloudflare.

## Running it locally

```sh
bun run dev:hosted          # gateway on :3000, data in ./.hosted-data
```

When no variables are set:

- emails are printed to the console instead of being sent;
- a throwaway master key is used, so stored secrets don't survive a restart;
- the frontend is bundled in memory at start;
- the first admin is made as on Railway; sign in as it to allow addresses.

## Code map

| File | Role |
|---|---|
| `src/gateway/index.ts` | entry: config, database, keyring, workers, `Bun.serve` |
| `src/gateway/server.ts` | routing: pages, `/auth/*`, the session check, proxying |
| `src/gateway/accounts.ts` | sign-up, login, reset and change password |
| `src/gateway/admin.ts` | roles, the allowed emails and invitations, the first admin |
| `src/gateway/sessions.ts`, `rateLimit.ts` | cookies and sessions; fixed-window limits |
| `src/gateway/crypto.ts`, `secrets.ts` | AES-GCM keyring and the per-user secret store |
| `src/gateway/datastore.ts` | the accounts' mirror in the datastore repo |
| `src/gateway/workers.ts`, `proxy.ts` | the per-user worker pool and the streaming proxy |
| `src/gateway/appShell.ts`, `assets.ts`, `pages/` | the app's frontend and the gateway's own pages |
| `src/gateway/mail.ts` | Resend client and email texts |
| `src/server/hostedMode.ts` | what a hosted worker refuses |
| `src/server/agentKeys.ts` | agent keys for future remote-agent integrations |

## Public read-only site

A third service from the same image: `SPECDRIVEN_READONLY=1` runs the app as a
public site that shows one spec repository to anyone, with no sign-in, and lets
nobody change anything. It serves https://specs.specdriven.app from
[SpecDriven/specs-specdriven](https://github.com/SpecDriven/specs-specdriven).

- **What a visitor sees:** the app's own UI with the Specs tab (the feature
  tree, every feature and every scenario, rendered), the Roadmap tab, the
  README and search. Every way to create, edit, move, publish or delete is
  hidden, and so are Sync, the folder switch, Settings, Plugins, the logs, the
  data viewer and the coding agents. A scenario's page is rendered, not an
  editor.
- **What the server allows:** a short list of GET routes
  (`src/server/readOnlyMode.ts` `ALLOWED`). Every other request, every write
  first of all, gets `403 This site is read-only` before its handler runs.
  Only the built-in Roadmap plugin is mounted; plugin folders, marketplace
  installs and agent plugins are off, so a file in the repo can't run code.
- **Where the specs come from:** the repository must be **public**. At start,
  the service makes a shallow clone with no credentials under
  `/tmp/specdriven-readonly/mirror`, and the app serves a copy of it with
  `.git` left out. With no `.git`, every git operation of the app's is
  skipped, so nothing it does can commit or push. Every minute it fetches the
  branch. When the branch has moved, it makes a new copy, brings the
  documents in step with the markdown, and switches to it. Open pages re-read
  on the same cadence. The service needs no volume: a restart clones again.
- **When the repo can't be cloned** (private, renamed, GitHub down), the
  service exits at start and Railway restarts it. A refresh that fails later
  is logged, and the site keeps showing what it has.

To deploy it:

1. **Make the spec repository public** on GitHub.
2. **Create the service** from this repository (no volume) and set:

   | Variable | Value |
   |---|---|
   | `SPECDRIVEN_READONLY` | `1` |
   | `SPECDRIVEN_READONLY_REPO` | optional, default `https://github.com/SpecDriven/specs-specdriven` |
   | `SPECDRIVEN_READONLY_BRANCH` | optional, default `main` |
   | `SPECDRIVEN_READONLY_REFRESH_SECONDS` | optional, default 60; `0` never refreshes |

   The site answers any Host, like the demo; set `SPECDRIVEN_ALLOWED_HOSTS`
   to `specs.specdriven.app` to narrow that. It drops from root to the
   image's `bun` user (`src/gateway/readOnly.ts`).
3. **Add the domain** `specs.specdriven.app`
   ([on Cloudflare](#custom-domains-on-cloudflare)). The site has no sign-in,
   so Cloudflare's proxy is harmless here too.

| File | Role |
|---|---|
| `src/server/readOnlyMode.ts` | the flag, the settings and the route allowlist |
| `src/server/readOnly.ts` | start: clone, snapshot, refresh timer |
| `src/server/api.ts` `handleApi`, `readOnlyFields` | the refusal; what `/api/state` reports |
| `src/frontend/App.tsx` `readOnly`, `src/frontend/pages/` | what the UI hides |
| `src/gateway/readOnly.ts` | the hosted image's hand-over to the site |

Run it locally against any repo, a local path included:

```sh
SPECDRIVEN_READONLY=1 SPECDRIVEN_READONLY_REPO=$PWD/../specs-specdriven SPECDRIVEN_ROOT=/tmp/sd-readonly bun src/index.ts
```

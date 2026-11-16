# Hosted SpecDriven on Railway

SpecDriven is a single-user app: one settings file, one GitHub token, one data
repo. The hosted setup keeps it that way and puts a small **gateway** in front.
The gateway signs people in with email and password, keeps each person's
secrets encrypted, and runs **one app server (a worker) per person**. Each
worker has its own folders and its own credentials.

```
Browser ──HTTPS──▶ Railway edge ──▶ gateway (src/gateway, :$PORT, not root)
                                      │  /login /signup /forgot /set-password /account /admin
                                      │  /auth/* API, session cookie → user
                                      │  the app's frontend (built once, /_app/*)
                                      │
                                      │  unix socket: start / stop / report
                                      ▼
                     spawner (root: the image's first process, no HTTP, no network)
                                      │  a uid, caps and a sandbox for each worker
                                      ▼
                     worker per user = bun src/index.ts, SPECDRIVEN_HOSTED=1
                     unix socket /data/users/<id>/run/app.sock
                     HOME, settings, clones, temp files under /data/users/<id>/
                     env: that user's agent keys only; no GitHub token
                     GitHub: asks the gateway for an hour's token per repository
                     out: through the gateway's proxy, to GitHub only
```

- **Two processes.** The image starts as root. That first process, the
  **spawner**, starts the gateway as a uid that is not root (199000) and
  from then on only starts, stops and reports on workers when the gateway
  asks over a unix socket (`src/gateway/spawner.ts`). The gateway answers
  the internet, signs people in and holds the master key. A bug in request
  handling therefore does not run as root.
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

  Git runs on a repository its person controls, so in a hosted worker it
  also runs with fixed settings (`HOSTED_GIT_CONFIG` in
  `src/server/git/cli.ts`; the bundled engine does the same): no hook and no
  file-system monitor command, only http(s) remotes, and a symlink is
  checked out as a plain file holding its target. A clone from before that
  rule has its symlinks replaced the same way when the worker starts.
- **Isolation between users.** Each worker runs as a Linux uid of its own
  (200000 and up, kept in the database), started through `setpriv` with no
  supplementary groups and `no_new_privs`. Inside `/data/users/<id>` its
  five folders (`home`, `root`, `repos`, `run`, `tmp`) belong to that uid
  with mode 0700; `/data` and `/data/users` are 0711, so a worker can pass
  through to its own folder but can't list the others. `app.db` is in the
  gateway's own folder, `/data/gateway` (0700, the gateway's uid), which no
  worker can enter.
  - This is what makes the folders separate. A user controls their data
    repo's contents, symlinks included, so a link to another user's folder,
    to the database or to `/proc/<gateway>/environ` (where the master key
    is) is refused by the kernel, not by convention.
  - **Root stays out of those folders.** Root would follow a link a worker
    left anywhere it wrote or read. So `/data/users/<id>` itself is root's
    (mode 0751, the worker's group): the worker can list it, and only root
    can add, rename or replace one of the five folders. Root makes those
    and never opens anything inside them. The worker sets up its own git
    author and settings as it starts (`src/gateway/workerStart.ts`), and
    the spawner reads a worker's settings and measures its folder as that
    worker's uid, handing the text to the gateway unparsed. A volume from
    before this rule is brought in line the next time each worker starts.
  - **The gateway reaches a worker's socket and nothing else of it.** The
    `run` folder also belongs to the gateway's group (0750), so the gateway
    can connect to the socket in it. No other worker can.
  - **A worker serves only its own gateway's requests.** A worker owns the
    folder its socket is in and could put a link to another person's socket
    there. So the gateway gives each worker a fresh key at every start and
    sends it with every request, and a worker refuses a request without its
    own key (`src/server/hostedMode.ts`).
  - **A worker is confined to its own folders and one way out**, where the
    kernel allows. A launcher applies Landlock and seccomp before the app
    starts (`src/gateway/launcher.ts`): the worker reads the system and the
    app's code, writes its own five folders and nowhere else (`/tmp`
    included), makes no call that reaches another process, a mount or a
    namespace, and connects to one TCP port, the gateway's outbound proxy
    (`src/gateway/egress.ts`), which lets through `github.com` and
    `api.github.com` only. The service logs at each start what its kernel
    holds a worker to; `bun src/gateway/index.ts probe` prints the same.
    [Hosted tenant isolation](hosted-tenant-isolation.md#what-the-network-rule-cannot-do)
    says what the network rule cannot do.
  - **Stopping a worker ends every process of its uid**, not only the
    worker: anything it started and detached goes too, on a stop, a restart
    and before the next start (`src/gateway/endProcesses.ts`).
  - **Limits.** Each worker starts under `prlimit` caps on processes and
    open files, with a temp folder of its own, and no worker starts while
    the volume is nearly full. A disk and a memory budget per person are
    off until you set them (see the variables below).
  - Separate uids need the image to start as root with `setpriv` installed,
    as it does. Elsewhere (development, tests) there is one process, the
    workers share its user, and it logs a warning.
  - Hosted mode still runs no user-supplied code. Running agents or plugins
    would need more than a uid: a container or sandbox per person.

## Credential storage

| What | How it is stored | Where |
|---|---|---|
| Password | argon2id hash (`Bun.password`), per-hash salt. At least 12 characters, common passwords refused | `users.password_hash` in `/data/app.db` |
| Session | 32 random bytes in an `HttpOnly; Secure; SameSite=Lax` `__Host-` cookie. The database keeps only its SHA-256. Expires after 14 idle days and 30 days at most. With [an account host](#the-account-host) there are two: the sign-in on the account host, and one made from it for the app's host, which ends with it | `sessions` |
| Hand-over code | 32 random bytes in a redirect's url, from the account host to the app's. Stored as SHA-256 with the hash of a secret in that browser's cookie; works once, for a minute | `handover_codes` |
| Email links (sign-up, reset) | 32 random bytes in the link's `#fragment`, so the token never reaches a server log or a `Referer` header. Stored as SHA-256, single use; sign-up links last 24 h, reset links 30 min | `email_tokens` |
| GitHub account | With [the service's GitHub App](#github): the person's GitHub id and login, as they proved them once. No token is stored: each is made for an hour when a worker's git asks | `github_links` |
| Agent API keys, and a GitHub token pasted before the app | AES-256-GCM with a fresh IV per secret. The owner's id and the secret's name are bound in as associated data | `secrets` |
| The GitHub App's private key and client secret | **Railway variables**, never on the volume or in the datastore | `SPECDRIVEN_GITHUB_APP_PRIVATE_KEY`, `SPECDRIVEN_GITHUB_APP_CLIENT_SECRET` |
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
  time; sign-ins only, never the sessions made from them for the app's
  host). Email links and rate-limit counters stay behind. A repo saved before
  the roles is still read: its accounts are users, its `invites.json` becomes
  the allowed emails, and the next save replaces it with `allowed-emails.json`.
- **On start:** the gateway clones the repo into `/data/gateway/datastore`
  (the gateway's alone, like `app.db`). If `app.db` has no accounts, it is filled from the repo. If it
  already has accounts, the volume survived and is newer, so its copy is pushed
  over the repo's.
- **While running:** every 30 s, a change worth keeping (sign-up, password,
  secret, allowed email, role, recent repos, sign-in, sign-out) is committed
  as "Save accounts" and pushed. A session's sliding expiry alone is not pushed.
- **Recent repos** (`src/gateway/repos.ts`): the gateway learns them from each
  running worker's settings file every minute and when the worker stops.
  The spawner reads the file as that worker's uid. A worker that starts with no settings file (its
  folder was on the lost volume) is handed the list and writes one naming
  them, the most recent open, so the next sign-in goes straight to that
  repo instead of asking for its url. A settings file that is already there
  is never overwritten.
- **On SIGTERM** (every redeploy): one last forced push, so everything is in
  the repo before the container goes.
- **When the repo can't be read**, the gateway refuses to start rather than
  start with no accounts and push that list over the real one.
- **The master key must stay the same** across redeploys, or the secrets in the
  repo no longer open. Rotate it with `SPECDRIVEN_MASTER_KEYS_PREVIOUS` as
  usual. The re-sealed secrets are pushed on the next save.

The browser can only write secrets: the account page shows each one's name
and its last four characters. Secrets are decrypted only in the gateway,
when it starts that person's worker. They reach the worker as environment
variables:

- each agent key as `SPECDRIVEN_AGENT_KEY_<NAME>`, read through
  `src/server/agentKeys.ts`;
- without [the service's GitHub App](#github), the pasted GitHub token as
  `SPECDRIVEN_GITHUB_TOKEN_RECORD`, read through `createEnvBackend` in
  `src/server/tokenStore.ts`.

With the app, no GitHub token is in the environment at all: see
[GitHub](#github).

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

## GitHub

A worker reaches GitHub in one of two ways. Which one depends on whether the
service has a GitHub App of its own.

**With the app** (`SPECDRIVEN_GITHUB_APP_*` set; recommended):

- A person presses **Connect GitHub** on the account page, once. GitHub asks
  them to confirm, and the gateway learns which GitHub account is theirs.
  The token that sign-in produces is revoked straight away. The gateway
  keeps the account's id and login as the commit identity.
- They install the app on their specs repository, from the link on the
  account page.
- When their worker's git fetches or pushes, it asks the gateway for a
  token over a socket only that worker can open. The gateway asks GitHub
  whether the app is installed on that repository and what the person may
  do there, and answers with a token that lasts one hour, reaches that one
  repository, and can write only if the person can.
- When the worker stops, the tokens it was given are revoked.
- One GitHub account belongs to one account here. To move it, disconnect
  it on the account that has it.

Nothing a person could lose is stored. A token pasted before the app keeps
working until its owner connects, which deletes it; no new one can be
pasted.

**Without the app:** people paste a
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
limited to their specs repository, with **Contents: read and write**. When
the token is saved, the gateway checks it with GitHub (`GET /user`) and
stores the login, name and email as the commit identity. The token is kept
sealed and handed to the worker in its environment. It lasts as long as its
owner chose, which is the weakness the app removes.

[Hosted tenant isolation, step 3](hosted-tenant-isolation.md#step-3-make-a-stolen-token-worth-little)
has the reasons and the limits.

### Registering the app

1. On GitHub, under the organisation that runs the service: Settings →
   Developer settings → GitHub Apps → **New GitHub App**.
2. Fill in:

   | Field | Value |
   |---|---|
   | Callback URL | `<ACCOUNT_URL>/auth/github/callback` (`<PUBLIC_URL>/…` while there is no account host) |
   | Setup URL | optional: `<ACCOUNT_URL>/account` |
   | Expire user authorization tokens | on |
   | Request user authorization (OAuth) during installation | off |
   | Webhook | not active |
   | Repository permissions | **Contents: Read and write**, **Metadata: Read-only**; nothing else |
   | Where can this GitHub App be installed? | any account, if people keep their specs outside the organisation |

3. On the app's page, **generate a client secret** and **generate a private
   key** (a `.pem` file downloads).
4. Set the three variables in [Deploying on Railway](#deploying-on-railway)
   and redeploy. The start log no longer says that people paste a token.

The private key can make a token for every repository the app is installed
on. Keep it where the master key is kept, and nowhere else.

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
gets HSTS and `nosniff`. What a worker answers is passed on without any
cookie it set, and an API answer carries a policy that keeps it from running
as a page (`src/gateway/proxy.ts`).

The app's own pages carry a Content-Security-Policy too
(`src/gateway/appCsp.ts`): only script from the service's own host runs, no
`eval`, and nothing is sent to or framed by another site. The one host
outside it is `esm.sh`, for the diagram editor's fonts.
`SPECDRIVEN_APP_CSP=report` sends the policy as report-only and `=off` sends
none.

## The account host

A worker runs on a repository its person, or a teammate of theirs, controls,
and what it answers is shown in the browser. With one host name, script it
got a browser to run would be on the same origin as the account and admin
pages and could call `/auth/*` as the signed-in person. So the gateway can
answer on two host names (`src/gateway/server.ts`):

| Host | Serves | Its cookie |
|---|---|---|
| `ACCOUNT_URL`, e.g. `account.specdriven.app` | `/login`, `/signup`, `/forgot`, `/set-password`, `/account`, `/admin`, `/auth/*` | the sign-in: it can change secrets and roles |
| `PUBLIC_URL`, e.g. `private.specdriven.app` | the app's pages, `/api/*` to the person's worker, `/_session/me` and `/_session/logout` | reaches that person's worker and nothing else |

- **Getting from one to the other.** A browser with no session on the app's
  host is sent to the account host, which sends it back with a code that
  works once, for a minute. The app's host then sets its own cookie. The
  code only works together with a secret the app's host left in that
  browser, so a code made for one browser cannot sign another one in.
- **What script on the app's host cannot do.** It finds no cookie the
  account host accepts, and a write it sends to the account host comes from
  another origin and is refused. `/auth/*` is not served on the app's host
  at all. It can still act as the person inside the app itself: that is the
  worker's own reach.
- **Signing out** on either host ends both sessions. So does changing the
  password.
- **Old links** to `/account`, `/admin` and the sign-in pages on the app's
  host redirect to the account host, and email links lead there directly.

To turn it on:

1. **Pick the name.** Any host other than `PUBLIC_URL`'s will do. Behind
   Cloudflare, pick one a single level under the zone, such as
   `account.specdriven.app`: see the warning below.
2. **Add it as a second custom domain** on the gateway's Railway service
   ([on Cloudflare](#custom-domains-on-cloudflare): its own CNAME and
   `_railway-verify` TXT record). Give it the **same port** as the service's
   existing domain: both names reach the one gateway, which listens on
   `PORT` (3000 in the image unless Railway sets another).
3. **Open `https://<the account host>/healthz`** in a browser. It answers
   `ok` once the certificate is in place. Do this before the next step.
4. **Set `ACCOUNT_URL`** to it, with `https://`, and redeploy.
5. Everyone signs in again: the sign-in cookie now belongs to the account
   host.

**Set `ACCOUNT_URL` only once the name answers over https.** From then on
every page of the app sends a browser with no session to the account host.
If that host has no certificate, nobody can sign in. Unsetting `ACCOUNT_URL`
and redeploying puts everything back on one host.

**A name two levels under the zone fails behind Cloudflare's proxy.**
Cloudflare's free certificate covers `specdriven.app` and one level below
it (`*.specdriven.app`). A name such as `account.private.specdriven.app` is
two levels down, so a proxied record for it (orange cloud) has no
certificate, and the browser stops before any request is made:
`SSL_ERROR_NO_CYPHER_OVERLAP` in Firefox, `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`
in Chrome. Three ways out:

- use a one-level name, which the existing certificate covers;
- or set that record to DNS only (grey cloud), so Railway serves its own
  certificate for it;
- or buy Cloudflare's Advanced Certificate Manager and issue a certificate
  for the deeper name.

The account host does not have to be under the app's host for the two to be
kept apart: what matters is that they are different hosts.

Without `ACCOUNT_URL` everything stays on `PUBLIC_URL`'s host, and the
gateway logs at start that the account pages share it.

## Deploying on Railway

1. **Create a service from this repository.** `railway.json` points Railway at
   `Dockerfile.hosted` and the `/healthz` health check. It applies to every
   service built from this repository: a service with `DEMO_MODE=1` runs the
   public demo from the same image instead of the gateway, needs none of the
   variables below and no volume (`src/gateway/demo.ts`); so does one with
   `SPECDRIVEN_READONLY=1`, the [public read-only site](#public-read-only-site).
2. **Add a volume mounted at `/data`.** It holds the gateway's folder
   (`/data/gateway`: `app.db` and the datastore's clone) and every user's
   folders. A service with a volume runs as a single replica, and a redeploy
   has a short gap while the volume moves to the new container. That suits a
   small team. Railway mounts volumes as root. The image's first process
   runs as root, which it needs in order to give each worker its own uid;
   the gateway it starts and the workers do not. A volume from before the
   gateway had its own folder is brought in line on the first start:
   `app.db` and `datastore` move into `/data/gateway`.
3. **Set the variables:**

   | Variable | Value |
   |---|---|
   | `SPECDRIVEN_MASTER_KEY` | output of `bun src/gateway/index.ts genkey` — keep a copy in your password manager; without it the stored secrets are lost |
   | `PUBLIC_URL` | `https://specs.example.com` (or the `*.up.railway.app` domain) — the app's host: the Host check uses it, and page loads on any other host redirect to it |
   | `ACCOUNT_URL` | optional but recommended: `https://account.specs.example.com`, [a host of their own](#the-account-host) for sign-in, the account page and the admin page. Unset, they share `PUBLIC_URL`'s host |
   | `RESEND_API_KEY` | from [resend.com](https://resend.com), with your sending domain verified |
   | `MAIL_FROM` | e.g. `SpecDriven <no-reply@specs.example.com>` on that verified domain |
   | `SPECDRIVEN_GITHUB_APP_CLIENT_ID` | recommended: the client id of [the service's GitHub App](#github). Set all three of these or none: with only some, the gateway refuses to start |
   | `SPECDRIVEN_GITHUB_APP_CLIENT_SECRET` | a client secret generated on the app's page |
   | `SPECDRIVEN_GITHUB_APP_PRIVATE_KEY` | the app's private key: the whole text of the `.pem` file. Its line ends may be written as `\n`, or the file given in base64 |
   | `SPECDRIVEN_WORKER_IDLE_MINUTES` | optional, default 30 |
   | `SPECDRIVEN_WORKER_MAX_PROCESSES` | optional, default 512: processes and threads one person's worker may have |
   | `SPECDRIVEN_WORKER_MAX_OPEN_FILES` | optional, default 4096: files one worker process may hold open |
   | `SPECDRIVEN_MIN_FREE_MB` | optional, default 256: no worker starts while the volume has less free, so `app.db` keeps room |
   | `SPECDRIVEN_WORKER_MAX_DISK_MB` | optional, no budget unless set: a worker whose folder holds more is stopped, and stays stopped until the folder is under it |
   | `SPECDRIVEN_WORKER_MAX_MEMORY_MB` | optional, no budget unless set: a worker holding more memory is stopped, and starts again on its person's next request |
   | `SPECDRIVEN_WORKER_EGRESS_HOSTS` | optional: more hosts a worker may reach besides GitHub, comma-separated, https unless a port is given (`otel.example.com:4318`) |
   | `SPECDRIVEN_WORKER_SANDBOX` | optional: `off` runs workers with a uid of their own and nothing more — no Landlock, no seccomp, no outbound proxy. For when the start log says the confinement is `BROKEN` |
   | `SPECDRIVEN_APP_CSP` | optional: `report` sends the app's Content-Security-Policy as report-only, `off` sends none |
   | `SPECDRIVEN_DATASTORE_TOKEN` | a GitHub token that can read and write the [datastore](#datastore) repo: a fine-grained token with resource owner **SpecDriven**, access to `hosted-app` only, and the **Contents: Read and write** permission. Unset, accounts live only on the volume |
   | `SPECDRIVEN_DATASTORE_REPO` | optional, default `https://github.com/SpecDriven/hosted-app` |

   `PORT` comes from Railway. In production the gateway refuses to start
   without the first four variables.
4. **Add a domain** (Settings → Networking). Railway terminates TLS. For a
   domain whose DNS is on Cloudflare, see
   [Custom domains on Cloudflare](#custom-domains-on-cloudflare).
5. **Deploy, then sign in** as the [first admin](#admins-and-the-allowed-emails)
   and change its password on the account page. Open **Admin** to allow the
   addresses and domains that may sign up. Open **Account & tokens**,
   connect [GitHub](#github) and install the app on your specs repository
   (or, without the app, paste a GitHub token), and enter the repository's
   url on the first-run screen.

**Limits to know:**

- Railway cuts HTTP requests off at 15 minutes. The app's long-lived streams
  (plugin events) reconnect on their own.
- The gateway's idle timeout is 255 s, and the worker's is 60 s per request.

**Backups:** the [datastore](#datastore) repo holds the accounts, who each
is on GitHub, and the encrypted secrets, and its history is a backup in itself. Railway volume
backups cover them as well. The specs themselves live in GitHub, and each
worker pushes saved work on its sync tick.

## Custom domains on Cloudflare

The services run under `specdriven.app`, whose DNS is on Cloudflare:

| Service | Domain | Railway domain |
|---|---|---|
| gateway | `private.specdriven.app`, and a second name for [the account host](#the-account-host) | `specdriven-app.up.railway.app` |
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
- there is one process and one host: no spawner, no sandbox, no account host
  (set `PUBLIC_URL` and `ACCOUNT_URL` to two local names to try the two
  hosts);
- GitHub is a pasted token, unless the three `SPECDRIVEN_GITHUB_APP_*`
  variables are set (a GitHub App whose callback url is
  `http://localhost:3000/auth/github/callback` will do);
- the frontend is bundled in memory at start;
- the first admin is made as on Railway; sign in as it to allow addresses.

## Code map

| File | Role |
|---|---|
| `src/gateway/index.ts` | entry: as root the spawner, otherwise the gateway |
| `src/gateway/spawnerMain.ts`, `spawner.ts`, `spawnerSocket.ts` | the root process: the volume, the gateway's start, and starting, stopping and reporting on workers over a socket |
| `src/gateway/main.ts` | the gateway: config, database, keyring, workers, `Bun.serve` |
| `src/gateway/server.ts` | routing: the two hosts, pages, `/auth/*`, the hand-over, the session check, proxying |
| `src/gateway/launcher.ts`, `sandbox.ts`, `sandboxCheck.ts` | what a worker starts through: Landlock and seccomp; trying them at start |
| `src/gateway/egress.ts` | the workers' outbound proxy |
| `src/gateway/appCsp.ts` | the Content-Security-Policy on the app's pages |
| `src/gateway/volume.ts` | the volume's layout and the gateway's own folder |
| `src/gateway/accounts.ts` | sign-up, login, reset and change password |
| `src/gateway/admin.ts` | roles, the allowed emails and invitations, the first admin |
| `src/gateway/sessions.ts`, `rateLimit.ts` | cookies and sessions; fixed-window limits |
| `src/gateway/crypto.ts`, `secrets.ts` | AES-GCM keyring and the per-user secret store |
| `src/gateway/githubApp.ts`, `githubLinks.ts` | the service's GitHub App: who a person is on GitHub, and an hour's token for one repository |
| `src/gateway/tokenSocket.ts` | the socket a worker's git asks for that token on |
| `src/gateway/datastore.ts` | the accounts' mirror in the datastore repo |
| `src/gateway/workers.ts`, `proxy.ts` | the per-user worker pool (when a worker starts and stops, what it may use) and the streaming proxy |
| `src/gateway/workerStart.ts` | what a worker sets up in its own folder as it starts |
| `src/gateway/limits.ts`, `endProcesses.ts` | a worker's caps and budgets; ending every process of a worker's uid |
| `src/gateway/appShell.ts`, `assets.ts`, `pages/` | the app's frontend and the gateway's own pages |
| `src/gateway/mail.ts` | Resend client and email texts |
| `src/server/hostedMode.ts` | what a hosted worker refuses |
| `src/server/hostedToken.ts`, `src/server/git/hostedCredential.ts` | a worker's side of the token socket, and git's credential helper that uses it |
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

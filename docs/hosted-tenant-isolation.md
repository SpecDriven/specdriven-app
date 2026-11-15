# Hosted tenant isolation: proposal

**Status:** 2026-11-15. Step 1 is built, with tests, and not yet deployed.
Steps 2 and 3 are proposals.

This is a plan for keeping people apart more firmly in the hosted app
(`private.specdriven.app`, described in
[Hosted SpecDriven on Railway](deployment-railway.md)). A **tenant** here is
one signed-in person together with their worker, their folder and their
secrets.

## Summary

Today each person's worker runs as its own Linux user (uid), with its own
folder and an environment built from scratch. That is a real wall, and it is
the only one. Everything else assumes that a worker never runs code its
tenant controls.

The proposal keeps one worker per person and adds walls around it, in three
steps:

1. **Close the gaps inside the current container.** Small changes to the
   gateway and to how hosted git runs. No new moving parts.
2. **Separate privileges and browser origins.** The part of the gateway that
   faces the internet stops being root, and the account and admin pages move
   to their own host name.
3. **Make a stolen token worth little.** Replace long-lived personal access
   tokens with one-hour tokens for a single repository.

A container per tenant is held back until the hosted app runs coding agents
or plugins. [Alternatives held back](#alternatives-held-back) says why.

## The threat to design for

**A worker is taken over through the repository it opens.** A person chooses
which GitHub repository their worker clones, and everything in it is theirs
to shape: file names, symlinks, markdown, images. The app then runs `git` on
it and reads and writes files inside it.

The attacker does not have to be the account's owner. A specs repository is
shared by a team, so **a teammate with push access can plant content that
another member's worker opens**. The design should hold even when one worker
is fully under an attacker's control.

Three things should stay true in that case:

- the attacker reads no other tenant's files or secrets;
- the attacker cannot change the gateway, its database or the app's code;
- the attacker cannot stop the service for everyone else.

## Where the wall was thin before step 1

These come from reading the code. None of them was tried against the running
service.

| # | What | Where | What it allows |
|---|---|---|---|
| 1 | The gateway, as root, writes and then changes the owner of `home/.gitconfig`, a path inside a folder the tenant owns. Both calls follow symlinks. | `writeGitIdentity` in `src/gateway/workers.ts` | A worker under attack replaces `.gitconfig` with a symlink to `/app/src/index.ts`. On the next start, root overwrites that file and hands it to the attacker's uid. That file is the code every other worker runs. |
| 2 | The same pattern, milder: root changes the owner of the settings file after writing it, and checks a file with `lstat` before reading it in a separate step. | `seedWorkerRepos`, `readWorkerRepos` in `src/gateway/repos.ts` | The tenant can swap the file between the two steps. |
| 3 | Root creates folders, runs `chown -R` and deletes the socket under the tenant's top folder, which the tenant owns and can rearrange. | `prepareDirs`, `start` in `src/gateway/workers.ts` | Root acts on a path the tenant chose. |
| 4 | Stopping a worker signals one process. | `stop` in `src/gateway/workers.ts` | A process the worker started and detached keeps running after sign-out, a password reset or a changed token, with the old token still in its environment. |
| 5 | Hosted mode runs the system `git` on the tenant's repository with no restriction on hooks, the file-system monitor setting or symlinks. | `src/server/git/cli.ts` | One write into `.git/config` or `.git/hooks` turns into code that runs on every later git command. |
| 6 | The checks on feature, page and image paths look at the names only. They do not notice a folder that is really a symlink. | `safe` in `src/server/features.ts`, `src/server/pages.ts` | A symlink committed to the repository sends a read or a write somewhere else the worker's uid can reach, `.git` included. |
| 7 | No limits on memory, number of processes or disk. Every worker's folder and `app.db` share one volume. | `src/gateway/workers.ts` | One tenant can fill the volume, and then the gateway cannot write its database for anyone. |
| 8 | Workers share `/tmp` and the container's network. | `PASSTHROUGH` in `src/gateway/workers.ts` | A worker can call the gateway on localhost with an `X-Forwarded-For` header of its choosing, which the rate limits trust. It can reach other services on Railway's private network, and any host on the internet. |
| 9 | The gateway runs as root, answers the internet, and holds the master key, the datastore token and the mail key in one process. | `src/gateway/index.ts` | A single bug in request handling exposes everything. |
| 10 | The app, the account page and the admin page share one browser origin. Worker responses are forwarded with their headers, and plugin scripts come from the worker. | `src/gateway/proxy.ts`, `isWorkerPath` in `src/gateway/appShell.ts` | A worker under attack can serve script that calls `/auth/secrets/*` and `/auth/admin/*` with the person's session. If that person is an admin, the attacker can allow new sign-ups and make admins. It can also set the session cookie. |
| 11 | The GitHub token is a personal access token that lasts months and sits in the worker's environment. People often give it more than one repository. | `workerEnv` in `src/gateway/workers.ts` | Whoever takes over a worker gets everything that token can reach, for as long as it lasts. |

Rows 1, 4, 5 and 6 mattered most together: 5 and 6 are how a worker could be
taken over, 4 let the attacker stay, and 1 turned one tenant's worker into
everyone's.

**After step 1:**

- Rows 1 to 6 are closed.
- Row 7 is closed for processes, open files and a full volume. A disk and a
  memory budget per person exist and are off until set.
- Row 8 is closed for temp files and open for the network.
- Row 10 is closed for cookies and API answers, and open for plugin scripts,
  which still come from the worker.
- Rows 9 and 11 are open. Steps 2 and 3 are for those.

## Target design

```
Browser
 ├─ account.private.specdriven.app ─▶ gateway (not root): sign-in, secrets, admin
 └─ private.specdriven.app ─────────▶ gateway (not root): app pages, /api proxy
                                          │ unix socket: start / stop / status
                                          ▼
                                      spawner (root, no network, no HTTP)
                                          │ own uid + limits + file and network rules
                                          ▼
                       worker per person: own folder, own tmp, no stored token
                                          │ the only way out
                                          ▼
                                 outbound proxy ─▶ GitHub only
```

## Step 1: close the gaps inside the current container

Built. No new services and no change for the people using the app.

| Change | Closes | Where |
|---|---|---|
| **Root never opens a path the tenant can rearrange.** Root owns each person's top folder (`/data/users/<id>`); the tenant owns only `home`, `root`, `repos`, `run` and `tmp` inside it, and root never opens anything below those. A volume from before this is brought in line when each worker next starts. | 1, 2, 3 | `prepareDirs` in `src/gateway/workers.ts` |
| **The worker sets its own git author** from `SPECDRIVEN_ACCOUNT_EMAIL` as it starts. The gateway's write is gone. | 1 | `src/gateway/workerStart.ts` |
| **The worker writes its own remembered repositories.** The gateway passes the urls in the environment, and the worker writes its settings file if it has none. | 2 | `src/gateway/workerStart.ts` |
| **The gateway reads a worker's settings as that worker's uid.** This differs from the first draft, which asked the worker over its socket: a worker that has stopped or crashed cannot answer, and its repositories are noted then too. | 2 | `readWorkerRepos` in `src/gateway/repos.ts` |
| **Stopping a worker ends every process of its uid**, on a stop, on a restart even when no worker is running, and before every start. | 4 | `endProcessesOf` in `src/gateway/workers.ts`, `src/gateway/endProcesses.ts` |
| **Hosted git runs with fixed settings on every command:** `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `core.symlinks=false`, and `protocol.allow=never` with only https and http allowed (http for a stand-in GitHub in development). The bundled engine is given no way to make a symlink. | 5, 6 | `HOSTED_GIT_CONFIG` in `src/server/git/cli.ts`, `plainFileSystem` in `src/server/git/nodeFs.ts` |
| **No symlink exists in a hosted worker's repositories.** This also differs from the first draft, which checked every read and write: some fifty modules open files directly, so there is no one place to check. Instead git never makes a symlink (the row above), the hosted app has no feature that makes one, and a worker replaces any left in an older clone with a plain file when it starts. | 6 | `replaceSymlinks` in `src/gateway/workerStart.ts` |
| **Caps per worker.** `prlimit` caps processes and open files; since each tenant has its own uid, the process cap is per tenant. No worker starts while the volume's free space is under a floor kept for `app.db`. | 7 | `workerCommand`, `checkRoom` in `src/gateway/workers.ts` |
| **Budgets per person, off until set.** The sweep measures each running worker's folder and memory and stops one that is over. The numbers are not decided (see the open questions), so `SPECDRIVEN_WORKER_MAX_DISK_MB` and `SPECDRIVEN_WORKER_MAX_MEMORY_MB` have no default. | 7 | `enforceBudgets` in `src/gateway/workers.ts`, `src/gateway/limits.ts` |
| **A temp folder per tenant:** `TMPDIR` points inside the person's own folder. | 8 (part) | `workerEnv` in `src/gateway/workers.ts` |
| **The proxy cleans what a worker sends back:** it drops every `Set-Cookie`, and an API answer carries a policy that stops it running as a page. | 10 (part) | `src/gateway/proxy.ts` |

**Left for step 2:** a Content-Security-Policy on the app's own pages. The
frontend has an inline script, uses WebAssembly and starts workers from
blobs, and plugin scripts come from the worker on the same origin. A policy
strict enough to matter needs a run through every screen in a browser, and
it protects little until the account pages are on their own host.

The tests are in `tests/gatewayWorkers.test.ts`, `tests/gatewayLimits.test.ts`,
`tests/gatewayWorkerStart.test.ts`, `tests/hostedGit.test.ts` and
`tests/gatewayServer.test.ts`. The ones about uids need root and `setpriv`,
so they run in the hosted image and are skipped on a developer's machine.
One of them plants the symlinks from rows 1 to 3 and checks that root's
file is untouched.

## Step 2: separate privileges and origins

**Split the gateway in two.**

- A process that is **not root** answers HTTP, signs people in and holds the
  master key.
- A small **spawner**, the only part that stays root, listens on a unix
  socket and knows three requests: start a worker with this uid and this
  environment, stop it, report on it. It never parses HTTP and never touches
  the network.

A bug in request handling then no longer runs as root. Closes row 9.

**Two host names.**

- `account.private.specdriven.app` serves sign-in, the account page, the
  admin page and `/auth/*`. Its session cookie is the one that can change
  secrets and roles.
- `private.specdriven.app` serves the app and forwards to the worker. After
  sign-in the account host hands the browser over with a one-time code, and
  the app host sets a cookie of its own that can reach the worker and nothing
  else.

The app's pages also get a Content-Security-Policy here, tested screen by
screen. Script that a worker manages to serve then runs on a host with no
power over the account. The app's user menu, which reads `/auth/me` today, needs a small
endpoint on the app host that returns the email and role only. Closes row 10.

**Confine each worker's files and network.** Linux has two features a
process can apply to itself without being root: Landlock, which limits the
files and network ports a process may use, and seccomp, which limits the
system calls it may make. A small launcher applies both before starting the
worker:

- read-only access to the app's code and the system folders;
- write access to the worker's own folder and nowhere else, `/tmp` included;
- outbound connections to one local port only: a proxy the gateway runs,
  which lets through `github.com` and `api.github.com` and refuses the rest.

Workers already honour `HTTPS_PROXY`. Without the Landlock rule the proxy is
a convention a taken-over worker can ignore, so this item depends on the
check below. Closes row 8.

**Check Railway first.** Whether Railway's kernel offers Landlock, and with
network rules (Linux 6.7 or later), was not checked for this proposal. A
one-off deploy that prints the kernel version and tries a Landlock rule
settles it. If Landlock is missing, the file rules fall back to what the uid
already gives, and the network rule is the reason to bring forward the
[container per tenant](#alternatives-held-back).

## Step 3: make a stolen token worth little

**Replace personal access tokens with a GitHub App.**

- A person installs the SpecDriven GitHub App on their specs repository, once.
- When a worker needs to fetch or push, the gateway asks GitHub for a token
  that lasts one hour and covers that one repository.
- The token reaches git through a socket only that worker can open. The
  gateway knows which tenant is asking from the uid on the other end of the
  socket, which the worker cannot fake.

Nothing long-lived is stored for GitHub any more, so the master key and the
datastore repository protect much less. Whoever takes over a worker gets one
repository for at most an hour. Closes row 11.

Agent keys stay as they are, encrypted under the master key. A key of its
own per person, wrapped by the master key, would let deleting an account
make its stored secrets unreadable for good, including the copies in the
datastore repository's history.

## Alternatives held back

**A subdomain per tenant** (`<name>.private.specdriven.app`). It adds little
here: a worker only ever serves its own person, so one tenant's content is
never shown in another's browser session. The split that matters is between
the account host and the app host, in step 2. A subdomain per tenant becomes
worth it if a tenant grows into an organisation with several members.

**A Railway service per tenant**, created through Railway's API, each with
its own container and volume. This is a much stronger wall and the right
move on the day the hosted app runs coding agents or plugins, as
[Hosted SpecDriven on Railway](deployment-railway.md) already says. Until
then it costs:

- a slow first request while the service wakes;
- a volume and a service per person to pay for and clean up;
- a Railway API token in the gateway that can change the whole project;
- a new check in every worker, because services in one Railway project can
  reach each other's ports: the worker must accept only requests the gateway
  signed for that tenant.

## Open questions

- **Which GitHub App token?** A token for the installation is simplest, but
  the push is then recorded as the app's, with the person as commit author
  only. A token for the person (through the app, eight hours, renewable)
  keeps pushes theirs and needs a sign-in redirect to GitHub.
- **Budgets.** How much disk and memory one person gets, and what the app
  shows when a worker is stopped for going over.

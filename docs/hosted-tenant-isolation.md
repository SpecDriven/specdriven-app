# Hosted tenant isolation

**Status:** 2026-11-15. All three steps are built, with tests, and not yet
deployed. Step 2 needs two things done on Railway before it is all in force:
see [Deploying step 2](#deploying-step-2). Step 3 is off until a GitHub App
is registered and its three variables are set: see
[Deploying step 3](#deploying-step-3).

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

The plan keeps one worker per person and adds walls around it, in three
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

**After step 2:**

- Row 9 is closed: the process that answers the internet is not root.
- Row 10 is closed once the account pages have their own host name
  (`ACCOUNT_URL`). Until that is set they still share the app's host.
- Row 8 is closed where the kernel has Landlock with TCP rules, with one
  limit that Landlock itself sets: see
  [what the network rule cannot do](#what-the-network-rule-cannot-do).
- A twelfth row, found while building step 2 and closed by it: a worker owns
  the folder its socket is in, and `/proc/net/unix` shows every worker's
  socket path. A taken-over worker could put a link to another person's
  socket where its own belongs, and the gateway would have forwarded the
  attacker's own requests to that person's worker.
- Row 11 is open. Step 3 is for it.

**After step 3**, once the service has its GitHub App:

- Row 11 is closed for everyone who has connected GitHub. A worker holds no
  GitHub token. What its git is handed lasts an hour and reaches one
  repository, and ends when the worker stops.
- A person who has not connected yet keeps the token they pasted before,
  until they do. Connecting deletes it. No new token can be pasted.

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
                       worker per person: own folder, own tmp, no GitHub token
                          │ own socket: "a token for owner/repo"      │ the only way out
                          ▼                                           ▼
                       gateway ─▶ GitHub App: one hour, one repo   outbound proxy ─▶ GitHub only
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

**Left for step 2, and done there:** a Content-Security-Policy on the app's
own pages. The frontend has an inline script, uses WebAssembly and starts
workers from blobs, and plugin scripts come from the worker on the same
origin. A policy strict enough to matter needed a run through every screen
in a browser, and protects little until the account pages are on their own
host.

The tests are in `tests/gatewayWorkers.test.ts`, `tests/gatewayLimits.test.ts`,
`tests/gatewayWorkerStart.test.ts`, `tests/hostedGit.test.ts` and
`tests/gatewayServer.test.ts`. The ones about uids need root and `setpriv`,
so they run in the hosted image and are skipped on a developer's machine.
One of them plants the symlinks from rows 1 to 3 and checks that root's
file is untouched.

## Step 2: separate privileges and origins

Built. The first two parts change what runs; the last two need something of
the platform and are in force only where it is there.

| Change | Closes | Where |
|---|---|---|
| **The gateway is two processes.** The image starts as root, as before. That process is now the **spawner**: it readies the volume, starts the gateway as uid 199000, and from then on does three things when asked over a unix socket: start a person's worker, stop it, report on it. It parses no HTTP and opens no network connection. The **gateway** answers HTTP, signs people in and holds the master key, and is not root. | 9 | `src/gateway/spawnerMain.ts`, `spawner.ts`, `spawnerSocket.ts`, `main.ts` |
| **Nothing in a request picks what root does.** The gateway may be taken over, so the spawner checks every request: the user id must be a UUID, the uid a worker's (200000 and up, never root's or the gateway's), and the program is the one the spawner was started with. The worker's environment is the gateway's to choose, and no program that runs as root sees it: the tools that drop to the worker's uid get `PATH` alone, and the worker's environment is applied after the drop. | 9 | `checkStart` in `src/gateway/spawner.ts`, `src/gateway/launcher.ts` |
| **The spawner's socket takes one client.** A connection must first say a key the spawner made at start and handed only to the gateway, and a line that is not one of its messages ends the connection, with nothing after it read. This matters because the gateway connects to sockets in folders workers own. | 9 | `src/gateway/spawnerSocket.ts` |
| **The gateway has a folder of its own**, `/data/gateway`, for `app.db` and the datastore's clone. Root hands it over once and stays out of it afterwards. An older volume's files are moved in on the first start. | 9 | `src/gateway/volume.ts` |
| **Each worker asks every request for a key** the gateway made for that start. A request that reaches a worker through another worker's socket carries the wrong key and is refused. The gateway reaches a worker's socket as its own uid: the folder the socket is in belongs to the worker and the gateway's group, and to no other worker. | 12 | `workerKeyGuard` in `src/server/hostedMode.ts`, `prepareDirs` in `src/gateway/spawner.ts` |
| **Two host names**, when `ACCOUNT_URL` is set. The account host serves sign-in, the account page, the admin page and `/auth/*`; its session cookie is the one that can change secrets and roles. The app's host serves the app and each person's worker. A write must come from the page's own origin, so script shown on the app's host cannot write to the account host, with the person's cookies or without. | 10 | `handle` in `src/gateway/server.ts` |
| **A code that works once** takes a signed-in browser from the account host to the app's, where it gets a cookie of that host's own. The cookie reaches the person's worker and nothing else. The code works for a minute, and only with a secret the app's host left in that browser, so a code made for one browser cannot sign another one in. The app's session ends with the sign-in it came from. | 10 | `issueHandover`, `redeemHandover` in `src/gateway/sessions.ts` |
| **The app's host answers who is signed in, and no more:** `/_session/me` gives the email and role, which is what the user menu needs. `/auth/*` is not served there at all. | 10 | `sessionApi` in `src/gateway/server.ts` |
| **A Content-Security-Policy on the app's pages.** Only script from this host runs, the one inline script by its hash; no `eval`; nothing is sent to another host or framed by one. | 10 | `src/gateway/appCsp.ts` |
| **Each worker confines itself before it starts.** A launcher applies Landlock (the worker may read the system and the app's code, write its own five folders and nothing else, `/tmp` included, and connect to one TCP port) and seccomp (no call that reaches another process, a mount, a namespace or the kernel, and no socket but a unix one or plain TCP). Then it becomes the worker, which keeps every rule. | 8 | `src/gateway/launcher.ts`, `sandbox.ts` |
| **One way out.** The gateway runs a proxy on a local port that lets a connection through to `github.com` and `api.github.com` and refuses the rest. Git and the app's own requests go through it. That port is the one a worker may connect to. | 8 | `src/gateway/egress.ts` |

### How the policy on the app's pages was tried

Screen by screen, in a browser, with the policy enforced: the real build of
the app's pages behind a stand-in gateway, in front of the demo data. Each
screen below loaded and worked with no violation reported:

- the specs tree, a feature page, the scenario editor, Write and Preview;
- Settings, Project settings, Plugins, Observability, Data, Images, What's
  new, Updates;
- the Roadmap, Tasks, Notebook, Tests and Event models tabs, the last of
  them a plugin from the marketplace with its own script;
- the command palette, the coding agent pane, the user menu.

Two things came out of it:

- **The diagram editor's fonts** come from `esm.sh`, pinned to the library's
  version. The policy allows that one path, for fonts and for the fetch that
  puts them into an exported drawing. Nothing else outside the host is
  allowed.
- **Excalidraw's font subsetter asks for `eval`** when a drawing is
  exported. It is refused, and the drawing is still exported with its font.

The demo is not the hosted app: it shows more screens, not fewer. If a
screen turns out to be blocked in production, `SPECDRIVEN_APP_CSP=report`
sends the policy as report-only, where the browser's console says what would
be blocked and nothing is.

### What a second read of the code found

Before this was called done, the new code was read once more by a reviewer
who had not written it, looking only for ways in. It found no way to root.
It found five weaknesses, all fixed and each with a test:

- **A worker could stop the whole service.** A settings file filled with
  control characters made the spawner's answer longer than the gateway
  accepts on that socket, and the gateway, having lost the spawner, exits.
  The limit now fits the longest honest answer, and an answer over it fails
  that one request only.
- **The system-call filter looked at a socket's kind and not its protocol.**
  An MPTCP socket is a stream socket that Landlock's port rule does not
  cover. Only plain TCP passes now.
- **A process could end whatever was sent to end it.** Ending a uid's
  processes is done as that uid. On a kernel older than 6.12 a detached
  process looping on "end everything" could end that helper first and
  survive a stop. Root now checks afterwards and ends what is left itself.
  This one dates from step 1.
- **The outbound proxy had no limit.** It now holds at most 256 connections
  and closes one that does not say where it wants to go within 15 seconds.
- **The hand-over's secret could be planted** by script on the app's host
  once the real cookie had expired. The secret is now signed by the gateway,
  and one it did not make is never used. A worker's answer also no longer
  carries the header that lets a script become a service worker for the
  whole host.

### What differs from the proposal

- **The worker's key** was not in the proposal. It closes the twelfth row
  above.
- **The network rule is weaker than the proposal said.** See the next
  section.
- **Railway's kernel was not checked.** There was no way to do that from
  here without a deploy. Instead the service checks itself: at every start
  the spawner runs a throwaway process through the same launcher, has it try
  what a worker must and must not be able to do, and logs one line saying
  what held. `bun src/gateway/index.ts probe` prints the same line.

### What the network rule cannot do

A Landlock TCP rule names a port, not an address. So "the worker may connect
to the proxy's port" really means "to that port number on any host". Three
things follow:

- A worker cannot reach the gateway's own port, or another service on
  Railway's private network, unless that service happens to listen on the
  same port number. The proxy takes a free port at each start, so this is
  unlikely.
- A taken-over worker **can** still reach a host on the internet that
  listens on that port number. Its owner would have to learn the number
  first, and the only way out to tell them is through GitHub.
- It cannot use UDP at all: the seccomp filter refuses the socket. A worker
  needs none, since the proxy looks names up for it.

Sending data out through GitHub itself was always possible, since GitHub is
on the list. What the rule protects is the gateway and the private network.
A rule by address needs a network of its own per worker, which is the
[container per tenant](#alternatives-held-back).

### Deploying step 2

The split and the worker's key need nothing. The other two parts do:

1. **Read the first start's log.** The line starting `workers: a uid each;`
   says which kernel it found and what holds. It reads one of four ways:
   - `Landlock 4` or higher, `tried, and it holds`: everything is in force.
   - `Landlock 1` to `3`: files are confined and the proxy is a convention
     only.
   - `Landlock absent`: neither. The uid still keeps files apart, as after
     step 1.
   - `BROKEN`: a worker could not do something it must. Set
     `SPECDRIVEN_WORKER_SANDBOX=off` and report it.
2. **Add the account host.** Add `account.private.specdriven.app` as a
   second custom domain on the same Railway service, then set `ACCOUNT_URL`
   to it. Everyone signs in again. [Hosted SpecDriven on
   Railway](deployment-railway.md#the-account-host) has the steps.

The tests are in `tests/gatewaySpawner.test.ts`, `tests/gatewaySandbox.test.ts`,
`tests/gatewayEgress.test.ts`, `tests/gatewayHosts.test.ts` and
`tests/gatewayWorkers.test.ts`. As in step 1, the ones about uids and the
kernel run in the hosted image and are skipped on a developer's machine. One
starts the image's own entry point as root and checks that the process
listening is not root. Another starts a stand-in worker exactly as a real
one is started and has it try to read a file anyone may read, write to
`/tmp`, connect to a second port and reach a host that is not on the list.

## Step 3: make a stolen token worth little

Built. It replaces personal access tokens with a GitHub App of the
service's own, and is in force once that app is registered: see
[Deploying step 3](#deploying-step-3). Until then people paste a token as
before.

| Change | Closes | Where |
|---|---|---|
| **A person connects GitHub once**, on the account page. They are sent to GitHub and back, and the gateway learns which GitHub account is theirs. The token that sign-in produces is used for that one question and revoked at once. What is kept is an id and a login, and no secret. | 11 | `identify` in `src/gateway/githubApp.ts`, `githubCallback` in `src/gateway/server.ts`, `src/gateway/githubLinks.ts` |
| **Only the browser that set out comes back.** The trip to GitHub carries a secret that is signed for the account that started it and kept in that browser's cookie. A code GitHub made for someone else's sign-in, sent to this browser, links nothing. | 11 | `githubConnect`, `githubCallback` in `src/gateway/server.ts` |
| **Only the account page sets out, and one GitHub account is one person's here.** Setting out for GitHub is a write that must come from the account page itself, so a link, or a page a worker serves, cannot send a signed-in browser on that trip. A GitHub account that is connected to one hosted account is refused for another. | 11 | `githubConnect`, `githubCallback` in `src/gateway/server.ts`, `ownerOf` in `src/gateway/githubLinks.ts` |
| **A worker holds no GitHub token.** Its environment says who the person is on GitHub and where to ask. The pasted token is no longer handed over, and connecting deletes it. | 11 | `workerEnv` in `src/gateway/workers.ts` |
| **A token is made when git asks, for the one repository it asks for.** It lasts an hour. The gateway makes it only when the app is installed on that repository and the person's GitHub account has access to it there, and it can write only if the person can. A person who can only read gets a token that can only read. | 11 | `repositoryToken` in `src/gateway/githubApp.ts` |
| **What a person may reach is asked of GitHub each time a token is made**, never remembered. Access taken away on GitHub is gone here within the hour. The check goes by the account's id, since a login can pass to somebody else. | 11 | `repositoryToken` in `src/gateway/githubApp.ts` |
| **The token reaches git through a socket only that worker can open.** The spawner makes a sixth folder for each person, `gate`, which belongs to the gateway; only that worker's group may pass through it. The gateway listens there. Git's credential helper connects, names the repository, and hands git the answer. The token is never in the worker's environment or on disk. | 11 | `src/gateway/tokenSocket.ts`, `prepareDirs` in `src/gateway/spawner.ts`, `src/server/git/hostedCredential.ts` |
| **The gateway knows who is asking from the uid on the other end**, which the kernel reports and a worker cannot choose. Anyone else is hung up on before a byte is read: another worker cannot reach the socket at all, and root, which can, is not answered. | 11 | `peerUid` in `src/gateway/tokenSocket.ts` |
| **A worker's tokens end with it.** When a worker stops, for any reason, the gateway revokes what it gave it. Disconnecting GitHub stops the worker. | 4, 11 | `release` in `src/gateway/workers.ts`, `forget` in `src/gateway/githubLinks.ts` |
| **A worker cannot make the gateway ask GitHub without end.** A token is handed out again until its hour is nearly over, a refusal stands for a minute, and one person gets thirty questions to GitHub in ten minutes, however often their worker stops and starts. Everyone together gets two hundred. What stops a worker from the account page is limited too. | 7 | `RepoTokens` in `src/gateway/githubLinks.ts`, `authApi` in `src/gateway/server.ts` |
| **A refusal says the same thing either way**: the app is not installed on the repository, or the person has no access to it. Told apart, the two would tell a guesser which private repositories exist. | 11 | `repositoryToken` in `src/gateway/githubApp.ts` |
| **The token is for the repository GitHub named.** GitHub says which repository a token is for; one for any other is not handed on, the final token is asked for by that repository's id, and a repository that answers with a redirect, because it was renamed or moved, is not followed. | 11 | `mint` in `src/gateway/githubApp.ts` |

Nothing long-lived is stored for a person's GitHub any more, so the master
key and the datastore repository protect much less: agent keys only. Whoever
takes over a worker gets the repositories that person can reach, one at a
time, for at most an hour each, and only while the worker runs.

### What a second read of the code found

As in step 2, the new code was read once more by a reviewer who had not
written it, looking only for ways in. It found no way to another person's
files or to root. It found six weaknesses, all fixed and each with a test:

- **The count of questions to GitHub began again with every new worker.**
  An account holder could stop their worker from the account page in a
  loop, and a taken-over worker could simply exit, and use up the allowance
  at GitHub that every person shares. The count is now the person's and
  outlives the worker, there is one for everyone together, and the calls
  that stop a worker are limited.
- **A GitHub account could be connected to the wrong hosted account.**
  Someone sent another person's set-password link ends up signed in to
  that person's account, where a page the other person's worker serves
  could send the browser to GitHub and back. GitHub does not ask again
  about an app a person has already approved, so the attacker's account
  would have been handed the victim's repositories. Setting out is now a
  write from the account page itself, and a GitHub account that is already
  someone's here is refused. This closes it where the account pages have
  their own host; on one shared host a worker's page is the account page's
  own origin, which is why step 2 gives them two.
- **The two refusals differed**, and so told a guesser which private
  repositories exist in an organisation that installed the app.
- **Revoking was fired and forgotten.** A shutdown now waits a few seconds
  for GitHub to take the revocations, a failed one is logged, and a token
  whose repository the person can no longer reach is ended when that is
  found out.
- **A renamed repository's redirect was followed** when looking it up. It
  failed safely, but by luck of how the first token was scoped.
- **A worker still starting was not stopped at shutdown.**

### What is new to protect

The app's **private key** is now the one secret that reaches every
connected person's repositories: whoever holds it can make a token for any
repository the app is installed on. It is a variable of the service, like
the master key. It is never written to the volume or the datastore, and no
worker's environment has it. The gateway holds it, and step 2 is what keeps
the gateway apart from the workers.

### What differs from the proposal

- **A person connects their GitHub account**, which the proposal did not
  say. Installing the app on a repository does not tell the gateway who
  installed it: the number GitHub passes back afterwards can be typed in by
  anyone. Without a proven account, one person could ask for a token for a
  repository another person installed the app on.
- **A token is for the person as well as the repository.** The proposal
  gave one to whoever's worker asked for a repository the app was installed
  on. Now the person's own access on GitHub decides, each time.
- **The socket is one per worker**, in a folder of its own, and the uid on
  the other end is checked as well. The proposal had the uid alone. Two
  locks cost little here, and the folder keeps other workers from reaching
  the socket in the first place.
- **The open question is settled for the installation's token.** Only that
  kind lasts an hour and can be held to one repository. A push is recorded
  on GitHub as the app's; the commits in it are still the person's.

### What it does not do

- **A push shows the app's name** in GitHub's own record of who pushed. The
  commit author is the person.
- **A rule on GitHub that names people** (a branch only some may push to)
  sees the app, not the person. The gateway checks that the person may write
  to the repository, not to each branch.
- **A taken-over worker still reaches every repository its person can**,
  where the app is installed, by asking for each. It gets them one at a time
  and each token dies within the hour, or sooner when the worker stops.
- **An organisation's single sign-on and IP allow-list do not apply to the
  app's tokens.** A person GitHub would turn away for lack of a single
  sign-on session, but who is still a collaborator, gets a token through
  the app. The organisation's owner chose to install the app.
- **Someone knowingly signed in to another person's account** who presses
  Connect GitHub there connects their own GitHub account to it, unless it
  is connected somewhere already. The account page says who is signed in.
- **It was not tried against github.com.** Every call was checked against
  GitHub's documentation and runs in the tests against a stand-in. The first
  real connection is the first real test.

### Deploying step 3

1. **Register a GitHub App** under the organisation that runs the service
   (GitHub → Settings → Developer settings → GitHub Apps → New):
   - **Callback URL:** `<ACCOUNT_URL>/auth/github/callback`, or
     `<PUBLIC_URL>/auth/github/callback` while there is no account host.
   - **Setup URL** (optional): `<ACCOUNT_URL>/account`.
   - **Expire user authorization tokens:** on. **Request user authorization
     during installation:** off. **Webhook:** not active.
   - **Repository permissions:** Contents, read and write; Metadata, read.
     Nothing else.
   - **Where can it be installed:** any account, if people outside the
     organisation keep their specs under their own.
2. **Make a client secret and a private key** on the app's page. The key
   downloads as a `.pem` file.
3. **Set three variables** on the Railway service and redeploy:
   `SPECDRIVEN_GITHUB_APP_CLIENT_ID`, `SPECDRIVEN_GITHUB_APP_CLIENT_SECRET`
   and `SPECDRIVEN_GITHUB_APP_PRIVATE_KEY` (the file's whole text; its line
   ends may be written as `\n`, or the file given in base64). With some but
   not all of them set the gateway refuses to start.
4. **Each person** opens their account page, presses **Connect GitHub**, and
   installs the app on their specs repository from the link under it.
   Their pasted token is deleted when they connect.

The tests are in `tests/gatewayGithubApp.test.ts`,
`tests/gatewayGithubConnect.test.ts`, `tests/gatewayTokenSocket.test.ts` and
`tests/gatewayWorkerGithub.test.ts`. One starts the real app as a worker
with no GitHub token of any kind and has it open a repository on a stand-in
GitHub that lets in the hour's token only; in the hosted image that worker
is also confined as in step 2. Another, in the hosted image only, has the
gateway's uid listen in the folder the spawner made and asks as the worker's
uid, as another worker's, and as root.

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

- **Budgets.** How much disk and memory one person gets, and what the app
  shows when a worker is stopped for going over.

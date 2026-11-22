// Automates git-operations.md "a spec folder that cannot be pushed to opens
// read only" (issue #467): a spec folder whose git repository has no remote,
// or whose remote turns this computer's pushes down, is reported read only —
// at GET /api/repo-access when the folder opens, and with the feature listing
// on every tick after — and a remote that did not answer leaves it editable.
//
// The refusal is a real one: the origin's receive-pack is a script that says
// what GitHub says over ssh to an account without write access, ASCII host
// key and all (`VisualHostKey yes`), and exits as GitHub does. Nothing about
// it is mocked inside git; a dry-run push meets it exactly as it would meet
// github.com.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { handleApi } from "../src/server/api";
import { forgetWriteAccess, readOnlyReason, setGitEngine, writeAccessOf } from "../src/server/git";
import { WRITE_CHECK_REF, withoutHostKeyArt, withoutUserinfo, writeRefusal } from "../src/server/git/cli";
import { jsCheckWrite } from "../src/server/git/js";
import { writeState } from "../src/server/state";
import { installFakeGh } from "./helpers/binPath";
import type { FakeGh } from "./helpers/binPath";
import { gitEngines } from "./helpers/engines";
import { git, twoClones } from "./helpers/fixtures";

let root: string;
let home: string;
let fakeGh: FakeGh | null = null;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-readonly-repo-"));
  // An empty home keeps the developer's own settings and sign-in out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-readonly-repo-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  fakeGh?.restore();
  fakeGh = null;
  setGitEngine(null);
  forgetWriteAccess();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Reported = { kind: string; remote?: string; reason?: string } | null;

/** What the page hears when the folder opens — or, with POST, on Check again. */
async function repoAccess(method: "GET" | "POST" = "GET"): Promise<Reported> {
  const res = await handleApi(new Request("http://localhost/api/repo-access", { method }));
  expect(res!.status).toBe(200);
  return ((await res!.json()) as { readOnly: Reported }).readOnly;
}

/** What the feature listing says with every tick. */
async function listedReadOnly(): Promise<Reported> {
  const res = await handleApi(new Request("http://localhost/api/features"));
  expect(res!.status).toBe(200);
  return ((await res!.json()) as { readOnlyRepo: Reported }).readOnlyRepo;
}

/** GitHub's answer over ssh to an account that may read but not write, with the host key drawn. */
const GITHUB_SSH_REFUSAL = [
  "Host key fingerprint is SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
  "+---[ECDSA 256]---+",
  "|       .o=X*+ .o.|",
  "|      . O.o.=  ..|",
  "+----[SHA256]-----+",
  "ERROR: Write access to repository not granted.",
];

/** Make a clone's origin answer pushes the way GitHub does when write access is not granted. */
async function refuseWrites(clone: string): Promise<void> {
  const script = join(root, "refuse-receive-pack.sh");
  const lines = GITHUB_SSH_REFUSAL.map((line) => `echo '${line}' >&2`).join("\n");
  await writeFile(script, `#!/bin/sh\n${lines}\nexit 128\n`);
  await chmod(script, 0o755);
  await git(clone, "config", "remote.origin.receivepack", script);
}

/** The refs the origin holds, to prove a check sent nothing. */
async function originRefs(originDir: string): Promise<string> {
  return (await $`git -C ${originDir} show-ref`.quiet()).stdout.toString();
}

for (const engine of gitEngines()) {
  describe(`git engine: ${engine}`, () => {
    beforeEach(() => {
      if (engine === "gh") fakeGh = installFakeGh();
      setGitEngine(engine);
    });

    test("a git repository with no remote opens read only", async () => {
      const data = join(root, "data");
      await mkdir(join(data, "specs"), { recursive: true });
      await $`git init -q -b main ${data}`.quiet();
      await writeFile(join(data, "specs", "seed.feature.md"), "# Seed\n");
      await git(data, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "seed");
      await writeState({ dataRepo: "data" }, root);

      expect(await repoAccess()).toEqual({ kind: "no-remote" });
      expect(await listedReadOnly()).toEqual({ kind: "no-remote" });

      // A remote added later is found by Check again.
      const { originDir } = await twoClones(join(root, "elsewhere"));
      await git(data, "remote", "add", "origin", originDir);
      expect(await repoAccess("POST")).toBeNull();
      expect(await listedReadOnly()).toBeNull();
    });

    test("a remote that takes pushes leaves the folder editable and is sent nothing", async () => {
      const { originDir } = await twoClones(root);
      await writeState({ dataRepo: "a" }, root);
      const before = await originRefs(originDir);

      expect(await repoAccess()).toBeNull();
      expect(await listedReadOnly()).toBeNull();
      expect(await originRefs(originDir)).toBe(before);
      expect(await originRefs(originDir)).not.toContain(WRITE_CHECK_REF);
    });

    test("a folder that is no git repository of its own stays editable", async () => {
      await mkdir(join(root, "plain", "specs"), { recursive: true });
      await writeState({ dataRepo: "plain" }, root);

      expect(await repoAccess()).toBeNull();
    });

    test("a remote that does not answer leaves the folder editable", async () => {
      const { originDir } = await twoClones(root);
      await writeState({ dataRepo: "a" }, root);
      // Offline, as far as git can tell: the remote is not there to ask.
      await rename(originDir, `${originDir}.away`);

      expect(await repoAccess()).toBeNull();
    });
  });
}

// The bundled engine has no dry-run push and reaches a local path through the
// file system, so the refusal below is for the two engines that run git; its
// own check, over https, is covered against a stand-in host further down.
for (const engine of gitEngines().filter((e) => e !== "js")) {
  describe(`git engine: ${engine}`, () => {
    beforeEach(() => {
      if (engine === "gh") fakeGh = installFakeGh();
      setGitEngine(engine);
    });

    test("a remote that refuses this account's pushes opens the folder read only, in the remote's words", async () => {
      const { a, originDir } = await twoClones(root);
      await refuseWrites(a);
      await writeState({ dataRepo: "a" }, root);

      const reported = await repoAccess();
      expect(reported?.kind).toBe("denied");
      expect(reported?.remote).toBe(originDir);
      expect(reported?.reason).toContain("ERROR: Write access to repository not granted.");
      // The ssh host key's ASCII art is not part of the reason shown.
      expect(reported?.reason).not.toContain("Host key fingerprint");
      expect(reported?.reason).not.toContain("+---[ECDSA 256]---+");
      expect(await listedReadOnly()).toEqual(reported);

      // Write access granted: Check again makes the folder editable.
      await git(a, "config", "--unset", "remote.origin.receivepack");
      expect(await repoAccess("POST")).toBeNull();
      expect(await listedReadOnly()).toBeNull();
    });
  });
}

for (const engine of gitEngines().filter((e) => e !== "js")) {
  describe(`git engine: ${engine}`, () => {
    beforeEach(() => {
      if (engine === "gh") fakeGh = installFakeGh();
      setGitEngine(engine);
    });

    test("an answer stands until Check again asks the remote afresh", async () => {
      const { a } = await twoClones(root);
      expect(readOnlyReason(await writeAccessOf(a, { wait: true }))).toBeNull();
      await refuseWrites(a);
      // The answer the folder opened with stands for the ticks after it…
      expect(readOnlyReason(await writeAccessOf(a))).toBeNull();
      // …until the page asks again.
      expect(readOnlyReason(await writeAccessOf(a, { wait: true, fresh: true }))?.kind).toBe("denied");
      expect(readOnlyReason(await writeAccessOf(a))?.kind).toBe("denied");
    });

    test("a credential written into the remote url never reaches the page", async () => {
      const { a, originDir } = await twoClones(root);
      await refuseWrites(a);
      await git(a, "remote", "set-url", "origin", `file://user:s3cret@localhost${originDir}`);
      const reported = readOnlyReason(await writeAccessOf(a, { wait: true }));
      expect(reported?.kind).toBe("denied");
      expect(JSON.stringify(reported)).not.toContain("s3cret");
      expect(withoutUserinfo("https://x-access-token:ghp_abc@github.com/o/r.git")).toBe("https://github.com/o/r.git");
      expect(withoutUserinfo("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    });
  });
}

describe("what a failed write check says", () => {
  test("GitHub's refusals over ssh and https are a no, in git's words", () => {
    const ssh = writeRefusal("git@github.com:o/r.git", `${GITHUB_SSH_REFUSAL.join("\n")}\nfatal: Could not read from remote repository.`);
    expect(ssh).toMatchObject({ kind: "denied", remote: "git@github.com:o/r.git" });
    expect(ssh.kind === "denied" && ssh.reason.startsWith("ERROR: Write access to repository not granted.")).toBe(true);

    const https = writeRefusal(
      "https://github.com/o/r",
      "remote: Permission to o/r.git denied to someone.\nfatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403",
    );
    expect(https.kind).toBe("denied");
  });

  test("a credential problem is a no with the sign-in hint", () => {
    const res = writeRefusal("https://github.com/o/r", "fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    expect(res.kind).toBe("denied");
    expect(res.kind === "denied" && res.reason).toContain("authentication required");
  });

  test("a network that is down says nothing about access", () => {
    expect(writeRefusal("https://github.com/o/r", "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com").kind).toBe(
      "unknown",
    );
    expect(
      writeRefusal("/gone", "fatal: '/gone' does not appear to be a git repository\nfatal: Could not read from remote repository.").kind,
    ).toBe("unknown");
  });

  test("ssh's host key art is taken out of what git said and nothing else is", () => {
    const said = `${GITHUB_SSH_REFUSAL.join("\n")}\nfatal: Could not read from remote repository.`;
    expect(withoutHostKeyArt(said)).toBe(
      "ERROR: Write access to repository not granted.\nfatal: Could not read from remote repository.",
    );
    const plain = "|just a line|\n+---+";
    expect(withoutHostKeyArt(plain)).toBe(plain);
  });
});

describe("the bundled engine asks the push's first request", () => {
  /** A stand-in git host answering receive-pack's refs with `status`. */
  function host(status: number, body = "") {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(new URL(req.url).pathname + new URL(req.url).search);
        return new Response(body, { status });
      },
    });
    return { url: `http://127.0.0.1:${server.port}/o/r.git`, seen, stop: () => server.stop(true) };
  }

  test("200 takes pushes, asked at the receive-pack refs", async () => {
    const h = host(200);
    try {
      expect(await jsCheckWrite("/repo", "origin", h.url)).toEqual({ kind: "writable" });
      expect(h.seen).toEqual(["/o/r.git/info/refs?service=git-receive-pack"]);
    } finally {
      h.stop();
    }
  });

  test("401 is a no with the sign-in hint, 403 a no in the host's words", async () => {
    const unauthorized = host(401);
    const forbidden = host(403, "Permission to o/r.git denied to someone.");
    try {
      const a = await jsCheckWrite("/repo", "origin", unauthorized.url);
      expect(a.kind).toBe("denied");
      expect(a.kind === "denied" && a.reason).toContain("authentication required");
      const b = await jsCheckWrite("/repo", "origin", forbidden.url);
      expect(b.kind).toBe("denied");
      expect(b.kind === "denied" && b.reason).toContain("Permission to o/r.git denied to someone.");
    } finally {
      unauthorized.stop();
      forbidden.stop();
    }
  });

  test("a host that cannot be reached, or a credential in the url, says nothing", async () => {
    const h = host(200);
    const url = h.url;
    h.stop();
    expect((await jsCheckWrite("/repo", "origin", url)).kind).toBe("unknown");
    expect((await jsCheckWrite("/repo", "origin", "https://user:secret@example.com/o/r.git")).kind).toBe("unknown");
  });
});

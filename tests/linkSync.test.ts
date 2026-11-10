// specs/ui/navigation.feature.md "a link opens on synced data": the folder
// is pulled before a link from outside is resolved, and a page the link does
// not find is reported by what the app knows.
import { test, expect, describe } from "bun:test";
import { missedFeatureNote, pullProblemOf, syncForLink } from "../src/frontend/linkSync";

const FILE = "specs/ui/test-plan.feature.md";

function fetcher(status: number, body: unknown, calls: string[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("syncForLink", () => {
  test("a link runs one sync tick before it is resolved", async () => {
    const calls: string[] = [];
    expect(await syncForLink(fetcher(200, { message: "Already up to date." }, calls))).toBeNull();
    expect(calls).toEqual(["POST /api/reload"]);
  });

  test("a pull that failed is handed back as the reason", async () => {
    const problem = "fatal: unable to access 'https://example.test/x.git/': Could not resolve host";
    expect(await syncForLink(fetcher(200, { message: problem, pullProblem: problem }))).toBe(problem);
  });

  test("a tick that failed outright is the reason too", async () => {
    expect(await syncForLink(fetcher(502, { error: "clone failed" }))).toBe("clone failed");
  });

  test("a server with nothing to sync does not hold the link up", async () => {
    // The read-only site refuses the POST; that is not a failed pull.
    expect(await syncForLink(fetcher(403, { error: "read-only" }))).toBeNull();
  });

  test("an unreachable server does not throw", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await syncForLink(down)).toBeNull();
  });
});

describe("pullProblemOf", () => {
  test("reads the problem off an answer, and nothing else", () => {
    expect(pullProblemOf({ pullProblem: " no route to host \n" })).toBe("no route to host");
    expect(pullProblemOf({ pullProblem: "" })).toBeNull();
    expect(pullProblemOf({ message: "Already up to date." })).toBeNull();
    expect(pullProblemOf(null)).toBeNull();
  });
});

describe("missedFeatureNote", () => {
  test("a file that is not there in a synced folder is a stale link", () => {
    expect(missedFeatureNote(FILE, 404)).toBe(`Feature "${FILE}" not found — the link may be stale.`);
  });

  test("a miss behind a failed pull names the pull, not the link", () => {
    const note = missedFeatureNote(FILE, 404, {
      pullProblem: "fatal: unable to access 'https://example.test/x.git/'\nmore detail",
    });
    expect(note).toContain("could not be synced");
    expect(note).toContain("fatal: unable to access");
    expect(note).not.toContain("more detail");
    expect(note).not.toContain("stale");
  });

  test("any other answer is reported as what it is", () => {
    expect(missedFeatureNote(FILE, 409, { error: "data repo not configured" })).toBe(
      `Could not open feature "${FILE}": data repo not configured.`,
    );
    expect(missedFeatureNote(FILE, 500)).toBe(`Could not open feature "${FILE}" (server answered 500).`);
  });
});

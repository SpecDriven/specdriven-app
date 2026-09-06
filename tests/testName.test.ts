// specs/external-links/test-traceability.feature.md "the test name is read
// from the code on GitHub": a `[test: … ]` url names a line in a file; the
// test function declared there is read through the GitHub API and stored
// as the reference's name. Line patterns per language, the anchor-to-
// declaration rule, the ref/path split of a blob url, and the API route
// against a stub GitHub on loopback. No network, no real GitHub.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../src/server/api";
import { signOut } from "../src/server/auth";
import {
  declaredTest,
  fetchTestSource,
  languageOf,
  parseTestUrl,
  resolveTestName,
  testNameAt,
} from "../src/server/testName";
import { createFileBackend, saveToken, setTokenBackend } from "../src/server/tokenStore";

const JAVA_URL =
  "https://github.com/SpecDriven/insurance-cap-java/blob/main/srv/src/test/java/com/acme/insurance/policy/QuoteHomeownersPolicyTest.java#L32";

describe("the url of a test", () => {
  test("a blob url with a line anchor names owner, repo, ref-and-path and line", () => {
    expect(parseTestUrl(JAVA_URL)).toEqual({
      owner: "SpecDriven",
      repo: "insurance-cap-java",
      segments: ["main", "srv", "src", "test", "java", "com", "acme", "insurance", "policy", "QuoteHomeownersPolicyTest.java"],
      line: 32,
    });
    expect(parseTestUrl("https://www.github.com/o/r/blob/dev/t.py?plain=1#L3-L9")?.line).toBe(3);
    expect(parseTestUrl("  https://github.com/o/r/blob/feature/x/t.go#L1  ")?.segments).toEqual(["feature", "x", "t.go"]);
  });

  test("anything else is not one: no anchor, no blob, another host, no path", () => {
    expect(parseTestUrl("https://github.com/o/r/blob/main/t.py")).toBeNull();
    expect(parseTestUrl("https://github.com/o/r/blob/main/t.py#readme")).toBeNull();
    expect(parseTestUrl("https://github.com/o/r/tree/main/t.py#L3")).toBeNull();
    expect(parseTestUrl("https://gitlab.com/o/r/blob/main/t.py#L3")).toBeNull();
    expect(parseTestUrl("https://github.com/o/r/blob/main#L3")).toBeNull();
    expect(parseTestUrl("")).toBeNull();
  });

  test("the language follows the file extension", () => {
    expect(languageOf("Foo.java")).toBe("java");
    expect(languageOf("Foo.kt")).toBe("kotlin");
    expect(languageOf("foo.test.ts")).toBe("javascript");
    expect(languageOf("foo.spec.jsx")).toBe("javascript");
    expect(languageOf("test_foo.py")).toBe("python");
    expect(languageOf("foo_test.go")).toBe("go");
    expect(languageOf("Foo.rb")).toBeNull();
    expect(languageOf("Makefile")).toBeNull();
  });
});

describe("what a line declares", () => {
  test("Java methods, not calls or locals", () => {
    expect(declaredTest("    void quotesAHomeownersPolicy() {", "java")).toBe("quotesAHomeownersPolicy");
    expect(declaredTest("  public void quotesAHomeownersPolicy() throws Exception {", "java")).toBe("quotesAHomeownersPolicy");
    expect(declaredTest("  static List<String> names(int n) {", "java")).toBe("names");
    expect(declaredTest("  private Optional<Map<String, Integer>> lookup(String k) {", "java")).toBe("lookup");
    expect(declaredTest("    assertEquals(1, quote.size());", "java")).toBeNull();
    expect(declaredTest("    String s = compute(x);", "java")).toBeNull();
    expect(declaredTest("    return new Quote(x);", "java")).toBeNull();
    expect(declaredTest("    if (x) {", "java")).toBeNull();
    expect(declaredTest("  @Test", "java")).toBeNull();
  });

  test("Kotlin functions, backticked names included", () => {
    expect(declaredTest("    fun quotesAHomeownersPolicy() {", "kotlin")).toBe("quotesAHomeownersPolicy");
    expect(declaredTest("    @Test fun `quotes a homeowners policy`() {", "kotlin")).toBeNull();
    expect(declaredTest("    fun `quotes a homeowners policy`() {", "kotlin")).toBe("quotes a homeowners policy");
    expect(declaredTest("    override suspend fun <T> run(block: () -> T) {", "kotlin")).toBe("run");
    expect(declaredTest("    val x = fun() {}", "kotlin")).toBeNull();
  });

  test("JavaScript and TypeScript test titles, functions and methods", () => {
    expect(declaredTest('test("only GitHub urls are test links", () => {', "javascript")).toBe("only GitHub urls are test links");
    expect(declaredTest("  it('adds', async () => {", "javascript")).toBe("adds");
    expect(declaredTest("  test.only(`with ${x} inside`, () => {", "javascript")).toBe("with ${x} inside");
    expect(declaredTest('  test.each(rows)("row %s", (r) => {', "javascript")).toBe("row %s");
    expect(declaredTest('Deno.test("deno style", () => {', "javascript")).toBe("deno style");
    expect(declaredTest("export async function testQuote() {", "javascript")).toBe("testQuote");
    expect(declaredTest("  async quotesAHomeownersPolicy(): Promise<void> {", "javascript")).toBe("quotesAHomeownersPolicy");
    expect(declaredTest("  if (ready) {", "javascript")).toBeNull();
    expect(declaredTest('describe("a group", () => {', "javascript")).toBeNull();
    expect(declaredTest("  expect(x).toBe(1);", "javascript")).toBeNull();
    expect(declaredTest("  const y = compute(x);", "javascript")).toBeNull();
  });

  test("Python defs and Go funcs", () => {
    expect(declaredTest("def test_quotes_a_homeowners_policy():", "python")).toBe("test_quotes_a_homeowners_policy");
    expect(declaredTest("    async def test_async(self) -> None:", "python")).toBe("test_async");
    expect(declaredTest("    assert quote == 1", "python")).toBeNull();
    expect(declaredTest("func TestQuotesAHomeownersPolicy(t *testing.T) {", "go")).toBe("TestQuotesAHomeownersPolicy");
    expect(declaredTest("func (s *Suite) TestQuote(t *testing.T) {", "go")).toBe("TestQuote");
    expect(declaredTest('\tt.Run("sub", func(t *testing.T) {', "go")).toBeNull();
  });
});

describe("the declaration a line anchor names", () => {
  const java = [
    "package com.acme;",
    "",
    "class QuoteHomeownersPolicyTest {",
    "",
    "    @Test",
    '    @DisplayName("quotes a homeowners policy")',
    "    void quotesAHomeownersPolicy() {",
    "        Quote q = quote(house);",
    "        assertEquals(120, q.premium());",
    "    }",
    "",
    "    // the other one",
    "    @Test",
    "    void rejectsAnEmptyAddress() {",
    "        assertThrows(IllegalArgumentException.class, () -> quote(empty));",
    "    }",
    "}",
  ].join("\n");

  test("an anchor on the annotation names the method under it", () => {
    expect(testNameAt(java, 5, "java")).toBe("quotesAHomeownersPolicy");
    expect(testNameAt(java, 6, "java")).toBe("quotesAHomeownersPolicy");
    expect(testNameAt(java, 12, "java")).toBe("rejectsAnEmptyAddress");
  });

  test("an anchor on the declaration or inside the body names that test", () => {
    expect(testNameAt(java, 7, "java")).toBe("quotesAHomeownersPolicy");
    expect(testNameAt(java, 9, "java")).toBe("quotesAHomeownersPolicy");
    expect(testNameAt(java, 15, "java")).toBe("rejectsAnEmptyAddress");
  });

  test("an anchor above every test, or a blank line under one, still finds the nearest", () => {
    // Line 4 is blank: the @Test right under it leads to the first method.
    expect(testNameAt(java, 4, "java")).toBe("quotesAHomeownersPolicy");
    // Line 11 is blank between tests: the comment and @Test lead down to the second.
    expect(testNameAt(java, 11, "java")).toBe("rejectsAnEmptyAddress");
    // Line 10 closes the first test: nothing declares below within reach, so the one above.
    expect(testNameAt(java, 10, "java")).toBe("quotesAHomeownersPolicy");
  });

  test("a line out of range, or a file with no test near it, names nothing", () => {
    expect(testNameAt(java, 0, "java")).toBeNull();
    expect(testNameAt(java, 99, "java")).toBeNull();
    expect(testNameAt("package x;\n\nclass Empty {}\n", 1, "java")).toBeNull();
  });

  test("a TypeScript anchor inside a test's body names its title", () => {
    const ts = [
      'import { test, expect } from "bun:test";',
      "",
      'describe("quotes", () => {',
      '  test("prices a homeowners policy", () => {',
      "    expect(quote(house)).toBe(120);",
      "  });",
      "});",
    ].join("\n");
    expect(testNameAt(ts, 5, "javascript")).toBe("prices a homeowners policy");
    expect(testNameAt(ts, 3, "javascript")).toBe("prices a homeowners policy");
  });

  test("a Python decorator and a Go comment lead to the declaration under them", () => {
    const py = "@pytest.mark.slow\ndef test_slow():\n    assert True\n";
    expect(testNameAt(py, 1, "python")).toBe("test_slow");
    expect(testNameAt(py, 3, "python")).toBe("test_slow");
    const go = "// TestQuote checks pricing.\nfunc TestQuote(t *testing.T) {\n\tt.Run(\"sub\", func(t *testing.T) {})\n}\n";
    expect(testNameAt(go, 1, "go")).toBe("TestQuote");
    expect(testNameAt(go, 3, "go")).toBe("TestQuote");
  });
});

// --- Reading the file from GitHub ---------------------------------------------

let server: ReturnType<typeof Bun.serve> | null = null;
/** Raw file text by `path?ref=…` as GitHub's contents endpoint would answer. */
let files: Record<string, string> = {};
let seen: { path: string; accept: string | null; auth: string | null }[] = [];
const savedApi = process.env.SPECDRIVEN_GITHUB_API_URL;
const savedPath = process.env.PATH;
let root: string;

function stubGitHub(): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname + url.search, accept: req.headers.get("accept"), auth: req.headers.get("authorization") });
      const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
      const key = m ? `${m[1]}/${m[2]}:${decodeURIComponent(m[3]!)}?ref=${url.searchParams.get("ref")}` : "";
      const body = files[key];
      if (body === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      return new Response(body, { headers: { "Content-Type": "application/vnd.github.raw" } });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

describe("reading the test's source from GitHub", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "specdriven-testname-"));
    setTokenBackend(createFileBackend(join(root, "token.json")));
    process.env.SPECDRIVEN_GITHUB_API_URL = stubGitHub();
    // An empty PATH keeps the machine's gh (and its token) out of the test.
    process.env.PATH = "";
    files = {};
    seen = [];
  });

  afterEach(async () => {
    await signOut();
    server?.stop(true);
    server = null;
    setTokenBackend(createFileBackend());
    if (savedApi === undefined) delete process.env.SPECDRIVEN_GITHUB_API_URL;
    else process.env.SPECDRIVEN_GITHUB_API_URL = savedApi;
    process.env.PATH = savedPath ?? "";
    await rm(root, { recursive: true, force: true });
  });

  const JAVA = "class T {\n    @Test\n    void quotesAHomeownersPolicy() {\n    }\n}\n";

  test("the file is fetched raw through the contents endpoint, with the sign-in token", async () => {
    await saveToken({ token: "tok-123", login: "octo", name: null, email: null, id: 1 });
    files["acme/app:src/test/T.java?ref=main"] = JAVA;
    const text = await fetchTestSource(parseTestUrl("https://github.com/acme/app/blob/main/src/test/T.java#L2")!);
    expect(text).toBe(JAVA);
    expect(seen).toEqual([
      { path: "/repos/acme/app/contents/src/test/T.java?ref=main", accept: "application/vnd.github.raw+json", auth: "Bearer tok-123" },
    ]);
  });

  test("a branch name with slashes is found by trying longer refs until GitHub knows one", async () => {
    files["acme/app:t/T.java?ref=feature/quotes"] = JAVA;
    const text = await fetchTestSource(parseTestUrl("https://github.com/acme/app/blob/feature/quotes/t/T.java#L2")!);
    expect(text).toBe(JAVA);
    expect(seen.map((s) => s.path)).toEqual([
      "/repos/acme/app/contents/quotes/t/T.java?ref=feature",
      "/repos/acme/app/contents/t/T.java?ref=feature%2Fquotes",
    ]);
  });

  test("the name comes back for a file GitHub has", async () => {
    files["acme/app:src/test/T.java?ref=main"] = JAVA;
    expect(await resolveTestName("https://github.com/acme/app/blob/main/src/test/T.java#L2")).toEqual({
      name: "quotesAHomeownersPolicy",
    });
    expect(await resolveTestName("https://github.com/acme/app/blob/main/src/test/T.java#L4")).toEqual({
      name: "quotesAHomeownersPolicy",
    });
  });

  test("every way of finding nothing is a reason, not an error", async () => {
    const missing = await resolveTestName("https://github.com/acme/app/blob/main/src/test/T.java#L2");
    expect(missing.name).toBeNull();
    expect(missing.reason).toContain("no such");
    files["acme/app:src/test/T.java?ref=main"] = JAVA;
    const far = await resolveTestName("https://github.com/acme/app/blob/main/src/test/T.java#L40");
    expect(far.name).toBeNull();
    expect(far.reason).toContain("line 40");
    files["acme/app:t.rb?ref=main"] = "def x; end";
    const ruby = await resolveTestName("https://github.com/acme/app/blob/main/t.rb#L1");
    expect(ruby.name).toBeNull();
    expect(ruby.reason).toContain("t.rb");
    const shape = await resolveTestName("https://github.com/acme/app/blob/main/t.py");
    expect(shape.name).toBeNull();
    expect(shape.reason).toContain("#L<line>");
  });

  test("GET /api/test-name answers the name, a reason, or 400 for a url of the wrong shape", async () => {
    files["acme/app:src/test/T.java?ref=main"] = JAVA;
    const ok = await handleApi(
      new Request(`http://localhost/api/test-name?url=${encodeURIComponent("https://github.com/acme/app/blob/main/src/test/T.java#L3")}`),
    );
    expect(ok!.status).toBe(200);
    expect(await ok!.json()).toEqual({ name: "quotesAHomeownersPolicy" });

    const none = await handleApi(
      new Request(`http://localhost/api/test-name?url=${encodeURIComponent("https://github.com/acme/app/blob/main/src/test/Other.java#L3")}`),
    );
    expect(none!.status).toBe(200);
    const body = (await none!.json()) as { name: string | null; reason: string };
    expect(body.name).toBeNull();
    expect(body.reason).toContain("no such");

    const bad = await handleApi(
      new Request(`http://localhost/api/test-name?url=${encodeURIComponent("https://github.com/acme/app/blob/main/src/test/T.java")}`),
    );
    expect(bad!.status).toBe(400);
    expect(((await bad!.json()) as { error: string }).error).toContain("#L<line>");
    expect((await handleApi(new Request("http://localhost/api/test-name")))!.status).toBe(400);
  });
});

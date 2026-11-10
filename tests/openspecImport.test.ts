// Automates specs/external-links/openspec-import.feature.md: an OpenSpec
// spec.md read into its requirements and scenarios, planned as a feature
// file the feature parser reads back unchanged, and the two routes — the
// capabilities a code repository's openspec/specs holds, and the import that
// writes one feature per capability, skips one already imported and never
// reads openspec/changes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { writeState } from "../src/server/state";
import { parseFeature } from "../src/server/parser";
import {
  featureNameFromCapability,
  findOpenSpecSpecs,
  parseOpenSpec,
  planOpenSpecImport,
  safeMarkdown,
  scenarioCount,
} from "../src/server/openspecImport";

const AUTH = `# Auth Specification

## Purpose
Authentication and session management for the application.

## Requirements

### Requirement: User Authentication
The system SHALL issue a JWT token upon successful login.

#### Scenario: Valid credentials
- GIVEN a user with valid credentials
- WHEN the user submits login form
- THEN a JWT token is returned
- AND the user is redirected to dashboard

#### Scenario: Invalid credentials
- **WHEN** the user submits invalid credentials
- **THEN** an error message is displayed

### Requirement: Session Expiration
The system MUST expire sessions after 30 minutes of inactivity.
`;

const PAYMENTS = `# Payments

## Purpose
Taking payments.

## Requirements

### Requirement: Card payments
The system SHALL accept card payments.

#### Scenario: Card accepted
- WHEN a valid card is charged
- THEN the order is paid
`;

/** A delta spec from a change in flight: must never be imported. */
const DELTA = `## ADDED Requirements

### Requirement: Two-factor
The system SHALL ask for a second factor.

#### Scenario: Code sent
- WHEN the user signs in
- THEN a code is sent
`;

describe("parseOpenSpec", () => {
  test("reads the title, purpose, requirements with their statements, and scenarios", () => {
    const doc = parseOpenSpec(AUTH);
    expect(doc.title).toBe("Auth Specification");
    expect(doc.purpose).toBe("Authentication and session management for the application.");
    expect(doc.requirements.map((r) => r.name)).toEqual(["User Authentication", "Session Expiration"]);
    expect(doc.requirements[0]!.statement).toBe("The system SHALL issue a JWT token upon successful login.");
    expect(doc.requirements[0]!.scenarios.map((s) => s.name)).toEqual(["Valid credentials", "Invalid credentials"]);
    expect(doc.requirements[0]!.scenarios[0]!.body).toBe(
      [
        "- GIVEN a user with valid credentials",
        "- WHEN the user submits login form",
        "- THEN a JWT token is returned",
        "- AND the user is redirected to dashboard",
      ].join("\n"),
    );
    expect(doc.requirements[1]!.scenarios).toEqual([]);
    expect(scenarioCount(doc)).toBe(3);
  });

  test("a heading inside a code fence is text, and other headings stay in what they sit in", () => {
    const doc = parseOpenSpec(
      [
        "## Requirements",
        "### Requirement: Config",
        "The system SHALL read config.",
        "#### Scenario: File",
        "- WHEN the file is",
        "```md",
        "#### Scenario: not one",
        "```",
        "##### Notes",
        "Some note.",
      ].join("\n"),
    );
    expect(doc.requirements).toHaveLength(1);
    expect(doc.requirements[0]!.scenarios).toHaveLength(1);
    expect(doc.requirements[0]!.scenarios[0]!.body).toContain("#### Scenario: not one");
    expect(doc.requirements[0]!.scenarios[0]!.body).toContain("##### Notes");
  });

  test("lenient — Requirement headings without a Requirements section, CRLF, a bare ### under Requirements", () => {
    const doc = parseOpenSpec("### Requirement: A\r\nText A\r\n## Requirements\r\n### B\r\nText B\r\n");
    expect(doc.requirements.map((r) => [r.name, r.statement])).toEqual([
      ["A", "Text A"],
      ["B", "Text B"],
    ]);
  });
});

describe("planOpenSpecImport", () => {
  test("one proposed scenario per OpenSpec scenario, the requirement quoted on top, in OpenSpec's order", () => {
    const plan = planOpenSpecImport("auth", "openspec/specs/auth/spec.md", AUTH);
    expect(plan.name).toBe("Auth");
    expect(plan.scenarios).toEqual([
      "User Authentication - Valid credentials",
      "User Authentication - Invalid credentials",
      "Session Expiration",
    ]);
    const feature = parseFeature(plan.text);
    expect(feature.name).toBe("Auth");
    expect(feature.description).toBe(
      "_Imported from OpenSpec `openspec/specs/auth/spec.md`._\n\nAuthentication and session management for the application.",
    );
    expect(feature.scenarios.map((s) => [s.name, s.version, s.status])).toEqual([
      ["User Authentication - Valid credentials", 1, "proposed"],
      ["User Authentication - Invalid credentials", 1, "proposed"],
      ["Session Expiration", 1, "proposed"],
    ]);
    expect(feature.scenarios[0]!.body).toStartWith("> The system SHALL issue a JWT token upon successful login.\n\n- GIVEN");
    // A requirement without scenarios is one scenario holding its statement, unquoted.
    expect(feature.scenarios[2]!.body).toBe("The system MUST expire sessions after 30 minutes of inactivity.");
    expect(plan.text).toContain("## S1: User Authentication - Valid credentials @v1 [proposed]");
  });

  test("lines the feature parser would lift out stay in the body; headings become bold", () => {
    const plan = planOpenSpecImport(
      "x",
      "openspec/specs/x/spec.md",
      [
        "## Requirements",
        "### Requirement: R",
        "#### Scenario: S",
        "- WHEN it runs",
        "[test: a test : https://example.com/t.ts]",
        "[ff:beta:on]",
        "[Jira:ABC-1](https://example.atlassian.net/browse/ABC-1)",
        "**Assigned:** pat",
        "[negative]",
        "##### Detail",
      ].join("\n"),
    );
    const s = parseFeature(plan.text).scenarios[0]!;
    expect(s.tests).toEqual([]);
    expect(s.flags).toBeUndefined();
    expect(s.negative).toBeFalsy();
    expect(s.body).toContain("\\[test: a test");
    expect(s.body).toContain("\\[ff:beta:on]");
    expect(s.body).toContain("\\[Jira:ABC-1]");
    expect(s.body).toContain("**Detail**");
    expect(safeMarkdown("```\n[test: x : https://e.com]\n```")).toBe("```\n[test: x : https://e.com]\n```");
  });

  test("names — the capability folder title-cased, nested capabilities keep their folders, repeats told apart", () => {
    expect(featureNameFromCapability("user-auth")).toBe("User Auth");
    expect(featureNameFromCapability("billing/invoice_runs")).toBe("Invoice Runs");
    expect(planOpenSpecImport("billing/invoices", "p", "").name).toBe("billing/Invoices");
    const plan = planOpenSpecImport(
      "x",
      "p",
      "### Requirement: R / Q\n#### Scenario: S @v2 [published]\n#### Scenario: S\n",
    );
    expect(plan.scenarios).toEqual(["R - Q - S", "R - Q - S (2)"]);
    expect(parseFeature(plan.text).scenarios.map((s) => s.name)).toEqual(["R - Q - S", "R - Q - S (2)"]);
  });
});

// --- The routes --------------------------------------------------------------------

let root: string;
let data: string;
let code: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHosted = process.env.SPECDRIVEN_HOSTED;

const put = async (base: string, rel: string, text: string) => {
  await mkdir(dirname(join(base, rel)), { recursive: true });
  await writeFile(join(base, rel), text);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-openspec-"));
  process.env.SPECDRIVEN_ROOT = root;
  data = join(root, "data");
  code = join(root, "code");
  await mkdir(join(data, "specs"), { recursive: true });
  await put(data, "project-settings.json", JSON.stringify({ "code-repos": ["../code"] }));
  await put(code, "openspec/specs/auth/spec.md", AUTH);
  await put(code, "openspec/specs/payments/spec.md", PAYMENTS);
  await put(code, "openspec/changes/add-2fa/specs/auth/spec.md", DELTA);
  await put(code, "openspec/changes/add-2fa/proposal.md", "# Add 2FA\n");
  await writeState({ dataRepo: data }, root);
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOSTED", realHosted],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = (await handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  ))!;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("findOpenSpecSpecs", () => {
  test("lists each capability under openspec/specs and nothing from openspec/changes", async () => {
    await put(code, "openspec/specs/billing/invoices/spec.md", PAYMENTS);
    expect(await findOpenSpecSpecs(code)).toEqual([
      { capability: "auth", path: "openspec/specs/auth/spec.md" },
      { capability: "billing/invoices", path: "openspec/specs/billing/invoices/spec.md" },
      { capability: "payments", path: "openspec/specs/payments/spec.md" },
    ]);
    expect(await findOpenSpecSpecs(data)).toEqual([]);
  });
});

describe("GET /api/openspec/specs", () => {
  test("the default code repo's capabilities, with what each becomes and whether it is there", async () => {
    const res = await call("GET", "/api/openspec/specs?folder=security");
    expect(res.status).toBe(200);
    expect(res.body.repo).toBe(code);
    expect(res.body.repos).toEqual([{ path: "../code", dir: code, isDefault: true }]);
    expect(res.body.specs).toEqual([
      {
        capability: "auth",
        path: "openspec/specs/auth/spec.md",
        name: "Auth",
        fileName: "specs/security/auth.feature.md",
        exists: false,
        requirements: 2,
        scenarios: 3,
      },
      {
        capability: "payments",
        path: "openspec/specs/payments/spec.md",
        name: "Payments",
        fileName: "specs/security/payments.feature.md",
        exists: false,
        requirements: 1,
        scenarios: 1,
      },
    ]);
  });

  test("another folder can be typed; one without specs, or no code repo at all, says why", async () => {
    const other = join(root, "other");
    await put(other, "openspec/specs/search/spec.md", PAYMENTS);
    const typed = await call("GET", `/api/openspec/specs?repo=${encodeURIComponent(other)}`);
    expect(typed.body.repo).toBe(other);
    expect(typed.body.specs.map((s: { capability: string }) => s.capability)).toEqual(["search"]);

    const empty = await call("GET", `/api/openspec/specs?repo=${encodeURIComponent(data)}`);
    expect(empty.body.specs).toEqual([]);
    expect(empty.body.problem).toContain("No OpenSpec specs in");

    await put(data, "project-settings.json", "{}");
    const none = await call("GET", "/api/openspec/specs");
    expect(none.body.repo).toBeNull();
    expect(none.body.problem).toContain("No code repository in Project settings");
  });
});

describe("POST /api/openspec/import", () => {
  test("each chosen capability becomes a feature in the folder; a second import skips them", async () => {
    const first = await call("POST", "/api/openspec/import", {
      folder: "security",
      capabilities: ["auth", "payments"],
    });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      created: [
        { capability: "auth", fileName: "specs/security/auth.feature.md", title: "Auth", scenarios: 3 },
        { capability: "payments", fileName: "specs/security/payments.feature.md", title: "Payments", scenarios: 1 },
      ],
      skipped: [],
      failed: [],
    });
    const auth = parseFeature(await readFile(join(data, "specs/security/auth.feature.md"), "utf8"));
    expect(auth.scenarios.map((s) => s.name)).toEqual([
      "User Authentication - Valid credentials",
      "User Authentication - Invalid credentials",
      "Session Expiration",
    ]);
    // Nothing from the change in flight.
    expect(JSON.stringify(auth)).not.toContain("Two-factor");

    const listed = await call("GET", "/api/openspec/specs?folder=security");
    expect(listed.body.specs.map((s: { exists: boolean }) => s.exists)).toEqual([true, true]);

    const again = await call("POST", "/api/openspec/import", { folder: "security", capabilities: ["auth"] });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({
      created: [],
      skipped: [{ capability: "auth", fileName: "specs/security/auth.feature.md" }],
      failed: [],
    });
  });

  test("a capability the folder does not hold is not imported, and says why; nothing chosen is refused", async () => {
    const res = await call("POST", "/api/openspec/import", { capabilities: ["../changes/add-2fa/specs/auth"] });
    expect(res.status).toBe(200);
    expect(res.body.created).toEqual([]);
    expect(res.body.failed[0].error).toContain("No openspec/specs/../changes/add-2fa/specs/auth/spec.md");
    expect((await call("POST", "/api/openspec/import", { capabilities: [] })).status).toBe(400);
  });

  test("refused in the hosted app", async () => {
    process.env.SPECDRIVEN_HOSTED = "1";
    expect((await call("GET", "/api/openspec/specs")).status).toBe(403);
    expect((await call("POST", "/api/openspec/import", { capabilities: ["auth"] })).status).toBe(403);
  });
});

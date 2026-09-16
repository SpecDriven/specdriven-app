// Automates specs/editor/data-model-integration-in-editor.feature.md: the
// entity fields the editor offers after `@` + Tab come from the Java
// classes and SAP CDS entities in the project's code repo (project-
// settings.json `code-repo`), a field shared by two entities is offered
// prefixed by each entity's name, and GET /api/entity-fields serves the
// list — empty, not an error, when there is no code repo to read.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fieldChoices,
  parseCdsEntities,
  parseJavaEntities,
  resetEntitiesCache,
  scanEntities,
} from "../src/server/entities";
import { handleApi, reloader } from "../src/server/api";
import { PROJECT_SETTINGS_FILE } from "../src/server/members";
import { writeState } from "../src/server/state";

const byName = (entities: { name: string; fields: string[] }[]) =>
  Object.fromEntries(entities.map((e) => [e.name, e.fields]));

describe("parseJavaEntities", () => {
  test("reads the instance fields of a plain POJO, whatever their modifiers", () => {
    const src = `
      package acme;
      import java.util.List;
      public class Policy {
        private String policyNumber;
        protected final long premium = 0L;
        transient volatile int retries;
        public List<String> riders;
        Map<String, List<Integer>> tags;
        int[] a, b[];
        public Policy() {}
        public String getPolicyNumber() { return policyNumber; }
      }`;
    expect(byName(parseJavaEntities(src, "src/main/java/acme/Policy.java"))).toEqual({
      Policy: ["policyNumber", "premium", "retries", "riders", "tags", "a", "b"],
    });
  });

  test("keeps a field whose initializer opens a block, and skips what is inside it", () => {
    const src = `
      class Cfg {
        private Runnable hook = () -> { String local; return; };
        private final Map<String, String> m = new HashMap<>() {{ put("a", "b"); }};
        private int[] sizes = {1, 2, 3};
        private String name;
      }`;
    expect(byName(parseJavaEntities(src, "Cfg.java"))).toEqual({ Cfg: ["hook", "m", "sizes", "name"] });
  });

  test("leaves out constants, method locals, and abstract methods", () => {
    const src = `
      public abstract class Account {
        public static final int MAX = 3;
        private static Logger log;
        private String owner;
        abstract void close();
        void open(String who) {
          String tmp;
          int count = 0;
          if (who != null) { Object o; }
        }
      }`;
    expect(byName(parseJavaEntities(src, "Account.java"))).toEqual({ Account: ["owner"] });
  });

  test("ignores annotations, comments and strings, even ones holding braces and semicolons", () => {
    const src = `
      @Entity @Table(name = "users; {x}")
      public class User {
        // private String fromComment;
        /* private String fromBlock; } */
        @Column(name = "first", nullable = false) private String firstName;
        @Size(min = 1, max = 5)
        private String lastName;
        private String note = "a; b } { class Fake {";
        private String block = """
          multi; line }
          """;
        private char sep = ';';
      }`;
    expect(byName(parseJavaEntities(src, "User.java"))).toEqual({
      User: ["firstName", "lastName", "note", "block", "sep"],
    });
  });

  test("reads record components, and nested classes as entities of their own", () => {
    const src = `
      public record Point(int x, @Deprecated int y, List<String> labels, String... rest) {
        public Point { }
        static int origin() { return 0; }
      }
      class Outer {
        private String outerField;
        static class Inner { private Long innerField; }
        interface Shape { int sides(); }
        enum Color { RED, GREEN; private String hex; }
      }`;
    expect(byName(parseJavaEntities(src, "Point.java"))).toEqual({
      Point: ["x", "y", "labels", "rest"],
      Inner: ["innerField"],
      Outer: ["outerField"],
    });
  });

  test("declares nothing for a test file or a class named like a test", () => {
    const src = "class PolicyTest { private String subject; }";
    expect(parseJavaEntities(src, "src/test/java/PolicyTest.java")).toEqual([]);
    expect(parseJavaEntities(src, "src/main/java/PolicyTest.java")).toEqual([]);
    expect(parseJavaEntities("class Foo { private int x; }", "tests/Foo.java")).toEqual([]);
    expect(parseJavaEntities("package a;", "src/main/java/a/package-info.java")).toEqual([]);
  });

  test("never throws on unbalanced input", () => {
    expect(() => parseJavaEntities("class A { private int x; ", "A.java")).not.toThrow();
    expect(() => parseJavaEntities("}}} class { ;;; private", "A.java")).not.toThrow();
  });
});

describe("parseCdsEntities", () => {
  test("reads an entity's element names, associations and compositions included", () => {
    const src = `
      namespace acme.claims;
      using { cuid, managed } from '@sap/cds/common';
      entity Customers : cuid, managed {
        firstName : String(100);
        lastName  : String(100);
        email     : String;
        addresses : Composition of many Addresses on addresses.customer = $self;
        claims    : Association to many Claims on claims.customer = $self;
      }
      entity Addresses {
        key ID : UUID;
        street : String;
        customer : Association to Customers;
      }`;
    expect(byName(parseCdsEntities(src, "db/schema.cds"))).toEqual({
      Customers: ["firstName", "lastName", "email", "addresses", "claims"],
      Addresses: ["ID", "street", "customer"],
    });
  });

  test("drops annotations in every spelling, and reads structured and quoted elements", () => {
    const src = `
      @title: 'Claims; { entity Fake {'
      entity Claims {
        @title: 'Number' @readonly
        key ID : UUID;
        @(Common.Label: 'Amount', UI.Hidden: false)
        amount : Decimal(10, 2) @Measures.ISOCurrency: currency;
        @assert.range: [0, 100]
        score : Integer;
        @Common: { Text: name, TextArrangement: #TextOnly }
        status : String;
        ![order] : Integer;
        virtual total : Decimal;
        addr : { street : String; city : String; };
        contact { phone : String; };
        actions { action cancel(); }
      }`;
    expect(byName(parseCdsEntities(src, "db/schema.cds"))).toEqual({
      Claims: ["ID", "amount", "score", "status", "order", "total", "addr", "contact"],
    });
  });

  test("reads projections and selects from their column lists, aliases first", () => {
    const src = `
      using { acme.claims as db } from '../db/schema';
      service ClaimService {
        entity Claims as projection on db.Claims {
          key ID,
          claimant.name as claimantName,
          amount,
          author { name },
          count(*) as total,
          customer.email
        };
        entity Open as select from db.Claims { *, status } where status = 'open';
        entity All as projection on db.Claims;
        entity Some as projection on db.Claims excluding { amount };
        type Money : Decimal(10, 2);
        aspect Audited { changedBy : String; }
        extend entity db.Claims with { extra : String; }
        annotate db.Claims with { amount @title: 'x'; }
      }`;
    expect(byName(parseCdsEntities(src, "srv/service.cds"))).toEqual({
      Claims: ["ID", "claimantName", "amount", "author", "total", "customer_email"],
      Open: ["status"],
    });
  });

  test("ignores an entity in a comment, and never throws on unbalanced input", () => {
    expect(parseCdsEntities("// entity Fake { x : String; }\n/* entity Other { y : Int; } */", "a.cds")).toEqual([]);
    expect(() => parseCdsEntities("entity A { x : String;", "a.cds")).not.toThrow();
  });
});

describe("fieldChoices", () => {
  const user = { name: "User", file: "User.java", language: "java" as const, fields: ["firstName", "email"] };
  const claim = { name: "Claim", file: "db/schema.cds", language: "cds" as const, fields: ["amount", "email"] };

  test("offers a unique field bare, and a shared one prefixed by each entity", () => {
    expect(fieldChoices([user, claim]).map((c) => c.label)).toEqual([
      "@amount",
      "@Claim.email",
      "@firstName",
      "@User.email",
    ]);
  });

  test("says which entity and file each choice came from, and inserts its label", () => {
    const choice = fieldChoices([user, claim]).find((c) => c.label === "@Claim.email");
    expect(choice).toEqual({ label: "@Claim.email", insert: "@Claim.email", entity: "Claim", field: "email", file: "db/schema.cds" });
  });

  test("gives one row for a Java class and the CDS entity it maps", () => {
    const twin = { ...user, file: "db/schema.cds", language: "cds" as const };
    expect(fieldChoices([user, twin]).map((c) => c.label)).toEqual(["@User.email", "@User.firstName"]);
  });
});

describe("scanEntities", () => {
  let code: string;
  beforeEach(async () => {
    resetEntitiesCache();
    code = await mkdtemp(join(tmpdir(), "specdriven-entities-"));
    await mkdir(join(code, "src/main/java/acme"), { recursive: true });
    await mkdir(join(code, "src/test/java/acme"), { recursive: true });
    await mkdir(join(code, "target/classes"), { recursive: true });
    await mkdir(join(code, "db"), { recursive: true });
    await mkdir(join(code, ".hidden"), { recursive: true });
    await writeFile(join(code, "src/main/java/acme/Policy.java"), "package acme; class Policy { private String policyNumber; }");
    await writeFile(join(code, "src/test/java/acme/PolicyTest.java"), "class PolicyTest { private String skipped; }");
    await writeFile(join(code, "target/classes/Gen.java"), "class Gen { private String generated; }");
    await writeFile(join(code, ".hidden/Secret.java"), "class Secret { private String hidden; }");
    await writeFile(join(code, "db/schema.cds"), "entity Customers { key ID : UUID; email : String; }");
  });
  afterEach(async () => {
    await rm(code, { recursive: true, force: true });
  });

  test("reads every Java and CDS source, skipping tests, build output and hidden folders", async () => {
    const entities = await scanEntities(code);
    expect(entities.map((e) => `${e.name}:${e.file}`).sort()).toEqual([
      "Customers:db/schema.cds",
      "Policy:src/main/java/acme/Policy.java",
    ]);
  });

  test("picks up a file that changed since the last scan", async () => {
    expect(byName(await scanEntities(code)).Policy).toEqual(["policyNumber"]);
    await writeFile(
      join(code, "src/main/java/acme/Policy.java"),
      "package acme; class Policy { private String policyNumber; private long premium; }",
    );
    expect(byName(await scanEntities(code)).Policy).toEqual(["policyNumber", "premium"]);
  });

  test("scans a missing folder as nothing", async () => {
    expect(await scanEntities(join(code, "nope"))).toEqual([]);
  });
});

describe("GET /api/entity-fields", () => {
  let root: string;
  let home: string;
  let data: string;
  let code: string;
  const realRoot = process.env.SPECDRIVEN_ROOT;
  const realHome = process.env.SPECDRIVEN_HOME;

  beforeEach(async () => {
    resetEntitiesCache();
    root = await mkdtemp(join(tmpdir(), "specdriven-entity-api-"));
    home = await mkdtemp(join(tmpdir(), "specdriven-entity-api-home-"));
    process.env.SPECDRIVEN_ROOT = root;
    process.env.SPECDRIVEN_HOME = home;
    data = join(root, "data");
    code = join(root, "code");
    await mkdir(join(data, "specs"), { recursive: true });
    await mkdir(join(code, "db"), { recursive: true });
    await writeFile(join(code, "db/schema.cds"), "entity Customers { key ID : UUID; email : String; }\nentity Claims { key ID : UUID; amount : Decimal; }");
    await writeState({ dataRepo: data }, root);
  });

  afterEach(async () => {
    reloader.stop();
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

  const get = () =>
    handleApi(new Request("http://localhost/api/entity-fields")) as Promise<Response>;

  test("lists the code repo's fields, shared names prefixed by their entity", async () => {
    await writeFile(join(data, PROJECT_SETTINGS_FILE), JSON.stringify({ "code-repo": "../code" }));
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { codeRepo: string; entities: number; fields: { label: string }[] };
    expect(body.codeRepo).toBe(code);
    expect(body.entities).toBe(2);
    expect(body.fields.map((f) => f.label)).toEqual(["@amount", "@Claims.ID", "@Customers.ID", "@email"]);
  });

  test("offers nothing when the project names no code repo", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ codeRepo: null, entities: 0, fields: [] });
  });

  test("offers nothing when the code repo is not there", async () => {
    await writeFile(join(data, PROJECT_SETTINGS_FILE), JSON.stringify({ "code-repo": "../missing" }));
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ codeRepo: join(root, "missing"), entities: 0, fields: [] });
  });
});

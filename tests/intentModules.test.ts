// Automates specs/app/extract-specs-from-code.feature.md: the folders
// proposed for a code project's specifications, worked out from its build
// files and layout — JavaScript and TypeScript workspaces, Maven and Gradle
// modules, Java packages, Python packages and Django apps — with tests
// going to the code they test, installed and built folders left out, and
// the proposal capped for a large project.

import { describe, expect, test } from "bun:test";
import {
  analyseModules,
  flattenFolders,
  isExcludedPath,
  isTestPath,
  languageOf,
  MAX_FOLDER_DEPTH,
  MAX_FOLDERS,
  moduleFiles,
  ROOT_ID,
  type ProposedFolder,
  type RepoSnapshot,
} from "../src/server/intentModules";

const MANIFESTS = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "lerna.json",
  "tsconfig.json",
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
]);

/** A project from its files: a build file with its text, any other file with "" or a size. */
function project(name: string, tree: Record<string, string | number>): RepoSnapshot {
  const manifests: Record<string, string> = {};
  const files = Object.entries(tree).map(([path, value]) => {
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (typeof value === "string" && MANIFESTS.has(base)) manifests[path] = value;
    return { path, size: typeof value === "number" ? value : value.length || 100 };
  });
  return { name, files, manifests };
}

/** `n` source files in a folder. */
const many = (dir: string, n: number, ext = "ts"): Record<string, string> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/file${i}.${ext}`, ""]));

const names = (folders: readonly ProposedFolder[]) => folders.map((f) => f.name);
const byName = (folders: readonly ProposedFolder[], name: string) => flattenFolders(folders).find((f) => f.name === name)!;

describe("JavaScript and TypeScript workspaces", () => {
  test("npm workspaces become folders named after their packages", () => {
    const p = analyseModules(
      project("shop", {
        "package.json": '{"name":"shop","workspaces":["packages/*"]}',
        "packages/ui/package.json": '{"name":"@acme/web-ui","description":"The storefront"}',
        "packages/ui/src/index.tsx": "",
        "packages/api/package.json": '{"name":"@acme/api"}',
        "packages/api/src/server.ts": "",
        "packages/api/src/routes.test.ts": "",
      }),
    );
    expect(names(p.folders)).toEqual(["API", "Web UI"]);
    const ui = byName(p.folders, "Web UI");
    expect(ui).toMatchObject({
      id: "packages/ui",
      folder: "web-ui",
      source: "npm-workspace",
      reason: "npm workspace listed in package.json",
      description: "The storefront",
      languages: ["typescript"],
      files: 1,
      selected: true,
    });
    expect(byName(p.folders, "API")).toMatchObject({ files: 1, tests: 1 });
    expect(p.languages).toEqual(["typescript"]);
  });

  test("pnpm workspaces in several folders are grouped by folder", () => {
    const p = analyseModules(
      project("mono", {
        "package.json": '{"name":"mono"}',
        "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - libs/*\n",
        "apps/web/package.json": '{"name":"web"}',
        "apps/web/src/main.ts": "",
        "apps/admin/package.json": '{"name":"admin"}',
        "apps/admin/src/main.ts": "",
        "libs/core/package.json": '{"name":"core"}',
        "libs/core/index.ts": "",
        "libs/auth/package.json": '{"name":"auth"}',
        "libs/auth/index.ts": "",
      }),
    );
    expect(names(p.folders)).toEqual(["Apps", "Libs"]);
    expect(names(byName(p.folders, "Apps").children)).toEqual(["Admin", "Web"]);
    expect(byName(p.folders, "Web")).toMatchObject({
      folder: "apps/web",
      source: "pnpm-workspace",
      reason: "pnpm workspace listed in pnpm-workspace.yaml",
    });
    expect(byName(p.folders, "Apps")).toMatchObject({ source: "group", reason: "Folder holding 2 modules", selected: true });
  });

  test("Lerna packages, Nx projects and tsconfig references are modules too", () => {
    const p = analyseModules(
      project("tools", {
        "lerna.json": '{"packages":["modules/*"]}',
        "tsconfig.json": '{ "references": [{ "path": "./compiler" }] } // build order',
        "modules/cli/package.json": '{"name":"cli"}',
        "modules/cli/index.js": "",
        "compiler/index.ts": "",
        "services/mailer/project.json": "{}",
        "services/mailer/src/send.ts": "",
      }),
    );
    expect(flattenFolders(p.folders).map((f) => [f.name, f.source])).toEqual([
      ["Compiler", "tsconfig-reference"],
      ["CLI", "lerna"],
      ["Mailer", "nx"],
    ]);
  });

  test("a folder with a package.json of its own is a module without any workspace", () => {
    const p = analyseModules(
      project("app", {
        "client/package.json": '{"name":"client"}',
        "client/src/App.tsx": "",
        "server/package.json": '{"name":"server"}',
        "server/index.js": "",
      }),
    );
    expect(flattenFolders(p.folders).map((f) => [f.name, f.reason])).toEqual([
      ["Client", "Has its own package.json"],
      ["Server", "Has its own package.json"],
    ]);
    expect(p.languages).toEqual(["javascript", "typescript"]);
  });
});

describe("Maven and Gradle", () => {
  test("Maven modules are followed through the modules' own poms", () => {
    const p = analyseModules(
      project("shop", {
        "pom.xml": "<project><artifactId>shop</artifactId><packaging>pom</packaging><modules><module>billing</module><module>platform</module></modules></project>",
        "billing/pom.xml": "<project><parent><artifactId>shop</artifactId></parent><artifactId>billing-service</artifactId><description>Invoices</description></project>",
        "billing/src/main/java/com/acme/billing/Invoice.java": "",
        "billing/src/test/java/com/acme/billing/InvoiceTest.java": "",
        "platform/pom.xml": "<project><artifactId>platform</artifactId><packaging>pom</packaging><modules><module>security</module></modules></project>",
        "platform/security/pom.xml": "<project><artifactId>security</artifactId><name>Security Core</name></project>",
        "platform/security/src/main/java/com/acme/sec/Login.java": "",
      }),
    );
    expect(names(p.folders)).toEqual(["Billing Service", "Platform"]);
    expect(byName(p.folders, "Billing Service")).toMatchObject({
      id: "billing",
      source: "maven-module",
      reason: "Maven module listed in pom.xml",
      description: "Invoices",
      files: 1,
      tests: 1,
      languages: ["java"],
    });
    expect(byName(p.folders, "Security Core")).toMatchObject({
      folder: "platform/security-core",
      reason: "Maven module listed in platform/pom.xml",
    });
  });

  test("Gradle projects come from the settings file's includes", () => {
    const p = analyseModules(
      project("shop", {
        "settings.gradle.kts": 'rootProject.name = "shop"\ninclude(":app", ":libs:payments")\n',
        "app/build.gradle.kts": "",
        "app/src/main/java/com/acme/App.java": "",
        "libs/payments/build.gradle.kts": "",
        "libs/payments/src/main/java/com/acme/pay/Pay.java": "",
      }),
    );
    expect(flattenFolders(p.folders).map((f) => [f.name, f.source, f.reason])).toEqual([
      ["App", "gradle-project", "Gradle project included in settings.gradle.kts"],
      ["Payments", "gradle-project", "Gradle project included in settings.gradle.kts"],
    ]);
  });

  test("without a readable include, folders with a build.gradle are the projects", () => {
    const p = analyseModules(
      project("shop", {
        "settings.gradle": "rootDir.eachDir { include it.name }\n",
        "api/build.gradle": "",
        "api/src/main/java/a/Api.java": "",
        "worker/build.gradle": "",
        "worker/src/main/java/w/Worker.java": "",
      }),
    );
    expect(flattenFolders(p.folders).map((f) => [f.name, f.reason])).toEqual([
      ["API", "Has its own build.gradle"],
      ["Worker", "Has its own build.gradle"],
    ]);
  });

  test("a single Java module is split into the packages below its base package", () => {
    const base = "src/main/java/com/acme/shop";
    const p = analyseModules(
      project("shop", {
        "pom.xml": "<project><artifactId>shop</artifactId></project>",
        [`${base}/ShopApplication.java`]: "",
        [`${base}/billing/Invoice.java`]: "",
        [`${base}/billing/InvoiceService.java`]: "",
        [`${base}/orders/Order.java`]: "",
        [`${base}/common/Dates.java`]: "",
        "src/test/java/com/acme/shop/billing/InvoiceServiceTest.java": "",
        "src/test/java/com/acme/shop/OrderControllerIT.java": "",
      }),
    );
    expect(names(p.folders)).toEqual(["Billing", "Common", "Orders"]);
    expect(byName(p.folders, "Billing")).toMatchObject({
      id: `${base}/billing`,
      source: "java-package",
      reason: `Java package under ${base}`,
      files: 2,
      tests: 1,
      selected: true,
    });
    // A test named after a package goes with it; shared plumbing starts unticked.
    expect(byName(p.folders, "Orders").tests).toBe(1);
    expect(byName(p.folders, "Common").selected).toBe(false);
  });
});

describe("Python", () => {
  test("a src layout's package is split into its subpackages", () => {
    const p = analyseModules(
      project("shop", {
        "pyproject.toml": '[project]\nname = "shop"\n[tool.setuptools.packages.find]\nwhere = ["src"]\n',
        "src/shop/__init__.py": "",
        "src/shop/billing/__init__.py": "",
        "src/shop/billing/invoices.py": "",
        "src/shop/orders/__init__.py": "",
        "src/shop/orders/cart.py": "",
        "tests/test_billing.py": "",
        "tests/orders/test_cart.py": "",
        "tests/conftest.py": "",
      }),
    );
    expect(names(p.folders)).toEqual(["Billing", "Orders"]);
    expect(byName(p.folders, "Billing")).toMatchObject({
      source: "python-package",
      reason: "Python package in src/shop",
      files: 2,
      tests: 1,
      languages: ["python"],
    });
    expect(byName(p.folders, "Orders").tests).toBe(1);
  });

  test("Django apps are named as such", () => {
    const p = analyseModules(
      project("site", {
        "manage.py": "",
        "site_config/__init__.py": "",
        "site_config/settings.py": "",
        "billing/__init__.py": "",
        "billing/apps.py": "",
        "billing/models.py": "",
        "billing/tests/test_models.py": "",
        "orders/__init__.py": "",
        "orders/apps.py": "",
        "orders/views.py": "",
      }),
    );
    expect(flattenFolders(p.folders).map((f) => [f.name, f.source])).toEqual([
      ["Billing", "django-app"],
      ["Orders", "django-app"],
      ["Site Config", "python-package"],
    ]);
    expect(byName(p.folders, "Billing")).toMatchObject({ reason: "Django app in the project", files: 3, tests: 1 });
  });

  test("uv workspace members and folders with their own pyproject are modules", () => {
    const p = analyseModules(
      project("mono", {
        "pyproject.toml": '[tool.uv.workspace]\nmembers = ["packages/*"]\n',
        "packages/core/pyproject.toml": '[project]\nname = "mono-core"\n',
        "packages/core/core/__init__.py": "",
        "tools/lint/setup.py": 'setup(name="lint-tool")',
        "tools/lint/lint.py": "",
      }),
    );
    expect(flattenFolders(p.folders).map((f) => [f.name, f.reason])).toEqual([
      ["Mono Core", "uv workspace member listed in pyproject.toml"],
      ["Lint Tool", "Has its own setup.py"],
    ]);
  });
});

describe("projects without modules, and mixed ones", () => {
  test("a single-module project falls back to the folders under src", () => {
    const p = analyseModules(
      project("app", {
        "package.json": '{"name":"app"}',
        "src/index.ts": "",
        "src/api/routes.ts": "",
        "src/api/routes.test.ts": "",
        "src/ui/App.tsx": "",
        "src/utils/dates.ts": "",
        "scripts/release.ts": "",
        "scripts/seed.ts": "",
      }),
    );
    expect(flattenFolders(p.folders).map((f) => [f.name, f.reason, f.selected])).toEqual([
      ["Scripts", "Folder at the top of the project", false],
      ["API", "Folder under src", true],
      ["UI", "Folder under src", true],
      ["Utils", "Folder under src", false],
    ]);
    expect(byName(p.folders, "API")).toMatchObject({ files: 1, tests: 1 });
  });

  test("a project with no structure is one folder named after it", () => {
    const p = analyseModules(project("quick-script", { "main.py": "", "helpers.py": "", "README.md": "" }));
    expect(p.folders).toHaveLength(1);
    expect(p.folders[0]).toMatchObject({
      id: ROOT_ID,
      name: "Quick Script",
      folder: "quick-script",
      source: "root",
      reason: "The whole project",
      files: 2,
      selected: true,
    });
  });

  test("feature folders under src are proposed, not the folder that sorts them", () => {
    const p = analyseModules(
      project("app", {
        "src/main.ts": "",
        "src/features/cart/cart.ts": "",
        "src/features/checkout/pay.ts": "",
        "src/components/Button.tsx": "",
      }),
    );
    expect(names(p.folders)).toEqual(["Components", "Cart", "Checkout"]);
    expect(byName(p.folders, "Cart").reason).toBe("Folder under src/features");
  });

  test("a mixed project keeps each language's module", () => {
    const p = analyseModules(
      project("fullstack", {
        "frontend/package.json": '{"name":"frontend"}',
        "frontend/src/App.tsx": "",
        "backend/pom.xml": "<project><artifactId>backend</artifactId></project>",
        "backend/src/main/java/com/acme/Api.java": "",
        "ml/pyproject.toml": '[project]\nname = "ml"\n',
        "ml/ml/__init__.py": "",
        "ml/ml/train.py": "",
        "infra/main.go": "",
        "infra/deploy.sh": "",
      }),
    );
    expect(flattenFolders(p.folders).map((f) => [f.name, f.languages])).toEqual([
      ["Backend", ["java"]],
      ["Frontend", ["typescript"]],
      ["ML", ["python"]],
    ]);
    expect(p.languages).toEqual(["python", "java", "typescript"]);
    expect(p.skipped).toEqual([
      { what: "Go", files: 1 },
      { what: "Shell", files: 1 },
    ]);
  });

  test("code at the top of a project with modules gets a General folder", () => {
    const p = analyseModules(
      project("app", {
        "package.json": '{"name":"app","workspaces":["packages/*"]}',
        "packages/a/package.json": '{"name":"a"}',
        "packages/a/index.ts": "",
        "packages/b/package.json": '{"name":"b"}',
        "packages/b/index.ts": "",
        ...many("src", 6),
      }),
    );
    expect(names(p.folders)).toEqual(["A", "B", "General"]);
    expect(byName(p.folders, "General")).toMatchObject({ id: ROOT_ID, files: 6, selected: true, source: "root" });
  });

  test("a large module is split by its layout; a small one is not", () => {
    const p = analyseModules(
      project("mono", {
        "package.json": '{"workspaces":["packages/*"]}',
        "packages/big/package.json": '{"name":"big"}',
        ...many("packages/big/src/orders", 30),
        ...many("packages/big/src/billing", 30),
        "packages/small/package.json": '{"name":"small"}',
        ...many("packages/small/src/a", 3),
        ...many("packages/small/src/b", 3),
      }),
    );
    expect(names(byName(p.folders, "Big").children)).toEqual(["Billing", "Orders"]);
    expect(byName(p.folders, "Billing")).toMatchObject({ folder: "big/billing", files: 30 });
    expect(byName(p.folders, "Big").files).toBe(0);
    expect(byName(p.folders, "Small").children).toEqual([]);
    expect(byName(p.folders, "Small").files).toBe(6);
  });
});

describe("what is left out, and how much is proposed", () => {
  test("installed, built, generated and hidden folders are not read", () => {
    for (const path of [
      "node_modules/react/index.js",
      "packages/a/node_modules/x/y.js",
      "dist/bundle.js",
      "target/classes/A.class",
      "build/libs/app.jar",
      ".venv/lib/site.py",
      "src/generated/api.ts",
      "pkg.egg-info/PKG-INFO",
      ".github/workflows/ci.yml",
      "vendor/lib.py",
    ]) {
      expect(isExcludedPath(path)).toBe(true);
    }
    expect(isExcludedPath("src/build.ts")).toBe(false);
    expect(isExcludedPath("src/dist-tools/x.ts")).toBe(false);
    const p = analyseModules(
      project("app", { "src/a/x.ts": "", "src/b/y.ts": "", "node_modules/dep/index.js": "", "dist/a/x.js": "" }),
    );
    expect(p.sourceFiles).toBe(2);
    expect(names(p.folders)).toEqual(["A", "B"]);
  });

  test("tests are told by their folder or their name, and never get a folder", () => {
    for (const path of [
      "src/test/java/com/acme/A.java",
      "src/integrationTest/java/A.java",
      "src/api/__tests__/a.ts",
      "tests/unit/a.py",
      "src/a.test.tsx",
      "src/a.spec.js",
      "pkg/test_a.py",
      "pkg/a_test.py",
      "pkg/conftest.py",
      "src/main/java/acme/InvoiceTest.java",
      "e2e/login.ts",
    ]) {
      expect(isTestPath(path)).toBe(true);
    }
    expect(isTestPath("src/main/java/acme/Contest.java")).toBe(false);
    expect(isTestPath("src/testing.ts")).toBe(false);
    const p = analyseModules(project("app", { "src/a/x.ts": "", "src/b/y.ts": "", "tests/a/x.test.ts": "", "test/z.test.ts": "" }));
    expect(names(p.folders)).toEqual(["A", "B"]);
    expect(byName(p.folders, "A").tests).toBe(1);
  });

  test("a declaration file is not source, and other languages are not read", () => {
    expect(languageOf("src/a.d.ts")).toBeNull();
    expect(languageOf("src/a.mts")).toBe("typescript");
    expect(languageOf("src/App.vue")).toBe("javascript");
    expect(languageOf("main.go")).toBeNull();
    expect(languageOf("Makefile")).toBeNull();
  });

  test("more folders than the limit are proposed with the smallest unticked", () => {
    const tree: Record<string, string> = { "package.json": '{"workspaces":["packages/*"]}' };
    for (let i = 0; i < MAX_FOLDERS + 10; i++) {
      tree[`packages/p${i}/package.json`] = `{"name":"p${i}"}`;
      tree[`packages/p${i}/index.ts`] = "";
      if (i < MAX_FOLDERS) tree[`packages/p${i}/extra.ts`] = "";
    }
    const p = analyseModules(project("huge", tree));
    expect(p.truncated).toBe(true);
    expect(p.folders).toHaveLength(MAX_FOLDERS + 10);
    expect(p.folders.filter((f) => f.selected)).toHaveLength(MAX_FOLDERS);
    expect(byName(p.folders, `P${MAX_FOLDERS + 5}`).selected).toBe(false);
  });

  test("folders nest no deeper than the limit", () => {
    const tree: Record<string, string> = {};
    let dir = "";
    for (const name of ["a", "b", "c", "d", "e"]) {
      dir = dir ? `${dir}/${name}` : name;
      tree[`${dir}/package.json`] = `{"name":"${name}"}`;
      tree[`${dir}/index.ts`] = "";
    }
    const p = analyseModules(project("deep", tree));
    const depth = (f: ProposedFolder): number => 1 + Math.max(0, ...f.children.map(depth));
    expect(Math.max(...p.folders.map(depth))).toBe(MAX_FOLDER_DEPTH);
    // What was too deep stays with the folder above it.
    expect(byName(p.folders, "C").files).toBe(3);
  });

  test("a snapshot cut short says so", () => {
    expect(analyseModules({ ...project("app", { "a.ts": "" }), truncated: true }).truncated).toBe(true);
  });
});

describe("the files a folder owns", () => {
  test("every file belongs to one folder, the deepest that holds it", () => {
    const snapshot = project("shop", {
      "pom.xml": "<project><modules><module>billing</module></modules></project>",
      "billing/pom.xml": "<project><artifactId>billing</artifactId></project>",
      "billing/README.md": "",
      "billing/openapi.yaml": "",
      ...many("billing/src/main/java/com/acme/billing/invoices", 25, "java"),
      ...many("billing/src/main/java/com/acme/billing/payments", 25, "java"),
      "billing/src/main/java/com/acme/billing/BillingApp.java": "",
      "billing/src/test/java/com/acme/billing/invoices/InvoiceTest.java": "",
      "billing/src/test/java/com/acme/billing/PaymentsFlowIT.java": "",
    });
    const proposal = analyseModules(snapshot);
    const files = moduleFiles(snapshot);
    expect(flattenFolders(proposal.folders).map((f) => f.id)).toEqual([
      "billing",
      "billing/src/main/java/com/acme/billing/invoices",
      "billing/src/main/java/com/acme/billing/payments",
    ]);
    const billing = files.get("billing")!;
    expect(billing.source).toEqual(["billing/src/main/java/com/acme/billing/BillingApp.java"]);
    expect(billing.rest).toEqual(["billing/README.md", "billing/openapi.yaml", "billing/pom.xml"]);
    const invoices = files.get("billing/src/main/java/com/acme/billing/invoices")!;
    expect(invoices.source).toHaveLength(25);
    expect(invoices.tests).toEqual(["billing/src/test/java/com/acme/billing/invoices/InvoiceTest.java"]);
    expect(files.get("billing/src/main/java/com/acme/billing/payments")!.tests).toEqual([
      "billing/src/test/java/com/acme/billing/PaymentsFlowIT.java",
    ]);
    // No file twice.
    const all = [...files.values()].flatMap((f) => [...f.source, ...f.tests, ...f.rest]);
    expect(new Set(all).size).toBe(all.length);
    // The counts the proposal shows are these lists' lengths.
    for (const f of flattenFolders(proposal.folders)) {
      expect(f.files).toBe(files.get(f.id)!.source.length);
      expect(f.tests).toBe(files.get(f.id)!.tests.length);
      expect(f.modules).toEqual([f.id]);
    }
  });

  test("two folders of the same name get different spec folders", () => {
    const p = analyseModules(
      project("app", {
        "client/package.json": '{"name":"core"}',
        "client/index.ts": "",
        "server/package.json": '{"name":"core"}',
        "server/index.ts": "",
      }),
    );
    expect(p.folders.map((f) => f.folder)).toEqual(["core", "core-2"]);
  });
});

// Automates specs/app/extract-specs-from-code.feature.md: what each build
// file says about a project's modules — npm, pnpm and Lerna workspaces,
// tsconfig references, Maven modules, Gradle includes, and where a Python
// project keeps its packages — read from the file's text, with a file that
// does not parse answering with nothing.

import { describe, expect, test } from "bun:test";
import {
  globMatches,
  matchWorkspaceGlobs,
  readGradleSettings,
  readLernaJson,
  readPackageJson,
  readPnpmWorkspace,
  readPom,
  readPyProject,
  readSetupPy,
  readToml,
  readTsconfigReferences,
  stripJsonComments,
  stripXmlComments,
  tomlStrings,
} from "../src/server/intentManifests";

describe("package.json", () => {
  test("workspaces are read from the array form and the object form", () => {
    expect(readPackageJson('{"name":"@acme/root","workspaces":["packages/*","apps/web"]}')?.workspaces).toEqual([
      "packages/*",
      "apps/web",
    ]);
    expect(readPackageJson('{"workspaces":{"packages":["libs/**"],"nohoist":["x"]}}')?.workspaces).toEqual(["libs/**"]);
    expect(readPackageJson('{"name":"plain"}')?.workspaces).toEqual([]);
  });

  test("the name, description and entry files are read", () => {
    const pkg = readPackageJson(
      JSON.stringify({
        name: "@acme/billing",
        description: "Invoices and payments",
        main: "./dist/index.js",
        bin: { bill: "bin/bill.js" },
        exports: { ".": { import: "./src/index.ts", types: "./src/index.d.ts" }, "./*": "./src/*.ts" },
      }),
    )!;
    expect(pkg.name).toBe("@acme/billing");
    expect(pkg.description).toBe("Invoices and payments");
    expect(pkg.entries).toEqual(["dist/index.js", "bin/bill.js", "src/index.ts", "src/index.d.ts"]);
  });

  test("a package.json that is not JSON reads as nothing", () => {
    expect(readPackageJson("{ not json")).toBeNull();
    expect(readPackageJson("[]")).toBeNull();
  });
});

describe("workspace globs", () => {
  test("a star is one folder, two stars any depth, anything else itself", () => {
    expect(globMatches("packages/*", "packages/ui")).toBe(true);
    expect(globMatches("packages/*", "packages/ui/nested")).toBe(false);
    expect(globMatches("libs/**", "libs/a/b")).toBe(true);
    expect(globMatches("./apps/web/", "apps/web")).toBe(true);
    expect(globMatches("apps/web", "apps/website")).toBe(false);
    expect(globMatches("packages/ui-*", "packages/ui-kit")).toBe(true);
  });

  test("a negated glob takes folders back out", () => {
    expect(matchWorkspaceGlobs(["packages/*", "!packages/legacy"], ["packages/a", "packages/legacy", "tools/x"])).toEqual([
      "packages/a",
    ]);
  });
});

test("pnpm-workspace.yaml and lerna.json name their packages", () => {
  expect(readPnpmWorkspace("packages:\n  - 'apps/*'\n  - packages/*\n  - '!**/test/**'\n")).toEqual([
    "apps/*",
    "packages/*",
    "!**/test/**",
  ]);
  expect(readPnpmWorkspace(": : not yaml : [")).toEqual([]);
  expect(readLernaJson('{"packages":["modules/*"]}')).toEqual(["modules/*"]);
  expect(readLernaJson('{"version":"1.0.0"}')).toEqual(["packages/*"]);
});

describe("tsconfig.json", () => {
  test("comments and trailing commas are allowed", () => {
    const text = `{
      // the projects
      "files": [],
      /* built in this order */
      "references": [
        { "path": "./packages/core" },
        { "path": "packages/web/tsconfig.build.json" }, // the app
      ],
    }`;
    expect(readTsconfigReferences(text)).toEqual(["./packages/core", "packages/web/tsconfig.build.json"]);
  });

  test("a comment marker inside a string is text", () => {
    expect(JSON.parse(stripJsonComments('{"url":"http://x/y", "glob":"src/**/*.ts"}'))).toEqual({
      url: "http://x/y",
      glob: "src/**/*.ts",
    });
  });
});

describe("pom.xml", () => {
  const POM = `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
  </parent>
  <artifactId>shop-parent</artifactId>
  <name>Shop &amp; Billing</name>
  <packaging>pom</packaging>
  <description>
    The shop.
  </description>
  <modules>
    <module>billing</module>
    <!-- <module>retired</module> -->
    <module>services/orders</module>
  </modules>
  <dependencies>
    <dependency><artifactId>junit</artifactId></dependency>
  </dependencies>
  <profiles>
    <profile><modules><module>it-tests</module></modules></profile>
  </profiles>
</project>`;

  test("the project's own coordinates are read, not its parent's or a dependency's", () => {
    const pom = readPom(POM);
    expect(pom.artifactId).toBe("shop-parent");
    expect(pom.name).toBe("Shop & Billing");
    expect(pom.packaging).toBe("pom");
    expect(pom.description).toBe("The shop.");
  });

  test("every module is listed, a profile's too, a commented one not", () => {
    expect(readPom(POM).modules).toEqual(["billing", "services/orders", "it-tests"]);
  });

  test("a comment pieced together around another, or left open, hides its modules too", () => {
    const pom = (inner: string) => `<project><modules><module>billing</module>${inner}</modules></project>`;
    expect(readPom(pom("<!<!-- x -->-- <module>hidden</module> -->")).modules).toEqual(["billing"]);
    expect(readPom(pom("<!-- <module>unclosed</module>")).modules).toEqual(["billing"]);
    for (const text of ["<!<!-- x -->--", "a<!<!<!-- 1 -->-- 2 -->-- 3 -->b", "<!-- open", "<!<!-- x -->-- y"]) {
      expect(stripXmlComments(text)).not.toContain("<!--");
    }
    expect(stripXmlComments("a<!-- 1 -->b<!-- 2 -->c")).toBe("abc");
  });

  test("a name that is a property is not a name", () => {
    expect(readPom("<project><artifactId>a</artifactId><name>${project.artifactId}</name></project>").name).toBe("");
  });
});

describe("settings.gradle", () => {
  test("includes become folders, in Groovy and in Kotlin", () => {
    expect(readGradleSettings("rootProject.name = 'shop'\ninclude ':billing', ':services:orders'\n")).toEqual([
      "billing",
      "services/orders",
    ]);
    expect(readGradleSettings('include(":app")\ninclude(\n  ":libs:core",\n  ":libs:ui"\n)\n')).toEqual([
      "app",
      "libs/core",
      "libs/ui",
    ]);
  });

  test("an include over several lines, and a commented one", () => {
    const text = "include 'a',\n        'b'\n// include 'gone'\n/* include 'also-gone' */\ninclude 'c'\n";
    expect(readGradleSettings(text)).toEqual(["a", "b", "c"]);
  });

  test("includeFlat is a sibling folder, and projectDir moves a project", () => {
    expect(readGradleSettings("includeFlat 'shared'\n")).toEqual(["../shared"]);
    expect(readGradleSettings("include ':api'\nproject(':api').projectDir = file('backend/api')\n")).toEqual(["backend/api"]);
    expect(
      readGradleSettings('include(":api")\nproject(":api").projectDir = File(settingsDir, "srv/api")\n'),
    ).toEqual(["srv/api"]);
  });
});

describe("pyproject.toml", () => {
  test("tables, arrays over several lines and comments are read", () => {
    const toml = readToml(`# a project
[project]
name = "shop"   # the name
dependencies = [
  "django>=4",
  "requests",  # http
]

[tool.setuptools.packages.find]
where = ["src"]
`);
    expect(toml.get("project")?.get("name")).toBe('"shop"');
    expect(tomlStrings(toml.get("project")?.get("dependencies"))).toEqual(["django>=4", "requests"]);
    expect(tomlStrings(toml.get("tool.setuptools.packages.find")?.get("where"))).toEqual(["src"]);
  });

  test("the name and the src layout of setuptools, Poetry and a package-dir", () => {
    expect(readPyProject('[project]\nname = "shop"\n[tool.setuptools.packages.find]\nwhere = ["src"]\n')).toMatchObject({
      name: "shop",
      where: ["src"],
    });
    expect(
      readPyProject('[tool.poetry]\nname = "shop-api"\npackages = [{ include = "shop", from = "src" }]\n'),
    ).toMatchObject({ name: "shop-api", where: ["src"] });
    expect(readPyProject('[tool.setuptools]\npackage-dir = {"" = "lib"}\n').where).toEqual(["lib"]);
  });

  test("uv workspace members are read", () => {
    expect(readPyProject('[tool.uv.workspace]\nmembers = ["packages/*", "apps/api"]\n').members).toEqual([
      "packages/*",
      "apps/api",
    ]);
  });

  test("setup.py and setup.cfg say where the packages are", () => {
    expect(readSetupPy('setup(name="shop", package_dir={"": "src"}, packages=find_packages(where="src"))')).toEqual({
      name: "shop",
      where: ["src"],
    });
    expect(readSetupPy("[metadata]\nname = shop\n[options.packages.find]\nwhere = lib\n")).toEqual({
      name: "shop",
      where: ["lib"],
    });
  });
});

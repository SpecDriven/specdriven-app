// Project members and feature assignment (src/server/members.ts): the data
// repo's `project-settings.json` lists who works on the project, and a
// feature names the member it is assigned to on an `**Assigned:**` line
// under its heading — parsed into `Feature.assigned`, held in the Automerge
// document, and written back by the projection.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_SETTINGS_FILE,
  normalizeCodeRepo,
  normalizeMembers,
  readProjectMembers,
  readProjectSettings,
} from "../src/server/members";
import { handleApi, reloader } from "../src/server/api";
import { normalizeAssignments, readState, writeState } from "../src/server/state";
import {
  formatAssigned,
  parseAssignedLine,
  parseFeature,
  serializeFeature,
  splitFeatureMeta,
} from "../src/server/parser";
import { docToFeature, projectFeature } from "../src/server/automerge/project";
import { importFeatureDoc, reconcile } from "../src/server/automerge/reconcile";
import { threeWayFeature } from "../src/server/automerge/merge";
import { readFeature, readFeatureView, saveFeature } from "../src/server/features";
import { loadFeatureDoc } from "../src/server/automerge/store";

const DANA = "Dana Whitfield";
const MIGUEL = "Miguel Santos";
const JIRA_LINE = "[Jira:ABC-123](https://acme.atlassian.net/browse/ABC-123)";

let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-members-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-members-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
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

// The user setting (src/server/state.ts): assignment is opt-in, so a project
// that doesn't assign features never sees the dropdown.
describe("the Assignments setting", () => {
  test("is off unless it is explicitly turned on", () => {
    expect(normalizeAssignments(undefined)).toBe(false);
    expect(normalizeAssignments(false)).toBe(false);
    expect(normalizeAssignments("yes")).toBe(false);
    expect(normalizeAssignments(true)).toBe(true);
  });

  test("the Settings switch round-trips through the settings file", async () => {
    await writeState({ dataRepo: root }, root);
    const settings = async (assignments: boolean) =>
      (await handleApi(
        new Request("http://localhost/api/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignments }),
        }),
      ))!;
    const on = await settings(true);
    expect(on.status).toBe(200);
    expect(((await on.json()) as { assignments: boolean }).assignments).toBe(true);
    expect((await readState(root)).assignments).toBe(true);
    // Off is the default, stored as an absent key.
    const off = await settings(false);
    expect(off.status).toBe(200);
    expect(((await off.json()) as { assignments: boolean }).assignments).toBe(false);
    expect((await readState(root)).assignments).toBeUndefined();
  });
});

describe("project-settings.json", () => {
  test("members are read from the data repo", async () => {
    await writeFile(
      join(root, PROJECT_SETTINGS_FILE),
      JSON.stringify({
        members: [
          { name: DANA, email: "dana@acme.example" },
          { name: MIGUEL },
        ],
      }),
    );
    expect(await readProjectMembers(root)).toEqual([
      { name: DANA, email: "dana@acme.example" },
      { name: MIGUEL },
    ]);
  });

  test("no file, or one that doesn't parse, is an empty list", async () => {
    expect(await readProjectMembers(root)).toEqual([]);
    await writeFile(join(root, PROJECT_SETTINGS_FILE), "{ not json");
    expect(await readProjectMembers(root)).toEqual([]);
  });

  // The file is hand-edited, so anything that clearly names people counts.
  test("bare names and a bare list read like member objects", () => {
    expect(normalizeMembers({ members: [DANA, { name: MIGUEL }] })).toEqual([
      { name: DANA },
      { name: MIGUEL },
    ]);
    expect(normalizeMembers([DANA])).toEqual([{ name: DANA }]);
  });

  test("nameless entries and duplicate names drop out", () => {
    expect(
      normalizeMembers({
        members: [DANA, "  ", { email: "nobody@acme.example" }, 7, null, { name: "dana whitfield" }],
      }),
    ).toEqual([{ name: DANA }]);
  });

  // The code repo (`code-repo`): where a code gen session runs. A relative
  // path is relative to the data repo, so the checked-in setting holds for
  // every teammate with the two repos side by side.
  test("the code repo is read beside the members and resolved against the data repo", async () => {
    await writeFile(
      join(root, PROJECT_SETTINGS_FILE),
      JSON.stringify({ members: [DANA], "code-repo": "../acme-app" }),
    );
    expect(await readProjectSettings(root)).toEqual({
      members: [{ name: DANA }],
      codeRepo: join(root, "..", "acme-app"),
    });
  });

  test("no code repo, a blank one, or no file at all is null", async () => {
    expect((await readProjectSettings(root)).codeRepo).toBeNull();
    expect(normalizeCodeRepo({ members: [DANA] }, root)).toBeNull();
    expect(normalizeCodeRepo({ "code-repo": "  " }, root)).toBeNull();
    expect(normalizeCodeRepo({ "code-repo": 42 }, root)).toBeNull();
    expect(normalizeCodeRepo([DANA], root)).toBeNull();
  });

  test("an absolute code repo stands as written, and camelCase is accepted", () => {
    expect(normalizeCodeRepo({ "code-repo": "/srv/acme-app/" }, root)).toBe("/srv/acme-app");
    expect(normalizeCodeRepo({ codeRepo: "app" }, root)).toBe(join(root, "app"));
  });

  test("anything but a list of members is no members", () => {
    expect(normalizeMembers(null)).toEqual([]);
    expect(normalizeMembers({ members: "Dana" })).toEqual([]);
  });
});

describe("the assigned line", () => {
  test("parses off the top of a feature and serializes back", () => {
    const text = `# Bind Policy\n\n${formatAssigned(DANA)}\n\nTurning a quote into a policy.\n\n## Bind @v1 [published]\n\n- **Then** it is bound\n`;
    const feature = parseFeature(text);
    expect(feature.assigned).toBe(DANA);
    expect(feature.description).toBe("Turning a quote into a policy.");
    expect(serializeFeature(feature)).toBe(text);
  });

  test("a ticket link and an assignment sit together, in either order", () => {
    const canonical = `# Bind Policy\n\n${JIRA_LINE}\n\n${formatAssigned(DANA)}\n\nThe description.\n`;
    const other = `# Bind Policy\n\n${formatAssigned(DANA)}\n\n${JIRA_LINE}\n\nThe description.\n`;
    for (const text of [canonical, other]) {
      const feature = parseFeature(text);
      expect(feature.assigned).toBe(DANA);
      expect(feature.link?.ticket).toBe("ABC-123");
      expect(feature.description).toBe("The description.");
    }
    // Both forms normalize to the link-first one the projection writes.
    expect(serializeFeature(parseFeature(other))).toBe(canonical);
  });

  test("an Assigned line further down is ordinary description", () => {
    const feature = parseFeature(
      `# Bind Policy\n\nWho does what:\n\n${formatAssigned(DANA)}\n`,
    );
    expect(feature.assigned).toBeUndefined();
    expect(feature.description).toContain(formatAssigned(DANA));
  });

  test("a line that names nobody assigns nobody", () => {
    expect(parseAssignedLine("**Assigned:**   ")).toBeNull();
    expect(parseAssignedLine("Assigned: Dana")).toBeNull();
    expect(parseAssignedLine(`**Assigned:** ${DANA}`)).toBe(DANA);
    expect(splitFeatureMeta("").assigned).toBeUndefined();
  });

  // A name no longer in project-settings.json still parses: the file is the
  // record of who it was assigned to, whatever the member list says today.
  test("a name that is not a project member is kept", () => {
    expect(parseFeature(`# F\n\n**Assigned:** Somebody Else\n`).assigned).toBe("Somebody Else");
  });
});

describe("the document", () => {
  test("carries the assignment and projects it back", () => {
    const doc = importFeatureDoc(parseFeature(`# Bind Policy\n\n${formatAssigned(DANA)}\n`));
    expect(doc.assigned).toBe(DANA);
    expect(docToFeature(doc).assigned).toBe(DANA);
    expect(projectFeature(doc)).toBe(`# Bind Policy\n\n${formatAssigned(DANA)}\n`);
  });

  test("reconciliation reassigns and clears", () => {
    let doc = importFeatureDoc(parseFeature(`# Bind Policy\n\n${formatAssigned(DANA)}\n`));
    doc = reconcile(doc, parseFeature(`# Bind Policy\n\n${formatAssigned(MIGUEL)}\n`));
    expect(doc.assigned).toBe(MIGUEL);
    doc = reconcile(doc, parseFeature(`# Bind Policy\n`));
    expect(doc.assigned).toBeUndefined();
    expect(projectFeature(doc)).toBe("# Bind Policy\n");
  });

  // Like a ticket link: one value, so the side that changed it wins.
  test("a three-way merge takes the side that reassigned", () => {
    const base = parseFeature(`# F\n\n${formatAssigned(DANA)}\n`);
    const ours = parseFeature(`# F\n\n${formatAssigned(DANA)}\n`);
    const theirs = parseFeature(`# F\n\n${formatAssigned(MIGUEL)}\n`);
    const merged = threeWayFeature(base, ours, theirs);
    expect(merged.ok && merged.feature.assigned).toBe(MIGUEL);
    const bothCleared = threeWayFeature(base, parseFeature("# F\n"), theirs);
    expect(bothCleared.ok && bothCleared.feature.assigned).toBeUndefined();
  });
});

// The editor's save path: assigning a member is an ordinary feature save
// (the dropdown sends the whole feature back), so the line lands in the file
// and in the document that projects it.
test("saving an assignment writes the line and the document keeps it", async () => {
  await mkdir(join(root, "specs"), { recursive: true });
  await writeFile(join(root, "specs/bind.feature.md"), "# Bind Policy\n\nThe description.\n");
  const saved = await saveFeature(
    root,
    "specs/bind.feature.md",
    `# Bind Policy\n\n${formatAssigned(DANA)}\n\nThe description.\n`,
  );
  expect(saved.parsed.assigned).toBe(DANA);
  expect(await readFeature(root, "specs/bind.feature.md")).toContain(formatAssigned(DANA));
  const loaded = await loadFeatureDoc(root, "specs/bind.feature.md");
  expect(loaded?.doc.assigned).toBe(DANA);

  const view = await readFeatureView(root, "specs/bind.feature.md");
  expect(view?.parsed.assigned).toBe(DANA);

  const cleared = await saveFeature(root, "specs/bind.feature.md", "# Bind Policy\n\nThe description.\n");
  expect(cleared.parsed.assigned).toBeUndefined();
  expect(await readFeature(root, "specs/bind.feature.md")).not.toContain("Assigned");
});

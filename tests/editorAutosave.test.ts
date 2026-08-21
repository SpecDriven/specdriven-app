// Automates specs/editor-autosave.feature.md: the editor saves itself at an
// interval, and that interval is a setting — at least 3 seconds, 6 by default.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  autosavedDraftToDiscard,
  autosavedEditToRevert,
  scenarioSignature,
} from "../src/frontend/App";
import type { Scenario } from "../src/server/parser";
import {
  createFeature,
  deleteDraftScenario,
  readFeature,
  readFeatureForEditor,
  saveFeature,
} from "../src/server/features";
import {
  DEFAULT_AUTOSAVE_SECONDS,
  MIN_AUTOSAVE_SECONDS,
  normalizeAutosaveSeconds,
  readState,
  statePath,
  writeState,
} from "../src/server/state";

let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-autosave-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-autosave-home-"));
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

async function putState(body: unknown): Promise<Response> {
  return (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ))!;
}

test("the autosave interval defaults to 6 seconds and never goes below 3", () => {
  expect(DEFAULT_AUTOSAVE_SECONDS).toBe(6);
  expect(MIN_AUTOSAVE_SECONDS).toBe(3);
  expect(normalizeAutosaveSeconds(undefined)).toBe(DEFAULT_AUTOSAVE_SECONDS);
  expect(normalizeAutosaveSeconds("nope")).toBe(DEFAULT_AUTOSAVE_SECONDS);
  expect(normalizeAutosaveSeconds(0)).toBe(DEFAULT_AUTOSAVE_SECONDS);
  expect(normalizeAutosaveSeconds(2)).toBe(DEFAULT_AUTOSAVE_SECONDS);
  expect(normalizeAutosaveSeconds(3)).toBe(3);
  expect(normalizeAutosaveSeconds(9.7)).toBe(9);
});

test("the autosave interval round-trips through the settings file", async () => {
  await writeState({ dataRepo: "data", autosaveIntervalSeconds: 30 }, root);
  expect((await readState(root)).autosaveIntervalSeconds).toBe(30);
});

test("an unset autosave interval is reported as the 6 second default", async () => {
  const res = (await handleApi(new Request("http://localhost/api/state")))!;
  expect(res.status).toBe(200);
  expect(((await res.json()) as { autosaveIntervalSeconds: number }).autosaveIntervalSeconds).toBe(
    DEFAULT_AUTOSAVE_SECONDS,
  );
});

test("Settings saves the autosave interval to the settings file", async () => {
  const res = await putState({ autosaveIntervalSeconds: 12 });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { autosaveIntervalSeconds: number }).autosaveIntervalSeconds).toBe(
    12,
  );
  expect((await Bun.file(statePath(root)).json()).autosaveIntervalSeconds).toBe(12);
});

test("an interval below the 3 second minimum is refused, and changes nothing", async () => {
  await putState({ autosaveIntervalSeconds: 8 });
  const res = await putState({ autosaveIntervalSeconds: 2 });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("3");
  expect((await readState(root)).autosaveIntervalSeconds).toBe(8);
});

test("the minimum itself is accepted", async () => {
  const res = await putState({ autosaveIntervalSeconds: MIN_AUTOSAVE_SECONDS });
  expect(res.status).toBe(200);
  expect((await readState(root)).autosaveIntervalSeconds).toBe(MIN_AUTOSAVE_SECONDS);
});

// A tick only saves when the editor holds something new, so a dialog that is
// opened and read — or one already saved — costs no commit.
test("only changed editor contents make an autosave tick save", () => {
  const s: Scenario = {
    name: "Quote a policy",
    version: 2,
    status: "proposed",
    body: "Given a driver\n",
    tests: ["https://github.com/acme/repo/blob/main/QuoteTest.java"],
  };
  const sig = scenarioSignature(s, 2);
  expect(scenarioSignature({ ...s }, 2)).toBe(sig);
  expect(scenarioSignature({ ...s, body: "Given a driver\nWhen…" }, 2)).not.toBe(sig);
  expect(scenarioSignature({ ...s, name: "Quote a claim" }, 2)).not.toBe(sig);
  expect(scenarioSignature({ ...s, status: "draft" }, 2)).not.toBe(sig);
  expect(scenarioSignature({ ...s, tests: [] }, 2)).not.toBe(sig);
  // The version the dialog will save under, not the one on the object: a new
  // scenario renamed onto an existing name saves under a new version.
  expect(scenarioSignature(s, 3)).not.toBe(sig);
});

test("the autosave interval is independent of the autosync frequency", async () => {
  // Autosync off (0) must not switch autosave off — it has no off switch.
  await putState({ reloadFrequencySeconds: 0, autosaveIntervalSeconds: 5 });
  const state = await readState(root);
  expect(state.reloadFrequencySeconds).toBe(0);
  expect(normalizeAutosaveSeconds(state.autosaveIntervalSeconds)).toBe(5);
});

// specs/editor-autosave.feature.md "Canceling Autosaved Scenario Deletes it":
// Cancel takes a new scenario back out again when the only thing that ever
// saved it was a tick, and it is still a draft.
const newDraft: Scenario = {
  name: "Idea",
  version: 1,
  status: "draft",
  body: "wip\n",
  tests: [],
};

test("Cancel discards a new scenario that only autosave saved", () => {
  const feature = { name: "Quote", description: "", scenarios: [newDraft] };
  // index 0: a tick has placed the scenario in the feature.
  const discard = autosavedDraftToDiscard({ index: 0, isNew: true, scenario: newDraft }, feature);
  expect(discard).toEqual({ index: 0, scenario: newDraft });
});

test("Cancel deletes the entry as last saved, not the dialog's unsaved edits", () => {
  const saved: Scenario = { ...newDraft, name: "Idea", body: "wip\n" };
  const feature = { name: "Quote", description: "", scenarios: [{ ...newDraft, name: "Other" }, saved] };
  // The dialog has been typed into since the tick that saved it; the delete
  // still names the scenario the way the feature holds it.
  const discard = autosavedDraftToDiscard(
    { index: 1, isNew: true, scenario: { ...saved, name: "Idea, renamed", body: "more" } },
    feature,
  );
  expect(discard).toEqual({ index: 1, scenario: saved });
});

test("Cancel only closes the dialog when there is no autosaved draft to take back", () => {
  const feature = { name: "Quote", description: "", scenarios: [newDraft] };
  // No dialog at all.
  expect(autosavedDraftToDiscard(null, feature)).toBeNull();
  // A scenario the user opened, rather than one this dialog created: saved by
  // the user, so Cancel just exits.
  expect(autosavedDraftToDiscard({ index: 0, scenario: newDraft }, feature)).toBeNull();
  // New, but no tick has saved it yet — there is nothing in the feature to
  // delete.
  expect(autosavedDraftToDiscard({ index: null, isNew: true, scenario: newDraft }, feature)).toBeNull();
  // New and autosaved, but no longer a draft: unchecking Draft proposed it
  // into the .feature.md, which is not something Cancel undoes.
  const proposed: Scenario = { ...newDraft, status: "proposed" };
  expect(
    autosavedDraftToDiscard(
      { index: 0, isNew: true, scenario: proposed },
      { name: "Quote", description: "", scenarios: [proposed] },
    ),
  ).toBeNull();
  // The entry has gone from underneath the dialog.
  expect(
    autosavedDraftToDiscard({ index: 3, isNew: true, scenario: newDraft }, feature),
  ).toBeNull();
});

// The discard goes through the draft delete, not a save without the draft:
// the .feature.md never held it, so saving the feature without it would
// remove nothing.
test("discarding an autosaved draft leaves nothing behind", async () => {
  await createFeature(root, "Quote");
  // A tick on a new scenario: the draft joins the feature the dialog holds.
  await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nbody\n\n## Idea @v1 [draft]\n\nwip\n",
  );
  expect(await readFeatureForEditor(root, "quote.feature.md")).toContain("## Idea @v1 [draft]");
  // Cancel: the draft goes with the dialog.
  const result = await deleteDraftScenario(root, "quote.feature.md", { name: "Idea", version: 1 });
  expect(result.content).not.toContain("Idea");
  expect(await readFeatureForEditor(root, "quote.feature.md")).not.toContain("Idea");
  // The file never held the draft, and the scenario beside it is untouched.
  expect(await readFeature(root, "quote.feature.md")).not.toContain("Idea");
  expect(await readFeature(root, "quote.feature.md")).toContain("## Basic @v1 [proposed]");
});

// specs/editor-autosave.feature.md "Canceling an Autosaved Edit Restores the
// Scenario": Cancel puts a scenario back the way the dialog opened it, over
// whatever a tick saved in between.
const savedDraft: Scenario = {
  name: "Quote by phone",
  version: 1,
  status: "draft",
  body: "the agent takes the call\n",
  tests: [],
};

test("Cancel restores the scenario the dialog opened, over the autosaved edit", () => {
  // A tick has saved the text typed since the dialog opened.
  const autosaved: Scenario = { ...savedDraft, body: "the agent takes the call\nand more\n" };
  const feature = { name: "Quote", description: "", scenarios: [autosaved] };
  const revert = autosavedEditToRevert({ index: 0, scenario: autosaved }, feature, savedDraft);
  expect(revert).toEqual({ index: 0, opened: savedDraft, saved: autosaved });
});

test("Cancel restores a proposed scenario the same way", () => {
  const opened: Scenario = { ...savedDraft, status: "proposed" };
  const autosaved: Scenario = { ...opened, name: "Quote by phone, renamed" };
  const feature = { name: "Quote", description: "", scenarios: [autosaved] };
  expect(autosavedEditToRevert({ index: 0, scenario: autosaved }, feature, opened)).toEqual({
    index: 0,
    opened,
    saved: autosaved,
  });
});

test("Cancel has nothing to restore when no tick saved the dialog", () => {
  const feature = { name: "Quote", description: "", scenarios: [savedDraft] };
  // Edited in the dialog, but the entry is still what it was opened as.
  expect(
    autosavedEditToRevert(
      { index: 0, scenario: { ...savedDraft, body: "typed but never saved" } },
      feature,
      savedDraft,
    ),
  ).toBeNull();
  // No dialog, and no scenario to have opened one on.
  expect(autosavedEditToRevert(null, feature, savedDraft)).toBeNull();
  expect(autosavedEditToRevert({ index: 0, scenario: savedDraft }, feature, null)).toBeNull();
  // A scenario this dialog created: Cancel deletes it or leaves it, and never
  // restores an earlier version of something that had none.
  const autosaved: Scenario = { ...savedDraft, body: "more\n" };
  expect(
    autosavedEditToRevert(
      { index: 0, isNew: true, scenario: autosaved },
      { name: "Quote", description: "", scenarios: [autosaved] },
      savedDraft,
    ),
  ).toBeNull();
  // The entry has gone from underneath the dialog.
  expect(autosavedEditToRevert({ index: 3, scenario: savedDraft }, feature, savedDraft)).toBeNull();
});

test("restoring a scenario writes the opened contents back over the autosaved ones", async () => {
  await createFeature(root, "Quote");
  // A tick saved the edits: the draft in the document, the proposed scenario
  // in the file.
  await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nbody, edited\n\n## Idea @v1 [draft]\n\nwip, edited\n",
  );
  expect(await readFeatureForEditor(root, "quote.feature.md")).toContain("wip, edited");
  // Cancel: the feature is saved again with both scenarios as they were.
  await saveFeature(
    root,
    "quote.feature.md",
    "# Quote\n\n## Basic @v1\n\nbody\n\n## Idea @v1 [draft]\n\nwip\n",
  );
  const editor = await readFeatureForEditor(root, "quote.feature.md");
  expect(editor).toContain("wip");
  expect(editor).not.toContain("edited");
  expect(await readFeature(root, "quote.feature.md")).toContain("body\n");
});

test("restoring a renamed draft deletes the copy the tick saved", async () => {
  await createFeature(root, "Quote");
  await saveFeature(root, "quote.feature.md", "# Quote\n\n## Idea @v1 [draft]\n\nwip\n");
  // A tick saved the draft under a new name, with the body changed too — so
  // nothing identifies it as the same scenario any more.
  await saveFeature(root, "quote.feature.md", "# Quote\n\n## Bright idea @v1 [draft]\n\nwip, edited\n");
  // Cancel takes the renamed draft out and saves the feature as opened. The
  // delete is what removes it: markdown cannot express a draft's absence.
  await deleteDraftScenario(root, "quote.feature.md", { name: "Bright idea", version: 1 });
  await saveFeature(root, "quote.feature.md", "# Quote\n\n## Idea @v1 [draft]\n\nwip\n");
  const editor = await readFeatureForEditor(root, "quote.feature.md");
  expect(editor).toContain("## Idea @v1 [draft]");
  expect(editor).not.toContain("Bright idea");
  expect(await readFeature(root, "quote.feature.md")).not.toContain("Idea");
});

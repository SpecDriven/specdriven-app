// The description editor (specs/editor/feature-editor.feature.md) is supposed
// to land what it holds when the user leaves the feature — another spec,
// home, or a data-folder switch. The tick used to key off `selected`, and
// every leave path changed `selected` first, so the cleanup save saw the
// new file and dropped the edit. Capture the payload while the editor's
// file is still selected; after that it is too late.
import { describe, expect, test } from "bun:test";
import { descriptionSavePayload } from "../src/frontend/App";
import { createPromiseQueue } from "../src/frontend/promiseQueue";
import type { Feature } from "../src/server/parser";
import { parseFeature, serializeFeature } from "../src/server/parser";

const FEATURE_A: Feature = {
  name: "Quote Policy",
  description: "First draft.",
  scenarios: [
    { name: "Basic Quote", version: 1, status: "proposed", body: "- Given a customer", tests: [] },
  ],
};

const FEATURE_B: Feature = {
  name: "Bind Policy",
  description: "",
  scenarios: [],
};

describe("descriptionSavePayload", () => {
  test("writes the editor's text into its own feature, leaving scenarios alone", () => {
    const payload = descriptionSavePayload(
      { file: "specs/quote-policy.feature.md", text: "Second draft." },
      "specs/quote-policy.feature.md",
      FEATURE_A,
      "First draft.",
    );
    expect(payload).not.toBeNull();
    expect(payload!.file).toBe("specs/quote-policy.feature.md");
    expect(payload!.text).toBe("Second draft.");
    expect(parseFeature(payload!.content)).toEqual({
      ...FEATURE_A,
      description: "Second draft.",
    });
  });

  test("is nothing once selected has already moved on — the leftover feature is the wrong one", () => {
    expect(
      descriptionSavePayload(
        { file: "specs/quote-policy.feature.md", text: "Second draft." },
        "specs/bind-policy.feature.md",
        FEATURE_B,
        "First draft.",
      ),
    ).toBeNull();
  });

  test("is nothing when the selection was cleared (home, another tab, repo switch)", () => {
    expect(
      descriptionSavePayload(
        { file: "specs/quote-policy.feature.md", text: "Second draft." },
        null,
        null,
        "First draft.",
      ),
    ).toBeNull();
  });

  test("is nothing when the editor holds what the server already has", () => {
    expect(
      descriptionSavePayload(
        { file: "specs/quote-policy.feature.md", text: "First draft." },
        "specs/quote-policy.feature.md",
        FEATURE_A,
        "First draft.",
      ),
    ).toBeNull();
  });
});

/**
 * The leave-path the pane used to get wrong: change `selected`, then tick.
 * The flush the README / page / model editors already do: tick first, then
 * move. Each PUT records the file it reached.
 */
function descriptionEditor(put: (file: string, content: string) => Promise<void>) {
  const queue = createPromiseQueue();
  let selected: string | null = "specs/quote-policy.feature.md";
  let feature: Feature | null = FEATURE_A;
  let descEdit: { file: string; text: string } | null = {
    file: "specs/quote-policy.feature.md",
    text: "Second draft.",
  };
  let descSaved: string | null = "First draft.";

  const tick = async () => {
    const payload = descriptionSavePayload(descEdit, selected, feature, descSaved);
    if (!payload) return;
    await queue.run(async () => {
      if (payload.text === descSaved) return;
      await put(payload.file, payload.content);
      if (descEdit?.file === payload.file) descSaved = payload.text;
    });
  };

  return {
    /** The broken cleanup: selection moves, then the tick runs. */
    async leaveThenTick() {
      selected = "specs/bind-policy.feature.md";
      feature = FEATURE_B;
      await tick();
      descEdit = null;
    },
    /** The fix: capture and write while the editor's file is still selected. */
    async flushThenLeave() {
      await tick();
      selected = "specs/bind-policy.feature.md";
      feature = FEATURE_B;
      descEdit = null;
    },
    saved: () => descSaved,
  };
}

describe("flushing the description editor before leaving the feature", () => {
  test("a tick after selected has moved writes nothing — the edit is dropped", async () => {
    const disk: string[] = [];
    const editor = descriptionEditor(async (file, content) => {
      disk.push(`${file}\n${content}`);
    });
    await editor.leaveThenTick();
    expect(disk).toEqual([]);
    expect(editor.saved()).toBe("First draft.");
  });

  test("a flush while the editor's file is still selected lands the new description", async () => {
    const disk: { file: string; content: string }[] = [];
    const editor = descriptionEditor(async (file, content) => {
      disk.push({ file, content });
    });
    await editor.flushThenLeave();
    expect(disk).toHaveLength(1);
    expect(disk[0]!.file).toBe("specs/quote-policy.feature.md");
    expect(parseFeature(disk[0]!.content).description).toBe("Second draft.");
    expect(parseFeature(disk[0]!.content).scenarios).toEqual(FEATURE_A.scenarios);
    expect(editor.saved()).toBe("Second draft.");
  });

  test("the landed file is the one the editor was opened on, not the feature that replaced it", async () => {
    const files: string[] = [];
    const editor = descriptionEditor(async (file) => {
      files.push(file);
    });
    await editor.flushThenLeave();
    expect(files).toEqual(["specs/quote-policy.feature.md"]);
    expect(files).not.toContain("specs/bind-policy.feature.md");
  });

  test("the written feature keeps the heading the editor never touched", () => {
    const payload = descriptionSavePayload(
      { file: "specs/quote-policy.feature.md", text: "  Second draft.  " },
      "specs/quote-policy.feature.md",
      FEATURE_A,
      "First draft.",
    );
    expect(serializeFeature(parseFeature(payload!.content))).toBe(
      "# Quote Policy\n\nSecond draft.\n\n## Basic Quote @v1 [proposed]\n\n- Given a customer\n",
    );
  });
});

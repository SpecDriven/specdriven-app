// Automates specs/app/extract-specs-from-code.feature.md: "Refine with
// agent" — an agent regroups the proposed folders by business area, naming
// them only by the ids it was shown, so that every regrouped folder is made
// of folders the analysis found and nothing is invented; and the job the
// dialog polls, with a fake one-shot provider.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agents } from "../src/plugins/host/agents";
import type { OneShotRequest, OneShotResult } from "../src/plugins/host/agents";
import { handleApi, reloader } from "../src/server/api";
import { analyseModules, flattenFolders, type RepoSnapshot } from "../src/server/intentModules";
import {
  cancelRefine,
  REFINE_AGENT_MISSING,
  REFINE_SCHEMA,
  REFINE_SYSTEM_PROMPT,
  refinedFolders,
  refineJob,
  refinePrompt,
  refineProposal,
  refineUnits,
  startRefine,
} from "../src/server/intentRefine";
import { chosenFolders } from "../src/server/intentRepo";
import { writeState } from "../src/server/state";
import { fakeProvider } from "./helpers/fakeAgent";

const snapshot: RepoSnapshot = {
  name: "shop",
  files: [
    "package.json",
    "packages/cart/package.json",
    "packages/cart/src/cart.ts",
    "packages/cart/src/cart.test.ts",
    "packages/checkout/package.json",
    "packages/checkout/src/pay.ts",
    "packages/invoices/package.json",
    "packages/invoices/src/invoice.ts",
    "packages/ui-kit/package.json",
    "packages/ui-kit/src/Button.tsx",
  ].map((path) => ({ path, size: 100 })),
  manifests: {
    "package.json": '{"name":"shop","workspaces":["packages/*"]}',
    "packages/cart/package.json": '{"name":"cart","description":"The shopping cart"}',
    "packages/checkout/package.json": '{"name":"checkout"}',
    "packages/invoices/package.json": '{"name":"invoices"}',
    "packages/ui-kit/package.json": '{"name":"ui-kit"}',
  },
};
const proposal = analyseModules(snapshot);
const structured = (value: unknown): OneShotResult => ({ text: "", structured: value, isError: false });
const answer = (folders: unknown[], notes = "") => structured({ folders, notes });

describe("what the agent is shown", () => {
  test("each proposed folder with code has a short id", () => {
    expect([...refineUnits(proposal)].map(([id, f]) => [id, f.id])).toEqual([
      ["m1", "packages/cart"],
      ["m2", "packages/checkout"],
      ["m3", "packages/invoices"],
      ["m4", "packages/ui-kit"],
    ]);
  });

  test("a line a folder — where it is, its language and size, why it was proposed, what it says of itself", () => {
    const prompt = refinePrompt(
      proposal,
      new Map([
        [".", "# Shop\nAn online shop."],
        ["packages/cart", "# Cart\n\nHolds what a customer means to buy."],
      ]),
    );
    expect(prompt).toContain("Project: shop");
    expect(prompt).toContain("The project's README:\n# Shop\nAn online shop.");
    expect(prompt).toContain(
      "m1 | packages/cart | TypeScript | 1 files, 1 tests | Cart: npm workspace listed in package.json | The shopping cart — # Cart Holds what a customer means to buy.",
    );
    expect(prompt).toContain("m4 | packages/ui-kit | TypeScript | 1 files, 0 tests | UI Kit: npm workspace listed in package.json | -");
    expect(REFINE_SYSTEM_PROMPT).toContain("Use every id exactly once, and only the ids you were given");
  });

  test("every object of the schema requires all its properties", () => {
    const check = (node: any) => {
      if (node?.type === "object") {
        expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());
        Object.values(node.properties).forEach(check);
      }
      if (node?.type === "array") check(node.items);
    };
    check(REFINE_SCHEMA);
  });
});

describe("the agent's regrouping", () => {
  test("groups own the files of the folders they list, and may nest one level", () => {
    const refined = refinedFolders(
      proposal,
      answer(
        [
          { name: "Buying", parent: "", description: "From the cart to the payment.", modules: ["m1", "m2"] },
          { name: "Billing", parent: "", description: "Invoices.", modules: ["m3"] },
          { name: "Design system", parent: "Buying", description: "", modules: ["M4"] },
        ],
        "Grouped by what a customer does.",
      ),
    )!;
    expect(refined.notes).toBe("Grouped by what a customer does.");
    expect(refined.folders.map((f) => [f.name, f.folder, f.modules])).toEqual([
      ["Buying", "buying", ["packages/cart", "packages/checkout"]],
      ["Billing", "billing", ["packages/invoices"]],
    ]);
    const buying = refined.folders[0]!;
    expect(buying).toMatchObject({
      source: "refined",
      description: "From the cart to the payment.",
      reason: "From packages/cart, packages/checkout",
      files: 2,
      tests: 1,
      languages: ["typescript"],
      selected: true,
    });
    expect(buying.children.map((c) => [c.name, c.folder, c.modules, c.reason])).toEqual([
      ["Design system", "buying/design-system", ["packages/ui-kit"], "From packages/ui-kit"],
    ]);
    // What comes back is something the server will make: every module is one the analysis found.
    const known = new Set(flattenFolders(proposal.folders).map((f) => f.id));
    const asChosen = flattenFolders(refined.folders).map((f) => ({ folder: f.folder, name: f.name, modules: f.modules, draft: true }));
    expect(chosenFolders(asChosen, known)).toHaveLength(3);
  });

  test("an id that was not given is dropped, a repeated one counts once, and what is left out goes under Other", () => {
    const refined = refinedFolders(
      proposal,
      answer([
        { name: "Buying", parent: "", description: "", modules: ["m1", "m9", "../../etc/passwd", "m2"] },
        { name: "Also buying", parent: "", description: "", modules: ["m1"] },
        { name: "Empty", parent: "", description: "", modules: [] },
      ]),
    )!;
    expect(refined.folders.map((f) => [f.name, f.modules])).toEqual([
      ["Buying", ["packages/cart", "packages/checkout"]],
      ["Other", ["packages/invoices", "packages/ui-kit"]],
    ]);
    const all = flattenFolders(refined.folders).flatMap((f) => f.modules);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(["packages/cart", "packages/checkout", "packages/invoices", "packages/ui-kit"]);
  });

  test("a parent that is not a top-level group is ignored; names are cleaned and told apart", () => {
    const refined = refinedFolders(
      proposal,
      answer([
        { name: "  Buying\nand paying ", parent: "Nowhere", description: "", modules: ["m1"] },
        { name: "Inner", parent: "Buying and paying", description: "", modules: ["m2"] },
        { name: "Deeper", parent: "Inner", description: "", modules: ["m3"] },
        { name: "buying and paying", parent: "", description: "", modules: ["m4"] },
      ]),
    )!;
    expect(refined.folders.map((f) => [f.name, f.children.map((c) => c.name)])).toEqual([
      ["Buying and paying", ["Inner"]],
      ["Deeper", []],
      ["Other", []],
    ]);
  });

  test("an answer that places under half the folders, or is no answer, is refused", () => {
    expect(refinedFolders(proposal, answer([{ name: "One", parent: "", description: "", modules: ["m1"] }]))).toBeNull();
    expect(refinedFolders(proposal, { text: "I would rather not.", isError: false })).toBeNull();
    expect(refinedFolders(proposal, { text: "boom", isError: true })).toBeNull();
    expect(refinedFolders(proposal, structured({ folders: "none" }))).toBeNull();
  });

  test("JSON wrapped in words is read", () => {
    const text = `Sure:\n${JSON.stringify({ folders: [{ name: "All", parent: "", description: "", modules: ["m1", "m2", "m3", "m4"] }], notes: "" })}`;
    expect(refinedFolders(proposal, { text, isError: false })!.folders.map((f) => f.name)).toEqual(["All"]);
  });
});

describe("the job the dialog polls", () => {
  let root: string;
  let code: string;
  let dispose: (() => void) | null = null;
  let asked: OneShotRequest[] = [];
  let turn: (req: OneShotRequest) => Promise<OneShotResult>;
  const real = { ...process.env };

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
  /** Poll until the job is no longer running. */
  const settled = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const res = await call("GET", `/api/extract/refine/${id}`);
      if (res.body.state !== "running") return res.body;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("the regrouping never settled");
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "specdriven-refine-"));
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    process.env.SPECDRIVEN_ROOT = join(root, "app");
    process.env.SPECDRIVEN_HOME = join(root, "home");
    delete process.env.SPECDRIVEN_HOSTED;
    delete process.env.DEMO_MODE;
    await writeState({}, join(root, "app"));
    code = join(root, "work", "shop");
    for (const file of snapshot.files) {
      await mkdir(dirname(join(code, file.path)), { recursive: true });
      await writeFile(join(code, file.path), snapshot.manifests[file.path] ?? "export const x = 1;\n");
    }
    await writeFile(join(code, "packages/cart/README.md"), "# Cart\nHolds what a customer means to buy.\n");
    asked = [];
    turn = async () => answer([{ name: "Buying", parent: "", description: "", modules: ["m1", "m2", "m3", "m4"] }]);
    const { provider } = fakeProvider({
      id: "claude",
      label: "Claude",
      rank: 10,
      capabilities: { oneShot: true },
      oneShot: async (req) => {
        asked.push(req);
        return turn(req);
      },
    });
    dispose = agents.register(provider);
  });

  afterEach(async () => {
    reloader.stop();
    dispose?.();
    dispose = null;
    await rm(root, { recursive: true, force: true });
    for (const name of ["SPECDRIVEN_ROOT", "SPECDRIVEN_HOME", "SPECDRIVEN_HOSTED", "DEMO_MODE"]) {
      if (real[name] === undefined) delete process.env[name];
      else process.env[name] = real[name];
    }
  });

  test("starts at once and ends with the regrouped folders and who made them", async () => {
    const started = await call("POST", "/api/extract/refine", { codeDir: code, agent: "claude", model: "claude-haiku-4-5" });
    expect(started.status).toBe(202);
    expect(started.body.state).toBe("running");
    const job = await settled(started.body.id);
    expect(job.state).toBe("done");
    expect(job.refined.agent).toBe("Claude");
    expect(job.refined.folders.map((f: any) => [f.name, f.modules.length])).toEqual([["Buying", 4]]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.model).toBe("claude-haiku-4-5");
    expect(asked[0]!.schema).toBeDefined();
    expect(asked[0]!.prompt).toContain("m1 | packages/cart |");
    expect(asked[0]!.prompt).toContain("Holds what a customer means to buy.");
  });

  test("a turn that fails, or an answer that is no regrouping, fails the job with the agent named", async () => {
    turn = async () => ({ text: "overloaded", isError: true });
    let job = await settled((await call("POST", "/api/extract/refine", { codeDir: code })).body.id);
    expect(job).toMatchObject({ state: "failed", error: "Claude could not regroup the folders: overloaded" });
    turn = async () => ({ text: "No.", isError: false });
    job = await settled((await call("POST", "/api/extract/refine", { codeDir: code })).body.id);
    expect(job.error).toBe("Claude did not answer with a regrouping of the folders");
  });

  test("it can be stopped, and an answer that comes afterwards is not taken", async () => {
    let release: (r: OneShotResult) => void = () => {};
    turn = () => new Promise((resolve) => (release = resolve));
    const started = await call("POST", "/api/extract/refine", { codeDir: code });
    while (asked.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect((await call("DELETE", `/api/extract/refine/${started.body.id}`)).body.state).toBe("cancelled");
    expect(asked[0]!.signal?.aborted).toBe(true);
    release(answer([{ name: "Late", parent: "", description: "", modules: ["m1", "m2", "m3", "m4"] }]));
    await new Promise((r) => setTimeout(r, 20));
    const job = (await call("GET", `/api/extract/refine/${started.body.id}`)).body;
    expect(job.state).toBe("cancelled");
    expect(job.refined).toBeUndefined();
  });

  test("without an agent the job says so", async () => {
    dispose?.();
    dispose = null;
    const job = await settled((await call("POST", "/api/extract/refine", { codeDir: code })).body.id);
    expect(job).toMatchObject({ state: "failed", error: REFINE_AGENT_MISSING });
  });

  test("a project of one folder has nothing to regroup, and no turn is spent", async () => {
    const single = join(root, "work", "tool");
    await mkdir(single, { recursive: true });
    await writeFile(join(single, "main.py"), "print('hi')\n");
    await expect(refineProposal(single)).rejects.toThrow("There is only one folder: nothing to regroup");
    expect(asked).toHaveLength(0);
  });

  test("the turn runs in the project, reads its READMEs, and answers with who regrouped", async () => {
    const refined = await refineProposal(code, { agent: "claude" });
    expect(refined.agent).toBe("Claude");
    expect(refined.folders[0]!.modules).toHaveLength(4);
    expect(asked[0]!.cwd).toBe(code);
    expect(asked[0]!.systemPrompt).toBe(REFINE_SYSTEM_PROMPT);
  });

  test("a job is asked for by its id, and stopping one that is over changes nothing", async () => {
    const started = startRefine(code);
    expect(started.state).toBe("running");
    expect(refineJob("no-such-job")).toBeNull();
    expect(cancelRefine("no-such-job")).toBeNull();
    for (let i = 0; i < 200 && refineJob(started.id)!.state === "running"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(refineJob(started.id)!.state).toBe("done");
    expect(cancelRefine(started.id)!.state).toBe("done");
    expect(refineJob(started.id)!.refined!.folders).toHaveLength(1);
  });

  test("an unknown job, and the demo, are refused", async () => {
    expect((await call("GET", "/api/extract/refine/nope")).status).toBe(404);
    process.env.DEMO_MODE = "1";
    expect((await call("POST", "/api/extract/refine", { codeDir: code })).status).toBe(403);
  });
});

// specs/app/extract-specs-from-code.feature.md "Tests are linked in a pass
// of their own" and "Tests are linked later, on their own", as the page
// sees them: the wizard's tick for linking in the same run, the "Link tests
// to specs" dialog, and the pill's words while tests are linked — as static
// markup and plain data. App.tsx owns the open state.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentDescriptor } from "../src/server/agentTypes";
import { analyseModules, type RepoSnapshot } from "../src/server/intentModules";
import type { ExtractionJob, JobFolder, JobLink } from "../src/server/intentExtraction";
import { NO_GITHUB_REMOTE } from "../src/server/intentTestUrl";
import { ExtractSpecsDialog, lastAgent, type ExtractAnalysis } from "../src/frontend/ExtractSpecsDialog";
import { ExtractionFolders, ExtractionProgress, type Extraction } from "../src/frontend/ExtractionProgress";
import { LinkTestsDialog, type LinkChoices } from "../src/frontend/LinkTestsDialog";
import { SpecFoldersDialog } from "../src/frontend/SpecFolders";
import { featuresTouched, folderLine, linking, progressLabel, resumable, testsLinked } from "../src/frontend/extractSpecs";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};
const agent = (id: string, label: string): AgentDescriptor =>
  ({ id, label, available: true, capabilities: { oneShot: true } }) as unknown as AgentDescriptor;

const snapshot: RepoSnapshot = {
  name: "shop",
  files: ["package.json", "src/server.ts", "src/server.test.ts"].map((path) => ({ path, size: 100 })),
  manifests: { "package.json": '{"name":"shop"}' },
};
const analysis = (tests?: ExtractAnalysis["tests"]): ExtractAnalysis => ({
  codeDir: "/work/shop",
  proposal: analyseModules(snapshot),
  name: "specs-shop",
  target: "/work/specs-shop",
  targetState: "free",
  specsLink: "missing",
  ...(tests ? { tests } : {}),
});
const lastStep = (tests: ExtractAnalysis["tests"] | undefined, agents: AgentDescriptor[]) =>
  html(<ExtractSpecsDialog agents={agents} initialAnalysis={analysis(tests)} initialStep="repo" onCreated={noop} onClose={noop} />);
/** The linking checkbox's `<input>`, as written. */
const tick = (markup: string) => /<label class="choice"><input type="checkbox"[^>]*\/><span class="choice-label"><span>Link the project’s tests/.exec(markup)?.[0] ?? null;

describe("the wizard's tick for linking tests", () => {
  test("linking is offered ticked when the project has tests and a repository on github.com", () => {
    const markup = lastStep({ files: 3, repo: "acme/shop" }, [agent("claude", "Claude")]);
    expect(tick(markup)).toContain('checked=""');
    expect(tick(markup)).not.toContain("disabled");
    expect(markup).toContain("Claude matches each feature’s scenarios to the project’s tests (3 test files)");
    expect(markup).toContain("links them to acme/shop on GitHub");
    expect(markup).toContain("it can be done later with “Link tests to specs…”");
  });

  test("linking cannot be ticked for a project with nowhere for the links to point and says why", () => {
    const markup = lastStep({ files: 3, repo: null, problem: NO_GITHUB_REMOTE }, [agent("claude", "Claude")]);
    expect(tick(markup)).toContain('disabled=""');
    expect(tick(markup)).not.toContain("checked");
    expect(markup).toContain(`${NO_GITHUB_REMOTE}.`);
  });

  test("linking cannot be ticked for a project that has no tests", () => {
    const markup = lastStep({ files: 0, repo: "acme/shop", problem: "No tests were found in this project" }, [agent("claude", "Claude")]);
    expect(tick(markup)).toContain('disabled=""');
    expect(markup).toContain("No tests were found in this project.");
  });

  test("linking is not offered where no agent drafts the specs", () => {
    expect(tick(lastStep({ files: 3, repo: "acme/shop" }, []))).toBeNull();
    // Nor by a server that does not say whether tests can be linked.
    expect(tick(lastStep(undefined, [agent("claude", "Claude")]))).toBeNull();
  });
});

const choices: LinkChoices = {
  repos: [
    { dir: "/work/shop", default: true, files: 12, repo: "acme/shop" },
    { dir: "/work/inventory", default: false, files: 0, repo: null, problem: NO_GITHUB_REMOTE },
  ],
  folders: [
    { folder: "api", features: 2 },
    { folder: "api/orders", features: 1 },
  ],
};
const dialog = (over: Partial<Parameters<typeof LinkTestsDialog>[0]> = {}) =>
  html(<LinkTestsDialog agents={[agent("claude", "Claude")]} initialChoices={choices} onStarted={noop} onClose={noop} {...over} />);

describe("Link tests to specs", () => {
  test("the dialog says what will be linked and where the links point", () => {
    const markup = dialog();
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Link tests to specs"');
    expect(markup).toContain("Links are only added");
    expect(markup).toContain('aria-label="Code repository"');
    expect(markup).toContain("12 test files in shop; the links point at acme/shop on GitHub.");
    expect(markup).toContain("Every extracted feature (3 features)");
    expect(markup).toContain("api/orders (1 feature)");
    expect(markup).toContain("One agent turn for each feature, in the background.");
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary">Link tests<\/button>/);
  });

  test("the folder selected in the sidebar is the scope it starts on", () => {
    expect(dialog({ folder: "specs/api/orders" })).toContain('<option value="api/orders" selected="">');
    // A folder with nothing extracted in it: every feature.
    expect(dialog({ folder: "specs/billing" })).toContain('<option value="" selected="">');
  });

  test("a repository whose tests cannot be linked says why and cannot be started on", () => {
    const only = { ...choices, repos: [choices.repos[1]!] };
    const markup = dialog({ initialChoices: only });
    expect(markup).toContain(`<p class="error">inventory: ${NO_GITHUB_REMOTE}.</p>`);
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary" disabled="">Link tests<\/button>/);
    expect(markup).not.toContain('aria-label="Code repository"');
  });

  test("a folder with nothing extracted, no code repository or no agent says so in place of the fields", () => {
    expect(dialog({ initialChoices: { ...choices, folders: [] } })).toContain("No feature in this folder was extracted from code");
    expect(dialog({ initialChoices: { ...choices, repos: [] } })).toContain("This folder names no code repository");
    const noAgent = dialog({ agents: [] });
    expect(noAgent).toContain("No agent is set up here to match tests to scenarios");
    expect(noAgent).not.toContain('aria-label="Features to link"');
    expect(noAgent).toMatch(/disabled="">Link tests<\/button>/);
  });

  test("the agent picked last time is the one the dialog starts on", () => {
    const two = [agent("claude", "Claude"), agent("codex", "Codex")];
    // Nothing remembered: the first one.
    expect(lastAgent(two)).toBe("claude");
    const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => "codex" }, configurable: true });
    try {
      expect(lastAgent(two)).toBe("codex");
      expect(dialog({ agents: two })).toContain('<option value="codex" selected="">Codex</option>');
      // One that is not offered any more is not picked.
      expect(lastAgent([two[0]!])).toBe("claude");
    } finally {
      if (before) Object.defineProperty(globalThis, "localStorage", before);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  test("the dialog waits for what could be linked before it offers anything", () => {
    const markup = html(<LinkTestsDialog agents={[agent("claude", "Claude")]} onStarted={noop} onClose={noop} />);
    expect(markup).toContain("Looking for tests…");
    expect(markup).toMatch(/disabled="">Link tests<\/button>/);
  });

  test("the folders dialog offers linking only where a specification folder is open", () => {
    const props = { folders: [], current: null, busy: false, onOpen: noop, onRemove: noop, onAdd: noop, onClose: noop } as unknown as Parameters<typeof SpecFoldersDialog>[0];
    expect(html(<SpecFoldersDialog {...props} onLinkTests={noop} />)).toContain("Link tests to specs…");
    expect(html(<SpecFoldersDialog {...props} />)).not.toContain("Link tests to specs…");
  });
});

const link = (over: Partial<JobLink>): JobLink => ({ fileName: "specs/api/orders.feature.md", title: "Orders", state: "pending", ...over });
const folder = (over: Partial<JobFolder>): JobFolder => ({ folder: "api", name: "API", roots: [], state: "pending", batches: [], notRead: 0, ...over });
const job = (over: Partial<ExtractionJob>): ExtractionJob => ({
  id: "j1",
  dataDir: "/work/specs-shop",
  codeDir: "/work/shop",
  project: "shop",
  state: "running",
  kind: "link",
  tests: { base: "https://github.com/acme/shop/blob/main/", repo: "acme/shop" },
  folders: [],
  startedAt: "2026-11-22T00:00:00.000Z",
  ...over,
});
const drafted = (links?: JobLink[]): JobFolder =>
  folder({
    state: "done",
    batches: [{ label: "", files: [], state: "done", fileName: "specs/api/orders.feature.md", title: "Orders", scenarios: 4 }],
    ...(links ? { links } : {}),
  });

describe("the pill while tests are linked", () => {
  test("a run that only links tests says how many features it is through and how it ended", () => {
    const some = folder({ state: "running", links: [link({ state: "done", linked: 3 }), link({ state: "running" }), link({})] });
    expect(progressLabel(job({ folders: [some] }))).toBe("Linking tests — 1 of 3 features");
    expect(progressLabel(job({ state: "cancelling", folders: [some] }))).toBe("Stopping the linking…");
    expect(progressLabel(job({ state: "interrupted", folders: [some] }))).toBe("Linking paused — 1 of 3 features");
    expect(progressLabel(job({ state: "cancelled", folders: [some] }))).toBe("Linking stopped — 1 of 3 features");
    const through = folder({ state: "done", links: [link({ state: "done", linked: 3 }), link({ state: "empty", note: "its code has no tests" })] });
    expect(progressLabel(job({ state: "done", folders: [through] }))).toBe("Tests linked — 3 links");
    const broken = folder({ state: "failed", error: "rate limited", links: [link({ state: "failed", error: "rate limited" })] });
    expect(progressLabel(job({ state: "done", folders: [through, broken] }))).toBe("Tests linked — 1 feature failed");
  });

  test("a run that drafts and then links says which of the two it is at", () => {
    const pending = folder({ batches: [{ label: "", files: [], state: "pending" }] });
    const drafting = job({ kind: "draft", folders: [drafted([link({})]), pending] });
    expect(linking(drafting)).toBe(false);
    expect(progressLabel(drafting)).toBe("Drafting specs — 1 of 2 folders");
    const atLinks = job({ kind: "draft", folders: [drafted([link({ state: "running" })]), drafted([link({})])] });
    expect(linking(atLinks)).toBe(true);
    expect(progressLabel(atLinks)).toBe("Linking tests — 0 of 2 features");
    const over = job({ kind: "draft", state: "done", folders: [drafted([link({ state: "done", linked: 5 })])] });
    expect(linking(over)).toBe(false);
    expect(progressLabel(over)).toBe("Specs drafted — 1 feature, 5 tests linked");
    expect(testsLinked(over)).toBe(5);
  });

  test("a folder's line says what came of its tests", () => {
    expect(folderLine(drafted([link({ state: "done", linked: 2 })]))).toBe("1 feature, 4 scenarios · 2 tests linked");
    expect(folderLine(drafted([link({ state: "running" })]))).toBe("1 feature, 4 scenarios · linking tests…");
    expect(folderLine(drafted([link({})]))).toBe("1 feature, 4 scenarios · tests still to link");
    expect(folderLine(drafted([link({ state: "empty", note: "its code has no tests" })]))).toBe("1 feature, 4 scenarios · its code has no tests");
    expect(folderLine(drafted([link({ state: "failed", error: "rate limited" })]))).toBe("1 feature, 4 scenarios · linking failed: rate limited");
    // A run that only links: the folder's features, not its batches.
    expect(folderLine(folder({ links: [link({})] }))).toBe("waiting");
    expect(folderLine(folder({ state: "running", links: [link({ state: "done", linked: 1 }), link({ state: "running" })] }))).toBe(
      "linking tests — 1 of 2 features…",
    );
    expect(folderLine(folder({ state: "done", links: [link({ state: "done", linked: 1 }), link({ state: "done", linked: 3 })] }))).toBe(
      "2 features · 4 tests linked",
    );
    expect(folderLine(folder({ state: "empty", links: [link({ state: "empty", note: "no test checks its scenarios" })] }))).toBe(
      "1 feature · no test checks its scenarios",
    );
    expect(folderLine(folder({ state: "cancelled", links: [link({})] }))).toBe("not linked");
  });

  test("a run with tests left to link can be taken up again and each linked feature reloads the page", () => {
    const left = job({ kind: "draft", state: "cancelled", folders: [drafted([link({})])] });
    expect(resumable(left)).toBe(true);
    expect(resumable(job({ kind: "draft", state: "done", folders: [drafted([link({ state: "failed", error: "x" })])] }))).toBe(true);
    expect(resumable(job({ kind: "draft", state: "done", folders: [drafted([link({ state: "done", linked: 1 })])] }))).toBe(false);
    expect(featuresTouched(left)).toBe(1);
    expect(featuresTouched(job({ kind: "draft", state: "done", folders: [drafted([link({ state: "done", linked: 1 })])] }))).toBe(2);
  });

  test("the list of a linking run opens each feature it linked and names the count", () => {
    const markup = html(
      <ExtractionFolders
        folders={[folder({ state: "done", links: [link({ state: "done", linked: 2 }), link({ fileName: "specs/api/b.feature.md", title: "Billing", state: "empty" })] })]}
        busy={false}
        onOpenFeature={noop}
        onRetry={noop}
      />,
    );
    expect(markup).toContain('<button type="button" class="extract-feature">Orders — 2 tests</button>');
    expect(markup).not.toContain("Billing");
  });

  test("the pill of a linking run is named for what it does and flags a failed feature", () => {
    const extraction = (j: ExtractionJob): Extraction => ({
      status: { job: j, published: true },
      cancel: async () => {},
      retry: async () => null,
      dismiss: async () => {},
      published: noop,
    });
    const fine = html(<ExtractionProgress extraction={extraction(job({ state: "done", folders: [folder({ state: "done", links: [link({ state: "done", linked: 2 })] })] }))} onOpenFeature={noop} onError={noop} />);
    expect(fine).toContain('title="Tests linked to the specs"');
    expect(fine).toContain("Tests linked — 2 links");
    expect(fine).not.toContain("needs-attention");
    const broken = job({ kind: "draft", state: "done", folders: [drafted([link({ state: "failed", error: "rate limited" })])] });
    const flagged = html(<ExtractionProgress extraction={extraction(broken)} onOpenFeature={noop} onError={noop} />);
    expect(flagged).toContain("needs-attention");
    expect(flagged).toContain("Specs drafted — linking failed for 1 feature");
  });
});

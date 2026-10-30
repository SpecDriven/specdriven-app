// A scenario as a qTest test case (specs/external-links/qtest-test-cases
// .feature.md "Each scenario becomes one test case"): its Given lines are the
// test case's precondition, each When starts a test step, and the Then lines
// that follow a When are that step's expected result. Pure — the REST calls
// are in ./qtest.ts.

import { escapeXml } from "./confluenceStorage";
import { scenarioAnchorUrl } from "./confluenceUrl";
import type { Scenario } from "./parser";

/** A test step as qTest's API takes it. */
export interface TestStepDraft {
  description: string;
  expected: string;
}

/** A test case as qTest's API takes it, before the parent and properties. */
export interface TestCaseDraft {
  name: string;
  description: string;
  precondition: string;
  test_steps: TestStepDraft[];
}

type Kind = "given" | "when" | "then";

/** One Given / When / Then block of a scenario: its kind and its lines as written. */
interface Block {
  kind: Kind;
  lines: string[];
}

// A step line: an optional list marker, the keyword — bold or not, with or
// without a colon — and the rest. `And` / `But` carry on the block before.
const STEP_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?(given|when|then|and|but)(?:\*\*)?:?(?:\s+|$)(.*)$/i;
const LIST_LINE = /^\s*[-*+]\s+(.*)$/;

/** qTest keeps a test case's name to 255 characters. */
const NAME_LIMIT = 255;

/**
 * A scenario's body as its Given / When / Then blocks, in order. A line that
 * continues the one before (a wrapped step, a note, a table row) stays with
 * it; a list item that names no keyword is one more line of the block it is
 * in; lines before any keyword count as Given.
 */
export function scenarioBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  const current = () => blocks[blocks.length - 1];
  const open = (kind: Kind) => {
    blocks.push({ kind, lines: [] });
    return current()!;
  };
  for (const raw of body.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const step = raw.match(STEP_LINE);
    if (step) {
      const word = step[1]!.toLowerCase();
      const text = step[2]!.trim();
      const kind: Kind = word === "and" || word === "but" ? (current()?.kind ?? "given") : (word as Kind);
      const block = kind === current()?.kind && (word === "and" || word === "but") ? current()! : open(kind);
      block.lines.push(`${capitalize(step[1]!)} ${text}`.trim());
      continue;
    }
    const item = raw.match(LIST_LINE);
    const block = current() ?? open("given");
    if (item) {
      block.lines.push(item[1]!.trim());
    } else if (block.lines.length === 0) {
      block.lines.push(raw.trim());
    } else {
      // A wrapped line continues the line before it.
      block.lines[block.lines.length - 1] += ` ${raw.trim()}`;
    }
  }
  return blocks;
}

function capitalize(word: string): string {
  const lower = word.toLowerCase();
  return lower === "and" || lower === "but" ? lower : lower[0]!.toUpperCase() + lower.slice(1);
}

/** Where a scenario's steps come from, for the test case's description. */
export interface StepSource {
  /** The feature's name, as its heading reads. */
  featureName: string;
  /** The feature's file in the data repo, so a qTest reader can find the spec. */
  file: string;
  /**
   * The feature's Confluence page, when it has one: the description then
   * links the scenario on it rather than naming the file, which a qTest
   * reader cannot open.
   */
  confluencePage?: { url: string; title: string };
}

/**
 * A test case's description, as the HTML qTest's rich-text field holds: the
 * feature, then its scenario on the Confluence page as a link — the url its
 * own text, so it reads the same wherever qTest shows the description as
 * plain text — or else the spec file's path.
 */
function descriptionOf(source: StepSource, number: number | null): string {
  const page = source.confluencePage;
  const where = page
    ? (() => {
        const url = escapeXml(scenarioAnchorUrl(page.url, page.title, number));
        return `<a href="${url}">${url}</a>`;
      })()
    : escapeXml(source.file);
  return `Scenario of the SpecDriven feature “${escapeXml(source.featureName)}” (${where}).`;
}

/**
 * The test case a scenario makes. Its number leads the name, so qTest's
 * alphabetical module listing keeps the feature's order; a draft, which has
 * no number, is named as is.
 */
export function scenarioToTestCase(scenario: Scenario, number: number | null, source: StepSource): TestCaseDraft {
  const blocks = scenarioBlocks(scenario.body);
  const precondition: string[] = [];
  const steps: TestStepDraft[] = [];
  // A Given once the steps have begun sets the next step up: it leads that
  // step's description rather than the precondition.
  let setup: string | null = null;
  const lead = (text: string) => (setup === null ? text : `${setup}\n${text}`);
  for (const block of blocks) {
    const text = block.lines.join("\n");
    if (block.kind === "given") {
      if (steps.length === 0 && setup === null) precondition.push(text);
      else setup = lead(text);
    } else if (block.kind === "when") {
      steps.push({ description: lead(text), expected: "" });
      setup = null;
    } else {
      const last = steps[steps.length - 1];
      if (last && last.expected === "" && setup === null) last.expected = text;
      else steps.push({ description: lead("Check the outcome"), expected: text });
      setup = null;
    }
  }
  if (setup !== null) steps.push({ description: setup, expected: "" });
  if (steps.length === 0) {
    steps.push({ description: precondition.length > 0 ? "Check the outcome" : scenario.name, expected: "" });
  }
  const label = number === null ? scenario.name : `S${number}: ${scenario.name}`;
  return {
    name: label.slice(0, NAME_LIMIT),
    description: descriptionOf(source, number),
    precondition: precondition.join("\n"),
    test_steps: steps,
  };
}

// specs/external-links/jira-wiki-import.feature.md as static markup: the
// import dialog's sources step (the urls collected, the agent to ask,
// Analyze), its review step (the title, each scenario kept or dropped, the
// rest the sources describe), and the Settings → Jira tokens. App.tsx owns
// the open state and the menu entry.
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentDescriptor } from "../src/server/agentTypes";
import {
  ImportFromJiraWikiDialog,
  modelProblem,
  oneShotAgents,
  sourceProblem,
  sourceRow,
  type ImportSource,
  type Proposal,
} from "../src/frontend/ImportFromJiraWikiDialog";
import { JiraTokens } from "../src/frontend/JiraToken";
import { agentChat, type AgentChoices } from "../src/frontend/agentChat";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};
const JIRA = { base: "https://jira.acme.com", user: "David V" };
const WIKI = { base: "https://wiki.acme.com", user: "David V" };

function agent(id: string, over: Partial<AgentDescriptor> & { oneShot?: boolean } = {}): AgentDescriptor {
  const { oneShot = true, ...rest } = over;
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    description: "",
    available: true,
    missingMessage: `${id} not found`,
    plugin: `agent-${id}`,
    capabilities: {
      permissionModes: ["default"],
      canInterrupt: true,
      canChangeModeMidSession: true,
      hasAccount: false,
      rememberPermissions: "session",
      oneShot,
    },
    defaultPermissionMode: "default",
    rank: 10,
    ...rest,
  };
}

const dialog = (over: Partial<Parameters<typeof ImportFromJiraWikiDialog>[0]> = {}) => (
  <ImportFromJiraWikiDialog
    folder="billing"
    jiraSites={[JIRA]}
    wikis={[WIKI]}
    agents={[agent("claude")]}
    onCreated={noop}
    onClose={noop}
    {...over}
  />
);

afterEach(() => {
  agentChat.setChoices("claude", undefined);
  agentChat.setChoices("codex", undefined);
});

/** What the Claude plugin offers: the sign-in's models, narrowed by its list in Settings → Claude, and its default. */
const CLAUDE_CHOICES: AgentChoices = {
  models: [
    { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus", description: "Claude Code's latest Opus" },
    { value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  ],
  model: "claude-sonnet-4-6",
  effort: null,
};

describe("the sources step", () => {
  test("a modal dialog with the url field, Add and Analyze, naming the folder", () => {
    const markup = html(dialog());
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Import from Jira/Wiki"');
    expect(markup).toContain("in <strong>billing</strong>");
    expect(markup).toContain('aria-label="Jira issue or Confluence page url"');
    expect(markup).toMatch(/<button type="button" class="btn btn-secondary" disabled="">Add<\/button>/);
    // Nothing to read yet: Analyze waits.
    expect(markup).toMatch(/<button type="button" class="btn btn-primary" disabled="">Analyze<\/button>/);
    expect(html(dialog({ folder: null }))).toContain("at the top level");
  });

  test("the agent is named with one, chosen with two, missed with none", () => {
    expect(html(dialog())).toContain("Analyzed by Claude.");
    expect(html(dialog())).not.toContain('aria-label="Analyze with"');
    const two = html(dialog({ agents: [agent("claude"), agent("codex")] }));
    expect(two).toContain('aria-label="Analyze with"');
    expect(two).toMatch(/<option value="claude"[^>]*>Claude<\/option>/);
    expect(two).toContain('<option value="codex">Codex</option>');
    const none = html(dialog({ agents: [agent("codex", { oneShot: false }), agent("pi", { available: false })] }));
    expect(none).toContain("install the Claude or Codex agent plugin");
    expect(none).not.toContain('aria-label="Analyze with"');
  });

  test("a Model field of the models the agent offers, its default chosen", () => {
    // An agent whose plugin offers no choices: the data repo's list for it
    // alone, and nothing to choose until that lists some.
    agentChat.setChoices("claude", null);
    const unlisted = html(dialog());
    expect(unlisted).toContain(
      '<select aria-label="Model" disabled=""><option value="" selected="">No models listed</option></select>',
    );
    expect(unlisted).toContain("Claude lists no models — set up its sign-in, or list some, in Settings → Claude.");
    const listed = html(dialog({ agentModels: { claude: ["opus", "sonnet"], codex: ["gpt-5-codex"] } }));
    expect(listed).toContain(
      '<select aria-label="Model"><option value="opus" selected="">opus</option><option value="sonnet">sonnet</option></select>',
    );
    expect(listed).not.toContain("gpt-5-codex");
    // The agent's plugin lists what its sign-in offers (the account's
    // models, a proxy's /v1/models, its aliases), narrowed by Settings → AI
    // agents; the agent's own default is chosen until another is.
    agentChat.setChoices("claude", CLAUDE_CHOICES);
    const offered = html(dialog());
    expect(offered).toContain(
      '<select aria-label="Model"><option value="opus">Opus — opus</option>' +
        '<option value="claude-sonnet-4-6" selected="">Claude Sonnet 4.6 — claude-sonnet-4-6</option></select>',
    );
    expect(offered).not.toContain("Settings → Jira");
    // No default of its own: the first offered.
    agentChat.setChoices("claude", { ...CLAUDE_CHOICES, model: null });
    expect(html(dialog())).toContain('<option value="opus" selected="">Opus — opus</option>');
    const none = html(dialog({ agents: [agent("pi", { available: false })] }));
    expect(none).not.toContain('aria-label="Model"');
  });

  test("a model name is a CLI's name for one; anything else is said", () => {
    expect(modelProblem("")).toBeNull();
    expect(modelProblem("claude-sonnet-4-6[1m]")).toBeNull();
    expect(modelProblem("us.anthropic.claude-sonnet-4-6:0")).toBeNull();
    expect(modelProblem("openai/gpt-5.1-codex")).toBeNull();
    expect(modelProblem("two words")).toContain("A model name is");
    expect(modelProblem("--flag")).toContain("A model name is");
  });

  test("the agents offered are the available ones that answer one-shot turns", () => {
    const all = [agent("claude"), agent("codex", { oneShot: false }), agent("pi", { available: false })];
    expect(oneShotAgents(all).map((a) => a.id)).toEqual(["claude"]);
  });

  test("a url is a Jira issue or a Confluence page row", () => {
    expect(sourceRow("https://jira.acme.com/browse/ABC-1")).toEqual({
      url: "https://jira.acme.com/browse/ABC-1",
      kind: "jira",
      label: "ABC-1",
    });
    expect(sourceRow("https://wiki.acme.com/spaces/ABC/pages/5/Quote+Policy")).toEqual({
      url: "https://wiki.acme.com/spaces/ABC/pages/5/Quote+Policy",
      kind: "wiki",
      label: "Quote Policy",
    });
    expect(sourceRow("https://wiki.acme.com/pages/viewpage.action?pageId=5")?.label).toBe("Confluence page");
    expect(sourceRow("https://acme.aha.io/features/APP-1")).toBeNull();
  });

  test("Add waits for an issue or page url on a site with a token, within the limits", () => {
    const rows: ImportSource[] = [];
    expect(sourceProblem("", rows, [JIRA], [WIKI])).toBeNull();
    expect(sourceProblem("https://acme.aha.io/features/APP-1", rows, [JIRA], [WIKI])).toMatch(/Not a Jira issue/);
    expect(sourceProblem("https://jira.acme.com/browse/ABC-1", rows, [JIRA], [WIKI])).toBeNull();
    expect(sourceProblem("https://jira.other.com/browse/ABC-1", rows, [JIRA], [WIKI])).toBe(
      "No Jira token for https://jira.other.com — add one in Settings → Jira.",
    );
    expect(sourceProblem("https://wiki.other.com/pages/5", rows, [JIRA], [WIKI])).toBe(
      "No Confluence token for https://wiki.other.com — add one in Settings → Confluence.",
    );
    const one: ImportSource = { url: "https://jira.acme.com/browse/ABC-1", kind: "jira", label: "ABC-1" };
    expect(sourceProblem("https://jira.acme.com/browse/abc-1", [one], [JIRA], [WIKI])).toMatch(/already in the list/);
    const five = [1, 2, 3, 4, 5].map((n) => ({ url: `https://jira.acme.com/browse/ABC-${n}`, kind: "jira" as const, label: "" }));
    expect(sourceProblem("https://jira.acme.com/browse/ABC-6", five, [JIRA], [WIKI])).toMatch(/At most 5 Jira/);
    const pages = [1, 2, 3, 4, 5].map((n) => ({ url: `https://wiki.acme.com/pages/${n}`, kind: "wiki" as const, label: "" }));
    expect(sourceProblem("https://wiki.acme.com/pages/6", pages, [JIRA], [WIKI])).toMatch(/At most 5 Confluence/);
  });
});

describe("the review step", () => {
  const proposal: Proposal = {
    title: "Quote Policy",
    agent: "Claude",
    sources: [{ kind: "jira", url: "https://jira.acme.com/browse/ABC-1", title: "ABC-1" }],
    scenarios: [
      { name: "Basic quote", body: "- Given: an account", sources: ["ABC-1"], keep: true, open: true },
      { name: "Declined quote", body: "- Given: no account", sources: [], keep: false, open: false },
    ],
    more: ["Renewal", "Expiry"],
  };

  test("the title, each scenario kept or dropped with its body on show, and Create with the count", () => {
    const markup = html(dialog({ initialProposal: proposal }));
    expect(markup).toContain("Review the proposed feature");
    expect(markup).toContain("Claude proposed 2 scenarios from 1 source");
    expect(markup).toContain('aria-label="Feature title" value="Quote Policy"');
    expect(markup).toContain('aria-label="Keep Basic quote" checked=""');
    expect(markup).toMatch(/aria-label="Keep Declined quote"(?! checked)/);
    expect(markup).toContain('aria-label="Scenario 1 name" class="import-scenario-name" value="Basic quote"');
    expect(markup).toContain('<pre class="import-scenario-body">- Given: an account</pre>');
    expect(markup).not.toContain("- Given: no account");
    expect(markup).toContain('<li class="dropped">');
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary">Create feature with 1 scenario<\/button>/);
    expect(markup).toContain(">Back<");
  });

  test("more than fifteen is said, with Continue; nothing when the sources hold no more", () => {
    const markup = html(dialog({ initialProposal: proposal }));
    expect(markup).toContain("The sources describe 2 more scenarios: Renewal, Expiry.");
    expect(markup).toContain(">Continue</button>");
    expect(html(dialog({ initialProposal: { ...proposal, more: [] } }))).not.toContain("more scenario");
  });

  test("Create waits for a title and a kept scenario", () => {
    const none = { ...proposal, scenarios: proposal.scenarios.map((s) => ({ ...s, keep: false })) };
    expect(html(dialog({ initialProposal: none }))).toMatch(/class="btn btn-primary" disabled="">Create feature with 0 scenarios/);
    expect(html(dialog({ initialProposal: { ...proposal, title: " " } }))).toMatch(/class="btn btn-primary" disabled=""/);
  });
});

describe("Settings → Jira", () => {
  test("lists each site with who its token signs in as, never the token, each with Remove", () => {
    const markup = html(<JiraTokens sites={[JIRA, { base: "https://acme.com/jira", user: "" }]} onChange={noop} />);
    expect(markup).toContain("<strong>https://jira.acme.com</strong>");
    expect(markup).toContain(" — as David V");
    expect(markup).toContain('aria-label="Remove the token for https://jira.acme.com"');
    expect(markup).toContain('aria-label="Remove the token for https://acme.com/jira"');
    expect(markup).toContain("Add another Jira site");
  });

  test("offers the url and token fields, the token as a password", () => {
    const markup = html(<JiraTokens sites={[]} onChange={noop} />);
    expect(markup).toContain("Add a Jira site");
    expect(markup).toContain('aria-label="Jira url"');
    expect(markup).toContain('aria-label="Jira personal access token" type="password"');
    expect(markup).toMatch(/<button class="secondary" disabled="">Save token<\/button>/);
    expect(markup).toContain("nothing is ever written to Jira");
  });
});

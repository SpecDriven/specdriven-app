// A scenario's page on a folder that cannot be written (the read-only site,
// or a spec folder with nowhere to push): a page, not the editor — its
// trail, the way to its neighbours, and the scenario rendered with its
// links. The Specs tab's pane while such a scenario is open.

import { ChevronLeft, ChevronRight, ExternalLink, GitPullRequest, Ticket } from "lucide-react";
import type { TabApp } from "../../plugins/client/tabs";
import { scenarioNumbers, titleFromFileName } from "../../server/parser";
import { Breadcrumbs } from "../Breadcrumbs";
import { CopyLinkButton } from "../CopyLinkButton";
import { externalLinkLabel } from "../externallinks";
import { renderMarkdown } from "../markdown";
import { featurePath } from "../route";
import { StatusIcon } from "../StatusIcon";
import { Tooltip } from "../Tooltip";
import { folderCrumbs } from "./crumbs";
import type { SpecsActions } from "./host";
import { useOpenFeature } from "./openFeature";
import { useSpecsSettings } from "./settings";

export function ScenarioPage({ app, actions }: { app: TabApp; actions: SpecsActions }) {
  const { selected, feature, editing } = useOpenFeature();
  const { showTestLinks } = useSpecsSettings();
  if (!editing || !selected || !feature) return null;
  const { backToFeature, scenarioLink, scenarioNav, stepScenario, testsTable } = actions;
  return (
    <div className="scenario-pane">
      <div className="editor-bar scenario-pane-bar page-header">
        <div className="scenario-pane-title">
          <Breadcrumbs
            items={[
              app.repoCrumb,
              ...folderCrumbs(selected),
              {
                label: feature.name || titleFromFileName(selected),
                href: featurePath(selected),
                title: `Back to ${feature.name || titleFromFileName(selected)}`,
                onClick: (e) => {
                  e.preventDefault();
                  backToFeature();
                },
              },
            ]}
          />
        </div>
        <div className="editor-actions scenario-pane-actions">
          <span className="scenario-nav" role="group" aria-label="Scenario navigation">
            <Tooltip label="Previous scenario" keys="<">
              <button
                type="button"
                className="ibtn"
                aria-label="Previous scenario"
                disabled={!scenarioNav.prev}
                onClick={() => stepScenario(-1)}
              >
                <ChevronLeft size={18} aria-hidden="true" />
              </button>
            </Tooltip>
            <Tooltip label="Next scenario" keys=">">
              <button
                type="button"
                className="ibtn"
                aria-label="Next scenario"
                disabled={!scenarioNav.next}
                onClick={() => stepScenario(1)}
              >
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            </Tooltip>
          </span>
          <CopyLinkButton
            keys="mod+shift+c"
            copied={app.copied === scenarioLink(selected, editing.scenario)}
            onCopy={() => app.copyLink(scenarioLink(selected, editing.scenario))}
          />
        </div>
      </div>
      <div className="scenario-pane-head">
        {editing.index !== null && scenarioNumbers(feature.scenarios)[editing.index] != null && (
          <span className="scenario-number">S{scenarioNumbers(feature.scenarios)[editing.index]}</span>
        )}
        <h2 className="scenario-pane-heading">{editing.scenario.name}</h2>
        <span className="version">v{editing.scenario.version}</span>
        <span className="chip static">
          <StatusIcon status={editing.scenario.status} size={14} />
          {editing.scenario.status}
        </span>
      </div>
      <div className="scenario-pane-body read-only-scenario">
        <div className="md-preview">{renderMarkdown(editing.scenario.body)}</div>
        {showTestLinks && testsTable(editing.scenario.tests)}
        {(editing.scenario.link || (editing.scenario.prs ?? []).length > 0) && (
          <div className="props">
            {editing.scenario.link && (
              <a
                className="chip"
                href={editing.scenario.link.url}
                target="_blank"
                rel="noreferrer"
                title={editing.scenario.link.url}
              >
                <Ticket size={14} aria-hidden="true" />
                {externalLinkLabel(editing.scenario.link)}
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
            {(editing.scenario.prs ?? []).map((pr) => (
              <a key={pr.url} className="chip" href={pr.url} target="_blank" rel="noreferrer" title={pr.url}>
                <GitPullRequest size={14} aria-hidden="true" />
                {pr.title || pr.url.replace(/^https:\/\/github\.com\//, "")}
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

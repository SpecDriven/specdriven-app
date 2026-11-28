// A feature's page (specs/ui/ui.feature.md "Main page"): its trail and
// name, what it links to and carries, its description, and its scenarios as
// cards. The Specs tab's pane while a feature is open and no scenario is.

import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ClipboardCheck,
  CloudUpload,
  CopyPlus,
  Ellipsis,
  ExternalLink,
  FileText,
  Flag,
  FolderInput,
  GitPullRequest,
  History,
  Link,
  Pencil,
  Plus,
  Tag,
  Ticket,
  Trash2,
  UserRound,
} from "lucide-react";
import { type CSSProperties } from "react";
import type { TabApp } from "../../plugins/client/tabs";
import { definitionsFor } from "../../server/customAttributes";
import { scenarioNumbers, titleFromFileName } from "../../server/parser";
import { RESOURCE_LINK_KINDS, RESOURCE_LINK_TOOLS, resourceChipLabel } from "../../server/resourceLinks";
import { StartSessionIcon } from "../ActionIcons";
import { AttributeChips, AttributesField } from "../AttributesField";
import { Breadcrumbs } from "../Breadcrumbs";
import { CopyLinkButton } from "../CopyLinkButton";
import { FeatureFlagChips, FeatureFlagsField } from "../FeatureFlagsField";
import { HeightResizer } from "../HeightResizer";
import { MarkdownEditor } from "../MarkdownEditor";
import { Menu } from "../Menu";
import { PolarityPill } from "../PolarityPill";
import { Popover } from "../Popover";
import { PullRequestField, PullRequestList } from "../PullRequestField";
import { QtestLinkField } from "../QtestLinkField";
import { ResourceLinkField, ResourceLinkList } from "../ResourceLinkField";
import { ScenarioFileList } from "../ScenarioFilesField";
import { StatusIcon } from "../StatusIcon";
import { TicketLinkField } from "../TicketLinkField";
import { SaveIndicator } from "../Toasts";
import { Tooltip } from "../Tooltip";
import { authorshipLine } from "../authorship";
import { externalLinkLabel, isBlankLinkDraft, linkDraftOf, ticketChipLabel } from "../externallinks";
import { initialsOf } from "../initials";
import { renderMarkdown } from "../markdown";
import { RESOURCE_LINK_ICON } from "../resourceLinkIcons";
import { featurePath, scenarioPath } from "../route";
import { pushHint, useSyncProblem } from "../syncProblem";
import { scenarioMovesInto } from "../tree";
import { attributeFilterLabel, scenarioMatches } from "../treeFilter";
import { folderCrumbs } from "./crumbs";
import { setConfluencePublishOpen, setWikiQtestPublishOpen } from "./dialogs";
import { DESC_HEIGHT_KEY, DESC_MIN, clampDescHeight, storeEditorHeight } from "./editorHeight";
import { useEditorState } from "./editorState";
import {
  setAssigneeMenuOpen,
  setCardMenu,
  setDescEdit,
  setDescHeight,
  setFeatureAttributesOpen,
  setFeatureFlagsOpen,
  setFeatureMenuOpen,
  setFeaturePrsOpen,
  setFeatureQtestDraft,
  setFeatureQtestError,
  setFeatureResourceOpen,
  setFeatureTicketsError,
  setFeatureTicketsOpen,
  setPublishMenuOpen,
  setRenameDraft,
  setResizingDesc,
  useFeaturePageState,
} from "./featurePageState";
import type { SpecsActions } from "./host";
import { useSpecsListing } from "./listing";
import { setEditing, setSelectedScenario, useOpenFeature } from "./openFeature";
import { isCardControl, scenarioTarget } from "./scenarioEdit";
import { scenarioKey, scenarioSelected, toggleScenarioSelected, useSpecSelection } from "./selection";
import { useSpecsSettings } from "./settings";
import { setScenarioDrag, setScenarioDropAt, useTreeState } from "./treeState";

/** A feature file's name without its folders and extensions. */
const fileStem = (fileName: string) => fileName.split("/").pop()!.split(".")[0]!;

export function FeaturePage({ app, actions }: { app: TabApp; actions: SpecsActions }) {
  const { selected, feature, dirty, selectedScenario, editing } = useOpenFeature();
  const {
    renameDraft,
    renaming,
    descEdit,
    featureMenuOpen,
    publishMenuOpen,
    assigneeMenuOpen,
    assignedSaving,
    featureTicketsOpen,
    featureTicketsError,
    featureTicketsSaving,
    featureQtestDraft,
    featureQtestError,
    featureQtestSaving,
    featurePrsOpen,
    featureFlagsOpen,
    featureAttributesOpen,
    featureResourceOpen,
    resizingDesc,
    descHeight,
    cardMenu,
  } = useFeaturePageState();
  const { saving, savedAt, publishing } = useEditorState();
  const {
    qtestLinks,
    assignments,
    projectManagement,
    projectManagementTool,
    featureFlags,
    resourceLinksOn,
    previewLines,
    deletePublished,
    scenarioPolarity,
    showTestLinks,
  } = useSpecsSettings();
  const { features } = useSpecsListing();
  const { filter, scenarioDrag, scenarioDropAt } = useTreeState();
  // A card's checkbox follows what is checked for a session.
  useSpecSelection();
  /** The last push that failed, said beside the description editor's hint. */
  const syncProblem = useSyncProblem();
  // The shell's: the trail's first crumb, "Copy link", the autosave interval.
  const { repoCrumb, copied, copyLink, autosaveSeconds } = app;
  // What App.tsx still owns (./host.ts SpecsActions).
  const {
    assignableMembers,
    attributeDefs,
    cloneTreeScenario,
    closeDescriptionEditor,
    codeGen,
    confluenceEnabled,
    demo,
    descPaneRef,
    descSaved,
    dropTreeScenario,
    endScenarioDrag,
    hosted,
    knownAttributes,
    locked,
    moveFeaturePrompt,
    moveScenarioToFeature,
    newScenario,
    newVersion,
    openDescriptionEditor,
    openQtestPublish,
    pluginCrumbs,
    publish,
    removeFeature,
    renameDraftRef,
    renameFile,
    renameSelected,
    reorderScenario,
    saveAssigned,
    saveFeatureAttributes,
    saveFeatureFlags,
    saveFeatureQtest,
    saveFeatureTickets,
    savePullRequests,
    saveResourceLinks,
    scenarioLink,
    scenarioRefs,
    sessionCount,
    sessionRunning,
    spaClick,
    startSession,
    testsTable,
    toggleScenarioPolarityAt,
  } = actions;
  // The description editor belongs to the feature it was opened on.
  const descOpen = descEdit !== null && descEdit.file === selected;
  const featureLinkOpen = featureTicketsOpen;
  const featureQtestOpen = featureQtestDraft !== null;
  const hasProposed = feature?.scenarios.some((s) => s.status === "proposed") ?? false;
  if (!selected || !feature) return null;
  return (
    <>
      <header className="editor-bar page-header">
        {/* specs/ui/ui.feature.md "Main page": the trail ends in the
            feature name (the file's `# <name>` heading), never the file
            name. Clicking the name edits it — committed and pushed on the
            server; the file name never changes. */}
        <Breadcrumbs
          items={[repoCrumb, ...folderCrumbs(selected), ...pluginCrumbs(selected)]}
          tail={
            locked ? (
              <span className="crumb current">{feature.name || titleFromFileName(selected)}</span>
            ) : renameDraft === null ? (
              <Tooltip label="Rename feature">
                <button
                  type="button"
                  className="crumb current"
                  onClick={() =>
                    setRenameDraft(feature.name || titleFromFileName(selected))
                  }
                >
                  {feature.name || titleFromFileName(selected)}
                </button>
              </Tooltip>
            ) : (
              <form
                className="rename-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void renameSelected();
                }}
              >
                <input
                  className="rename-input"
                  value={renameDraft}
                  aria-label="Feature name"
                  autoFocus
                  spellCheck={false}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      renameDraftRef.current = null;
                      setRenameDraft(null);
                    }
                  }}
                  // Leaving the field saves, as in-place edits do; ESC
                  // or Cancel is the way out without saving.
                  onBlur={() => void renameSelected()}
                />
                {/* mousedown would blur the field first — save on
                    blur — so the buttons keep the focus where it is
                    and act on click alone. */}
                <button
                  type="submit"
                  className="link"
                  disabled={renaming || !renameDraft.trim()}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {renaming ? "Renaming…" : "Save"}
                </button>
                <button
                  type="button"
                  className="link"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    renameDraftRef.current = null;
                    setRenameDraft(null);
                  }}
                >
                  Cancel
                </button>
              </form>
            )
          }
        />
        <div className="editor-actions page-actions">
          <SaveIndicator
            saving={saving}
            savedAt={savedAt}
            dirty={dirty || (!!descEdit && descEdit.text !== descSaved.current)}
          />
          {/* The read-only site has no ⋯ menu, so the feature's
              "Copy link" is a button of its own. */}
          {locked && (
            <CopyLinkButton
              keys="mod+shift+c"
              copied={copied === featurePath(selected)}
              onCopy={() => void copyLink(featurePath(selected))}
            />
          )}
          {/* New scenario (specs/ui/ui.feature.md "Add A Scenario
              Button"): from the header, pinned above the list, so it is
              always in view — at the end of the feature; a card's ⋯
              adds one below that card. */}
          {!locked && (
          <>
          <Tooltip label="New scenario" keys="c">
            <button
              type="button"
              className="ibtn"
              aria-label="New scenario"
              onClick={() => void newScenario()}
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          {/* The description editor (specs/editor/feature-editor
              .feature.md): switches the description pane below between
              rendered and editable. */}
          <Tooltip
            label={
              descOpen
                ? "Done editing the description"
                : feature.description
                  ? "Edit description"
                  : "Add description"
            }
          >
            <button
              type="button"
              className={`ibtn${descOpen ? " active" : ""}`}
              aria-label={descOpen ? "Done editing the description" : "Edit description"}
              aria-pressed={descOpen}
              onClick={() =>
                descOpen
                  ? void closeDescriptionEditor()
                  : openDescriptionEditor(selected, feature.description)
              }
            >
              <Pencil size={15} aria-hidden="true" />
            </button>
          </Tooltip>
          <span className="page-more">
            <Tooltip label="More actions">
              <button
                type="button"
                className="ibtn"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={featureMenuOpen}
                onClick={() => setFeatureMenuOpen((o) => !o)}
              >
                <Ellipsis size={15} aria-hidden="true" />
              </button>
            </Tooltip>
            <Menu
              open={featureMenuOpen}
              onClose={() => setFeatureMenuOpen(false)}
              label="Feature actions"
              className="page-menu"
              containerSelector=".page-more"
              items={[
                {
                  id: "rename",
                  label: "Rename feature",
                  icon: <Pencil size={13} />,
                  onSelect: () =>
                    setRenameDraft(feature.name || titleFromFileName(selected)),
                },
                {
                  id: "rename-file",
                  label: `Rename file “${fileStem(selected)}”`,
                  icon: <FileText size={13} />,
                  onSelect: () => void renameFile(selected),
                },
                {
                  id: "move",
                  label: "Move to folder…",
                  icon: <FolderInput size={13} />,
                  onSelect: () => void moveFeaturePrompt(),
                },
                ...(codeGen
                  ? [
                      {
                        id: "session",
                        label: hosted ? "Open Prompt in Claude Code" : "Start AI Session",
                        icon: <StartSessionIcon size={13} />,
                        // Nothing checked, picked or open: nothing to run over.
                        disabled: sessionRunning || sessionCount === 0,
                        onSelect: () => void startSession(),
                      },
                    ]
                  : []),
                {
                  id: "copy",
                  label: copied === featurePath(selected) ? "Copied" : "Copy link",
                  icon: <Link size={13} />,
                  keys: "mod+shift+c",
                  onSelect: () => void copyLink(featurePath(selected)),
                },
                // Publish All (crud-feature.md "publish each scenario
                // individually"): marks every scenario published —
                // here and on the publish rollup chip; individual
                // scenarios publish from their cards.
                {
                  id: "publish-all",
                  label: publishing === "all" ? "Publishing…" : "Publish all",
                  icon: <CloudUpload size={13} />,
                  keys: "mod+enter",
                  disabled: publishing !== null,
                  onSelect: () => void publish(),
                },
                // "Publish to Confluence…" only while Confluence is
                // switched on in Settings (confluence-wiki.feature.md).
                ...(confluenceEnabled
                  ? [
                      {
                        id: "confluence",
                        label: "Publish to Confluence…",
                        icon: <BookOpen size={13} />,
                        onSelect: () => setConfluencePublishOpen(true),
                      },
                    ]
                  : []),
                ...(demo || hosted || !qtestLinks
                  ? []
                  : [
                      {
                        id: "qtest",
                        label: "Publish qTest Test Cases…",
                        icon: <ClipboardCheck size={13} />,
                        onSelect: () => void openQtestPublish(feature),
                      },
                      // Both at once ("Publish the page and the test
                      // cases from one dialog"): the page first, so the
                      // test cases link their scenarios on it. The page
                      // needs Confluence on, so this shows only then.
                      ...(confluenceEnabled
                        ? [
                            {
                              id: "wiki-qtest",
                              label: "Publish to Wiki & qTest…",
                              icon: <ClipboardCheck size={13} />,
                              onSelect: () => setWikiQtestPublishOpen(true),
                            },
                          ]
                        : []),
                    ]),
                {
                  id: "delete",
                  label: "Delete feature",
                  icon: <Trash2 size={13} />,
                  danger: true,
                  onSelect: () => {
                    const listing = features.find((f) => f.fileName === selected);
                    if (listing) void removeFeature(listing);
                  },
                },
              ]}
            />
          </span>
          </>
          )}
        </div>
      </header>
      {/* Properties as chips (specs/ui/ui.feature.md "Design system"):
          the publish rollup; the assignee (src/server/members.ts —
          the data repo's project-settings.yaml, saved on the spot,
          off unless Settings turns assignments on); the ticket
          (specs/external-links/project-management-jira-linear-etc
          .feature.md "Add link to feature"), edited in a popover. */}
      {locked ? (
        /* The read-only site: the same properties, as plain chips and
           links — nothing to assign, link or publish. */
        <div className="props">
          <span className="chip static">
            <StatusIcon status="published" size={14} />
            {feature.scenarios.filter((s) => s.status === "published").length} /{" "}
            {feature.scenarios.length} published
          </span>
          {authorshipLine(feature) && (
            <span className="chip static feature-authors">
              <UserRound size={14} aria-hidden="true" />
              {authorshipLine(feature)}
            </span>
          )}
          {(feature.links ?? []).map((l) => (
            <a key={l.url} className="chip" href={l.url} target="_blank" rel="noreferrer" title={l.url}>
              <Ticket size={14} aria-hidden="true" />
              {externalLinkLabel(l)}
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          ))}
          {(feature.prs ?? []).map((pr) => (
            <a key={pr.url} className="chip" href={pr.url} target="_blank" rel="noreferrer" title={pr.url}>
              <GitPullRequest size={14} aria-hidden="true" />
              {pr.title || pr.url.replace(/^https:\/\/github\.com\//, "")}
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          ))}
          {feature.confluence && (
            <a className="chip" href={feature.confluence.url} target="_blank" rel="noreferrer">
              <BookOpen size={14} aria-hidden="true" />
              Confluence
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
        </div>
      ) : (
      <div className="props">
        {/* The publish rollup, and the way to Publish All (crud-feature
            .md "publish each scenario individually"): its menu marks
            every scenario published; the dot means there is something
            unpublished. Sync lives in the sidebar header, beside the
            data folder. */}
        <span className="chip-anchor publish-anchor">
          <button
            type="button"
            className="chip"
            aria-haspopup="menu"
            aria-expanded={publishMenuOpen}
            aria-label={`${feature.scenarios.filter((s) => s.status === "published").length} of ${feature.scenarios.length} published${publishing === null && (dirty || hasProposed) ? ", unpublished changes" : ""}`}
            onClick={() => setPublishMenuOpen((o) => !o)}
          >
            <StatusIcon status="published" size={14} />
            {feature.scenarios.filter((s) => s.status === "published").length} /{" "}
            {feature.scenarios.length} published
            {publishing === null && (dirty || hasProposed) && (
              <span className="dot" role="img" aria-label="unpublished changes" />
            )}
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          <Menu
            open={publishMenuOpen}
            onClose={() => setPublishMenuOpen(false)}
            label="Publish"
            className="chip-menu"
            containerSelector=".publish-anchor"
            items={[
              {
                id: "all",
                label: publishing === "all" ? "Publishing…" : "Publish all",
                icon: <CloudUpload size={13} />,
                keys: "mod+enter",
                disabled: publishing !== null,
                onSelect: () => void publish(),
              },
            ]}
          />
        </span>
        {/* Who created the feature and last changed it
            (specs/app/specs-authorship.feature.md). */}
        {authorshipLine(feature) && (
          <span className="chip static feature-authors">
            <UserRound size={14} aria-hidden="true" />
            {authorshipLine(feature)}
          </span>
        )}
        {assignments && (
          <span className="chip-anchor assignee-anchor">
            <button
              type="button"
              className={`chip${feature.assigned ? "" : " muted"}`}
              aria-haspopup="menu"
              aria-expanded={assigneeMenuOpen}
              aria-label={`Assigned: ${feature.assigned ?? "nobody"}`}
              disabled={assignedSaving}
              onClick={() => setAssigneeMenuOpen((o) => !o)}
            >
              {feature.assigned ? (
                <span className="avatar chip-avatar" aria-hidden="true">
                  {initialsOf(feature.assigned)}
                </span>
              ) : (
                <UserRound size={14} aria-hidden="true" />
              )}
              {feature.assigned ?? "Unassigned"}
            </button>
            <Menu
              open={assigneeMenuOpen}
              onClose={() => setAssigneeMenuOpen(false)}
              label="Assigned member"
              className="chip-menu"
              containerSelector=".assignee-anchor"
              items={[
                {
                  id: "",
                  label: "Unassigned",
                  checked: !feature.assigned,
                  onSelect: () => void saveAssigned(""),
                },
                ...assignableMembers().map((m) => ({
                  id: m.name,
                  label: m.name,
                  checked: feature.assigned === m.name,
                  icon: (
                    <span className="avatar chip-avatar" aria-hidden="true">
                      {initialsOf(m.name)}
                    </span>
                  ),
                  onSelect: () => void saveAssigned(m.name),
                })),
              ]}
            />
          </span>
        )}
        {projectManagement && (
          <span className="chip-anchor ticket-anchor">
            {/* "Several tickets on a feature": the chip reads the one
                ticket, or counts them; the popover lists them and
                takes another, up to five. */}
            <button
              type="button"
              className={`chip${feature.links?.length ? "" : " muted"}`}
              aria-haspopup="dialog"
              aria-expanded={featureLinkOpen}
              onClick={() => {
                setFeatureTicketsError(null);
                setFeatureTicketsOpen((open) => !open);
              }}
            >
              <Ticket size={14} aria-hidden="true" />
              {ticketChipLabel(feature.links)}
            </button>
            {feature.links?.length === 1 && (
              <a
                className="chip-ext"
                href={feature.links[0]!.url}
                target="_blank"
                rel="noreferrer"
                title={feature.links[0]!.url}
                aria-label={`Open ${externalLinkLabel(feature.links[0]!)}`}
              >
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
            <Popover
              open={featureLinkOpen}
              onClose={() => setFeatureTicketsOpen(false)}
              label="Tickets for this feature"
              className="chip-popover ticket-popover"
              containerSelector=".ticket-anchor"
            >
              <p className="hint">The {projectManagementTool} tickets that track this feature.</p>
              <TicketLinkField
                links={feature.links ?? []}
                tool={projectManagementTool}
                error={featureTicketsError}
                saving={featureTicketsSaving}
                autoFocus
                onChange={(links) => saveFeatureTickets(links)}
              />
              <div className="dialog-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setFeatureTicketsOpen(false)}
                >
                  Close
                </button>
              </div>
            </Popover>
          </span>
        )}
        {/* specs/external-links/qtest-test-cases.feature.md: the qTest
            test case covering the feature as a whole. */}
        {qtestLinks && (
          <span className="chip-anchor qtest-anchor">
            <button
              type="button"
              className={`chip${feature.qtest ? "" : " muted"}`}
              aria-haspopup="dialog"
              aria-expanded={featureQtestOpen}
              onClick={() => {
                if (featureQtestOpen) {
                  setFeatureQtestDraft(null);
                } else {
                  setFeatureQtestError(null);
                  setFeatureQtestDraft(linkDraftOf(feature.qtest));
                }
              }}
            >
              <ClipboardCheck size={14} aria-hidden="true" />
              {feature.qtest ? externalLinkLabel(feature.qtest) : "Link qTest"}
            </button>
            {feature.qtest && (
              <a
                className="chip-ext"
                href={feature.qtest.url}
                target="_blank"
                rel="noreferrer"
                title={feature.qtest.url}
                aria-label={`Open ${externalLinkLabel(feature.qtest)}`}
              >
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
            <Popover
              open={featureQtestOpen}
              onClose={() => setFeatureQtestDraft(null)}
              label="qTest test case for this feature"
              className="chip-popover"
              containerSelector=".qtest-anchor"
            >
              {featureQtestDraft !== null && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveFeatureQtest();
                  }}
                >
                  <p className="hint">
                    The qTest test case that covers this feature. Clear the fields to
                    remove the link.
                  </p>
                  <div className="link-field">
                    <QtestLinkField
                      draft={featureQtestDraft}
                      onChange={(draft) => {
                        setFeatureQtestError(null);
                        setFeatureQtestDraft(draft);
                      }}
                      error={featureQtestError}
                      autoFocus
                    />
                  </div>
                  <div className="dialog-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setFeatureQtestDraft(null)}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={featureQtestSaving}>
                      {featureQtestSaving
                        ? "Saving…"
                        : feature.qtest && isBlankLinkDraft(featureQtestDraft)
                          ? "Remove link"
                          : "Save"}
                    </button>
                  </div>
                </form>
              )}
            </Popover>
          </span>
        )}
        {/* specs/external-links/confluence-wiki.feature.md: the page the
            feature was published to. Read-only — publishing sets it. */}
        {feature.confluence && (
          <span className="chip-anchor confluence-anchor">
            <a
              className="chip"
              href={feature.confluence.url}
              target="_blank"
              rel="noreferrer"
              title={feature.confluence.url}
              aria-label="Open the Confluence page"
            >
              <BookOpen size={14} aria-hidden="true" />
              Confluence
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          </span>
        )}
        {/* specs/external-links/related-pull-requests.feature.md "Link
            a pull request to a feature": the chip counts the feature's
            pull requests; the popover lists them and takes another. */}
        <span className="chip-anchor pr-anchor">
          <button
            type="button"
            className={`chip${feature.prs?.length ? "" : " muted"}`}
            aria-haspopup="dialog"
            aria-expanded={featurePrsOpen}
            onClick={() => setFeaturePrsOpen((open) => !open)}
          >
            <GitPullRequest size={14} aria-hidden="true" />
            {feature.prs?.length
              ? `${feature.prs.length} PR${feature.prs.length === 1 ? "" : "s"}`
              : "Link PR"}
          </button>
          <Popover
            open={featurePrsOpen}
            onClose={() => setFeaturePrsOpen(false)}
            label="Pull requests for this feature"
            className="chip-popover pr-popover"
            containerSelector=".pr-anchor"
          >
            <p className="hint">The pull requests implementing this feature.</p>
            <PullRequestField
              prs={feature.prs ?? []}
              autoFocus
              onChange={(prs) => savePullRequests(null, prs)}
            />
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setFeaturePrsOpen(false)}>
                Close
              </button>
            </div>
          </Popover>
        </span>
        {/* specs/app/feature-flags.feature.md: the flags gating the
            feature as a whole, a chip each, and a chip whose popover
            adds, toggles and removes them — saved on the spot. Only
            while Settings turns feature flags on. The edit chip comes
            first, so adding a flag never moves the popover's anchor. */}
        {featureFlags && (
          <span className="chip-anchor feature-flags-anchor">
            <button
              type="button"
              className={`chip${feature.flags?.length ? "" : " muted"}`}
              aria-haspopup="dialog"
              aria-expanded={featureFlagsOpen}
              onClick={() => setFeatureFlagsOpen((open) => !open)}
            >
              <Flag size={14} aria-hidden="true" />
              {feature.flags?.length ? "Edit flags" : "Add flag"}
            </button>
            <Popover
              open={featureFlagsOpen}
              onClose={() => setFeatureFlagsOpen(false)}
              label="Feature flags for this feature"
              className="chip-popover feature-flags-popover"
              containerSelector=".feature-flags-anchor"
            >
              <p className="hint">
                The feature flags gating this feature, written <code>[ff:name:on|off]</code> under its
                heading.
              </p>
              <FeatureFlagsField
                flags={feature.flags ?? []}
                autoFocus
                onChange={(flags) => saveFeatureFlags(flags)}
              />
              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setFeatureFlagsOpen(false)}>
                  Close
                </button>
              </div>
            </Popover>
          </span>
        )}
        {featureFlags && <FeatureFlagChips flags={feature.flags} />}
        {/* specs/app/custom-attributes.feature.md: the feature's own
            attributes, a chip each, whenever it carries any, and —
            once the data repo defines attributes for features — a
            chip whose popover adds, changes and removes them, saved
            on the spot. */}
        {definitionsFor(attributeDefs, "feature").length > 0 && (
          <span className="chip-anchor feature-attributes-anchor">
            <button
              type="button"
              className={`chip${feature.attributes?.length ? "" : " muted"}`}
              aria-haspopup="dialog"
              aria-expanded={featureAttributesOpen}
              onClick={() => setFeatureAttributesOpen((open) => !open)}
            >
              <Tag size={14} aria-hidden="true" />
              {feature.attributes?.length ? "Edit attributes" : "Add attribute"}
            </button>
            <Popover
              open={featureAttributesOpen}
              onClose={() => setFeatureAttributesOpen(false)}
              label="Attributes of this feature"
              className="chip-popover feature-flags-popover attributes-popover"
              containerSelector=".feature-attributes-anchor"
            >
              <p className="hint">
                The custom attributes of this feature, as Settings → Custom attributes defines them.
              </p>
              <AttributesField
                attributes={feature.attributes ?? []}
                where="feature"
                defs={attributeDefs}
                known={knownAttributes}
                autoFocus
                onChange={(attributes) => saveFeatureAttributes(attributes)}
              />
              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setFeatureAttributesOpen(false)}>
                  Close
                </button>
              </div>
            </Popover>
          </span>
        )}
        <AttributeChips
          attributes={feature.attributes}
          where="feature"
          defs={attributeDefs}
          known={knownAttributes}
        />
        {/* specs/external-links/aha-and-figma-links.feature.md "Link
            Aha! and Figma to a feature": a chip per tool switched on
            in Settings, counting the feature's links; the popover
            lists them and takes another. */}
        {RESOURCE_LINK_KINDS.filter((kind) => resourceLinksOn[kind]).map((kind) => {
          const { name, noun } = RESOURCE_LINK_TOOLS[kind];
          const Icon = RESOURCE_LINK_ICON[kind];
          const links = feature[kind] ?? [];
          return (
            <span className={`chip-anchor resource-anchor-${kind}`} key={kind}>
              <button
                type="button"
                className={`chip${links.length ? "" : " muted"}`}
                aria-haspopup="dialog"
                aria-expanded={featureResourceOpen === kind}
                onClick={() => setFeatureResourceOpen((open) => (open === kind ? null : kind))}
              >
                <Icon size={14} aria-hidden="true" />
                {resourceChipLabel(kind, links.length)}
              </button>
              <Popover
                open={featureResourceOpen === kind}
                onClose={() => setFeatureResourceOpen(null)}
                label={`${name} links for this feature`}
                className="chip-popover pr-popover"
                containerSelector={`.resource-anchor-${kind}`}
              >
                <p className="hint">
                  The {name} {noun}s behind this feature.
                </p>
                <ResourceLinkField
                  kind={kind}
                  links={links}
                  autoFocus
                  onChange={(next) => saveResourceLinks(null, kind, next)}
                />
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setFeatureResourceOpen(null)}
                  >
                    Close
                  </button>
                </div>
              </Popover>
            </span>
          );
        })}
      </div>
      )}
      {descOpen && descEdit ? (
        /* specs/editor/feature-editor.feature.md "Edit feature
           descrition": the description pane becomes the editor, sized
           like the rendered pane so the scenario list stays in view. */
        <div
          className={`feature-desc-editor${resizingDesc ? " resizing" : ""}`}
          ref={descPaneRef}
          style={
            descHeight === null ? undefined : ({ "--desc-h": `${descHeight}px` } as CSSProperties)
          }
        >
          <MarkdownEditor
            value={descEdit.text}
            onChange={(text) => setDescEdit({ file: descEdit.file, text })}
            placeholder="Describe this feature — any markdown. Saved automatically."
            // Opens rendered — a description is read far more often
            // than rewritten. A blank one has nothing to render, so a
            // new feature's editor opens ready to type into instead.
            initialTab={descSaved.current ? "preview" : "write"}
          />
          <span className={syncProblem !== null ? "readme-hint sync-failing" : "readme-hint"}>
            Saved automatically every {autosaveSeconds} seconds; {pushHint(syncProblem)}{" "}
            Done shows it rendered.
          </span>
          {/* The editor's lower boundary is a grab strip: drag it to give
              the description more or less room, double-click to restore
              the default third of the window. Sized like the sidebar
              divider, and nudged by the arrow keys when focused. */}
          <HeightResizer
            label="Resize the description editor"
            min={DESC_MIN}
            height={descHeight}
            target={descPaneRef}
            clamp={clampDescHeight}
            onHeight={setDescHeight}
            onCommit={(h) => storeEditorHeight(DESC_HEIGHT_KEY, h)}
            onReset={() => {
              setDescHeight(null);
              storeEditorHeight(DESC_HEIGHT_KEY, null);
            }}
            onResizing={setResizingDesc}
          />
        </div>
      ) : (
        feature.description && (
          /* Clicking the rendered description opens the editor too —
             links inside it still open as links. */
          <div
            className={`feature-desc md-preview${locked ? "" : " editable"}`}
            title={locked ? undefined : "Click to edit the description"}
            onClick={(e) => {
              if (locked || (e.target as HTMLElement).closest("a")) return;
              openDescriptionEditor(selected, feature.description);
            }}
          >
            {renderMarkdown(feature.description)}
          </div>
        )
      )}
      {/* specs/ui/ui.feature.md "Scenario List": each card renders its
          body as a Markdown preview, clamped to n lines (n set in
          Settings). */}
      <div
        className="scenarios"
        style={{ "--preview-lines": previewLines } as CSSProperties}
      >
        {feature.scenarios.map((s, i) => {
          if (!scenarioMatches(s, feature, filter)) return null;
          // A card is a drag source (specs/ui/navigation.feature.md
          // "drag a scenario to another feature"): onto another
          // feature in the sidebar it moves there; onto another card
          // here it lands before or after it, as a drag in the
          // sidebar outline does — or, dragged out of another
          // feature's outline, moves in at that spot.
          const isCard = (x: { file?: string; name: string; version: number } | null) =>
            x !== null && x.file === selected && x.name === s.name && x.version === s.version;
          const droppable =
            scenarioDrag !== null &&
            !isCard(scenarioDrag) &&
            (scenarioDrag.file === selected || scenarioMovesInto(scenarioDrag, selected, deletePublished));
          const dropEdge =
            droppable && isCard(scenarioDropAt)
              ? scenarioDropAt!.after
                ? " drop-after"
                : " drop-before"
              : "";
          return (
          <article
            key={i}
            ref={(el) => {
              scenarioRefs.current[i] = el;
            }}
            className={`scenario-card ${s.status}${i === selectedScenario ? " selected" : ""}${dropEdge}${
              isCard(scenarioDrag) ? " dragging" : ""
            }`}
            draggable={!locked}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", scenarioPath(selected, s));
              e.dataTransfer.effectAllowed = "move";
              setScenarioDrag({ file: selected, name: s.name, version: s.version, status: s.status });
            }}
            onDragEnd={endScenarioDrag}
            onDragOver={(e) => {
              if (!droppable) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const box = e.currentTarget.getBoundingClientRect();
              const after = e.clientY > box.top + box.height / 2;
              if (!isCard(scenarioDropAt) || scenarioDropAt!.after !== after) {
                setScenarioDropAt({ file: selected, name: s.name, version: s.version, after });
              }
            }}
            onDrop={(e) => {
              if (!droppable) return;
              e.preventDefault();
              const box = e.currentTarget.getBoundingClientRect();
              const dragged = scenarioDrag!;
              const at = { name: s.name, version: s.version, after: e.clientY > box.top + box.height / 2 };
              endScenarioDrag();
              if (dragged.file === selected) void dropTreeScenario(selected, dragged, at, at.after);
              else void moveScenarioToFeature(dragged.file, dragged, selected, at);
            }}
            // A click anywhere on the card highlights it (the title link
            // does so itself); a double-click opens it in the editor
            // pane, like Enter. The card's controls keep their own
            // clicks.
            onClick={(e) => {
              if (isCardControl(e.target)) return;
              setSelectedScenario(i);
            }}
            onDoubleClick={(e) => {
              if (isCardControl(e.target)) return;
              setEditing({ index: i, scenario: { ...s } });
            }}
            // A right-click opens the card's ⋯ menu, on the card it
            // also highlights.
            onContextMenu={(e) => {
              if (locked || isCardControl(e.target)) return;
              e.preventDefault();
              setSelectedScenario(i);
              setCardMenu(i);
            }}
          >
            <header>
              <span className="scenario-title">
                {/* Code gen selection (specs/agents/claude.feature.md): a
                    session takes whole specs, checked in the sidebar,
                    or single scenarios, checked here. Gone when the
                    Settings switch is off. */}
                {codeGen && (
                  <input
                    type="checkbox"
                    className="scenario-check"
                    checked={scenarioSelected(selected, s)}
                    onChange={() =>
                      toggleScenarioSelected(selected, feature.scenarios, scenarioKey(s))
                    }
                    aria-label={`Select scenario ${s.name} for an AI session`}
                    title="Include this scenario in an AI session"
                  />
                )}
                {/* The title is the scenario's permalink
                    (specs/ui/navigation.feature.md "share a link"). */}
                {/* Status as a glyph, not a word (specs/ui/ui.feature.md
                    "Design system"): draft, proposed or published. */}
                {/* Its number — its place in the file (specs/ui/
                    ui.feature.md "number scenarios"); a draft has none. */}
                {scenarioNumbers(feature.scenarios)[i] !== null && (
                  <span className="scenario-number">
                    S{scenarioNumbers(feature.scenarios)[i]}
                  </span>
                )}
                <StatusIcon status={s.status} />
                <a
                  href={scenarioPath(selected, s)}
                  onClick={(e) => spaClick(e, () => setSelectedScenario(i))}
                >
                  {s.name}
                </a>{" "}
                <span className="version">v{s.version}</span>
                {/* The scenario's ticket (specs/external-links/project-
                    management-jira-linear-etc.feature.md "Add link at
                    spec level"), opening in a new tab. */}
                {projectManagement && s.link && (
                  <a
                    className="ext-link"
                    href={s.link.url}
                    target="_blank"
                    rel="noreferrer"
                    title={s.link.url}
                  >
                    {externalLinkLabel(s.link)}
                  </a>
                )}
                {/* Its qTest test case (specs/external-links/qtest-test-
                    cases.feature.md), opening in a new tab. */}
                {qtestLinks && s.qtest && (
                  <a
                    className="ext-link"
                    href={s.qtest.url}
                    target="_blank"
                    rel="noreferrer"
                    title={s.qtest.url}
                  >
                    {externalLinkLabel(s.qtest)}
                  </a>
                )}
                {/* The flags gating it (specs/app/feature-flags.feature.md). */}
                {featureFlags && <FeatureFlagChips flags={s.flags} />}
                {/* Its polarity (specs/ui/scenario-polarity.feature.md),
                    a dot on the card: a click flips it; still while
                    the editor is open, as Move is, so the pane's copy
                    cannot go stale. */}
                {scenarioPolarity && (
                  <PolarityPill
                    compact
                    negative={!!s.negative}
                    disabled={editing !== null || locked}
                    onToggle={() => void toggleScenarioPolarityAt(i)}
                  />
                )}
              </span>
              {locked ? (
                /* The read-only site's card offers only its link
                   (specs/app/public-specs-site.feature.md "copies a
                   deep link"), on hover, focus or selection like the
                   editing card's actions. */
                <span className="card-actions">
                  <CopyLinkButton
                    size={14}
                    label={`Copy link to ${s.name}`}
                    copied={copied === scenarioLink(selected, s)}
                    onCopy={() => void copyLink(scenarioLink(selected, s))}
                  />
                </span>
              ) : (
              <span className="card-actions">
                {/* Edit up front, the rest behind ⋯ — Publish or New
                    version, Copy link (crud-feature.md
                    "publish each scenario individually"). Shown while
                    the card is hovered, focused or selected; a
                    right-click opens the same menu. A published card's
                    Edit opens the same pane: its test links
                    (specs/traceability.feature.md) and its ticket link
                    stay editable. */}
                <Tooltip label="Edit" keys="e">
                  <button
                    type="button"
                    className="ibtn"
                    aria-label={`Edit ${s.name}`}
                    onClick={() => setEditing({ index: i, scenario: { ...s } })}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                </Tooltip>
                <Tooltip label="More actions">
                  <button
                    type="button"
                    className="ibtn"
                    aria-label={`Menu for ${s.name}`}
                    aria-haspopup="menu"
                    aria-expanded={cardMenu === i}
                    onClick={() => setCardMenu((m) => (m === i ? null : i))}
                  >
                    <Ellipsis size={14} aria-hidden="true" />
                  </button>
                </Tooltip>
                <Menu
                  open={cardMenu === i}
                  onClose={() => setCardMenu(null)}
                  label={`Menu for ${s.name}`}
                  className="card-menu"
                  containerSelector=".card-actions"
                  items={[
                    {
                      id: "edit",
                      label: "Edit",
                      icon: <Pencil size={13} />,
                      keys: "e",
                      onSelect: () => setEditing({ index: i, scenario: { ...s } }),
                    },
                    // A new scenario right after this one (specs/ui/
                    // ui.feature.md "Add A Scenario Button").
                    {
                      id: "new-below",
                      label: "New scenario below",
                      icon: <Plus size={13} />,
                      disabled: editing !== null,
                      onSelect: () => void newScenario(i + 1),
                    },
                    s.status !== "published"
                      ? {
                          id: "publish",
                          label: publishing === scenarioKey(s) ? "Publishing…" : "Publish",
                          icon: <StatusIcon status="published" size={13} />,
                          disabled: publishing !== null,
                          onSelect: () => void publish(scenarioTarget(s)),
                        }
                      : {
                          id: "new-version",
                          label: "New version",
                          icon: <History size={13} />,
                          onSelect: () => newVersion(i),
                        },
                    {
                      id: "clone",
                      label: "Clone",
                      icon: <CopyPlus size={13} />,
                      onSelect: () => void cloneTreeScenario(selected, s),
                    },
                    {
                      id: "copy",
                      label: copied === scenarioPath(selected, s) ? "Copied" : "Copy link",
                      icon: <Link size={13} />,
                      onSelect: () => void copyLink(scenarioPath(selected, s)),
                    },
                    // Move up / Move down (specs/ui/ui.feature.md
                    // "number scenarios"): the order is the user's,
                    // saved like any other change to the feature.
                    {
                      id: "move-up",
                      label: "Move up",
                      icon: <ArrowUp size={13} />,
                      keys: "alt+arrowup",
                      disabled: i === 0 || editing !== null,
                      onSelect: () => void reorderScenario(i, -1),
                    },
                    {
                      id: "move-down",
                      label: "Move down",
                      icon: <ArrowDown size={13} />,
                      keys: "alt+arrowdown",
                      disabled: i === feature.scenarios.length - 1 || editing !== null,
                      onSelect: () => void reorderScenario(i, 1),
                    },
                  ]}
                />
              </span>
              )}
            </header>
            {/* Its custom attributes (specs/app/custom-attributes.feature.md),
                a row of chips under the title whenever it carries any. */}
            {s.attributes && s.attributes.length > 0 && (
              <div className="scenario-attributes">
                <AttributeChips
                  attributes={s.attributes}
                  where="scenario"
                  defs={attributeDefs}
                  known={knownAttributes}
                />
              </div>
            )}
            {s.body && (
              <div className="md-preview scenario-body">{renderMarkdown(s.body)}</div>
            )}
            {/* specs/traceability.feature.md: links to the automated
                tests, as a table at the end of the scenario. Optional —
                the Settings toggle hides it (default ON). */}
            {showTestLinks && testsTable(s.tests)}
            {/* specs/external-links/related-pull-requests.feature.md
                "The scenario card lists its pull requests". */}
            {s.prs && s.prs.length > 0 && (
              <div className="scenario-prs">
                <span className="scenario-prs-head">Pull requests</span>
                <PullRequestList prs={s.prs} />
              </div>
            )}
            {/* specs/external-links/aha-and-figma-links.feature.md "The
                scenario card lists its Aha! and Figma links". */}
            {RESOURCE_LINK_KINDS.filter((kind) => resourceLinksOn[kind] && s[kind]?.length).map(
              (kind) => (
                <div className={`scenario-prs scenario-${kind}`} key={kind}>
                  <span className="scenario-prs-head">{RESOURCE_LINK_TOOLS[kind].name}</span>
                  <ResourceLinkList kind={kind} links={s[kind]!} />
                </div>
              ),
            )}
            {/* specs/editor/store-associated-files.feature.md: the
                scenario's files, each a download. */}
            {s.files && s.files.length > 0 && (
              <div className="scenario-prs scenario-files">
                <span className="scenario-prs-head">Files</span>
                <ScenarioFileList files={s.files} />
              </div>
            )}
            {/* specs/app/specs-authorship.feature.md: who created the
                scenario and who last changed it. */}
            {authorshipLine(s) && <p className="scenario-authors">{authorshipLine(s)}</p>}
          </article>
          );
        })}
        {feature.scenarios.length > 0 &&
          !feature.scenarios.some((s) => scenarioMatches(s, feature, filter)) && (
            <p className="empty">
              {filter.attribute
                ? `No ${filter.status ? `${filter.status} ` : ""}scenarios here carry ${attributeFilterLabel(filter.attribute, attributeDefs)}`
                : `No ${filter.status} scenarios here`}{" "}
              — the sidebar filter hides the rest.
            </p>
          )}
        {feature.scenarios.length === 0 && (
          <p className="empty">
            {locked ? "No scenarios yet." : "No scenarios yet. Press c, or the + above, to add one."}
          </p>
        )}
      </div>
    </>
  );
}

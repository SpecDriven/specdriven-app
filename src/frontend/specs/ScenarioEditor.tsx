// The scenario editor (specs/editor/spec-editor.feature.md "Spec editor
// pane"): it takes the feature pane's slot — the sidebar stays beside it —
// with a bar on top and one scrolling column below. The Specs tab's pane
// while a scenario is open on a folder that can be written.

import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  Ellipsis,
  History,
  Link,
  Pencil,
  Plus,
  SendHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { type CSSProperties } from "react";
import type { TabApp } from "../../plugins/client/tabs";
import { definitionsFor } from "../../server/customAttributes";
import { scenarioNumbers, titleFromFileName } from "../../server/parser";
import { RESOURCE_LINK_KINDS, RESOURCE_LINK_TOOLS } from "../../server/resourceLinks";
import { AttributesField } from "../AttributesField";
import { Breadcrumbs } from "../Breadcrumbs";
import { ExternalLinkField } from "../ExternalLinkField";
import { FeatureFlagsField } from "../FeatureFlagsField";
import { HeightResizer } from "../HeightResizer";
import { MarkdownEditor } from "../MarkdownEditor";
import { Menu } from "../Menu";
import { PolarityPill } from "../PolarityPill";
import { PullRequestField } from "../PullRequestField";
import { QtestLinkField } from "../QtestLinkField";
import { ResourceLinkField } from "../ResourceLinkField";
import { ScenarioFilesField } from "../ScenarioFilesField";
import { StatusIcon } from "../StatusIcon";
import { SaveIndicator } from "../Toasts";
import { Tooltip } from "../Tooltip";
import { featurePath, scenarioPath } from "../route";
import { canSetTestLink, testLinkLabel, testLinkUrl } from "../testlinks";
import { folderCrumbs } from "./crumbs";
import { BODY_HEIGHT_KEY, BODY_MIN, clampBodyHeight, storeEditorHeight } from "./editorHeight";
import {
  setBodyHeight,
  setEditorMenuOpen,
  setResizingBody,
  setStatusMenuOpen,
  setTestDraft,
  setTestEdit,
  setTestEditDraft,
  setTestNameDraft,
  useEditorState,
} from "./editorState";
import type { SpecsActions } from "./host";
import { setEditing, useOpenFeature } from "./openFeature";
import { scenarioTarget, withPolarity } from "./scenarioEdit";
import { useSpecsSettings } from "./settings";

export function ScenarioEditor({ app, actions }: { app: TabApp; actions: SpecsActions }) {
  const { editing, selected, feature, dirty, searchTerms } = useOpenFeature();
  const {
    publishing,
    saving,
    savedAt,
    editorMenuOpen,
    statusMenuOpen,
    unpublishing,
    bodyHeight,
    resizingBody,
    testEdit,
    testEditDraft,
    testDraft,
    testNameDraft,
    testNameHint,
    testsError,
    linkDraft,
    linkError,
    qtestDraft,
    qtestError,
  } = useEditorState();
  const {
    scenarioPolarity,
    deletePublished,
    showTestLinks,
    projectManagement,
    projectManagementTool,
    qtestLinks,
    featureFlags,
    resourceLinksOn,
  } = useSpecsSettings();
  // The shell's: the trail's first crumb and "Copy link".
  const { repoCrumb, copied, copyLink } = app;
  // What App.tsx still owns (./host.ts SpecsActions).
  const {
    addTest,
    attributeDefs,
    backToFeature,
    bodyFieldRef,
    canAddAfter,
    cancelTestLookup,
    changeLinkDraft,
    changeQtestDraft,
    cloneTreeScenario,
    commitTestEdit,
    deleteScenario,
    draftVersion,
    editingDeletable,
    editingPublished,
    knownAttributes,
    nameFieldRef,
    newScenarioAfterCurrent,
    newVersion,
    proposeScenario,
    publishScenario,
    removeTest,
    savePullRequests,
    saveResourceLinks,
    saveScenarioFileList,
    savedEntry,
    scenarioNav,
    startTestEdit,
    stepScenario,
    unpublishScenario,
    uploadScenarioFiles,
  } = actions;
  if (!editing || !selected || !feature) return null;
  return (
    <div className="scenario-pane">
      <div className="editor-bar scenario-pane-bar page-header">
        <div className="scenario-pane-title">
          {/* The top line is the trail alone — the data folder, the
              feature's folders and the feature (specs/editor/
              spec-editor.feature.md "Adding Scanarios"). The feature
              crumb is the way back: like ESC, it leaves the scenario in
              its autosaved state and lands on its card. */}
          <Breadcrumbs
            items={[
              repoCrumb,
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
          {/* Previous / next scenario across the whole tree, as `<`
              and `>` (or k / j) do from the keyboard. */}
          <span className="scenario-nav" role="group" aria-label="Scenario navigation">
            <Tooltip
              label={
                scenarioNav.prev
                  ? `Previous: ${scenarioNav.prev.scenario.name} v${scenarioNav.prev.scenario.version}`
                  : "No previous scenario"
              }
              keys="<"
            >
              <button
                type="button"
                className="ibtn"
                aria-label="Previous scenario"
                disabled={scenarioNav.prev === null}
                onClick={() => stepScenario(-1)}
              >
                <ChevronLeft size={18} aria-hidden="true" />
              </button>
            </Tooltip>
            <Tooltip
              label={
                scenarioNav.next
                  ? `Next: ${scenarioNav.next.scenario.name} v${scenarioNav.next.scenario.version}`
                  : "No next scenario"
              }
              keys=">"
            >
              <button
                type="button"
                className="ibtn"
                aria-label="Next scenario"
                disabled={scenarioNav.next === null}
                onClick={() => stepScenario(1)}
              >
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            </Tooltip>
          </span>
          {/* Copy link (specs/ui/navigation.feature.md "share a link"):
              the scenario's versioned url, as the card's ⋯ menu and
              mod+shift+c copy it. A scenario with no name has no url
              yet. */}
          <Tooltip
            label={copied === scenarioPath(selected, editing.scenario) ? "Copied" : "Copy link"}
            keys="mod+shift+c"
          >
            <button
              type="button"
              className="ibtn"
              aria-label="Copy link"
              disabled={!editing.scenario.name.trim()}
              onClick={() => void copyLink(scenarioPath(selected, editing.scenario))}
            >
              {copied === scenarioPath(selected, editing.scenario) ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Link size={16} aria-hidden="true" />
              )}
            </button>
          </Tooltip>
          {/* The next scenario, from here (specs/editor/
              spec-editor.feature.md "Spec editor pane"): the pane saves
              on the way out and the new draft opens right after it. */}
          <Tooltip label="New scenario after this one" keys="c">
            <button
              type="button"
              className="ibtn"
              aria-label="New scenario after this one"
              disabled={!canAddAfter || publishing !== null}
              onClick={() => void newScenarioAfterCurrent()}
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          <SaveIndicator saving={saving} savedAt={savedAt} dirty={dirty} />
          {/* The rest of the pane's actions as a menu, like a card's ⋯.
              Delete sits last, apart and red: proposed scenarios and
              drafts can be deleted (specs/editor/spec-editor.feature.md)
              — published ones too while Settings allows it ("Delete
              Published Spec") — confirmed first, then saved out of the
              feature or removed from the document. Propose and Publish
              are not here: they are the status chip's, under the bar. A
              published scenario is read-only apart from its links, which
              save themselves, so its bar carries no save action. */}
          <span className="page-more editor-more">
            <Tooltip label="More actions">
              <button
                type="button"
                className="ibtn"
                aria-label="Scenario actions"
                aria-haspopup="menu"
                aria-expanded={editorMenuOpen}
                onClick={() => setEditorMenuOpen((o) => !o)}
              >
                <Ellipsis size={15} aria-hidden="true" />
              </button>
            </Tooltip>
            <Menu
              open={editorMenuOpen}
              onClose={() => setEditorMenuOpen(false)}
              label="Scenario actions"
              className="page-menu"
              containerSelector=".editor-more"
              items={[
                {
                  id: "new-below",
                  label: "New scenario below",
                  icon: <Plus size={13} />,
                  keys: "c",
                  disabled: !canAddAfter || publishing !== null,
                  onSelect: () => void newScenarioAfterCurrent(),
                },
                {
                  id: "clone",
                  label: "Clone",
                  icon: <CopyPlus size={13} />,
                  disabled: savedEntry === null,
                  onSelect: () => {
                    if (savedEntry) void cloneTreeScenario(selected, savedEntry);
                  },
                },
                ...(editingPublished && editing.index !== null
                  ? [
                      {
                        id: "new-version",
                        label: "New version",
                        icon: <History size={13} />,
                        onSelect: () => newVersion(editing.index!),
                      },
                    ]
                  : []),
                {
                  id: "copy",
                  label:
                    copied === scenarioPath(selected, editing.scenario) ? "Copied" : "Copy link",
                  icon: <Link size={13} />,
                  keys: "mod+shift+c",
                  disabled: !editing.scenario.name.trim(),
                  onSelect: () => void copyLink(scenarioPath(selected, editing.scenario)),
                },
                ...(editingDeletable
                  ? [
                      {
                        id: "delete",
                        label: "Delete",
                        icon: <Trash2 size={13} />,
                        danger: true,
                        onSelect: () => void deleteScenario(),
                      },
                    ]
                  : []),
              ]}
            />
          </span>
        </div>
      </div>
      {/* The scenario's name sits above the editor's top left corner
          (specs/editor/spec-editor.feature.md "Adding Scanarios") —
          editable until published (specs/ui/ui.feature.md "Scenario
          editor"), a read-only heading after. The version is assigned by
          the app, never typed: a new scenario takes the next version for
          its name (specs/ui/ui.feature.md). The status rides along as a
          badge: a scenario starts as a draft — persisted by autosave,
          kept out of the .feature.md — until Propose or Publish advances
          it. */}
      <div className="scenario-pane-head">
        {editing.index !== null &&
          feature !== null &&
          scenarioNumbers(feature.scenarios)[editing.index] != null && (
            <span className="scenario-number">
              S{scenarioNumbers(feature.scenarios)[editing.index]}
            </span>
          )}
        {editingPublished ? (
          <h2 className="scenario-pane-heading">{editing.scenario.name}</h2>
        ) : (
          <input
            className="scenario-pane-name"
            // While this field has the caret autosave stands down, so
            // the name is saved once, whole
            // (specs/editor/editor-autosave.feature.md).
            ref={nameFieldRef}
            value={editing.scenario.name}
            placeholder="Scenario name"
            aria-label="Scenario name"
            spellCheck={false}
            onChange={(e) =>
              setEditing({
                ...editing,
                scenario: { ...editing.scenario, name: e.target.value },
              })
            }
          />
        )}
        {/* Its polarity (specs/ui/scenario-polarity.feature.md),
            flipped in the draft; the pane's save writes it. */}
        {scenarioPolarity && (
          <PolarityPill
            negative={!!editing.scenario.negative}
            onToggle={() =>
              setEditing({
                ...editing,
                scenario: withPolarity(editing.scenario, !editing.scenario.negative),
              })
            }
          />
        )}
        {/* The status as a chip (specs/editor/spec-editor.feature.md
            "Spec editor pane"): a draft's menu offers the two ways
            forward — Propose moves it into the .feature.md as
            [proposed]; Publish takes it straight to [published],
            committed and pushed — a proposed scenario's only Publish,
            and a published one is a plain badge, unless Settings allows
            deleting published specs: then its menu offers Back to
            proposed ("Unpublish a Spec"). Closing without either keeps
            the autosaved draft. mod+enter picks the first. */}
        <div className="version-field">
          Version <span className="version">v{draftVersion}</span>
          {editingPublished && deletePublished && savedEntry?.status === "published" ? (
            <span className="chip-anchor status-anchor">
              <button
                type="button"
                className="chip status-chip"
                aria-haspopup="menu"
                aria-expanded={statusMenuOpen}
                aria-label="Status: published"
                disabled={unpublishing}
                onClick={() => setStatusMenuOpen((o) => !o)}
              >
                <StatusIcon status="published" size={14} />
                published
                <ChevronDown size={12} aria-hidden="true" />
              </button>
              <Menu
                open={statusMenuOpen}
                onClose={() => setStatusMenuOpen(false)}
                label="Scenario status"
                className="chip-menu"
                containerSelector=".status-anchor"
                items={[
                  {
                    id: "unpublish",
                    label: unpublishing ? "Moving back…" : "Back to proposed",
                    icon: <StatusIcon status="proposed" size={13} />,
                    disabled: unpublishing,
                    onSelect: () => void unpublishScenario(),
                  },
                ]}
              />
            </span>
          ) : editingPublished ? (
            <span className="chip static status-chip">
              <StatusIcon status="published" size={14} />
              published
            </span>
          ) : (
            <span className="chip-anchor status-anchor">
              <button
                type="button"
                className="chip status-chip"
                aria-haspopup="menu"
                aria-expanded={statusMenuOpen}
                aria-label={`Status: ${editing.scenario.status}`}
                disabled={publishing !== null}
                onClick={() => setStatusMenuOpen((o) => !o)}
              >
                <StatusIcon status={editing.scenario.status} size={14} />
                {editing.scenario.status}
                <ChevronDown size={12} aria-hidden="true" />
              </button>
              <Menu
                open={statusMenuOpen}
                onClose={() => setStatusMenuOpen(false)}
                label="Scenario status"
                className="chip-menu"
                containerSelector=".status-anchor"
                items={[
                  ...(editing.scenario.status === "draft"
                    ? [
                        {
                          id: "propose",
                          label: "Propose",
                          icon: <SendHorizontal size={13} />,
                          keys: "mod+enter",
                          disabled: !editing.scenario.name.trim() || publishing !== null,
                          onSelect: () => void proposeScenario(),
                        },
                      ]
                    : []),
                  {
                    id: "publish",
                    label: publishing !== null ? "Publishing…" : "Publish",
                    icon: <StatusIcon status="published" size={13} />,
                    ...(editing.scenario.status === "proposed" ? { keys: "mod+enter" } : {}),
                    disabled: !editing.scenario.name.trim() || publishing !== null,
                    onSelect: () => void publishScenario(),
                  },
                ]}
              />
            </span>
          )}
        </div>
      </div>
      <div className="scenario-pane-body">
        <div
          className={`body-field${bodyHeight === null ? "" : " sized"}${resizingBody ? " resizing" : ""}`}
          ref={bodyFieldRef}
          style={
            bodyHeight === null ? undefined : ({ "--body-h": `${bodyHeight}px` } as CSSProperties)
          }
        >
          <span className="field-label">Body</span>
          <MarkdownEditor
            value={editing.scenario.body}
            readOnly={editingPublished}
            highlight={searchTerms ?? undefined}
            placeholder="Describe the scenario in Markdown…"
            // Opens rendered, like the feature description; a new
            // scenario's blank body opens ready to type into instead.
            initialTab={editing.scenario.body.trim() ? "preview" : "write"}
            // specs/editor/table-editor.feature.md "variable creates a
            // column": a {var} in the body names an example column.
            tableVariables
            onChange={(body) =>
              setEditing({ ...editing, scenario: { ...editing.scenario, body } })
            }
          />
          {/* The body's lower boundary is a grab strip like the
              description editor's: drag it to give the body more room
              when the ticket and test links crowd it, double-click to
              restore the default. */}
          <HeightResizer
            label="Resize the body editor"
            min={BODY_MIN}
            height={bodyHeight}
            target={bodyFieldRef}
            clamp={clampBodyHeight}
            onHeight={setBodyHeight}
            onCommit={(h) => storeEditorHeight(BODY_HEIGHT_KEY, h)}
            onReset={() => {
              setBodyHeight(null);
              storeEditorHeight(BODY_HEIGHT_KEY, null);
            }}
            onResizing={setResizingBody}
          />
        </div>
        {/* specs/traceability.feature.md: GitHub links to the automated
            tests covering this scenario — added, corrected in place (✎)
            and removed (✕). Editable even for a published scenario: the
            links track the tests, not the immutable spec. Hidden
            entirely when the Settings toggle is off. */}
        {showTestLinks && (
          <div className="tests-field">
            <span className="field-label">Automated tests</span>
            {editing.scenario.tests.length > 0 && (
              <ul className="test-list">
                {editing.scenario.tests.map((t, i) => (
                  <li key={t}>
                    {testEdit === i ? (
                      <form
                        className="test-edit"
                        onSubmit={(e) => {
                          e.preventDefault();
                          commitTestEdit();
                        }}
                      >
                        <input
                          value={testEditDraft.url}
                          aria-label="Test link (GitHub url with #L line)"
                          spellCheck={false}
                          autoFocus
                          onChange={(e) =>
                            setTestEditDraft({ ...testEditDraft, url: e.target.value })
                          }
                          // ESC backs out of the row, not out of the
                          // whole editor pane (specs/ui/ui.feature.md).
                          onKeyDown={(e) => {
                            if (e.key !== "Escape") return;
                            e.stopPropagation();
                            setTestEdit(null);
                            cancelTestLookup();
                          }}
                        />
                        <input
                          className="test-name"
                          value={testEditDraft.name}
                          placeholder="test name"
                          aria-label="Test name"
                          spellCheck={false}
                          onChange={(e) =>
                            setTestEditDraft({ ...testEditDraft, name: e.target.value })
                          }
                          onKeyDown={(e) => {
                            if (e.key !== "Escape") return;
                            e.stopPropagation();
                            setTestEdit(null);
                            cancelTestLookup();
                          }}
                        />
                        <button
                          type="submit"
                          className="link"
                          disabled={
                            !canSetTestLink(editing.scenario.tests, i, testEditDraft)
                          }
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            setTestEdit(null);
                            cancelTestLookup();
                          }}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        <a
                          href={testLinkUrl(t)}
                          target="_blank"
                          rel="noreferrer"
                          title={testLinkUrl(t)}
                          data-test-link=""
                        >
                          {testLinkLabel(t)}
                        </a>
                        <button
                          type="button"
                          className="link"
                          title={`Edit ${testLinkUrl(t)}`}
                          aria-label={`Edit ${testLinkUrl(t)}`}
                          onClick={() => startTestEdit(i)}
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="link"
                          title={`Remove ${testLinkUrl(t)}`}
                          aria-label={`Remove ${testLinkUrl(t)}`}
                          onClick={() => removeTest(i)}
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <form
              className="test-add"
              onSubmit={(e) => {
                e.preventDefault();
                addTest();
              }}
            >
              <input
                value={testDraft}
                placeholder="https://github.com/owner/repo/blob/main/…/MyTest.java#L32"
                aria-label="Test link (GitHub url with #L line)"
                spellCheck={false}
                onChange={(e) => setTestDraft(e.target.value)}
              />
              <input
                className="test-name"
                value={testNameDraft}
                placeholder="test name"
                aria-label="Test name"
                spellCheck={false}
                onChange={(e) => setTestNameDraft(e.target.value)}
              />
              <button
                type="submit"
                className="link"
                disabled={
                  !canSetTestLink(editing.scenario.tests, null, {
                    url: testDraft,
                    name: testNameDraft,
                  })
                }
              >
                Add
              </button>
            </form>
            {testNameHint && <p className="test-name-hint">{testNameHint}</p>}
            {testsError && <p className="error">{testsError}</p>}
          </div>
        )}
        {/* specs/external-links/project-management-jira-linear-etc.
            feature.md "Add link at spec level": the ticket tracking this
            scenario. Editable on a published scenario too — like the test
            links, it is bookkeeping around the spec, not the spec. */}
        {projectManagement && (
          <div className="link-field">
            <span className="field-label">Ticket link</span>
            <ExternalLinkField
              draft={linkDraft}
              onChange={changeLinkDraft}
              error={linkError}
              tool={projectManagementTool}
            />
          </div>
        )}
        {/* specs/external-links/qtest-test-cases.feature.md: the qTest
            test case covering this scenario. Editable on a published
            scenario too, like the ticket link. */}
        {qtestLinks && (
          <div className="link-field">
            <span className="field-label">qTest test case</span>
            <QtestLinkField draft={qtestDraft} onChange={changeQtestDraft} error={qtestError} />
          </div>
        )}
        {/* specs/app/feature-flags.feature.md: the flags gating this
            scenario, saved with it. Editable on a published scenario
            too — like the ticket link, bookkeeping around the spec. */}
        {featureFlags && (
          <div className="feature-flags-field-wrap">
            <span className="field-label">Feature flags</span>
            <FeatureFlagsField
              flags={editing.scenario.flags ?? []}
              onChange={(flags) => {
                const { flags: _previous, ...rest } = editing.scenario;
                setEditing({ ...editing, scenario: flags.length > 0 ? { ...rest, flags } : rest });
              }}
            />
          </div>
        )}
        {/* specs/app/custom-attributes.feature.md: the scenario's custom
            attributes, saved with it — editable on a published
            scenario too, like the flags. Shown once the data repo
            defines attributes for scenarios, or while it has some. */}
        {(definitionsFor(attributeDefs, "scenario").length > 0 ||
          (editing.scenario.attributes?.length ?? 0) > 0) && (
          <div className="attributes-field-wrap">
            <span className="field-label">Attributes</span>
            <AttributesField
              attributes={editing.scenario.attributes ?? []}
              where="scenario"
              defs={attributeDefs}
              known={knownAttributes}
              onChange={(attributes) => {
                const { attributes: _previous, ...rest } = editing.scenario;
                setEditing({
                  ...editing,
                  scenario: attributes.length > 0 ? { ...rest, attributes } : rest,
                });
              }}
            />
          </div>
        )}
        {/* specs/external-links/related-pull-requests.feature.md: the
            pull requests implementing this scenario. Saved to the
            document on every add and remove, never to the markdown —
            so it needs the scenario to be in the document, which the
            first autosave of a new one sees to. Editable on a
            published scenario too. */}
        <div className="prs-field-wrap">
          <span className="field-label">Pull requests</span>
          <PullRequestField
            prs={editing.scenario.prs ?? []}
            disabled={editing.scenario.id === undefined}
            disabledHint="Pull requests can be linked once the scenario has been saved."
            onChange={(prs) => savePullRequests(scenarioTarget(editing.scenario), prs)}
          />
        </div>
        {/* specs/external-links/aha-and-figma-links.feature.md: the
            Aha! records and Figma designs behind this scenario, each
            tool only while Settings switches it on. Saved to the
            document like the pull requests; editable on a published
            scenario too. */}
        {RESOURCE_LINK_KINDS.filter((kind) => resourceLinksOn[kind]).map((kind) => (
          <div className="prs-field-wrap" key={kind}>
            <span className="field-label">{RESOURCE_LINK_TOOLS[kind].name}</span>
            <ResourceLinkField
              kind={kind}
              links={editing.scenario[kind] ?? []}
              disabled={editing.scenario.id === undefined}
              disabledHint={`${RESOURCE_LINK_TOOLS[kind].name} links can be added once the scenario has been saved.`}
              onChange={(links) => saveResourceLinks(scenarioTarget(editing.scenario), kind, links)}
            />
          </div>
        ))}
        {/* specs/editor/store-associated-files.feature.md: the files
            the scenario needs at run time — test data to upload into
            the system under test. Stored in the data repo and listed
            on the document, like the pull requests; editable on a
            published scenario too. */}
        <div className="prs-field-wrap">
          <span className="field-label">Files</span>
          <ScenarioFilesField
            files={editing.scenario.files ?? []}
            disabled={editing.scenario.id === undefined}
            disabledHint="Files can be uploaded once the scenario has been saved."
            onUpload={(chosen, replacing) =>
              uploadScenarioFiles(
                scenarioTarget(editing.scenario),
                editing.scenario.files ?? [],
                chosen,
                replacing,
              )
            }
            onChange={(files) => saveScenarioFileList(scenarioTarget(editing.scenario), files)}
          />
        </div>
      </div>
    </div>
  );
}

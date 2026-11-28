// Publishing from a feature's page (specs/ui/ui.feature.md "Main page",
// specs/external-links/): publishing its proposed scenarios or one of them,
// what a publish to Confluence or qTest answered written into the feature,
// opening the qTest dialog, and deleting the feature. Moved out of App.tsx
// as they were, into a hook App.tsx calls: each handler sees the same
// render's values it saw there.

import { type Dispatch, type RefObject, type SetStateAction } from "react";
import { type FeatureListing } from "../../server/features";
import { type Feature, type ScenarioTarget, serializeFeature } from "../../server/parser";
import { type ConfluencePublishResult } from "../ConfluencePublishDialog";
import { type ConfirmOptions } from "../ModalPrompts";
import { type PromiseQueue } from "../promiseQueue";
import { type QtestPublishResult } from "../QtestPublishDialog";
import { toast } from "../Toasts";
import { setQtestPublishOpen } from "./dialogs";
import { setConflict, setConflictDraft, setPublishing, useEditorState } from "./editorState";
import { type Listing, useSpecsListing } from "./listing";
import {
  type OpenOptions,
  setDirty,
  setEditing,
  setFeature,
  setSelected,
  setSelectedScenario,
  useOpenFeature,
} from "./openFeature";
import { type Placement, featureFromResponse } from "./scenarioEdit";
import { scenarioKey } from "./selection";

export interface PublishDeps {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  descSaveQueue: RefObject<PromiseQueue>;
  editorRef: RefObject<{ close: () => Promise<{ ok: boolean; placed: Placement; }> | null; back: () => void; flush: () => Promise<void>; seal: () => void; }>;
  featureEditorsRetiring: RefObject<boolean>;
  loadFeatures: () => Promise<Listing | null>;
  markSaved: () => void;
  openFeature: (file: string, opts?: OpenOptions) => Promise<void>;
  scenarioSaveQueue: RefObject<PromiseQueue>;
  selectedRef: RefObject<string | null>;
  setQtestParentUrl: Dispatch<SetStateAction<string>>;
  unsealFeatureEditors: () => void;
}

export function usePublish(deps: PublishDeps) {
  const { conflict, publishing } = useEditorState();
  const { feature, selected } = useOpenFeature();
  const { features } = useSpecsListing();
  const {
    confirm,
    descSaveQueue,
    editorRef,
    featureEditorsRetiring,
    loadFeatures,
    markSaved,
    openFeature,
    scenarioSaveQueue,
    selectedRef,
    setQtestParentUrl,
    unsealFeatureEditors,
  } = deps;

  // A feature's page is published (specs/external-links/confluence-wiki.feature.md
  // "Publish a feature to Confluence"): the feature now links it, shown as
  // saved, and the toast offers "Open page". Shared by the Confluence
  // dialog and the Wiki & qTest one.
  const confluencePublished = (data: ConfluencePublishResult) => {
    if (!selected) return;
    setFeature(featureFromResponse(data, selected));
    setDirty(false);
    markSaved();
    const open = { label: "Open page", run: () => window.open(data.url, "_blank", "noreferrer") };
    toast.success(`${data.created ? "Published" : "Updated"} “${data.title}” in Confluence`, { action: open });
    if (data.warning) toast.error(data.warning);
  };

  // A feature's test cases are written (specs/external-links/qtest-test-cases.feature.md
  // "Create qTest test cases from a feature"): the feature and its scenarios
  // link them, the parent module is remembered for next time, and the toast
  // says how many were created and offers "Open module". Shared by the qTest
  // dialog and the Wiki & qTest one; each decides whether to stay open.
  const qtestPublished = (data: QtestPublishResult) => {
    if (!selected) return;
    setFeature(featureFromResponse(data, selected));
    setDirty(false);
    markSaved();
    setQtestParentUrl(data.parentUrl);
    const open = { label: "Open module", run: () => window.open(data.module.url, "_blank", "noreferrer") };
    const what = [
      data.created > 0 ? `created ${data.created}` : "",
      data.updated > 0 ? `updated ${data.updated}` : "",
      // Test cases of scenarios no longer in the feature (or out of scope), removed from the module.
      (data.deleted ?? 0) > 0 ? `deleted ${data.deleted}` : "",
      // The requirements of the feature's Jira issues they cover, those found and linked.
      (() => {
        const pids = (data.requirements ?? []).filter((r) => r.linked + r.alreadyLinked > 0).map((r) => r.pid);
        return pids.length > 0 ? `linked to ${pids.join(", ")}` : "";
      })(),
    ]
      .filter(Boolean)
      .join(", ");
    // A run refused at its first test case wrote nothing to report.
    if (what || !data.failure) toast.success(`qTest: ${what || "nothing to write"} for “${data.title}”`, { action: open });
    if (data.warning) toast.error(data.warning);
  };

  // "Publish qTest Test Cases…" (specs/external-links/qtest-test-cases.feature.md
  // "A feature with no Confluence page asks first"): each test case links its
  // scenario on the feature's Confluence page, so without one it would only
  // name the spec file — asked before the dialog opens.
  const openQtestPublish = async (f: Feature) => {
    if (!f.confluence) {
      const ok = await confirm({
        title: "No Confluence page",
        body: `“${f.name}” has not been published to Confluence, so its test cases cannot link their scenarios there — they will name the spec file instead. Create the qTest test cases anyway?`,
        confirmLabel: "Create anyway",
        danger: false,
      });
      if (!ok) return;
    }
    setQtestPublishOpen(true);
  };

  // Delete (specs/ui/ui.feature.md "Feature entry menu"): removes the feature
  // file after a confirmation — a `git rm`, committed and pushed on the server.
  const removeFeature = async (f: FeatureListing) => {
    const ok = await confirm({
      title: "Delete feature",
      body: `Delete "${f.name}" (${f.fileName})?`,
      confirmLabel: "Delete feature",
    });
    if (!ok) return;
    // Seal without a parting save: writing the file back would undo the
    // delete, the way an open page seals before its DELETE. Saves already
    // away finish first, or they would recreate the file after git rm.
    const retiring = selected === f.fileName;
    if (retiring) {
      featureEditorsRetiring.current = true;
      await scenarioSaveQueue.current.idle();
      await descSaveQueue.current.idle();
      editorRef.current.seal();
    }
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(f.fileName)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (res.ok) {
        if (selected === f.fileName) {
          // An editor open on the deleted feature has nothing left to save into.
          setEditing(null);
          setSelected(null);
          setFeature(null);
          setSelectedScenario(null);
        }
        await loadFeatures();
        toast.success(`Deleted "${f.name}" — ${data.message}.`);
      } else {
        toast.error(data.error ?? "Delete failed");
      }
    } finally {
      if (retiring) unsealFeatureEditors();
    }
  };

  // Publish buttons (specs/ui/ui.feature.md "Main page"): same style and
  // behavior as Sync — disabled with a progress label while running, no
  // "Published" status line at the bottom of the page. Without a target every
  // scenario is published (the upper-left "Publish All"); with one, only that
  // scenario (crud-feature.md "publish each scenario individually").
  // `over` carries content the state hasn't caught up with yet: the dialog's
  // Publish saves its scenario into the feature and publishes in one motion.
  // The target carries the scenario's document id, so one going out under a
  // new name or version is published as itself, not as a second scenario.
  const publish = async (scenario?: ScenarioTarget, over?: Feature, file = selected) => {
    const content = over ?? feature;
    if (!file || !content) return;
    setPublishing(scenario ? scenarioKey(scenario) : "all");
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(content), scenario }),
      });
      const data = await res.json();
      // The dialog's Publish can wait behind an autosave tick, long enough
      // for the user to open another feature. Its answer then belongs to a
      // feature no longer on screen: reopening it would pull the user back,
      // and its conflict dialog would resolve against the wrong page.
      const stillHere = selectedRef.current === file;
      if (res.status === 409 && data.status === "conflict") {
        if (stillHere) {
          setConflict({ ours: data.ours, theirs: data.theirs, message: data.message, scenario });
          setConflictDraft(data.ours);
          toast.info("Merge conflict — choose a resolution below.");
        } else {
          toast.error(`Merge conflict publishing to ${file} — open it and publish again to resolve.`);
        }
      } else if (res.ok) {
        if (stillHere) await openFeature(file);
        else await loadFeatures();
      } else {
        toast.error(data.error ?? "Publish failed");
      }
    } catch {
      toast.error("Publish failed — is the server running?");
    } finally {
      setPublishing(null);
    }
  };

  return {
    confluencePublished,
    openQtestPublish,
    publish,
    qtestPublished,
    removeFeature,
  };
}

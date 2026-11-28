// What a feature and a scenario link to and carry, saved from their fields
// and popovers: the editor's tests, ticket and qTest drafts, and a
// feature's or a scenario's flags, attributes, tickets, qTest case, pull
// requests, Aha! and Figma links, files and assignee. Moved out of App.tsx
// as they were, into a hook App.tsx calls: each handler sees the same
// render's values it saw there.

import { type RefObject } from "react";
import { type ProjectMember } from "../../server/members";
import {
  type Feature,
  type FeatureFlag,
  type PullRequestLink,
  type ResourceLink,
  type ScenarioFile,
  type ScenarioTarget,
  type SpecAttribute,
  type ExternalLink as TicketLink,
  serializeFeature,
} from "../../server/parser";
import { RESOURCE_LINK_TOOLS, type ResourceLinkKind } from "../../server/resourceLinks";
import { type LinkDraft, externalLinkLabel, resolveLinkDraft, resolveQtestDraft } from "../externallinks";
import { type ConfirmOptions } from "../ModalPrompts";
import { toast } from "../Toasts";
import { setLinkDraft, setQtestDraft } from "./editorState";
import {
  setAssignedSaving,
  setFeatureQtestDraft,
  setFeatureQtestError,
  setFeatureQtestSaving,
  setFeatureTicketsError,
  setFeatureTicketsSaving,
  useFeaturePageState,
} from "./featurePageState";
import { setDirty, setEditing, setFeature, useOpenFeature } from "./openFeature";
import { featureFromResponse } from "./scenarioEdit";

export interface FeatureFieldsDeps {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  markSaved: () => void;
  members: ProjectMember[];
  selectedRef: RefObject<string | null>;
}

export function useFeatureFields(deps: FeatureFieldsDeps) {
  const { editing, feature, selected } = useOpenFeature();
  const { featureQtestDraft } = useFeaturePageState();
  const {
    confirm,
    markSaved,
    members,
    selectedRef,
  } = deps;
  // The dialog's "Automated tests" list editor (specs/traceability.feature.md);
  // the rules for what may go in a row live in ./testlinks.
  const setTests = (tests: string[]) => {
    if (!editing) return;
    setEditing({ ...editing, scenario: { ...editing.scenario, tests } });
  };

  // The dialog's "Ticket link" fields (specs/external-links/project-
  // management-jira-linear-etc.feature.md): typed into a draft; the moment
  // the fields make a whole link — or are all cleared — the scenario follows,
  // so autosave and closing carry the link like any other edit. A half-filled
  // draft stays in the fields until an explicit save, which it blocks.
  const changeLinkDraft = (draft: LinkDraft) => {
    setLinkDraft(draft);
    if (!editing) return;
    const resolved = resolveLinkDraft(draft);
    if (resolved.error) return;
    const { link: _previous, ...rest } = editing.scenario;
    setEditing({ ...editing, scenario: resolved.link ? { ...rest, link: resolved.link } : rest });
  };

  // The dialog's "qTest test case" fields
  // (specs/external-links/qtest-test-cases.feature.md), following the
  // scenario the same way as the ticket link's.
  const changeQtestDraft = (draft: LinkDraft) => {
    setQtestDraft(draft);
    if (!editing) return;
    const resolved = resolveQtestDraft(draft);
    if (resolved.error) return;
    const { qtest: _previous, ...rest } = editing.scenario;
    setEditing({ ...editing, scenario: resolved.link ? { ...rest, qtest: resolved.link } : rest });
  };

  /**
   * Save the feature's own ticket link (specs/external-links/project-
   * management-jira-linear-etc.feature.md "Add link to feature"): the feature
   * is saved like any scenario edit — locally, marked [proposed] where
   * applicable, pushed by the reload cron — with the link set or cleared.
   */
  /**
   * The feature's own flags (specs/app/feature-flags.feature.md), saved on
   * the spot from the header's popover — written into the `.feature.md` like
   * the ticket link.
   */
  const saveFeatureFlags = async (flags: FeatureFlag[]) => {
    if (!feature || !selected) return;
    const { flags: _previous, ...rest } = feature;
    const next: Feature = flags.length > 0 ? { ...rest, flags } : rest;
    setFeature(next);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeature(featureFromResponse(data, selected));
        setDirty(false);
        markSaved();
      } else {
        setFeature(feature);
        toast.error(data.error ?? "Could not save the feature flags");
      }
    } catch {
      setFeature(feature);
      toast.error("Could not save the feature flags — is the server running?");
    }
  };

  /**
   * The feature's own custom attributes (specs/app/custom-attributes.feature.md),
   * saved on the spot from the header's popover like the flags.
   */
  const saveFeatureAttributes = async (attributes: SpecAttribute[]) => {
    if (!feature || !selected) return;
    const { attributes: _previous, ...rest } = feature;
    const next: Feature = attributes.length > 0 ? { ...rest, attributes } : rest;
    setFeature(next);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeature(featureFromResponse(data, selected));
        setDirty(false);
        markSaved();
      } else {
        setFeature(feature);
        toast.error(data.error ?? "Could not save the attributes");
      }
    } catch {
      setFeature(feature);
      toast.error("Could not save the attributes — is the server running?");
    }
  };

  /**
   * Set the feature's tickets (specs/external-links/project-management-jira-
   * linear-etc.feature.md "Several tickets on a feature"): the whole list to
   * the tickets route, which saves it from the server's own view of the
   * feature — the markdown changes with it when links are published, so it
   * is a save, not a document-only write like the pull requests'.
   */
  const saveFeatureTickets = async (links: TicketLink[]) => {
    if (!feature || !selected) return;
    const before = feature.links ?? [];
    const added = links.find((l) => !before.includes(l));
    const removed = before.find((l) => !links.includes(l));
    setFeatureTicketsSaving(true);
    setFeatureTicketsError(null);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}/tickets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeature(featureFromResponse(data, selected));
        setDirty(false);
        toast.success(
          added
            ? `Linked ${externalLinkLabel(added)} — ${data.message}.`
            : removed
              ? `Removed ${externalLinkLabel(removed)} — ${data.message}.`
              : `Tickets saved — ${data.message}.`,
        );
        markSaved();
      } else {
        setFeatureTicketsError(data.error ?? "Could not save the tickets");
      }
    } catch {
      setFeatureTicketsError("Could not save the tickets — is the server running?");
    } finally {
      setFeatureTicketsSaving(false);
    }
  };

  /**
   * Save the feature's own qTest test case link
   * (specs/external-links/qtest-test-cases.feature.md), the way
   * saveFeatureLink saves its ticket.
   */
  const saveFeatureQtest = async () => {
    if (!feature || !selected || featureQtestDraft === null) return;
    const resolved = resolveQtestDraft(featureQtestDraft);
    if (resolved.error) {
      setFeatureQtestError(resolved.error);
      return;
    }
    const { qtest: _previous, ...rest } = feature;
    const next: Feature = resolved.link ? { ...rest, qtest: resolved.link } : rest;
    setFeatureQtestSaving(true);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeature(featureFromResponse(data, selected));
        setDirty(false);
        setFeatureQtestDraft(null);
        toast.success(
          resolved.link
            ? `Linked ${externalLinkLabel(resolved.link)} — ${data.message}.`
            : `Test case link removed — ${data.message}.`,
        );
        markSaved();
      } else {
        setFeatureQtestError(data.error ?? "Could not save the test case link");
      }
    } catch {
      setFeatureQtestError("Could not save the test case link — is the server running?");
    } finally {
      setFeatureQtestSaving(false);
    }
  };

  /**
   * Save the pull requests linked to the feature (`target` null) or to one
   * scenario (specs/external-links/related-pull-requests.feature.md): a
   * document-only write through its own route — the links never ride in
   * the markdown a save sends — answered with the editor's view, which the
   * page and an open editor pane follow. Nothing to autosave: every add and
   * remove is saved on the spot.
   */
  const savePullRequests = async (target: ScenarioTarget | null, prs: PullRequestLink[]) => {
    if (!selected) return;
    const file = selected;
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}/pull-requests`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: target, prs }),
      });
      const data = await res.json();
      if (selectedRef.current !== file) return;
      if (res.ok) {
        setFeature(featureFromResponse(data, file));
        if (target) {
          setEditing((prev) =>
            prev === null || prev.scenario.id !== target.id
              ? prev
              : { ...prev, scenario: { ...prev.scenario, prs } },
          );
        }
        markSaved();
      } else {
        toast.error(data.error ?? "Could not save the pull requests");
      }
    } catch {
      toast.error("Could not save the pull requests — is the server running?");
    }
  };

  /**
   * Save the Aha! or Figma links of the feature (`target` null) or of one
   * scenario (specs/external-links/aha-and-figma-links.feature.md): a
   * document-only write through its own route, like the pull requests'.
   */
  const saveResourceLinks = async (
    target: ScenarioTarget | null,
    kind: ResourceLinkKind,
    links: ResourceLink[],
  ) => {
    if (!selected) return;
    const file = selected;
    const { name } = RESOURCE_LINK_TOOLS[kind];
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}/links/${kind}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: target, links }),
      });
      const data = await res.json();
      if (selectedRef.current !== file) return;
      if (res.ok) {
        setFeature(featureFromResponse(data, file));
        if (target) {
          setEditing((prev) =>
            prev === null || prev.scenario.id !== target.id
              ? prev
              : { ...prev, scenario: { ...prev.scenario, [kind]: links } },
          );
        }
        markSaved();
      } else {
        toast.error(data.error ?? `Could not save the ${name} links`);
      }
    } catch {
      toast.error(`Could not save the ${name} links — is the server running?`);
    }
  };

  /**
   * Follow a files route's answer (specs/editor/store-associated-files
   * .feature.md): the page and an open editor pane take the scenario's new
   * list. True when it was saved.
   */
  const followScenarioFiles = async (
    res: Response,
    file: string,
    target: ScenarioTarget,
    failure: string,
  ): Promise<boolean> => {
    const data = await res.json();
    if (selectedRef.current !== file) return res.ok;
    if (!res.ok) {
      toast.error(data.error ?? failure);
      return false;
    }
    const next = featureFromResponse(data, file);
    setFeature(next);
    const saved = next.scenarios.find((s) =>
      target.id !== undefined ? s.id === target.id : s.name === target.name && s.version === target.version,
    );
    setEditing((prev) =>
      prev === null || prev.scenario.id !== target.id
        ? prev
        : { ...prev, scenario: { ...prev.scenario, files: saved?.files ?? [] } },
    );
    markSaved();
    return true;
  };

  /**
   * Upload files chosen for a scenario, one request each: the bytes are
   * stored in the data repo and the scenario lists them by name. A chosen
   * file named like one already listed replaces its contents — after a
   * confirm, unless the Replace button is what chose it (`replacing`).
   */
  const uploadScenarioFiles = async (
    target: ScenarioTarget | null,
    listed: ScenarioFile[],
    chosen: File[],
    replacing?: string,
  ) => {
    if (!selected || !target) return;
    const file = selected;
    if (replacing === undefined) {
      const clashes = chosen.filter((c) => listed.some((f) => f.name === c.name)).map((c) => c.name);
      if (clashes.length > 0) {
        const ok = await confirm({
          title: clashes.length === 1 ? `Replace "${clashes[0]}"?` : `Replace ${clashes.length} files?`,
          body: `This scenario already has ${clashes.map((n) => `"${n}"`).join(", ")}. The upload replaces the contents.`,
          confirmLabel: "Replace",
        });
        if (!ok) return;
      }
    }
    for (const one of chosen) {
      const form = new FormData();
      form.append("file", one);
      form.append("scenario", JSON.stringify(target));
      if (replacing !== undefined) form.append("name", replacing);
      try {
        const res = await fetch(`/api/features/${encodeURIComponent(file)}/scenario-files`, {
          method: "POST",
          body: form,
        });
        const ok = await followScenarioFiles(res, file, target, `Could not upload ${one.name}`);
        if (!ok) return;
      } catch {
        toast.error(`Could not upload ${one.name} — is the server running?`);
        return;
      }
    }
  };

  /** Save a scenario's file list after a rename or a removal. */
  const saveScenarioFileList = async (target: ScenarioTarget | null, files: ScenarioFile[]) => {
    if (!selected || !target) return;
    const file = selected;
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(file)}/scenario-files`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: target, files }),
      });
      await followScenarioFiles(res, file, target, "Could not save the files");
    } catch {
      toast.error("Could not save the files — is the server running?");
    }
  };

  /**
   * The project members the "Assigned" dropdown offers: the data repo's
   * project-settings.yaml (src/server/members.ts), plus whoever the feature
   * is assigned to when that name is no longer on the list — a member who
   * left the project must still show, or opening the feature would silently
   * look unassigned.
   */
  const assignableMembers = (): ProjectMember[] => {
    const assigned = feature?.assigned;
    if (!assigned || members.some((m) => m.name === assigned)) return members;
    return [...members, { name: assigned }];
  };

  /**
   * Assign the feature to a project member, or to nobody (the empty choice).
   * Saved like the feature's ticket link: locally, right away, pushed by the
   * reload cron — the name lands in the file's `**Assigned:**` line.
   */
  const saveAssigned = async (name: string) => {
    if (!feature || !selected) return;
    const assigned = name.trim();
    if ((feature.assigned ?? "") === assigned) return;
    const { assigned: _previous, ...rest } = feature;
    const next: Feature = assigned ? { ...rest, assigned } : rest;
    setAssignedSaving(true);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(next), save: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeature(featureFromResponse(data, selected));
        setDirty(false);
        toast.success(
          assigned ? `Assigned to ${assigned} — ${data.message}.` : `Assignment cleared — ${data.message}.`,
          { action: { label: "Undo", run: () => void saveAssigned(_previous ?? "") } },
        );
        markSaved();
      } else {
        toast.error(data.error ?? "Could not save the assignment");
      }
    } catch {
      toast.error("Could not save the assignment — is the server running?");
    } finally {
      setAssignedSaving(false);
    }
  };
  return {
    assignableMembers,
    changeLinkDraft,
    changeQtestDraft,
    saveAssigned,
    saveFeatureAttributes,
    saveFeatureFlags,
    saveFeatureQtest,
    saveFeatureTickets,
    savePullRequests,
    saveResourceLinks,
    saveScenarioFileList,
    setTests,
    uploadScenarioFiles,
  };
}

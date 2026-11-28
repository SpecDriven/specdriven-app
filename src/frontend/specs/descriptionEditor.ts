// The feature description editor's handlers (specs/editor/feature-editor
// .feature.md "Edit feature descrition"): opening it on a feature, the
// autosave tick and its interval, and Done. Moved out of App.tsx as they
// were, into a hook App.tsx calls: each handler sees the same render's
// values it saw there. The draft is in ./featurePageState.ts; the refs a
// tick reads between renders are still App's.

import { type RefObject, useEffect, useRef } from "react";
import { type Feature, serializeFeature } from "../../server/parser";
import { type PromiseQueue } from "../promiseQueue";
import { toast } from "../Toasts";
import { setSaving } from "./editorState";
import { setDescEdit, useFeaturePageState } from "./featurePageState";
import { useSpecsListing } from "./listing";
import { setFeature, useOpenFeature } from "./openFeature";
import { featureFromResponse } from "./scenarioEdit";

export interface DescriptionEditorDeps {
  autosaveSeconds: number;
  descEditRef: RefObject<{ file: string; text: string; } | null>;
  descSaveQueue: RefObject<PromiseQueue>;
  descSaved: RefObject<string | null>;
  featureEditorsRetiring: RefObject<boolean>;
  featureEditorsSealed: RefObject<boolean>;
  markSaved: () => void;
  selectedRef: RefObject<string | null>;
}

export function useDescriptionEditor(deps: DescriptionEditorDeps) {
  const { descEdit } = useFeaturePageState();
  const { feature, selected } = useOpenFeature();
  const { features } = useSpecsListing();
  const {
    autosaveSeconds,
    descEditRef,
    descSaveQueue,
    descSaved,
    featureEditorsRetiring,
    featureEditorsSealed,
    markSaved,
    selectedRef,
  } = deps;
  /**
   * Feature description editor (specs/editor/feature-editor.feature.md "Edit
   * feature descrition"). Opening seeds it with the description on the
   * feature, which counts as saved; nothing is written until it changes.
   */
  const openDescriptionEditor = (file: string, text: string) => {
    descSaved.current = text;
    setDescEdit({ file, text });
  };

  /**
   * One autosave tick of the description editor: save the feature with the
   * description it holds, unless that is what the server already has. Same
   * rules as the README editor — ticks never overlap, only a landed save
   * counts, a failed one is reported and retried by the next tick. The save
   * goes through the ordinary feature save, so the scenarios ride along
   * unchanged and the reload cron commits and pushes it.
   */
  const autosaveDescription = async () => {
    if (featureEditorsSealed.current) return;
    // `selected` and `feature` come from the closure, not from refs, and that
    // is what makes leaving a feature safe: React runs an effect's cleanup
    // before the effect bodies of the same commit, and the assignment that
    // refreshes `descTick` below has no dep array — so the cleanup tick still
    // holds the render in which this feature was the selected one. Reading
    // refs here would see the file the user moved *to* and drop the edit.
    const edit = descEditRef.current;
    if (!edit || !feature || edit.file !== selected) return;
    if (edit.text === descSaved.current) return;
    const next: Feature = { ...feature, description: edit.text.trim() };
    const content = serializeFeature(next);
    await descSaveQueue.current.run(async () => {
      // A tick queued ahead of this one may already have landed these words.
      if (edit.text === descSaved.current) return;
      setSaving(true);
      try {
        const res = await fetch(`/api/features/${encodeURIComponent(edit.file)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, save: true }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          content?: string;
          parsed?: Feature;
          error?: string;
        };
        if (res.ok && typeof data.content === "string") {
          // The editor may have closed, or moved to another feature, while the
          // save was away: then its result belongs to nothing on screen.
          if (descEditRef.current?.file === edit.file) descSaved.current = edit.text;
          if (selectedRef.current === edit.file) {
            setFeature(
              featureFromResponse({ content: data.content, parsed: data.parsed }, edit.file),
            );
            markSaved();
          }
        } else {
          toast.error(`Description not saved: ${data.error ?? res.statusText} — will retry.`);
        }
      } catch (e) {
        toast.error(`Description not saved: ${(e as Error).message} — will retry.`);
      } finally {
        setSaving(false);
      }
    });
  };
  const descTick = useRef(autosaveDescription);
  useEffect(() => {
    descTick.current = autosaveDescription;
  });
  // Ticks run while the selected feature's description editor is on. Leaving
  // it — Done, or navigating to another feature or home — saves what was typed
  // since the last tick, then drops an editor left behind by navigation.
  const descOpen = descEdit !== null && descEdit.file === selected;
  useEffect(() => {
    if (!descOpen) return;
    const id = setInterval(() => {
      if (featureEditorsRetiring.current || featureEditorsSealed.current) return;
      void descTick.current();
    }, autosaveSeconds * 1000);
    return () => {
      clearInterval(id);
      if (!featureEditorsSealed.current) void descTick.current();
      if (descEditRef.current && descEditRef.current.file !== selectedRef.current) setDescEdit(null);
    };
  }, [descOpen, autosaveSeconds]);

  /** Done: land what the editor holds and show the description rendered. */
  const closeDescriptionEditor = async () => {
    await descTick.current();
    setDescEdit(null);
  };

  return {
    closeDescriptionEditor,
    descTick,
    openDescriptionEditor,
  };
}

// What the command palette shows of the spec files, for the Specs tab
// (src/plugins/builtin/specs/client.tsx): its search (specs/search.feature
// .md) — the tab's own, and the one every tab without a search falls back
// to — where a hit is a feature or one of its scenarios, opened exactly like
// its deep link; and how the Recent list names one that was open.

import { FileText } from "lucide-react";
import type { PaletteHit, RecentItem } from "../../plugins/client/tabs";
import type { SpecsView } from "../../plugins/builtin/specs/route";
import { slugify, titleFromFileName } from "../../server/parser";
import type { SearchResultItem } from "../../server/search";
import { markText } from "../highlight";
import { featurePath, scenarioPath } from "../route";
import { StatusIcon } from "../StatusIcon";
import { scenarioStatus, specsListing } from "./listing";
import { openFeatureState } from "./openFeature";

/** A hit's url: the scenario's page, or the feature's. */
export function resultHref(r: SearchResultItem): string {
  return r.scenario ? scenarioPath(r.fileName, r.scenario) : featurePath(r.fileName);
}

/** The features and scenarios a query finds, as palette hits. */
export async function searchSpecs(q: string, signal: AbortSignal): Promise<PaletteHit<SpecsView>[]> {
  const res = await fetch(`/api/search?scope=specs&q=${encodeURIComponent(q)}`, { signal });
  const data = (await res.json()) as { results?: SearchResultItem[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Search failed");
  return (data.results ?? []).map((r) => {
    const scenario = r.scenario ? { slug: slugify(r.scenario.name), version: r.scenario.version } : null;
    const view: SpecsView = { feature: r.fileName, scenario, terms: r.terms };
    return {
      id: `${r.kind}:${r.fileName}:${r.scenario?.name ?? ""}@${r.scenario?.version ?? 0}`,
      group: r.scenario ? "Scenarios" : "Features",
      label: r.scenario ? r.scenario.name : r.featureName,
      sub: r.scenario ? (
        <>
          {r.featureName}
          {r.snippet && <> · {markText(r.snippet, r.terms)}</>}
        </>
      ) : r.snippet ? (
        markText(r.snippet, r.terms)
      ) : undefined,
      icon: r.scenario ? (
        <StatusIcon status={scenarioStatus(r.fileName, r.scenario)} size={14} />
      ) : (
        <FileText size={14} />
      ),
      href: resultHref(r),
      view,
      // Alt opens the scenario's card on its feature's page.
      ...(r.scenario ? { altView: { ...view, page: true } } : {}),
    };
  });
}

/**
 * How the Recent list shows a feature or a scenario that was open: by its
 * name as the open feature has it, else as listed; null for a scenario that
 * is no longer there.
 */
export function recentSpec(view: SpecsView): RecentItem<SpecsView> | null {
  const listing = specsListing().features.find((f) => f.fileName === view.feature);
  const { selected, feature } = openFeatureState();
  const open = view.feature === selected ? feature : null;
  const name = open?.name || listing?.name || titleFromFileName(view.feature);
  if (!view.scenario) return { label: name, icon: <FileText size={14} /> };
  const { slug, version } = view.scenario;
  const s = (open?.scenarios ?? listing?.scenarios ?? []).find(
    (x) => slugify(x.name) === slug && (version === undefined || x.version === version),
  );
  if (!s) return null;
  return {
    label: s.name,
    sub: name,
    icon: <StatusIcon status={scenarioStatus(view.feature, s)} size={14} />,
    altView: { ...view, page: true },
  };
}

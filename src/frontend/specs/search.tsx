// The palette's search of the spec files (specs/search.feature.md): the
// Specs tab's own, and the one every tab without a search falls back to
// (src/plugins/builtin/specs/client.tsx). A hit is a feature or one of its
// scenarios, opened exactly like its deep link.

import { FileText } from "lucide-react";
import type { PaletteHit } from "../../plugins/client/tabs";
import type { SpecsView } from "../../plugins/builtin/specs/route";
import { slugify } from "../../server/parser";
import type { SearchResultItem } from "../../server/search";
import { markText } from "../highlight";
import { featurePath, scenarioPath } from "../route";
import { StatusIcon } from "../StatusIcon";
import { scenarioStatus } from "./listing";

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

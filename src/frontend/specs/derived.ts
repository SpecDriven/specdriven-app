// What the Specs tab derives from the listing and the open feature: the
// data repo's attribute definitions as parsed, the names and values its
// attributes use, and how many scenarios are draft, proposed and published.
// Moved out of App.tsx as they were, into a hook App.tsx calls.

import { useMemo } from "react";
import { knownNames, parseAttributeDefinitions } from "../../server/customAttributes";
import { useSpecsListing } from "./listing";
import { useOpenFeature } from "./openFeature";

export interface SpecsDerivedDeps {
  customAttributesText: string | null;
}

export function useSpecsDerived(deps: SpecsDerivedDeps) {
  const { feature } = useOpenFeature();
  const { features } = useSpecsListing();
  const {
    customAttributesText,
  } = deps;
  const attributeDefs = useMemo(
    () => parseAttributeDefinitions(customAttributesText ?? ""),
    [customAttributesText],
  );
  /**
   * Project-wide status rollup for the Specs section head: how many scenarios
   * are draft / proposed / published across every feature. Always the full
   * totals — independent of any active filter.
   */
  const statusTotals = useMemo(() => {
    const t = { draft: 0, proposed: 0, published: 0 };
    for (const f of features) for (const s of f.scenarios) t[s.status]++;
    return t;
  }, [features]);
  // What the data repo's attributes use, for the chips' checks and the
  // editor's suggestions (specs/app/custom-attributes.feature.md): every
  // listed feature, and the open one as it stands — its drafts and an edit
  // the listing has not caught up with included.
  const knownAttributes = useMemo(
    () =>
      knownNames([
        ...features.flatMap((f) => [f.attributes, ...f.scenarios.map((s) => s.attributes)]),
        feature?.attributes,
        ...(feature?.scenarios.map((s) => s.attributes) ?? []),
      ]),
    [features, feature],
  );
  return {
    attributeDefs,
    knownAttributes,
    statusTotals,
  };
}

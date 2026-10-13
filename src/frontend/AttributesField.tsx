// Custom attributes (specs/app/custom-attributes.feature.md): the chips a
// feature header and a scenario card show for the attributes a feature or a
// scenario carries. An attribute is written `[<key>:<name>…:<value>]` under
// the heading (src/server/parser.ts); the data repo's definitions
// (src/server/customAttributes.ts) label the chips and say which ones do not
// fit.

import { Tag, TriangleAlert } from "lucide-react";
import {
  attributeLabel,
  attributeProblems,
  type AttributeDefinitions,
  type AttributeScope,
  type KnownAttributes,
} from "../server/customAttributes";
import { formatAttribute, type SpecAttribute } from "../server/parser";

/** How an attribute reads to a screen reader and in a chip's title. */
export function attributeText(a: SpecAttribute, label = a.key): string {
  return [label, ...a.names].join(" ") + ` = ${a.value}`;
}

/**
 * One chip per attribute; nothing when there are none. With definitions, a
 * chip carries its definition's label, an `on` value reads green and `off`
 * red, and one that does not fit is amber with the reason in its title. A
 * repo with no definitions at all warns about nothing.
 */
export function AttributeChips({
  attributes,
  where,
  defs,
  known = new Map(),
}: {
  attributes: readonly SpecAttribute[] | undefined;
  where: AttributeScope;
  defs?: AttributeDefinitions;
  known?: KnownAttributes;
}) {
  if (!attributes || attributes.length === 0) return null;
  const problems =
    defs && defs.list.length > 0 ? attributeProblems(attributes, where, defs, known) : attributes.map(() => null);
  return (
    <span className="attribute-chips">
      {attributes.map((a, i) => {
        const label = attributeLabel(defs, a.key);
        const problem = problems[i];
        const description = defs?.byKey.get(a.key)?.description;
        const tone = problem ? " warning" : a.value === "on" ? " on" : a.value === "off" ? " off" : "";
        return (
          <span
            key={formatAttribute(a)}
            className={`chip static attribute${tone}`}
            title={[attributeText(a, label), problem ?? description].filter(Boolean).join(" — ")}
            data-attribute={formatAttribute(a)}
          >
            {problem ? (
              <TriangleAlert size={12} aria-label="Warning" />
            ) : (
              <Tag size={12} aria-hidden="true" />
            )}
            <span className="attribute-label">{label}</span>
            {a.names.length > 0 && <span className="attribute-names">{a.names.join(" · ")}</span>}
            <span className="attribute-value">{a.value}</span>
          </span>
        );
      })}
    </span>
  );
}

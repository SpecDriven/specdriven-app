// Custom attributes (specs/app/custom-attributes.feature.md): the chips a
// feature header and a scenario card show for the attributes a feature or a
// scenario carries. An attribute is written `[<key>:<name>…:<value>]` under
// the heading (src/server/parser.ts).

import { Tag } from "lucide-react";
import { formatAttribute, type SpecAttribute } from "../server/parser";

/** How an attribute reads to a screen reader and in a chip's title. */
export function attributeText(a: SpecAttribute, label = a.key): string {
  return [label, ...a.names].join(" ") + ` = ${a.value}`;
}

/** One chip per attribute, labelled by its key; nothing when there are none. */
export function AttributeChips({ attributes }: { attributes: readonly SpecAttribute[] | undefined }) {
  if (!attributes || attributes.length === 0) return null;
  return (
    <span className="attribute-chips">
      {attributes.map((a) => (
        <span
          key={formatAttribute(a)}
          className="chip static attribute"
          title={attributeText(a)}
          data-attribute={formatAttribute(a)}
        >
          <Tag size={12} aria-hidden="true" />
          <span className="attribute-label">{a.key}</span>
          {a.names.length > 0 && <span className="attribute-names">{a.names.join(" · ")}</span>}
          <span className="attribute-value">{a.value}</span>
        </span>
      ))}
    </span>
  );
}

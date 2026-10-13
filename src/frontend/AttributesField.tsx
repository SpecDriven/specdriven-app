// Custom attributes (specs/app/custom-attributes.feature.md): the chips a
// feature header and a scenario card show for the attributes a feature or a
// scenario carries, and the field that adds, changes and removes them — in
// the scenario editor pane and in the feature header's popover. An attribute
// is written `[<key>:<name>…:<value>]` under the heading
// (src/server/parser.ts); the data repo's definitions
// (src/server/customAttributes.ts) label them, say which ones do not fit and
// shape the editor's controls.

import { useId, useState } from "react";
import { Tag, TriangleAlert, X } from "lucide-react";
import {
  attributeLabel,
  attributeProblems,
  attributeSuggestions,
  definitionsFor,
  partControl,
  segmentProblem,
  type AttributeDefinitions,
  type AttributePart,
  type AttributeScope,
  type AttributeSlot,
  type KnownAttributes,
} from "../server/customAttributes";
import { formatAttribute, isAttributeSegment, type SpecAttribute } from "../server/parser";

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

/** An attribute's identity: its key and names, without the value. */
const identity = (a: SpecAttribute) => [a.key, ...a.names].join(":");

/**
 * Why an attribute cannot be added to the list, or null when it can: a part
 * left empty, one the token cannot carry or the definition does not take,
 * or the same attribute already there (to change its value, change that
 * one).
 */
export function attributeAddError(
  list: readonly SpecAttribute[],
  a: SpecAttribute,
  defs: AttributeDefinitions,
  known: KnownAttributes,
): string | null {
  const def = defs.byKey.get(a.key);
  if (!def) return "Choose what kind of attribute to add.";
  const parts = [...def.names, def.value];
  const segments = [...a.names, a.value];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const segment = segments[i] ?? "";
    const what = part.slot?.name ?? (i === parts.length - 1 ? "value" : "name");
    if (segment.trim() === "") return `Fill in the ${what}.`;
    if (!isAttributeSegment(segment)) {
      return `The ${what} cannot hold [ ] or :, or start or end with a space.`;
    }
    const why = segmentProblem(part, segment, known, defs);
    if (why) return `${why}.`;
  }
  if (list.some((b) => identity(b) === identity(a))) {
    return `There is already a ${[def.label.toLowerCase(), ...a.names].join(" ")}.`;
  }
  return null;
}

/** The list with an attribute added after the last one of its key, else at the end. */
export function addAttribute(list: readonly SpecAttribute[], a: SpecAttribute): SpecAttribute[] {
  const next = [...list];
  let at = -1;
  next.forEach((b, i) => {
    if (b.key === a.key) at = i;
  });
  next.splice(at === -1 ? next.length : at + 1, 0, a);
  return next;
}

/** The list with one attribute's value changed. */
export function setAttributeValue(list: readonly SpecAttribute[], index: number, value: string): SpecAttribute[] {
  return list.map((a, i) => (i === index ? { ...a, value } : a));
}

/** The list without one attribute. */
export function removeAttribute(list: readonly SpecAttribute[], index: number): SpecAttribute[] {
  return list.filter((_, i) => i !== index);
}

/** What a part's control starts at in the add row. */
function initialSegment(part: AttributePart): string {
  const control = partControl(part);
  if (control.kind === "switch") return "on";
  if (control.kind === "select" || control.kind === "select-other") return control.options[0] ?? "";
  return "";
}

/** The select's "Other…" entry: not a word a pattern can hold, so never a real value. */
const OTHER = "<other>";

/**
 * One part's control: a switch for exactly `on|off`, a select for words, an
 * input for a slot (a number one with a decimal keypad), and a select with
 * "Other…" for words plus a slot. `onChange` gets every change; a typed
 * value is the caller's to commit.
 */
export function PartControl({
  part,
  value,
  onChange,
  onCommit,
  label,
  listId,
  disabled = false,
}: {
  part: AttributePart;
  value: string;
  onChange: (value: string) => void;
  /** A typed value is done: Enter or leaving the field. */
  onCommit?: () => void;
  label: string;
  listId?: string;
  disabled?: boolean;
}) {
  const control = partControl(part);
  const [other, setOther] = useState(
    control.kind === "select-other" && value !== "" && !control.options.includes(value),
  );
  const input = (slot: AttributeSlot, inputLabel = label) => (
    <input
      value={value}
      placeholder={slot.name}
      aria-label={inputLabel}
      spellCheck={false}
      disabled={disabled}
      list={listId}
      inputMode={slot.type === "number" ? "decimal" : undefined}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onCommit?.()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onCommit) {
          e.preventDefault();
          onCommit();
        }
      }}
    />
  );
  if (control.kind === "switch") {
    return (
      <label className="feature-flag-toggle">
        <span className="switch">
          <input
            type="checkbox"
            role="switch"
            aria-label={label}
            checked={value === "on"}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? "on" : "off")}
          />
          <span className="switch-track" aria-hidden="true" />
        </span>
        <span className={`feature-flag-state${value === "on" ? "" : " off"}`}>{value === "on" ? "on" : "off"}</span>
      </label>
    );
  }
  if (control.kind === "input") return input(control.slot);
  // A select-only value the definition no longer offers is still shown, so the row reads true.
  const options =
    control.kind === "select" && value !== "" && !control.options.includes(value)
      ? [value, ...control.options]
      : control.options;
  return (
    <span className="attribute-part">
      <select
        aria-label={label}
        value={other ? OTHER : value}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setOther(true);
            onChange("");
          } else {
            setOther(false);
            onChange(e.target.value);
          }
        }}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {control.kind === "select-other" && <option value={OTHER}>Other…</option>}
      </select>
      {control.kind === "select-other" && other && input(control.slot, `${label}, other value`)}
    </span>
  );
}

/** A row's value control for an attribute already in the list; typed values commit on Enter or blur. */
function ValueRow({
  a,
  part,
  onCommit,
  check,
  disabled,
}: {
  a: SpecAttribute;
  part: AttributePart;
  onCommit: (value: string) => void;
  check: (value: string) => string | null;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(a.value);
  const [error, setError] = useState<string | null>(null);
  const control = partControl(part);
  const commit = (value: string) => {
    if (value === a.value) return setError(null);
    const why = check(value);
    setError(why);
    if (!why) onCommit(value);
  };
  return (
    <>
      <PartControl
        part={part}
        value={draft}
        label={`Value of ${[a.key, ...a.names].join(" ")}`}
        disabled={disabled}
        onChange={(value) => {
          setDraft(value);
          setError(null);
          // A switch or a select is a choice made: saved at once. Typing waits for Enter or blur.
          const typed =
            control.kind === "input" ||
            (control.kind === "select-other" && !control.options.includes(value));
          if (!typed) commit(value);
        }}
        onCommit={() => commit(draft)}
      />
      {error && <span className="error">{error}</span>}
    </>
  );
}

/**
 * The editable list (specs/app/custom-attributes.feature.md "Attributes are
 * edited on the feature and in the scenario editor"): a row per attribute —
 * its label, its names, a control for its value and a ✕ — and an add row
 * that picks a kind of attribute from the definitions and fills in its
 * parts, suggesting the names the data repo already uses. An attribute the
 * definitions do not cover shows as written, with only its ✕. Every change
 * goes straight to `onChange`; the parent decides when it is saved.
 */
export function AttributesField({
  attributes,
  onChange,
  where,
  defs,
  known,
  disabled = false,
  autoFocus = false,
}: {
  attributes: readonly SpecAttribute[];
  onChange: (next: SpecAttribute[]) => void | Promise<void>;
  where: AttributeScope;
  defs: AttributeDefinitions;
  known: KnownAttributes;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const kinds = definitionsFor(defs, where);
  const [key, setKey] = useState(kinds[0]?.key ?? "");
  const def = kinds.find((k) => k.key === key) ?? kinds[0];
  const [segments, setSegments] = useState<string[]>(() =>
    def ? [...def.names, def.value].map(initialSegment) : [],
  );
  const [error, setError] = useState<string | null>(null);
  const baseId = useId();
  const problems = attributeProblems(attributes, where, defs, known);

  const pick = (next: string) => {
    setKey(next);
    const d = defs.byKey.get(next);
    setSegments(d ? [...d.names, d.value].map(initialSegment) : []);
    setError(null);
  };
  const add = () => {
    if (!def) return;
    const a: SpecAttribute = {
      key: def.key,
      names: def.names.map((_, i) => (segments[i] ?? "").trim()),
      value: (segments[def.names.length] ?? "").trim(),
    };
    const why = attributeAddError(attributes, a, defs, known);
    if (why) return setError(why);
    void onChange(addAttribute(attributes, a));
    setSegments([...def.names, def.value].map(initialSegment));
    setError(null);
  };

  return (
    <div className="attributes-field">
      {attributes.length > 0 && (
        <ul className="attribute-list">
          {attributes.map((a, i) => {
            const d = defs.byKey.get(a.key);
            const fits = d !== undefined && d.names.length === a.names.length && d.scope.includes(where);
            return (
              <li key={formatAttribute(a)} data-attribute={formatAttribute(a)}>
                <span className="attribute-row-label">{attributeLabel(defs, a.key)}</span>
                {a.names.length > 0 && <code>{a.names.join(" · ")}</code>}
                {fits ? (
                  <ValueRow
                    a={a}
                    part={d.value}
                    disabled={disabled}
                    check={(value) => {
                      if (!isAttributeSegment(value)) return "That value cannot hold [ ] or :, or start or end with a space.";
                      const why = segmentProblem(d.value, value, known, defs);
                      return why ? `${why}.` : null;
                    }}
                    onCommit={(value) => void onChange(setAttributeValue(attributes, i, value))}
                  />
                ) : (
                  <code className="attribute-value">{a.value}</code>
                )}
                {problems[i] && (
                  <span className="attribute-problem" title={problems[i]!}>
                    <TriangleAlert size={12} aria-hidden="true" /> {problems[i]}
                  </span>
                )}
                <button
                  type="button"
                  className="link"
                  title={`Remove ${formatAttribute(a)}`}
                  aria-label={`Remove ${formatAttribute(a)}`}
                  disabled={disabled}
                  onClick={() => void onChange(removeAttribute(attributes, i))}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {def ? (
        <form
          className="attribute-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <select
            aria-label="Kind of attribute"
            value={def.key}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={(e) => pick(e.target.value)}
          >
            {kinds.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
          {[...def.names, def.value].map((part, i) => {
            const listId = `${baseId}-${i}`;
            const suggestions = part.slot ? attributeSuggestions(defs, def.key, i, known) : [];
            const isValue = i === def.names.length;
            return (
              <span key={`${def.key}:${i}`} className="attribute-part">
                <PartControl
                  part={part}
                  value={segments[i] ?? ""}
                  label={part.slot?.name ?? (isValue ? "Value" : `Name ${i + 1}`)}
                  listId={suggestions.length > 0 ? listId : undefined}
                  disabled={disabled}
                  onChange={(value) => {
                    setSegments((s) => s.map((v, j) => (j === i ? value : v)));
                    setError(null);
                  }}
                />
                {suggestions.length > 0 && (
                  <datalist id={listId}>
                    {suggestions.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                )}
              </span>
            );
          })}
          <button type="submit" className="link" disabled={disabled}>
            Add
          </button>
        </form>
      ) : (
        <p className="hint">Define attributes for {where}s in Settings → Custom attributes to add them here.</p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

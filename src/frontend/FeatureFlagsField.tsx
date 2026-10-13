// Feature flags (specs/app/feature-flags.feature.md): the chips a feature
// header and a scenario card show for the flags gating them, and the
// "Feature flags" field that adds, toggles and removes them — in the
// scenario editor pane and in the feature header's popover. A flag is
// written `[ff:<name>:on|off]` under the heading (src/server/parser.ts).

import { useState } from "react";
import { Flag, X } from "lucide-react";
import { isFeatureFlagName, type FeatureFlag } from "../server/parser";

/** Why a name cannot be added to the list, or null when it can. */
export function featureFlagNameError(flags: readonly FeatureFlag[], name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the flag a name.";
  if (!isFeatureFlagName(trimmed)) {
    return "A flag name starts with a letter or digit and holds only letters, digits, . _ and -.";
  }
  if (flags.some((f) => f.name === trimmed)) return `There is already a flag named ${trimmed}.`;
  return null;
}

/** The list with a new flag added at the end, on or off as it was set in the add row. */
export function addFeatureFlag(flags: readonly FeatureFlag[], name: string, on = true): FeatureFlag[] {
  return [...flags, { name: name.trim(), on }];
}

/** The list with one flag switched to `on`. */
export function setFeatureFlag(flags: readonly FeatureFlag[], name: string, on: boolean): FeatureFlag[] {
  return flags.map((f) => (f.name === name ? { ...f, on } : f));
}

/** The list without one flag. */
export function removeFeatureFlag(flags: readonly FeatureFlag[], name: string): FeatureFlag[] {
  return flags.filter((f) => f.name !== name);
}

/** How a flag reads on a chip and to a screen reader. */
export function featureFlagLabel(flag: FeatureFlag): string {
  return `${flag.name}: ${flag.on ? "on" : "off"}`;
}

/** One chip per flag, an on flag green and an off one red; nothing when there are none. */
export function FeatureFlagChips({ flags }: { flags: readonly FeatureFlag[] | undefined }) {
  if (!flags || flags.length === 0) return null;
  return (
    <span className="feature-flag-chips">
      {flags.map((f) => (
        <span
          key={f.name}
          className={`chip static feature-flag${f.on ? " on" : " off"}`}
          title={`Feature flag ${featureFlagLabel(f)}`}
          data-feature-flag={f.name}
        >
          <Flag size={12} aria-hidden="true" />
          {f.name}
          <span className="feature-flag-state">{f.on ? "on" : "off"}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * The editable list: a row per flag with its on/off switch and a ✕, and an
 * add row for another — a name and its own on/off switch, so a flag is added
 * already set the way it should be. Every change goes straight to
 * `onChange`; the parent decides when it is saved.
 */
export function FeatureFlagsField({
  flags,
  onChange,
  disabled = false,
  autoFocus = false,
}: {
  flags: readonly FeatureFlag[];
  onChange: (next: FeatureFlag[]) => void | Promise<void>;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [name, setName] = useState("");
  /** Whether the flag being added starts on; on unless switched off. */
  const [on, setOn] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const why = featureFlagNameError(flags, name);
    if (why) {
      setError(why);
      return;
    }
    void onChange(addFeatureFlag(flags, name, on));
    setName("");
    setOn(true);
    setError(null);
  };

  return (
    <div className="feature-flags-field">
      {flags.length > 0 && (
        <ul className="feature-flag-list">
          {flags.map((f) => (
            <li key={f.name}>
              <label className="feature-flag-toggle">
                <span className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Feature flag ${f.name}`}
                    checked={f.on}
                    disabled={disabled}
                    onChange={(e) => void onChange(setFeatureFlag(flags, f.name, e.target.checked))}
                  />
                  <span className="switch-track" aria-hidden="true" />
                </span>
                <code>{f.name}</code>
                <span className={`feature-flag-state${f.on ? "" : " off"}`}>{f.on ? "on" : "off"}</span>
              </label>
              <button
                type="button"
                className="link"
                title={`Remove ${f.name}`}
                aria-label={`Remove ${f.name}`}
                disabled={disabled}
                onClick={() => void onChange(removeFeatureFlag(flags, f.name))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="feature-flag-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={name}
          placeholder="flag-name"
          aria-label="Feature flag name"
          spellCheck={false}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
        <label className="feature-flag-toggle">
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="New flag on"
              checked={on}
              disabled={disabled}
              onChange={(e) => setOn(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
          <span className={`feature-flag-state${on ? "" : " off"}`}>{on ? "on" : "off"}</span>
        </label>
        <button type="submit" className="link" disabled={disabled || !name.trim()}>
          Add
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

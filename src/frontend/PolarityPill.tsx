// A scenario's polarity (specs/ui/scenario-polarity.feature.md): green for a
// positive scenario, red for a negative one, flipped on a click. Shown only
// while the "Positive and negative scenarios" setting is on — on a scenario
// card as a small dot beside the title (`compact`), in the editor pane as a
// pill that also reads Positive or Negative.

export function PolarityPill({
  negative,
  onToggle,
  disabled = false,
  compact = false,
}: {
  negative: boolean;
  onToggle: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const word = negative ? "Negative" : "Positive";
  return (
    <button
      type="button"
      className={`${compact ? "polarity-dot-button" : "chip polarity-pill"} ${negative ? "negative" : "positive"}`}
      aria-label={negative ? "Mark positive" : "Mark negative"}
      title={`${word} scenario — click to mark ${negative ? "positive" : "negative"}`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <span className="polarity-dot" aria-hidden="true" />
      {!compact && word}
    </button>
  );
}

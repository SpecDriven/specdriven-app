// Add a task to Google Calendar (specs/app/tasks.feature.md "Add task to
// Google Calendar"): the small form behind a task's calendar chip — how long
// the task will take, proposed by Claude when the CLI is there or picked
// from a few presets when it is not, and when to start — and the link that
// opens Google Calendar on the prefilled event. The link is a real anchor
// rather than a window.open after a fetch, which a browser's popup blocker
// would swallow; the estimate is saved on the task as it is clicked.
//
// Pure over what it shows, so bun test can render it without a DOM
// (tests/addToCalendarForm.test.tsx).

import { ESTIMATE_PRESETS, formatEstimate, parseEstimate } from "../server/calendar";

/** Where the estimate in the field came from — what the hint says. */
export type EstimateProposal = "loading" | "claude" | "stored" | "manual";

export interface AddToCalendarFormProps {
  estimateText: string;
  onEstimateChange: (text: string) => void;
  /** The start as `<input type="datetime-local">` holds it. */
  startLocal: string;
  onStartChange: (value: string) => void;
  proposal: EstimateProposal;
  /** The Google Calendar link, or null while the estimate or the start does
      not make one. */
  url: string | null;
  /** The link was followed: save the estimate and close. */
  onSubmit: () => void;
  onCancel: () => void;
}

const HINTS: Record<EstimateProposal, string> = {
  loading: "Asking Claude how long this will take…",
  claude: "Suggested by Claude — change it if you know better.",
  stored: "The estimate on the task; change it if things have moved on.",
  manual: "How long will this take? Pick one, or type an estimate like 1h 30m.",
};

export function AddToCalendarForm({
  estimateText,
  onEstimateChange,
  startLocal,
  onStartChange,
  proposal,
  url,
  onSubmit,
  onCancel,
}: AddToCalendarFormProps) {
  const minutes = parseEstimate(estimateText);
  const invalid = estimateText.trim() !== "" && minutes === null;
  return (
    <form
      className="calendar-form"
      onSubmit={(e) => {
        // Enter in a field: the same as the link, opened in a user gesture.
        e.preventDefault();
        if (!url) return;
        window.open(url, "_blank", "noopener");
        onSubmit();
      }}
    >
      <p className="hint">{HINTS[proposal]}</p>
      <label className="calendar-field">
        <span>Estimate</span>
        <input
          type="text"
          aria-label="Estimate"
          value={estimateText}
          placeholder="1h 30m"
          disabled={proposal === "loading"}
          aria-invalid={invalid || undefined}
          onChange={(e) => onEstimateChange(e.target.value)}
          autoFocus
        />
      </label>
      {proposal !== "loading" && (
        <div className="calendar-presets" role="group" aria-label="Estimate presets">
          {ESTIMATE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`chip${minutes === preset ? "" : " muted"}`}
              aria-pressed={minutes === preset}
              onClick={() => onEstimateChange(formatEstimate(preset))}
            >
              {formatEstimate(preset)}
            </button>
          ))}
        </div>
      )}
      {invalid && <p className="hint error">Write an estimate like 30m, 2h or 1h 30m.</p>}
      <label className="calendar-field">
        <span>Start</span>
        <input
          type="datetime-local"
          aria-label="Start"
          value={startLocal}
          onChange={(e) => onStartChange(e.target.value)}
        />
      </label>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        {url ? (
          <a className="button-link" href={url} target="_blank" rel="noopener noreferrer" onClick={onSubmit}>
            Add to Google Calendar
          </a>
        ) : (
          <a className="button-link" aria-disabled="true" role="link">
            Add to Google Calendar
          </a>
        )}
      </div>
    </form>
  );
}

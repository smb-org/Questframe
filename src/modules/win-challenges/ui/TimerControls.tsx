export type TimerControlsProps = {
  state: "idle" | "running" | "paused" | "expired";
  labelPrefix: string;
  disabled?: boolean;
  showReset?: boolean;
  onToggle: () => void;
  onReset?: () => void;
};

const PlayIcon = () => (
  <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16">
    <path d="M5 3.2v9.6L12.6 8z" fill="currentColor" />
  </svg>
);

const PauseIcon = () => (
  <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16">
    <path d="M5 3h2.2v10H5zm3.8 0H11v10H8.8z" fill="currentColor" />
  </svg>
);

const ResetIcon = () => (
  <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16">
    <path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    <path d="M2.6 3.2v3h3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
  </svg>
);

export const TimerControls = ({
  state,
  labelPrefix,
  disabled = false,
  showReset = true,
  onToggle,
  onReset,
}: TimerControlsProps) => {
  const toggleLabel = `${labelPrefix} ${state === "running" ? "pausieren" : "starten"}`;
  const resetLabel = `${labelPrefix} zurücksetzen`;

  return (
    <div className="wc-timer-controls">
      <button
        aria-label={toggleLabel}
        className="wc-timer-control wc-timer-control--toggle"
        disabled={disabled}
        onClick={onToggle}
        title={toggleLabel}
        type="button"
      >
        {state === "running" ? <PauseIcon /> : <PlayIcon />}
      </button>
      {showReset && (
        <button
          aria-label={resetLabel}
          className="wc-timer-control wc-timer-control--reset"
          disabled={disabled || state === "idle"}
          onClick={onReset}
          title={resetLabel}
          type="button"
        >
          <ResetIcon />
        </button>
      )}
    </div>
  );
};

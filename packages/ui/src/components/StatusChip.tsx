interface StatusChipProps {
  readonly label: string;
  readonly tone?: "healthy" | "degraded" | "failed" | "warning" | "blocked" | "retry" | "neutral" | "selected";
}

const toneClasses: Record<NonNullable<StatusChipProps["tone"]>, string> = {
  healthy: "border-success/45 bg-success/12 text-success",
  degraded: "border-warning/45 bg-warning/12 text-warning",
  failed: "border-danger/45 bg-danger/12 text-danger",
  warning: "border-warning/45 bg-warning/12 text-warning",
  blocked: "border-blocked/50 bg-blocked/12 text-blocked",
  retry: "border-retry/50 bg-retry/12 text-retry",
  neutral: "border-border bg-bg-panel text-text-muted",
  selected: "border-primary/50 bg-primary/15 text-primary"
};

export function StatusChip({ label, tone = "neutral" }: StatusChipProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClasses[tone]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

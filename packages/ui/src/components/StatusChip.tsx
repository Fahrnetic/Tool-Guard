interface StatusChipProps {
  readonly label: string;
  readonly tone?: "healthy" | "degraded" | "failed" | "neutral" | "selected";
}

const toneClasses: Record<NonNullable<StatusChipProps["tone"]>, string> = {
  healthy: "border-success/40 bg-success/10 text-success",
  degraded: "border-warning/40 bg-warning/10 text-warning",
  failed: "border-danger/40 bg-danger/10 text-danger",
  neutral: "border-border bg-bg-panel text-text-muted",
  selected: "border-primary/50 bg-primary/15 text-primary"
};

export function StatusChip({ label, tone = "neutral" }: StatusChipProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${toneClasses[tone]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

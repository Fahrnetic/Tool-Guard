import { correlationKeys, type CorrelationContext } from "../lib/model.js";

interface CorrelationGridProps {
  readonly correlation: CorrelationContext;
  readonly compact?: boolean;
}

export function CorrelationGrid({ correlation, compact = false }: CorrelationGridProps) {
  const entries = correlationKeys.map((key) => [key, correlation[key]] as const).filter(([, value]) => value);
  if (entries.length === 0) {
    return <p className="text-sm text-text-muted">No correlation IDs are available for this item.</p>;
  }
  return (
    <dl className={`grid gap-2 ${compact ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-3"}`}>
      {entries.map(([key, value]) => (
        <div key={key} className="rounded-xl border border-border bg-bg/55 p-3">
          <dt className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-text-dim">{key}</dt>
          <dd className="mt-1 break-all font-mono text-xs text-primary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

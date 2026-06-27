import type { ResourceStatus } from "../lib/model.js";

interface StatePanelProps {
  readonly status: ResourceStatus;
  readonly title: string;
  readonly message: string;
  readonly action?: string;
}

export function StatePanel({ status, title, message, action }: StatePanelProps) {
  const label = status === "degraded" ? "Partial data" : status;
  return (
    <section
      className="rounded-2xl border border-border bg-bg-panel/80 p-5 shadow-2xl shadow-black/20"
      aria-label={`${title} ${label} state`}
    >
      <div className="flex items-start gap-4">
        <div className="mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
          {status === "loading" ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          ) : (
            <span className="text-sm font-black">{label.slice(0, 1).toUpperCase()}</span>
          )}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-dim">{label}</p>
          <h3 className="mt-1 text-base font-semibold text-text">{title}</h3>
          <p className="mt-2 text-sm leading-6 text-text-muted">{message}</p>
          {action ? <p className="mt-3 text-sm font-medium text-primary">{action}</p> : null}
        </div>
      </div>
    </section>
  );
}

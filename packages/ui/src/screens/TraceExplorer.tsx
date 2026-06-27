import { CorrelationGrid } from "../components/CorrelationGrid.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import type { ResourceStatus, TracePayload } from "../lib/model.js";

interface TraceExplorerProps {
  readonly payload?: TracePayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

export function TraceExplorer({ payload, status, error }: TraceExplorerProps) {
  if (status === "loading") {
    return <StatePanel status="loading" title="Loading Trace Explorer" message="Resolving the latest trace from `/api/traces/latest`." />;
  }
  if (status === "error") {
    return <StatePanel status="error" title="Trace Explorer unavailable" message={error ?? "Core did not return trace data."} />;
  }
  if (!payload || payload.status === "empty") {
    return <StatePanel status="empty" title="No trace data" message="No run, trace, tool call, attempt, policy, or artifact IDs have been emitted yet." />;
  }

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <StatusChip label={payload.status === "degraded" ? "Partial trace data inspectable" : "Trace context preserved"} tone={payload.status === "degraded" ? "degraded" : "selected"} />
            <h2 className="mt-3 text-2xl font-semibold text-text">Trace Explorer</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
              Selectable correlation fields preserve the parent-child path from harness to adapter, downstream server,
              tool call, attempt, policy decision, and artifact.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-panel p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-text-dim">traceId</p>
            <p className="mt-1 break-all font-mono text-xs text-primary">{payload.traceId}</p>
          </div>
        </div>
      </div>

      {payload.warnings.map((warning) => (
        <StatePanel key={warning} status="degraded" title="Partial trace" message={warning} action="Partial data remains available for inspection." />
      ))}

      <div className="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
        <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
          <h3 className="text-lg font-semibold text-text">Correlation selectors</h3>
          <p className="mt-1 text-sm text-text-muted">Keyboard-focusable IDs keep full context visible.</p>
          <div className="mt-4">
            <CorrelationGrid correlation={payload.correlation} />
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
          <h3 className="text-lg font-semibold text-text">Parent-child graph</h3>
          <ol className="mt-4 space-y-3">
            {payload.nodes.map((node) => (
              <li key={node.id} tabIndex={0} className="rounded-xl border border-border bg-bg/55 p-3 outline-none transition hover:border-primary/45 focus-visible:border-primary">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip label={node.kind} tone="neutral" />
                  <span className="break-all font-mono text-xs text-primary">{node.label}</span>
                </div>
                <p className="mt-2 text-sm text-text-muted">{node.summary}</p>
                {node.parentId ? <p className="mt-1 break-all text-xs text-text-dim">parentId {node.parentId}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
        <h3 className="text-lg font-semibold text-text">Trace events</h3>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[920px] w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.16em] text-text-dim">
              <tr>
                <th className="border-b border-border px-3 py-2">Event</th>
                <th className="border-b border-border px-3 py-2">Time</th>
                <th className="border-b border-border px-3 py-2">Tool call</th>
                <th className="border-b border-border px-3 py-2">Attempt</th>
                <th className="border-b border-border px-3 py-2">Policy</th>
              </tr>
            </thead>
            <tbody>
              {payload.events.map((event) => (
                <tr key={event.eventId} className="hover:bg-primary/5">
                  <td className="border-b border-border/70 px-3 py-2"><StatusChip label={event.type} tone="neutral" /></td>
                  <td className="border-b border-border/70 px-3 py-2 font-mono text-xs text-text-muted">{event.occurredAt}</td>
                  <td className="border-b border-border/70 px-3 py-2 font-mono text-xs text-primary">{event.toolCallId ?? "none"}</td>
                  <td className="border-b border-border/70 px-3 py-2 font-mono text-xs text-primary">{event.attemptId ?? "none"}</td>
                  <td className="border-b border-border/70 px-3 py-2 font-mono text-xs text-primary">{event.policyDecisionId ?? "none"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

import type { CoreEvent } from "@toolplane/core";
import { CorrelationGrid } from "../components/CorrelationGrid.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import { correlationFromEvent, requiredCoreEventTypes, selectionMatchesValues, type ResourceStatus, type TopologySelection } from "../lib/model.js";

interface TimelineProps {
  readonly events: readonly CoreEvent[];
  readonly status: ResourceStatus;
  readonly streamState: "loading" | "connected" | "degraded" | "error";
  readonly error?: string;
  readonly topologySelection?: TopologySelection;
}

export function Timeline({ events, status, streamState, error, topologySelection }: TimelineProps) {
  const ordered = uniqueEvents(events).sort((a, b) => a.sequence - b.sequence || a.occurredAt.localeCompare(b.occurredAt));
  const observed = new Set(ordered.map((event) => event.type));

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <StatusChip
              label={
                streamState === "connected"
                  ? "SSE connected to /events"
                  : streamState === "loading"
                    ? "Opening /events stream"
                    : streamState === "degraded"
                      ? "SSE reconnecting"
                      : "SSE error"
              }
              tone={streamState === "connected" ? "healthy" : streamState === "error" ? "failed" : "degraded"}
            />
            <h2 className="mt-3 text-2xl font-semibold text-text">Live Run Timeline</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
              Append-only Core events are consumed from `GET /events` as `text/event-stream`, ordered by sequence, and
              de-duplicated by event ID during reconnects.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-panel p-4 text-sm text-text-muted">
            <span className="font-mono text-primary">{ordered.length}</span> unique events rendered
          </div>
        </div>
      </div>

      {status === "loading" ? <StatePanel status="loading" title="Loading timeline" message="Fetching latest run events while the SSE stream opens." /> : null}
      {status === "empty" ? (
        <StatePanel status="empty" title="No timeline events" message="Core is reachable, but no run events have been emitted yet." />
      ) : null}
      {streamState === "degraded" ? (
        <StatePanel status="degraded" title="Timeline stream reconnecting" message="The last known events remain visible while EventSource reconnects." />
      ) : null}
      {status === "error" || streamState === "error" ? (
        <StatePanel
          status="error"
          title="Timeline stream unavailable"
          message={error ?? "The UI could not open the Core SSE stream."}
          action="Confirm Core is serving http://127.0.0.1:3660/events."
        />
      ) : null}

      <section className="rounded-2xl border border-border bg-bg-panel/80 p-5" aria-label="Required Core event type coverage">
        <h3 className="text-lg font-semibold text-text">Required Core event rendering</h3>
        <p className="mt-1 text-sm text-text-muted">Each required event type has a distinct label and observed/missing state.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {requiredCoreEventTypes.map((type) => (
            <StatusChip key={type} label={`${type} ${observed.has(type) ? "observed" : "waiting"}`} tone={observed.has(type) ? "healthy" : "neutral"} />
          ))}
        </div>
      </section>

      <ol className="space-y-3" aria-label="Chronological Core event stream">
        {ordered.map((event) => {
          const highlighted = selectionMatchesValues(topologySelection, [event.eventId, event.traceId, event.toolCallId, event.attemptId, event.policyDecisionId, event.artifactId]);
          return (
          <li key={event.eventId} className={`rounded-2xl border p-4 transition hover:border-primary/45 ${highlighted ? "border-primary bg-primary/10" : "border-border bg-bg-panel/90"}`}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip label={event.type} tone={toneForEvent(event.type)} />
                  <span className="font-mono text-xs text-text-dim">#{event.sequence}</span>
                  <time className="text-xs text-text-dim">{event.occurredAt}</time>
                </div>
                <p className="mt-2 text-sm font-medium text-text">{event.summary}</p>
                <p className="mt-1 text-xs text-text-muted">Source layer: {sourceLayer(event)}</p>
              </div>
              <span className="break-all font-mono text-xs text-primary">{event.eventId}</span>
            </div>
            <div className="mt-4">
              <CorrelationGrid correlation={correlationFromEvent(event)} compact />
            </div>
          </li>
        );
        })}
      </ol>
    </section>
  );
}

function uniqueEvents(events: readonly CoreEvent[]): CoreEvent[] {
  const byId = new Map<string, CoreEvent>();
  for (const event of events) {
    if (!byId.has(event.eventId)) {
      byId.set(event.eventId, event);
    }
  }
  return [...byId.values()];
}

function toneForEvent(type: string): "healthy" | "degraded" | "failed" | "neutral" | "selected" {
  if (type.includes("failed") || type === "circuit.opened") return "failed";
  if (type.includes("sanitized") || type.includes("retry")) return "degraded";
  if (type.includes("completed") || type.includes("created") || type.includes("exported")) return "healthy";
  return "selected";
}

function sourceLayer(event: CoreEvent): string {
  if (event.artifactId) return "evidence";
  if (event.downstreamServerId) return "downstream";
  if (event.adapterId && event.harnessId) return "harness → adapter";
  return "core";
}

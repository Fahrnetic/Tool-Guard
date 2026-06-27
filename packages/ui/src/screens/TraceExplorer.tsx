import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import { correlationKeys, type RawArtifactView, type ResourceStatus, type TracePayload } from "../lib/model.js";

interface TraceExplorerProps {
  readonly payload?: TracePayload;
  readonly status: ResourceStatus;
  readonly error?: string;
  readonly selectedId?: string;
  readonly onSelectCorrelation?: (selection: { readonly id: string; readonly kind: string; readonly traceId?: string }) => void | Promise<void>;
}

export function TraceExplorer({ payload, status, error, selectedId, onSelectCorrelation }: TraceExplorerProps) {
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
          <div className="mt-4 grid gap-3" role="list" aria-label="Selectable correlation controls">
            {buildCorrelationControls(payload).map((control) => {
              const selected = selectedId === control.id;
              return (
                <button
                  key={`${control.kind}:${control.id}`}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => void onSelectCorrelation?.({ id: control.id, kind: control.kind, traceId: payload.traceId })}
                  className={`rounded-xl border p-3 text-left transition active:scale-[0.99] focus-visible:border-primary disabled:opacity-50 ${
                    selected ? "border-primary bg-primary/15 shadow-lg shadow-primary/10" : "border-border bg-bg/55 hover:border-primary/45 hover:bg-primary/5"
                  }`}
                >
                  <span className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-text-dim">{control.label}</span>
                  <span className="mt-1 block break-all font-mono text-xs text-primary">{control.id}</span>
                  <span className="mt-2 block text-xs text-text-muted">
                    {selected ? "Selected, trace data refetched for this context." : "Select to keep this context pinned and refetch related trace data."}
                  </span>
                </button>
              );
            })}
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

      <section className="rounded-2xl border border-border bg-bg-panel/90 p-5" aria-label="Trace raw output separation">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-text">Raw artifact inspection</h3>
            <p className="mt-1 text-sm text-text-muted">Stdout and stderr stay in separate panes with redacted content, line breaks, and truncation metadata.</p>
          </div>
          <StatusChip label={`${payload.rawArtifacts.length} artifacts`} tone={payload.rawArtifacts.length > 0 ? "selected" : "neutral"} />
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <RawArtifactPane title="Raw stdout" artifacts={payload.rawStdout} empty="No raw stdout artifact exists for this trace." />
          <RawArtifactPane title="Raw stderr" artifacts={payload.rawStderr} empty="No raw stderr artifact exists for this trace." />
        </div>
      </section>
    </section>
  );
}

function buildCorrelationControls(payload: TracePayload): readonly { readonly kind: string; readonly label: string; readonly id: string }[] {
  const controls = correlationKeys.flatMap((key) => {
    const id = payload.correlation[key];
    return id ? [{ kind: key.replace("Id", ""), label: key, id }] : [];
  });
  const nodeControls = payload.nodes.flatMap((node) => {
    if (controls.some((control) => control.id === node.id)) {
      return [];
    }
    return [{ kind: node.kind, label: `${node.kind}Id`, id: node.id }];
  });
  return [...controls, ...nodeControls];
}

function RawArtifactPane({ title, artifacts, empty }: { readonly title: string; readonly artifacts: readonly RawArtifactView[]; readonly empty: string }) {
  return (
    <section className="min-h-56 rounded-xl border border-border bg-bg p-4">
      <h4 className="text-sm font-semibold text-text">{title}</h4>
      {artifacts.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">{empty}</p>
      ) : (
        <div className="mt-3 space-y-4">
          {artifacts.map((artifact) => (
            <article key={artifact.artifactId} className="rounded-lg border border-border/80 bg-bg-panel/60 p-3">
              <div className="flex flex-wrap gap-2">
                <StatusChip label={artifact.truncated ? "truncated at output limit" : "not truncated"} tone={artifact.truncated ? "degraded" : "selected"} />
                <StatusChip label={artifact.redacted ? "redacted content" : "raw content"} tone={artifact.redacted ? "degraded" : "neutral"} />
              </div>
              <dl className="mt-3 grid gap-2 text-xs text-text-muted sm:grid-cols-2">
                <div>
                  <dt className="text-text-dim">artifactId</dt>
                  <dd className="break-all font-mono text-primary">{artifact.artifactId}</dd>
                </div>
                <div>
                  <dt className="text-text-dim">bytes</dt>
                  <dd className="font-mono">{artifact.byteLength}{artifact.outputLimitBytes ? `, limit ${artifact.outputLimitBytes}` : ""}</dd>
                </div>
              </dl>
              <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-bg/80 p-3 text-xs leading-5 text-text-muted">
                {artifact.contentUnavailable ? `Content unavailable: ${artifact.contentUnavailable}` : artifact.content}
              </pre>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

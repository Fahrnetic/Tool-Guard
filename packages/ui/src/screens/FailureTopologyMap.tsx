import { useEffect, useMemo, useState } from "react";
import type React from "react";
import type { CoreEvent, TopologyEdge, TopologyNode, TopologyNodeStatus, TopologyNodeType } from "@toolplane/core";
import { CorrelationGrid } from "../components/CorrelationGrid.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import {
  selectionIdsForNode,
  selectionMatchesValues,
  type FailureInboxPayload,
  type HealthPayload,
  type NarrativePayload,
  type ReportsPayload,
  type ResourceStatus,
  type TopologyPayload,
  type TopologySelection,
  type TracePayload
} from "../lib/model.js";

interface FailureTopologyMapProps {
  readonly topology?: TopologyPayload;
  readonly narrative?: NarrativePayload;
  readonly failures?: FailureInboxPayload;
  readonly events?: readonly CoreEvent[];
  readonly trace?: TracePayload;
  readonly health?: HealthPayload;
  readonly reports?: ReportsPayload;
  readonly status: ResourceStatus;
  readonly selectedRunId?: string;
  readonly error?: string;
  readonly onSelectRunId?: (runId: string) => void;
  readonly onSelectCorrelation?: (selection: { readonly id: string; readonly kind: string; readonly traceId?: string }) => void | Promise<void>;
  readonly onSelectNode?: (selection: TopologySelection) => void;
}

const nodeTypes: readonly TopologyNodeType[] = [
  "harness",
  "adapter",
  "downstream-server",
  "downstream-tool",
  "policy-decision",
  "attempt",
  "circuit",
  "side-effect",
  "artifact",
  "report"
];

const edgeTypes: readonly TopologyEdge["type"][] = [
  "routed-through",
  "blocked-by",
  "retried-as",
  "sanitized-to",
  "produced-artifact",
  "caused-by"
];

const nodeStates: readonly TopologyNodeStatus[] = ["healthy", "degraded", "failed", "blocked", "retry-loop", "evidence-ready"];

export function FailureTopologyMap({
  topology,
  narrative,
  failures,
  events,
  trace,
  health,
  reports,
  status,
  selectedRunId = "latest",
  error,
  onSelectRunId,
  onSelectCorrelation,
  onSelectNode
}: FailureTopologyMapProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const selectedNode = useMemo(
    () => topology?.nodes.find((node) => node.id === selectedNodeId) ?? topology?.nodes.find((node) => node.status === "failed" || node.status === "blocked" || node.type === "side-effect") ?? topology?.nodes[0],
    [selectedNodeId, topology]
  );
  const selection = selectedNode ? { node: selectedNode, selectedIds: selectionIdsForNode(selectedNode) } : undefined;

  useEffect(() => {
    if (topology && selectedNodeId && !topology.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(undefined);
    }
  }, [selectedNodeId, topology]);

  async function selectNode(node: TopologyNode) {
    setSelectedNodeId(node.id);
    onSelectNode?.({ node, selectedIds: selectionIdsForNode(node) });
    const correlationId = firstCorrelationId(node);
    if (correlationId) {
      const traceId = typeof node.correlation.traceId === "string" ? node.correlation.traceId : undefined;
      await onSelectCorrelation?.({ id: correlationId.id, kind: correlationId.kind, ...(traceId ? { traceId } : {}) });
    }
  }

  if (status === "loading") {
    return <TopologyLoadingState selectedRunId={selectedRunId} onSelectRunId={onSelectRunId} />;
  }
  if (status === "error") {
    return <StatePanel status="error" title="Failure Topology unavailable" message={error ?? "Core did not return topology or narrative data."} action="Confirm Core is serving `/api/topology/latest` and `/api/narrative/latest`." />;
  }
  if (!topology || topology.nodes.length === 0) {
    return <TopologyEmptyState selectedRunId={selectedRunId} onSelectRunId={onSelectRunId} />;
  }

  const missingTypes = nodeTypes.filter((type) => !topology.nodes.some((node) => node.type === type));
  const missingEdges = edgeTypes.filter((type) => !topology.edges.some((edge) => edge.type === type));
  const noFailures = topology.summary.failures === 0 && topology.summary.blocked === 0 && !topology.nodes.some((node) => node.status === "failed" || node.status === "blocked" || node.status === "retry-loop");

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="flex flex-wrap gap-2">
              <StatusChip label="Failure Topology Map" tone="selected" />
              <StatusChip label={`${topology.nodes.length} nodes`} tone="neutral" />
              <StatusChip label={`${topology.edges.length} edges`} tone="neutral" />
              <StatusChip label={`${topology.generatedFrom.ledgerCount} ledger rows`} tone={topology.generatedFrom.ledgerCount > 0 ? "selected" : "neutral"} />
            </div>
            <h2 className="mt-3 text-2xl font-semibold text-text">Screenshot-ready run topology and linked evidence</h2>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-text-muted">
              Core topology nodes are derived from events and the side-effect ledger. Select any node to highlight matching
              Failure Cards, trace events, policy decisions, ledger references, health rows, and evidence artifacts below.
            </p>
          </div>
          <TopologyFixtureChooser selectedRunId={selectedRunId} onSelectRunId={onSelectRunId} />
          <div className="grid gap-2 rounded-2xl border border-border bg-bg-panel p-4 text-xs text-text-muted sm:grid-cols-2">
            <Metric label="runId" value={topology.runId} mono />
            <Metric label="source events" value={String(topology.generatedFrom.eventCount)} />
            <Metric label="side effects" value={String(topology.summary.sideEffects)} />
            <Metric label="artifacts" value={String(topology.summary.artifacts)} />
          </div>
        </div>
      </div>

      {status === "degraded" ? (
        <StatePanel status="degraded" title="Topology partially degraded" message={error ?? "One linked Core endpoint failed, but topology data remains inspectable."} />
      ) : null}
      {noFailures ? <NoFailureState runId={topology.runId} /> : null}
      {missingTypes.length > 0 || missingEdges.length > 0 ? (
        <StatePanel
          status="degraded"
          title="Topology coverage is partial for this run"
          message={`Missing node types: ${missingTypes.join(", ") || "none"}. Missing edge types: ${missingEdges.join(", ") || "none"}. The map still renders available Core data.`}
        />
      ) : null}

      <section className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-3xl border border-border bg-bg-panel/90 p-5 shadow-2xl shadow-black/20">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-text">Topology map</h3>
              <p className="mt-1 text-sm text-text-muted">Node labels include type, state, and visible correlation IDs.</p>
            </div>
            <Legend />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3" aria-label="Failure topology nodes">
            {nodeTypes.map((type) => {
              const nodes = topology.nodes.filter((node) => node.type === type);
              return (
                <section key={type} className="rounded-2xl border border-border bg-bg/45 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-text">{typeLabel(type)}</h4>
                    <span className="font-mono text-xs text-text-dim">{nodes.length}</span>
                  </div>
                  <div className="mt-3 space-y-3">
                    {nodes.length === 0 ? <p className="rounded-xl border border-dashed border-border p-3 text-xs text-text-dim">No {typeLabel(type)} node in this run.</p> : null}
                    {nodes.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        aria-pressed={selectedNode?.id === node.id}
                        aria-label={topologyNodeAccessibleLabel(node)}
                        onClick={() => void selectNode(node)}
                        className={`w-full rounded-xl border p-3 text-left transition active:scale-[0.99] focus-visible:border-primary ${nodeStateClasses(node.status)} ${
                          selectedNode?.id === node.id ? "ring-2 ring-primary ring-offset-2 ring-offset-bg" : "hover:border-primary/45"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-current/30 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.16em]">{node.status}</span>
                          <span className="rounded-full border border-current/20 px-2 py-0.5 text-[0.65rem] uppercase tracking-[0.14em]">{typeLabel(node.type)}</span>
                        </div>
                        <p className="mt-2 break-words text-sm font-semibold text-text">{node.label}</p>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-muted">{node.summary}</p>
                        <p className="mt-2 break-all font-mono text-[0.7rem] text-primary">{shortCorrelationLine(node)}</p>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          <section className="mt-5 rounded-2xl border border-border bg-bg/55 p-4">
            <h4 className="text-sm font-semibold text-text">Relationship labels</h4>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {topology.edges.map((edge) => (
                <EdgeRow key={edge.id} edge={edge} {...(selection ? { selection } : {})} />
              ))}
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <NarrativePanel {...(narrative ? { narrative } : {})} />
          {selectedNode ? <SelectedNodePanel node={selectedNode} /> : null}
        </aside>
      </section>

      <LinkedViews
        {...(selection ? { selection } : {})}
        events={events && events.length > 0 ? events : trace?.events ?? []}
        {...(failures ? { failures } : {})}
        {...(health ? { health } : {})}
        {...(reports ? { reports } : {})}
      />
    </section>
  );
}

function TopologyLoadingState({ selectedRunId, onSelectRunId }: { readonly selectedRunId: string; readonly onSelectRunId: ((runId: string) => void) | undefined }) {
  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <StatePanel status="loading" title="Loading Failure Topology" message={`Fetching \`/api/topology/${selectedRunId}\` and \`/api/narrative/${selectedRunId}\` from Core.`} />
          <TopologyFixtureChooser selectedRunId={selectedRunId} onSelectRunId={onSelectRunId} />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <div key={item} className="h-32 animate-pulse rounded-2xl border border-border bg-bg-panel/70" />
        ))}
      </div>
    </section>
  );
}

function TopologyEmptyState({ selectedRunId, onSelectRunId }: { readonly selectedRunId: string; readonly onSelectRunId: ((runId: string) => void) | undefined }) {
  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <StatePanel
            status="empty"
            title="No topology data in selected fixture run"
            message="The deterministic empty topology fixture is loaded. Core is reachable, but this run intentionally has no nodes, edges, side effects, policy decisions, or artifacts."
            action="Switch back to the live run for populated Core topology data, or use this fixture to validate the designed empty state."
          />
          <TopologyFixtureChooser selectedRunId={selectedRunId} onSelectRunId={onSelectRunId} />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <EmptyTopologyHint title="What would appear here" body="Harness, adapter, downstream tool, policy, attempt, side-effect, artifact, and report nodes render after Core records a run." />
        <EmptyTopologyHint title="Why this state exists" body="Validation can select a real UI fixture instead of replacing Core responses with route mocks." />
        <EmptyTopologyHint title="Next safe action" body="Run a ToolGuard demo fixture or return to Live Core topology when you want populated evidence." />
      </div>
    </section>
  );
}

function TopologyFixtureChooser({ selectedRunId, onSelectRunId }: { readonly selectedRunId: string; readonly onSelectRunId: ((runId: string) => void) | undefined }) {
  const options = [
    {
      id: "latest",
      label: "Live Core topology",
      description: "Uses current Core-backed run data."
    },
    {
      id: "demo-empty",
      label: "Empty fixture run",
      description: "No topology nodes, with meaningful empty-state copy."
    },
    {
      id: "demo-loading",
      label: "Loading skeleton demo",
      description: "Delays Core topology long enough for validation capture."
    }
  ] as const;

  return (
    <section className="min-w-72 rounded-2xl border border-border bg-bg-panel p-4" aria-label="Topology fixture selector">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-text-dim">Topology demo states</p>
      <div className="mt-3 grid gap-2" role="radiogroup" aria-label="Select topology run state">
        {options.map((option) => {
          const selected = selectedRunId === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelectRunId?.(option.id)}
              className={`rounded-xl border p-3 text-left transition active:scale-[0.99] focus-visible:border-primary ${
                selected ? "border-primary bg-primary/10 shadow-lg shadow-primary/10" : "border-border bg-bg/55 hover:border-primary/45"
              }`}
            >
              <span className="text-sm font-semibold text-text">{option.label}</span>
              <span className="mt-1 block text-xs leading-5 text-text-muted">{option.description}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function EmptyTopologyHint({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <article className="rounded-2xl border border-border bg-bg-panel/90 p-5">
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-text-muted">{body}</p>
    </article>
  );
}

function NoFailureState({ runId }: { readonly runId: string }) {
  return (
    <StatePanel
      status="ready"
      title="No failure topology detected"
      message={`Run ${runId} has no failed, blocked, or retry-loop nodes. Healthy routing and evidence nodes remain visible for auditability.`}
      action="Select healthy nodes to inspect correlation IDs and linked artifacts."
    />
  );
}

function Legend() {
  return (
    <div className="flex max-w-3xl flex-wrap gap-2" aria-label="Topology status legend">
      {nodeStates.map((state) => (
        <span key={state} className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${nodeStateClasses(state)}`}>
          {state}
        </span>
      ))}
    </div>
  );
}

function NarrativePanel({ narrative }: { readonly narrative?: NarrativePayload }) {
  if (!narrative) {
    return <StatePanel status="degraded" title="Narrative unavailable" message="Topology can be inspected while `/api/narrative/latest` recovers." />;
  }
  return (
    <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
      <StatusChip label="Run health narrative" tone="selected" />
      <h3 className="mt-3 text-lg font-semibold text-text">Generated story</h3>
      <pre className="mt-3 whitespace-pre-wrap rounded-xl border border-border bg-bg/70 p-4 text-sm leading-6 text-text-muted">{narrative.text}</pre>
      <div className="mt-4 grid gap-3">
        {Object.entries(narrative.sections).map(([key, value]) => (
          <Metric key={key} label={sectionLabel(key)} value={value} />
        ))}
      </div>
    </section>
  );
}

function SelectedNodePanel({ node }: { readonly node: TopologyNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
      <StatusChip label="Selected node" tone="selected" />
      <h3 className="mt-3 break-words text-lg font-semibold text-text">{node.label}</h3>
      <p className="mt-2 text-sm leading-6 text-text-muted">{node.summary}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <StatusChip label={typeLabel(node.type)} tone="neutral" />
        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${nodeStateClasses(node.status)}`}>{node.status}</span>
        <StatusChip label={`${node.eventIds.length} events`} tone="neutral" />
        <StatusChip label={`${node.ledgerIds.length} ledger rows`} tone={node.ledgerIds.length > 0 ? "selected" : "neutral"} />
        <StatusChip label={`${node.artifactIds.length} artifacts`} tone={node.artifactIds.length > 0 ? "healthy" : "neutral"} />
      </div>
      <div className="mt-4">
        <CorrelationGrid correlation={node.correlation} compact />
      </div>
    </section>
  );
}

function LinkedViews({
  selection,
  events,
  failures,
  health,
  reports
}: {
  readonly selection?: TopologySelection;
  readonly events: readonly CoreEvent[];
  readonly failures?: FailureInboxPayload;
  readonly health?: HealthPayload;
  readonly reports?: ReportsPayload;
}) {
  const selectedEventIds = new Set(selection?.node.eventIds ?? []);
  const selectedLedgerIds = selection?.node.ledgerIds ?? [];
  const selectedArtifactIds = selection?.node.artifactIds ?? [];
  const relatedFailures = (failures?.failures ?? []).filter((failure) =>
    selectionMatchesValues(selection, [
      failure.eventId,
      failure.correlation.traceId,
      failure.correlation.toolCallId,
      failure.correlation.attemptId,
      failure.correlation.policyDecisionId,
      ...failure.evidenceLinks.map((link) => link.artifactId)
    ])
  );
  const relatedEvents = events.filter((event) =>
    selectedEventIds.has(event.eventId) || selectionMatchesValues(selection, [
      event.traceId,
      event.toolCallId,
      event.attemptId,
      event.policyDecisionId,
      event.artifactId
    ])
  );
  const relatedPolicyEvents = relatedEvents.filter((event) => event.type === "policy.decision" || event.policyDecisionId);
  const relatedHealthRows = (health?.rows ?? []).filter((row) =>
    selectionMatchesValues(selection, [row.id, row.name, row.downstreamServerId, row.runId])
  );
  const relatedArtifacts = (reports?.reports ?? []).flatMap((report) =>
    report.artifacts.filter((artifact) => selectedArtifactIds.includes(artifact.artifactId))
  );

  return (
    <section className="grid gap-5 xl:grid-cols-2" aria-label="Topology linked views">
      <LinkedPanel title="Failure Card highlights" count={relatedFailures.length} empty="No Failure Card maps to the selected node.">
        {relatedFailures.map((failure) => (
          <article key={failure.eventId} className="rounded-xl border border-primary/50 bg-primary/10 p-3">
            <div className="flex flex-wrap gap-2">
              <StatusChip label={failure.failureType} tone={failure.retryable ? "degraded" : "failed"} />
              {failure.sideEffectSummary ? <StatusChip label="side-effect summary" tone="selected" /> : null}
            </div>
            <h4 className="mt-2 text-sm font-semibold text-text">{failure.toolName}</h4>
            <p className="mt-1 text-sm text-text-muted">{failure.sideEffectSummary ?? failure.safeSummary}</p>
            <p className="mt-2 break-all font-mono text-xs text-primary">{failure.correlation.toolCallId ?? failure.eventId}</p>
          </article>
        ))}
      </LinkedPanel>

      <LinkedPanel title="Trace events and policy decisions" count={relatedEvents.length} empty="No trace event maps to the selected node.">
        <div className="space-y-2">
          {relatedEvents.slice(0, 8).map((event) => (
            <article key={event.eventId} className="rounded-xl border border-border bg-bg/60 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip label={event.type} tone={event.type === "tool.call.failed" ? "failed" : event.type.includes("policy") ? "degraded" : "neutral"} />
                <span className="font-mono text-xs text-text-dim">#{event.sequence}</span>
              </div>
              <p className="mt-1 text-sm text-text-muted">{event.summary}</p>
              <p className="mt-1 break-all font-mono text-xs text-primary">{event.policyDecisionId ?? event.eventId}</p>
            </article>
          ))}
        </div>
        {relatedPolicyEvents.length > 0 ? <p className="mt-3 text-xs text-text-muted">{relatedPolicyEvents.length} policy decision references highlighted.</p> : null}
      </LinkedPanel>

      <LinkedPanel title="Ledger rows and Health Matrix" count={selectedLedgerIds.length + relatedHealthRows.length} empty="No ledger or health row maps to the selected node.">
        {selectedLedgerIds.map((ledgerId) => (
          <div key={ledgerId} className="rounded-xl border border-primary/50 bg-primary/10 p-3">
            <p className="text-xs uppercase tracking-[0.18em] text-text-dim">side-effect ledger row</p>
            <p className="mt-1 break-all font-mono text-xs text-primary">{ledgerId}</p>
            <p className="mt-2 text-sm text-text-muted">Ledger ID comes from Core topology data and is matched to side-effect nodes, edges, and Failure Card summaries.</p>
          </div>
        ))}
        {relatedHealthRows.map((row) => (
          <div key={row.id} className="rounded-xl border border-border bg-bg/60 p-3">
            <StatusChip label={row.status} tone={row.status === "healthy" ? "healthy" : row.status === "failed" ? "failed" : "degraded"} />
            <p className="mt-2 text-sm font-semibold text-text">{row.layer}: {row.name}</p>
            <p className="mt-1 text-sm text-text-muted">{row.remediation}</p>
          </div>
        ))}
      </LinkedPanel>

      <LinkedPanel title="Artifacts and Evidence Report Viewer" count={relatedArtifacts.length + selectedArtifactIds.length} empty="No artifact maps to the selected node.">
        {selectedArtifactIds.map((artifactId) => {
          const artifact = relatedArtifacts.find((item) => item.artifactId === artifactId);
          return (
            <a key={artifactId} href={artifact?.artifactUrl ?? "#"} className="block rounded-xl border border-primary/50 bg-primary/10 p-3 transition hover:border-primary focus-visible:border-primary">
              <p className="text-xs uppercase tracking-[0.18em] text-text-dim">artifactId</p>
              <p className="mt-1 break-all font-mono text-xs text-primary">{artifactId}</p>
              <p className="mt-2 text-sm text-text-muted">{artifact ? `${artifact.kind}, ${artifact.relativePath}` : "Artifact is referenced by topology but no exported report is loaded yet."}</p>
            </a>
          );
        })}
      </LinkedPanel>
    </section>
  );
}

function LinkedPanel({ title, count, empty, children }: { readonly title: string; readonly count: number; readonly empty: string; readonly children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-text">{title}</h3>
        <StatusChip label={`${count} highlighted`} tone={count > 0 ? "selected" : "neutral"} />
      </div>
      <div className="mt-4 space-y-3">{count > 0 ? children : <p className="text-sm text-text-muted">{empty}</p>}</div>
    </section>
  );
}

function EdgeRow({ edge, selection }: { readonly edge: TopologyEdge; readonly selection?: TopologySelection }) {
  const selected = selectionMatchesValues(selection, [edge.source, edge.target, ...edge.eventIds, ...edge.ledgerIds, ...edge.artifactIds]);
  return (
    <div className={`rounded-xl border p-3 ${selected ? "border-primary bg-primary/10" : "border-border bg-bg/55"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip label={edge.type} tone={selected ? "selected" : "neutral"} />
        {edge.ledgerIds.length > 0 ? <StatusChip label={`${edge.ledgerIds.length} ledger`} tone="selected" /> : null}
        {edge.artifactIds.length > 0 ? <StatusChip label={`${edge.artifactIds.length} artifacts`} tone="healthy" /> : null}
      </div>
      <p className="mt-2 text-sm font-medium text-text">{edge.label}</p>
      <p className="mt-1 break-all font-mono text-[0.7rem] text-text-muted">{edge.source} → {edge.target}</p>
    </div>
  );
}

function Metric({ label, value, mono = false }: { readonly label: string; readonly value: string; readonly mono?: boolean }) {
  return (
    <div>
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-text-dim">{label}</p>
      <p className={`mt-1 break-words text-sm text-text ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

export function topologyNodeAccessibleLabel(node: TopologyNode): string {
  return `${typeLabel(node.type)} ${node.label}, status ${node.status}, ${node.summary}, correlation ${shortCorrelationLine(node)}`;
}

function typeLabel(type: TopologyNodeType): string {
  return type.replaceAll("-", " ");
}

function sectionLabel(key: string): string {
  return key.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`);
}

function firstCorrelationId(node: TopologyNode): { readonly kind: string; readonly id: string } | undefined {
  for (const kind of ["policyDecisionId", "artifactId", "attemptId", "toolCallId", "downstreamServerId", "traceId", "adapterId", "harnessId", "runId"]) {
    const value = node.correlation[kind];
    if (typeof value === "string" && value.length > 0) {
      return { kind: kind.replace("Id", ""), id: value };
    }
  }
  return undefined;
}

function shortCorrelationLine(node: TopologyNode): string {
  const parts = Object.entries(node.correlation)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length > 0 ? parts.join("  ") : `nodeId=${node.id}`;
}

function nodeStateClasses(status: TopologyNodeStatus): string {
  switch (status) {
    case "healthy":
      return "border-success/50 bg-success/10 text-success";
    case "degraded":
      return "border-warning/50 bg-warning/10 text-warning";
    case "failed":
      return "border-danger/60 bg-danger/10 text-danger";
    case "blocked":
      return "border-danger/70 bg-danger/20 text-danger";
    case "retry-loop":
      return "border-warning/70 bg-warning/15 text-warning";
    case "evidence-ready":
      return "border-primary/60 bg-primary/15 text-primary";
  }
}


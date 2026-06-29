import { writeFile } from "node:fs/promises";
import path from "node:path";
import { redactStringWithSummary } from "./redaction.js";
import type { CoreEvent } from "./events.js";
import type {
  EvidenceArtifact,
  FailureCard,
  JsonObject,
  JsonValue,
  PolicyDecision,
  SideEffectLedgerEntry
} from "./types.js";

export type TopologyNodeType =
  | "harness"
  | "adapter"
  | "downstream-server"
  | "downstream-tool"
  | "policy-decision"
  | "attempt"
  | "circuit"
  | "side-effect"
  | "artifact"
  | "report";

export type TopologyEdgeType =
  | "routed-through"
  | "blocked-by"
  | "retried-as"
  | "sanitized-to"
  | "produced-artifact"
  | "caused-by";

export type TopologyNodeStatus = "healthy" | "degraded" | "failed" | "blocked" | "retry-loop" | "evidence-ready";

export interface TopologyNode {
  readonly id: string;
  readonly type: TopologyNodeType;
  readonly label: string;
  readonly status: TopologyNodeStatus;
  readonly summary: string;
  readonly correlation: JsonObject;
  readonly eventIds: readonly string[];
  readonly ledgerIds: readonly string[];
  readonly artifactIds: readonly string[];
}

export interface TopologyEdge {
  readonly id: string;
  readonly type: TopologyEdgeType;
  readonly source: string;
  readonly target: string;
  readonly label: string;
  readonly eventIds: readonly string[];
  readonly ledgerIds: readonly string[];
  readonly artifactIds: readonly string[];
}

export interface RunTopology {
  readonly runId: string;
  readonly generatedFrom: {
    readonly eventCount: number;
    readonly ledgerCount: number;
    readonly lastEventSequence: number;
    readonly lastEventOccurredAt?: string;
  };
  readonly summary: {
    readonly nodes: number;
    readonly edges: number;
    readonly failures: number;
    readonly blocked: number;
    readonly sideEffects: number;
    readonly artifacts: number;
    readonly reports: number;
  };
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
}

export interface RunNarrative {
  readonly runId: string;
  readonly generatedFrom: RunTopology["generatedFrom"];
  readonly text: string;
  readonly sections: {
    readonly rootCause: string;
    readonly blastRadius: string;
    readonly sideEffects: string;
    readonly recoveryStatus: string;
    readonly nextSafeAction: string;
  };
}

interface MutableNode {
  id: string;
  type: TopologyNodeType;
  label: string;
  status: TopologyNodeStatus;
  summary: string;
  correlation: Record<string, JsonValue>;
  eventIds: Set<string>;
  ledgerIds: Set<string>;
  artifactIds: Set<string>;
}

interface MutableEdge {
  id: string;
  type: TopologyEdgeType;
  source: string;
  target: string;
  label: string;
  eventIds: Set<string>;
  ledgerIds: Set<string>;
  artifactIds: Set<string>;
}

const generatedEventTypes = new Set(["topology.generated", "narrative.generated"]);

export async function generateAndPersistTopology(input: {
  readonly runId: string;
  readonly runDir: string;
  readonly events: readonly CoreEvent[];
  readonly ledger: readonly SideEffectLedgerEntry[];
}): Promise<RunTopology> {
  const topology = buildRunTopology(input);
  await writeFile(path.join(input.runDir, "topology.json"), `${stableStringify(topology)}\n`, "utf8");
  return topology;
}

export async function generateAndPersistNarrative(input: {
  readonly runId: string;
  readonly runDir: string;
  readonly events: readonly CoreEvent[];
  readonly ledger: readonly SideEffectLedgerEntry[];
  readonly topology?: RunTopology;
}): Promise<RunNarrative> {
  const narrative = buildRunNarrative({ ...input, topology: input.topology ?? buildRunTopology(input) });
  await writeFile(path.join(input.runDir, "narrative.json"), `${stableStringify(narrative)}\n`, "utf8");
  return narrative;
}

export function buildRunTopology(input: {
  readonly runId: string;
  readonly events: readonly CoreEvent[];
  readonly ledger: readonly SideEffectLedgerEntry[];
}): RunTopology {
  const sourceEvents = sourceEventsFor(input.events, input.runId);
  const sourceLedger = sourceLedgerFor(input.ledger, sourceEvents, input.runId);
  const nodes = new Map<string, MutableNode>();
  const edges = new Map<string, MutableEdge>();
  const toolNamesByCall = toolNamesByToolCall(sourceEvents, sourceLedger);

  for (const event of sourceEvents) {
    addCorrelationPath(nodes, edges, event, toolNamesByCall);
    if (isPolicyDecision(event.data)) {
      addNode(nodes, {
        id: policyNodeId(event.data.policyDecisionId),
        type: "policy-decision",
        label: `Policy ${event.data.decision}`,
        status: event.data.decision === "block" || event.data.decision === "fail-fast" ? "blocked" : "healthy",
        summary: event.data.reason,
        event,
        correlation: correlationFromEvent(event)
      });
      if (event.attemptId) {
        addEdge(edges, "caused-by", attemptNodeId(event.attemptId), policyNodeId(event.data.policyDecisionId), "evaluated by policy", event);
      }
      if ((event.data.decision === "block" || event.data.decision === "fail-fast") && event.attemptId) {
        addEdge(edges, "blocked-by", attemptNodeId(event.attemptId), policyNodeId(event.data.policyDecisionId), "blocked by policy", event);
      }
    }
    if (isEvidenceArtifact(event.data)) {
      addNode(nodes, {
        id: artifactNodeId(event.data.artifactId),
        type: event.data.kind === "report" ? "report" : "artifact",
        label: event.data.kind === "report" ? "Report artifact" : event.data.kind,
        status: "evidence-ready",
        summary: `${event.data.kind} evidence at ${event.data.relativePath}`,
        event,
        artifactIds: [event.data.artifactId],
        correlation: correlationFromEvent(event)
      });
      const source = event.attemptId ? attemptNodeId(event.attemptId) : event.toolCallId ? toolNodeId(event.downstreamServerId, event.toolCallId) : undefined;
      if (source) {
        addEdge(edges, "produced-artifact", source, artifactNodeId(event.data.artifactId), "produced artifact", event, {
          artifactIds: [event.data.artifactId]
        });
      }
    }
    if (event.type === "output.sanitized" && event.attemptId) {
      const artifactId = artifactIdFromSanitizedEvent(event);
      if (artifactId) {
        addEdge(edges, "sanitized-to", attemptNodeId(event.attemptId), artifactNodeId(artifactId), "sanitized to safe evidence", event, {
          artifactIds: [artifactId]
        });
      }
    }
    if (event.type === "tool.retry.scheduled" && event.toolCallId && event.attemptId) {
      const previousAttempt = [...sourceEvents]
        .filter((candidate) => candidate.toolCallId === event.toolCallId && candidate.attemptId && candidate.sequence < event.sequence)
        .at(-1)?.attemptId;
      if (previousAttempt) {
        addEdge(edges, "retried-as", attemptNodeId(previousAttempt), attemptNodeId(event.attemptId), "retried as bounded attempt", event);
      }
    }
    if ((event.type === "circuit.opened" || event.type === "circuit.closed") && event.downstreamServerId) {
      const circuitId = circuitNodeId(event.downstreamServerId, event.toolCallId);
      addNode(nodes, {
        id: circuitId,
        type: "circuit",
        label: event.type === "circuit.opened" ? "Circuit open" : "Circuit closed",
        status: event.type === "circuit.opened" ? "blocked" : "healthy",
        summary: event.summary,
        event,
        correlation: correlationFromEvent(event)
      });
      if (event.attemptId) {
        addEdge(edges, "caused-by", circuitId, attemptNodeId(event.attemptId), "caused by attempt outcome", event);
      }
    }
    if (event.type === "report.exported") {
      const reportId = reportIdFromEvent(event);
      addNode(nodes, {
        id: reportNodeId(reportId),
        type: "report",
        label: "Static report",
        status: "evidence-ready",
        summary: event.summary,
        event,
        correlation: correlationFromEvent(event)
      });
      if (event.artifactId) {
        addEdge(edges, "produced-artifact", reportNodeId(reportId), artifactNodeId(event.artifactId), "report includes artifact", event);
      }
    }
  }

  for (const entry of sourceLedger) {
    const status = statusFromLedger(entry);
    addNode(nodes, {
      id: sideEffectNodeId(entry.ledgerId),
      type: "side-effect",
      label: `${entry.effectState} ${entry.targetType}`,
      status,
      summary: `${entry.summary} Blast radius ${entry.blastRadius.score} (${entry.blastRadius.label}).`,
      ledger: entry,
      ledgerIds: [entry.ledgerId],
      artifactIds: entry.artifactIds,
      correlation: correlationFromLedger(entry)
    });
    addEdge(edges, "caused-by", sideEffectNodeId(entry.ledgerId), attemptNodeId(entry.attemptId), "side effect caused by attempt", undefined, {
      ledgerIds: [entry.ledgerId],
      artifactIds: entry.artifactIds
    });
    for (const artifactId of entry.artifactIds) {
      addEdge(edges, "produced-artifact", sideEffectNodeId(entry.ledgerId), artifactNodeId(artifactId), "side effect evidenced by artifact", undefined, {
        ledgerIds: [entry.ledgerId],
        artifactIds: [artifactId]
      });
    }
  }

  const finalNodes = [...nodes.values()].map(freezeNode).sort(compareById);
  const finalEdges = [...edges.values()].map(freezeEdge).sort(compareById);
  return {
    runId: input.runId,
    generatedFrom: generatedFrom(sourceEvents, sourceLedger),
    summary: {
      nodes: finalNodes.length,
      edges: finalEdges.length,
      failures: sourceEvents.filter((event) => event.type === "tool.call.failed").length,
      blocked: finalNodes.filter((node) => node.status === "blocked").length,
      sideEffects: sourceLedger.length,
      artifacts: finalNodes.filter((node) => node.type === "artifact").length,
      reports: finalNodes.filter((node) => node.type === "report").length
    },
    nodes: finalNodes,
    edges: finalEdges
  };
}

export function buildRunNarrative(input: {
  readonly runId: string;
  readonly events: readonly CoreEvent[];
  readonly ledger: readonly SideEffectLedgerEntry[];
  readonly topology: RunTopology;
}): RunNarrative {
  const sourceEvents = sourceEventsFor(input.events, input.runId);
  const sourceLedger = sourceLedgerFor(input.ledger, sourceEvents, input.runId);
  const failures = sourceEvents.filter((event) => event.type === "tool.call.failed" && isFailureCard(event.data));
  const latestFailure = failures.at(-1);
  const latestCard = isFailureCard(latestFailure?.data) ? latestFailure.data : undefined;
  const worstBlast = [...sourceLedger].sort((a, b) => b.blastRadius.score - a.blastRadius.score || a.ledgerId.localeCompare(b.ledgerId))[0];
  const rootCause = latestCard
    ? `${latestCard.failureType}: ${latestCard.likelyRootCause}`
    : sourceEvents.some((event) => event.type === "tool.call.completed")
      ? "No failure detected in the recorded ToolGuard event stream."
      : "No completed or failed tool call has been recorded yet.";
  const blastRadius = worstBlast
    ? `${worstBlast.blastRadius.score} (${worstBlast.blastRadius.label}) from ${worstBlast.targetType}; ${factorSummary(worstBlast.blastRadius.factors)}`
    : "No side-effect blast radius has been recorded.";
  const sideEffects =
    sourceLedger.length > 0
      ? sourceLedger
          .map((entry) => `${entry.effectState} ${entry.targetType} for ${entry.toolName} (${entry.reversibility})`)
          .sort()
          .join("; ")
      : "No side effects have been recorded.";
  const recoveryStatus = recoveryStatusFrom(sourceEvents, sourceLedger);
  const nextSafeAction =
    latestCard?.safeRecoveryOptions[0] ??
    (failures.length > 0
      ? "Inspect the Failure Card and separated evidence artifacts before retrying with changed inputs."
      : "Continue with the next planned tool call; no unsafe recovery action is required.");
  const sections = {
    rootCause: sanitizeSentence(rootCause),
    blastRadius: sanitizeSentence(blastRadius),
    sideEffects: sanitizeSentence(sideEffects),
    recoveryStatus: sanitizeSentence(recoveryStatus),
    nextSafeAction: sanitizeSentence(nextSafeAction)
  };
  return {
    runId: input.runId,
    generatedFrom: input.topology.generatedFrom,
    text: [
      `Root cause: ${sections.rootCause}`,
      `Blast radius: ${sections.blastRadius}`,
      `Side effects: ${sections.sideEffects}`,
      `Recovery status: ${sections.recoveryStatus}`,
      `Next safe action: ${sections.nextSafeAction}`
    ].join("\n"),
    sections
  };
}

function addCorrelationPath(
  nodes: Map<string, MutableNode>,
  edges: Map<string, MutableEdge>,
  event: CoreEvent,
  toolNamesByCall: ReadonlyMap<string, string>
): void {
  if (event.harnessId) {
    addNode(nodes, {
      id: harnessNodeId(event.harnessId),
      type: "harness",
      label: "Harness",
      status: statusFromEvent(event),
      summary: `Harness observed ${event.type}`,
      event,
      correlation: correlationFromEvent(event)
    });
  }
  if (event.adapterId) {
    addNode(nodes, {
      id: adapterNodeId(event.adapterId),
      type: "adapter",
      label: "Adapter",
      status: statusFromEvent(event),
      summary: `Adapter observed ${event.type}`,
      event,
      correlation: correlationFromEvent(event)
    });
  }
  if (event.downstreamServerId) {
    addNode(nodes, {
      id: serverNodeId(event.downstreamServerId),
      type: "downstream-server",
      label: event.downstreamServerId,
      status: event.type === "circuit.opened" ? "blocked" : statusFromEvent(event),
      summary: `Downstream server observed ${event.type}`,
      event,
      correlation: correlationFromEvent(event)
    });
  }
  if (event.toolCallId || event.data && isToolResultLike(event.data)) {
    const toolName = toolNameFromEvent(event, toolNamesByCall);
    const id = toolNodeId(event.downstreamServerId, toolName);
    addNode(nodes, {
      id,
      type: "downstream-tool",
      label: toolName,
      status: statusFromEvent(event),
      summary: `Downstream tool observed ${event.type}`,
      event,
      correlation: correlationFromEvent(event)
    });
  }
  if (event.attemptId) {
    addNode(nodes, {
      id: attemptNodeId(event.attemptId),
      type: "attempt",
      label: `Attempt ${event.attemptId}`,
      status: statusFromEvent(event),
      summary: event.summary,
      event,
      correlation: correlationFromEvent(event)
    });
  }
  if (event.harnessId && event.adapterId) {
    addEdge(edges, "routed-through", harnessNodeId(event.harnessId), adapterNodeId(event.adapterId), "routed through adapter", event);
  }
  if (event.adapterId && event.downstreamServerId) {
    addEdge(edges, "routed-through", adapterNodeId(event.adapterId), serverNodeId(event.downstreamServerId), "routed to downstream server", event);
  }
  if (event.downstreamServerId && event.toolCallId) {
    addEdge(edges, "routed-through", serverNodeId(event.downstreamServerId), toolNodeId(event.downstreamServerId, toolNameFromEvent(event, toolNamesByCall)), "routed to downstream tool", event);
  }
  if (event.toolCallId && event.attemptId) {
    addEdge(edges, "routed-through", toolNodeId(event.downstreamServerId, toolNameFromEvent(event, toolNamesByCall)), attemptNodeId(event.attemptId), "executed as attempt", event);
  }
}

function addNode(
  nodes: Map<string, MutableNode>,
  input: {
    readonly id: string;
    readonly type: TopologyNodeType;
    readonly label: string;
    readonly status: TopologyNodeStatus;
    readonly summary: string;
    readonly event?: CoreEvent;
    readonly ledger?: SideEffectLedgerEntry;
    readonly correlation?: JsonObject;
    readonly ledgerIds?: readonly string[];
    readonly artifactIds?: readonly string[];
  }
): void {
  const current = nodes.get(input.id);
  const node =
    current ??
    {
      id: input.id,
      type: input.type,
      label: input.label,
      status: input.status,
      summary: input.summary,
      correlation: {},
      eventIds: new Set<string>(),
      ledgerIds: new Set<string>(),
      artifactIds: new Set<string>()
    };
  node.status = strongerStatus(node.status, input.status);
  node.summary = strongerStatus(node.status, input.status) === input.status ? input.summary : node.summary;
  Object.assign(node.correlation, input.correlation ?? {});
  if (input.event) node.eventIds.add(input.event.eventId);
  if (input.ledger) node.ledgerIds.add(input.ledger.ledgerId);
  for (const ledgerId of input.ledgerIds ?? []) node.ledgerIds.add(ledgerId);
  for (const artifactId of input.artifactIds ?? []) node.artifactIds.add(artifactId);
  nodes.set(input.id, node);
}

function addEdge(
  edges: Map<string, MutableEdge>,
  type: TopologyEdgeType,
  source: string,
  target: string,
  label: string,
  event?: CoreEvent,
  input: { readonly ledgerIds?: readonly string[]; readonly artifactIds?: readonly string[] } = {}
): void {
  if (source === target) return;
  const id = `${type}:${source}->${target}`;
  const edge =
    edges.get(id) ??
    {
      id,
      type,
      source,
      target,
      label,
      eventIds: new Set<string>(),
      ledgerIds: new Set<string>(),
      artifactIds: new Set<string>()
    };
  if (event) edge.eventIds.add(event.eventId);
  for (const ledgerId of input.ledgerIds ?? []) edge.ledgerIds.add(ledgerId);
  for (const artifactId of input.artifactIds ?? []) edge.artifactIds.add(artifactId);
  edges.set(id, edge);
}

function freezeNode(node: MutableNode): TopologyNode {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    status: node.status,
    summary: sanitizeSentence(node.summary),
    correlation: sortJson(node.correlation) as JsonObject,
    eventIds: [...node.eventIds].sort(),
    ledgerIds: [...node.ledgerIds].sort(),
    artifactIds: [...node.artifactIds].sort()
  };
}

function freezeEdge(edge: MutableEdge): TopologyEdge {
  return {
    id: edge.id,
    type: edge.type,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    eventIds: [...edge.eventIds].sort(),
    ledgerIds: [...edge.ledgerIds].sort(),
    artifactIds: [...edge.artifactIds].sort()
  };
}

function sourceEventsFor(events: readonly CoreEvent[], runId: string): CoreEvent[] {
  return events
    .filter((event) => event.runId === runId && !generatedEventTypes.has(event.type))
    .slice()
    .sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
}

function sourceLedgerFor(
  ledger: readonly SideEffectLedgerEntry[],
  events: readonly CoreEvent[],
  runId: string
): SideEffectLedgerEntry[] {
  const byId = new Map<string, SideEffectLedgerEntry>();
  for (const entry of ledger) {
    if (entry.runId === runId) byId.set(entry.ledgerId, entry);
  }
  for (const event of events) {
    if (event.type === "side_effect.recorded" && isSideEffectLedgerEntry(event.data)) {
      byId.set(event.data.ledgerId, event.data);
    }
  }
  return [...byId.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.ledgerId.localeCompare(b.ledgerId));
}

function generatedFrom(events: readonly CoreEvent[], ledger: readonly SideEffectLedgerEntry[]): RunTopology["generatedFrom"] {
  const last = events.at(-1);
  return {
    eventCount: events.length,
    ledgerCount: ledger.length,
    lastEventSequence: last?.sequence ?? 0,
    ...(last?.occurredAt ? { lastEventOccurredAt: last.occurredAt } : {})
  };
}

function recoveryStatusFrom(events: readonly CoreEvent[], ledger: readonly SideEffectLedgerEntry[]): string {
  if (events.some((event) => event.type === "circuit.opened")) {
    return "Circuit protection is active for at least one downstream target.";
  }
  if (ledger.some((entry) => entry.retryLoopFinding?.classification === "loop-detected")) {
    return "A retry loop was detected and should be stopped before another identical attempt.";
  }
  if (events.some((event) => event.type === "tool.retry.scheduled")) {
    return "A bounded retry was scheduled with evidence captured for each attempt.";
  }
  if (events.some((event) => event.type === "tool.call.failed")) {
    return "The run failed safely with raw details separated into evidence artifacts.";
  }
  if (events.some((event) => event.type === "tool.call.completed")) {
    return "The run completed and evidence is ready for review.";
  }
  return "The run is waiting for a tool-call outcome.";
}

function factorSummary(factors: readonly { readonly name: string; readonly explanation: string }[]): string {
  return factors.length > 0 ? factors.map((factor) => factor.explanation).join(" ") : "No scoring factors were recorded.";
}

function statusFromEvent(event: CoreEvent): TopologyNodeStatus {
  if (event.type === "retry_loop.detected") return "retry-loop";
  if (event.type === "tool.call.failed" || event.type === "server.preflight.completed" && hasFailedStatus(event.data)) return "failed";
  if (event.type === "policy.decision" && isPolicyDecision(event.data) && (event.data.decision === "block" || event.data.decision === "fail-fast")) return "blocked";
  if (event.type === "circuit.opened") return "blocked";
  if (event.type === "output.sanitized") return "degraded";
  if (event.type === "evidence.artifact.created" || event.type === "report.exported") return "evidence-ready";
  return "healthy";
}

function statusFromLedger(entry: SideEffectLedgerEntry): TopologyNodeStatus {
  if (entry.retryLoopFinding?.classification === "loop-detected") return "retry-loop";
  if (entry.effectState === "blocked") return "blocked";
  if (entry.effectState === "unknown" || entry.effectState === "partial") return "degraded";
  return "healthy";
}

function strongerStatus(a: TopologyNodeStatus, b: TopologyNodeStatus): TopologyNodeStatus {
  const rank: Record<TopologyNodeStatus, number> = {
    healthy: 0,
    "evidence-ready": 1,
    degraded: 2,
    failed: 3,
    blocked: 4,
    "retry-loop": 5
  };
  return rank[b] > rank[a] ? b : a;
}

function correlationFromEvent(event: CoreEvent): JsonObject {
  const output: Record<string, JsonValue> = { runId: event.runId, traceId: event.traceId };
  for (const key of ["parentId", "harnessId", "adapterId", "downstreamServerId", "toolCallId", "attemptId", "policyDecisionId", "artifactId"] as const) {
    if (event[key]) output[key] = event[key] as string;
  }
  return output;
}

function correlationFromLedger(entry: SideEffectLedgerEntry): JsonObject {
  return {
    runId: entry.runId,
    traceId: entry.traceId,
    ...(entry.parentId ? { parentId: entry.parentId } : {}),
    harnessId: entry.harnessId,
    adapterId: entry.adapterId,
    downstreamServerId: entry.downstreamServerId,
    toolCallId: entry.toolCallId,
    attemptId: entry.attemptId,
    policyDecisionId: entry.policyDecisionId
  };
}

function toolNamesByToolCall(events: readonly CoreEvent[], ledger: readonly SideEffectLedgerEntry[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const entry of ledger) {
    names.set(entry.toolCallId, entry.toolName);
  }
  for (const event of events) {
    if (!event.toolCallId || names.has(event.toolCallId)) continue;
    if (isFailureCard(event.data) || isToolResultLike(event.data)) {
      names.set(event.toolCallId, event.data.toolName);
      continue;
    }
    if (isSideEffectLedgerEntry(event.data)) {
      names.set(event.toolCallId, event.data.toolName);
      continue;
    }
    const match = /^Tool call (?:started|completed|failed):\s*(.+)$/.exec(event.summary);
    if (match?.[1]) {
      names.set(event.toolCallId, match[1]);
    }
  }
  return names;
}

function toolNameFromEvent(event: CoreEvent, toolNamesByCall: ReadonlyMap<string, string>): string {
  if (event.toolCallId && toolNamesByCall.has(event.toolCallId)) return toolNamesByCall.get(event.toolCallId) ?? event.toolCallId;
  if (isFailureCard(event.data) || isToolResultLike(event.data)) return event.data.toolName;
  if (isSideEffectLedgerEntry(event.data)) return event.data.toolName;
  return event.toolCallId ?? "downstream-tool";
}

function artifactIdFromSanitizedEvent(event: CoreEvent): string | undefined {
  const data = isRecord(event.data) && isRecord(event.data.data) ? event.data.data : event.data;
  return isRecord(data) && typeof data.artifactId === "string" ? data.artifactId : undefined;
}

function reportIdFromEvent(event: CoreEvent): string {
  return isRecord(event.data) && typeof event.data.reportId === "string" ? event.data.reportId : event.eventId;
}

function hasFailedStatus(value: unknown): boolean {
  return isRecord(value) && value.status === "failed";
}

function harnessNodeId(id: string): string {
  return `harness:${id}`;
}

function adapterNodeId(id: string): string {
  return `adapter:${id}`;
}

function serverNodeId(id: string): string {
  return `downstream-server:${id}`;
}

function toolNodeId(serverId: string | undefined, toolName: string): string {
  return `downstream-tool:${serverId ?? "server:unknown"}:${toolName}`;
}

function attemptNodeId(id: string): string {
  return `attempt:${id}`;
}

function policyNodeId(id: string): string {
  return `policy-decision:${id}`;
}

function circuitNodeId(serverId: string, toolCallId: string | undefined): string {
  return `circuit:${serverId}:${toolCallId ?? "target"}`;
}

function sideEffectNodeId(id: string): string {
  return `side-effect:${id}`;
}

function artifactNodeId(id: string): string {
  return `artifact:${id}`;
}

function reportNodeId(id: string): string {
  return `report:${id}`;
}

function sanitizeSentence(value: string): string {
  return redactStringWithSummary(value).value.replace(/\s+/g, " ").trim();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
}

function compareById<T extends { readonly id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
  return isRecord(value) && typeof value.policyDecisionId === "string" && typeof value.decision === "string";
}

function isEvidenceArtifact(value: unknown): value is EvidenceArtifact {
  return isRecord(value) && typeof value.artifactId === "string" && typeof value.relativePath === "string";
}

function isFailureCard(value: unknown): value is FailureCard {
  return isRecord(value) && typeof value.failureType === "string" && typeof value.likelyRootCause === "string";
}

function isToolResultLike(value: unknown): value is { readonly toolName: string } {
  return isRecord(value) && typeof value.toolName === "string";
}

function isSideEffectLedgerEntry(value: unknown): value is SideEffectLedgerEntry {
  return isRecord(value) && typeof value.ledgerId === "string" && typeof value.toolName === "string";
}

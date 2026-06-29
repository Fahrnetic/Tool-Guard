import type { CoreEvent, RunIndexRecord, RunNarrative, RunTopology, TopologyNode } from "@toolplane/core";
import type {
  DemoStoryModePayload,
  EvidenceArtifact,
  EvidenceLink,
  FailureCard,
  IntegrationCapabilityCheck,
  IntegrationRouteType,
  IntegrationVerificationReceipt,
  PolicyDecision,
  PolicySimulationResult,
  ProposedPolicy,
  RecordedPolicyScenarioId
} from "@toolplane/core";

export type ScreenId =
  | "overview"
  | "timeline"
  | "run-index"
  | "topology"
  | "health"
  | "failures"
  | "traces"
  | "replay"
  | "story"
  | "validation"
  | "policy"
  | "integrations"
  | "reports";

export type ResourceStatus = "idle" | "loading" | "ready" | "degraded" | "empty" | "error";

export interface LatestRunPayload {
  readonly runId: string;
  readonly eventsPath: string;
  readonly evidenceDir: string;
  readonly eventCount: number;
  readonly events: readonly CoreEvent[];
}

export interface RunIndexPayload {
  readonly indexPath: string;
  readonly count: number;
  readonly records: readonly RunIndexRecord[];
}

export type RunIndexFilterWindow = "all" | "1h" | "24h" | "7d";

export interface RunIndexFilters {
  readonly failureType: string;
  readonly routeType: string;
  readonly toolOrStatus: string;
  readonly timeWindow: RunIndexFilterWindow;
}

export interface RunComparisonGroup {
  readonly key: string;
  readonly label: string;
  readonly raw: readonly RunIndexRecord[];
  readonly mediated: readonly RunIndexRecord[];
  readonly repeated: readonly RunIndexRecord[];
  readonly records: readonly RunIndexRecord[];
}

export type TopologyPayload = RunTopology;

export type NarrativePayload = RunNarrative;

export interface HealthPayload {
  readonly runId: string;
  readonly generatedAt: string;
  readonly summary: {
    readonly harnesses: number;
    readonly adapters: number;
    readonly downstreamServers: number;
    readonly downstreamTools: number;
    readonly preflightHealthy: number;
    readonly preflightDegraded: number;
    readonly preflightFailed: number;
    readonly normalizedFailures: number;
    readonly policyDecisions: number;
    readonly circuitOpen: number;
    readonly completedCalls: number;
    readonly artifactCount: number;
  };
  readonly rows: readonly HealthRow[];
}

export interface HealthRow {
  readonly id: string;
  readonly layer: "harness" | "adapter" | "downstream server" | "downstream tool" | string;
  readonly name: string;
  readonly status: "healthy" | "degraded" | "failed" | string;
  readonly preflight: string;
  readonly latencyMs: number;
  readonly failureType: string;
  readonly retryable: boolean;
  readonly circuitState: "closed" | "open" | "half-open" | string;
  readonly remediation: string;
  readonly runId: string;
  readonly downstreamServerId?: string;
}

export interface FailureInboxPayload {
  readonly runId: string;
  readonly generatedAt: string;
  readonly failures: readonly FailureCardView[];
}

export interface FailureCardView extends FailureCard {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly correlation: CorrelationContext;
  readonly rawStdout: readonly RawArtifactView[];
  readonly rawStderr: readonly RawArtifactView[];
  readonly rawArtifacts: readonly RawArtifactView[];
  readonly sanitizedEvents: readonly CoreEvent[];
}

export interface RawArtifactView extends EvidenceArtifact {
  readonly content: string;
  readonly truncated: boolean;
  readonly outputLimitBytes?: number;
  readonly contentUnavailable?: string;
}

export interface TracePayload {
  readonly runId: string;
  readonly traceId: string;
  readonly generatedAt: string;
  readonly status: "ready" | "degraded" | "empty" | "error";
  readonly events: readonly CoreEvent[];
  readonly nodes: readonly TraceNode[];
  readonly correlation: CorrelationContext;
  readonly rawStdout: readonly RawArtifactView[];
  readonly rawStderr: readonly RawArtifactView[];
  readonly rawArtifacts: readonly RawArtifactView[];
  readonly warnings: readonly string[];
}

export interface TraceNode {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly parentId?: string;
  readonly summary: string;
}

export interface PolicyPayload {
  readonly runId: string;
  readonly generatedAt: string;
  readonly decisions: readonly PolicyDecisionView[];
  readonly rules: readonly PolicyRule[];
  readonly preview: PolicyPreview;
}

export interface PolicyDecisionView extends PolicyDecision {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly correlation: CorrelationContext;
}

export interface PolicyRule {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly description: string;
}

export interface PolicyPreview {
  readonly decision: "allow" | "retry" | "block" | "open-circuit" | "close-circuit" | "fail-fast";
  readonly policyDecisionId: string;
  readonly reason: string;
}

export type PolicyScenarioId = RecordedPolicyScenarioId;
export type PolicySimulation = PolicySimulationResult;
export type PolicyDraft = ProposedPolicy;

export type StoryModePayload = DemoStoryModePayload;

export interface ValidationDashboardPayload {
  readonly runId: string;
  readonly generatedAt: string;
  readonly deterministicSeed: string;
  readonly approvedPorts: readonly number[];
  readonly artifactCoverage: {
    readonly ledger: boolean;
    readonly topology: boolean;
    readonly narrative: boolean;
    readonly report: boolean;
    readonly manifest: boolean;
    readonly bundleManifest: boolean;
  };
  readonly checks: readonly ValidationCheckView[];
}

export interface ValidationCheckView {
  readonly id: string;
  readonly label: string;
  readonly status: "pass" | "fail" | "warn";
  readonly detail: string;
}

export interface IntegrationsPayload {
  readonly runId: string;
  readonly generatedAt: string;
  readonly integrations: readonly IntegrationView[];
}

export type VerificationRouteType = IntegrationRouteType;
export type VerificationReceipt = IntegrationVerificationReceipt;
export type VerificationCapabilityCheck = IntegrationCapabilityCheck;

export interface ReplayPayload {
  readonly runId: string;
  readonly generatedAt: string;
  readonly replayableRuns: readonly ReplayableRun[];
  readonly fixtures: readonly ReplayFixture[];
  readonly latestReplayEvents: readonly CoreEvent[];
}

export interface ReplayableRun {
  readonly sourceRunId: string;
  readonly label: string;
  readonly failureCount: number;
  readonly safe: boolean;
  readonly fixtureOnly: boolean;
}

export interface ReplayFixture {
  readonly id: string;
  readonly label: string;
  readonly status: "safe" | "blocked" | "degraded" | string;
  readonly safe: boolean;
  readonly fixtureOnly: boolean;
  readonly destructiveRisk: "none" | "low" | "medium" | "high" | string;
  readonly description: string;
}

export interface ReplayResponse {
  readonly status: "success" | "failed" | "blocked";
  readonly replayId: string;
  readonly sourceRunId: string;
  readonly runId: string;
  readonly reason?: string;
  readonly safe: boolean;
  readonly fixtureOnly: boolean;
  readonly freshCorrelation?: CorrelationContext;
  readonly result?: unknown;
}

export interface ReportsPayload {
  readonly runId: string;
  readonly generatedAt: string;
  readonly reports: readonly ReportView[];
}

export interface ReportView {
  readonly runId: string;
  readonly generatedAt: string;
  readonly reportHtml: string;
  readonly reportUrl: string;
  readonly manifestJson: string;
  readonly manifestUrl: string;
  readonly artifactHashList: string;
  readonly artifactHashUrl: string;
  readonly redactionSummaryPath: string;
  readonly redactionSummaryUrl: string;
  readonly manifestValid: boolean;
  readonly validationErrors: readonly string[];
  readonly artifactCount: number;
  readonly artifacts: readonly ReportArtifactView[];
  readonly artifactHashes: readonly ArtifactHashView[];
  readonly redactionSummary: RedactionSummaryView;
  readonly narrative: string;
  readonly remediation: string;
  readonly exists: boolean;
}

export interface ArtifactHashView {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ReportArtifactView extends EvidenceArtifact {
  readonly artifactUrl: string;
}

export interface RedactionSummaryView {
  readonly redactionCount: number;
  readonly reasons: readonly string[];
}

export interface ReportExportResponse {
  readonly runId: string;
  readonly reportHtml: string;
  readonly reportUrl: string;
  readonly manifestJson: string;
  readonly manifestUrl: string;
  readonly artifactHashList: string;
  readonly artifactHashUrl: string;
  readonly redactionSummary: string;
  readonly redactionSummaryUrl: string;
  readonly manifestValid: boolean;
  readonly validationErrors: readonly string[];
}

export interface BundlePayload {
  readonly runId: string;
  readonly generatedAt: string;
  readonly bundle: BundleView;
}

export interface BundleView {
  readonly exists: boolean;
  readonly bundleId?: string;
  readonly bundleDir?: string;
  readonly generatedAt?: string;
  readonly manifestJson?: string;
  readonly manifestUrl?: string;
  readonly manifestValidation?: string;
  readonly manifestValidationUrl?: string;
  readonly manifestValid?: boolean;
  readonly validationErrors?: readonly string[];
  readonly reportManifestValid?: boolean;
  readonly reportManifestErrors?: readonly string[];
  readonly replaySafe?: boolean;
  readonly replayReason?: string;
  readonly replayInstructionsUrl?: string;
  readonly files?: readonly BundleFileView[];
  readonly rawArtifacts?: readonly BundleRawArtifactView[];
  readonly artifactHashes?: readonly BundleArtifactHashView[];
  readonly redactionSummary?: RedactionSummaryView;
  readonly manifestHealth: BundleStatusView;
  readonly artifactHashStatus: BundleStatusView;
  readonly redactionStatus: BundleStatusView;
  readonly replaySafetyStatus: BundleStatusView;
}

export interface BundleStatusView {
  readonly status: "healthy" | "failed" | "blocked" | "missing" | string;
  readonly label: string;
  readonly summary: string;
}

export interface BundleFileView {
  readonly key: string;
  readonly relativePath: string;
  readonly url: string;
  readonly present: boolean;
  readonly hashed: boolean;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface BundleRawArtifactView {
  readonly relativePath: string;
  readonly url: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface BundleArtifactHashView {
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface BundleExportResponse {
  readonly runId: string;
  readonly bundleDir: string;
  readonly manifestJson: string;
  readonly manifestUrl: string;
  readonly manifestValidation: string;
  readonly manifestValidationUrl: string;
  readonly manifestValid: boolean;
  readonly validationErrors: readonly string[];
  readonly replayInstructions?: string;
  readonly replayInstructionsUrl?: string;
}

export interface IntegrationView {
  readonly id: string;
  readonly name: string;
  readonly route: "MCP-routed" | "SDK-wrapped" | "CLI-supervised" | "unsupported" | "not-yet-verified";
  readonly claimLevel: "configured" | "available" | "unsupported" | "not-yet-verified";
  readonly status: "configured" | "available" | "unsupported" | "not-yet-verified";
  readonly limitation: string;
}

export interface CorrelationContext {
  readonly runId?: string;
  readonly traceId?: string;
  readonly parentId?: string;
  readonly harnessId?: string;
  readonly adapterId?: string;
  readonly downstreamServerId?: string;
  readonly toolCallId?: string;
  readonly attemptId?: string;
  readonly policyDecisionId?: string;
  readonly artifactId?: string;
}

export interface TopologySelection {
  readonly node: TopologyNode;
  readonly selectedIds: readonly string[];
}

export const correlationKeys = [
  "runId",
  "traceId",
  "parentId",
  "harnessId",
  "adapterId",
  "downstreamServerId",
  "toolCallId",
  "attemptId",
  "policyDecisionId",
  "artifactId"
] as const;

export const requiredCoreEventTypes = [
  "run.started",
  "run.completed",
  "adapter.connected",
  "server.preflight.started",
  "server.preflight.completed",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
  "tool.retry.scheduled",
  "circuit.opened",
  "circuit.closed",
  "output.sanitized",
  "evidence.artifact.created",
  "report.exported",
  "topology.generated",
  "narrative.generated",
  "policy.simulated",
  "integration.verified"
] as const;

export interface ToolOpsSummary {
  readonly runId: string;
  readonly harnessCount: number;
  readonly adapterCount: number;
  readonly downstreamToolCount: number;
  readonly preflightLabel: string;
  readonly failureCount: number;
  readonly retryOrPolicyCount: number;
  readonly openCircuitCount: number;
  readonly artifactCount: number;
  readonly reportLinks: readonly string[];
  readonly correlationIds: readonly string[];
}

export interface RunHealthCommandCenterSummary {
  readonly runId: string;
  readonly currentStatus: {
    readonly label: string;
    readonly detail: string;
    readonly tone: "healthy" | "degraded" | "failed" | "warning" | "blocked" | "retry" | "neutral" | "selected";
  };
  readonly topologyHealth: {
    readonly label: string;
    readonly detail: string;
    readonly tone: "healthy" | "degraded" | "failed" | "warning" | "blocked" | "retry" | "neutral" | "selected";
  };
  readonly sideEffectRisk: {
    readonly label: string;
    readonly detail: string;
    readonly tone: "healthy" | "degraded" | "failed" | "warning" | "blocked" | "retry" | "neutral" | "selected";
  };
  readonly retries: {
    readonly label: string;
    readonly detail: string;
    readonly tone: "healthy" | "degraded" | "failed" | "warning" | "blocked" | "retry" | "neutral" | "selected";
  };
  readonly policyDecisions: {
    readonly label: string;
    readonly detail: string;
    readonly tone: "healthy" | "degraded" | "failed" | "warning" | "blocked" | "retry" | "neutral" | "selected";
  };
  readonly evidenceReadiness: {
    readonly label: string;
    readonly detail: string;
    readonly tone: "healthy" | "degraded" | "failed" | "warning" | "blocked" | "retry" | "neutral" | "selected";
  };
}

export function summarizeToolOps(run: LatestRunPayload | undefined, health: HealthPayload | undefined): ToolOpsSummary {
  const events = run?.events ?? [];
  const reportLinks = [...new Set(events
    .filter((event) => event.type === "report.exported")
    .flatMap((event) => {
      const data = event.data;
      return data && "reportHtml" in data && typeof data.reportHtml === "string" ? [data.reportHtml] : [];
    }))];
  const correlationIds = [
    run?.runId,
    events.find((event) => event.traceId)?.traceId,
    events.find((event) => event.toolCallId)?.toolCallId,
    events.find((event) => event.policyDecisionId)?.policyDecisionId
  ].flatMap((value) => (value ? [value] : []));

  return {
    runId: run?.runId ?? health?.runId ?? "waiting-for-run",
    harnessCount: health?.summary.harnesses ?? uniqueCount(events, "harnessId"),
    adapterCount: health?.summary.adapters ?? uniqueCount(events, "adapterId"),
    downstreamToolCount: health?.summary.downstreamTools ?? uniqueCount(events, "toolCallId"),
    preflightLabel: health
      ? `${health.summary.preflightHealthy} healthy, ${health.summary.preflightDegraded} degraded, ${health.summary.preflightFailed} failed`
      : "Waiting for Core preflight",
    failureCount: health?.summary.normalizedFailures ?? events.filter((event) => event.type === "tool.call.failed").length,
    retryOrPolicyCount:
      health?.summary.policyDecisions ??
      events.filter((event) => event.type === "policy.decision" || event.type === "tool.retry.scheduled").length,
    openCircuitCount: health?.summary.circuitOpen ?? events.filter((event) => event.type === "circuit.opened").length,
    artifactCount: health?.summary.artifactCount ?? events.filter((event) => event.type === "evidence.artifact.created").length,
    reportLinks,
    correlationIds
  };
}

export function summarizeCommandCenter(input: {
  readonly run?: LatestRunPayload | undefined;
  readonly health?: HealthPayload | undefined;
  readonly topology?: TopologyPayload | undefined;
  readonly policies?: PolicyPayload | undefined;
  readonly reports?: ReportsPayload | undefined;
  readonly bundle?: BundlePayload | undefined;
  readonly status: ResourceStatus;
}): RunHealthCommandCenterSummary {
  const runId = input.run?.runId ?? input.health?.runId ?? input.topology?.runId ?? input.reports?.runId ?? "waiting-for-run";
  const events = input.run?.events ?? [];
  const failedHealthRows = input.health?.rows.filter((row) => row.status === "failed").length ?? 0;
  const degradedHealthRows = input.health?.rows.filter((row) => row.status === "degraded").length ?? 0;
  const retryEvents = events.filter((event) => event.type === "tool.retry.scheduled").length;
  const retryLoopNodes = input.topology?.nodes.filter((node) => node.status === "retry-loop").length ?? 0;
  const blockedNodes = input.topology?.nodes.filter((node) => node.status === "blocked").length ?? 0;
  const failedNodes = input.topology?.nodes.filter((node) => node.status === "failed").length ?? 0;
  const evidenceReady =
    (input.bundle?.bundle.exists && input.bundle.bundle.manifestValid) ||
    input.reports?.reports.some((report) => report.exists && report.manifestValid) ||
    (input.health?.summary.artifactCount ?? 0) > 0 ||
    (input.topology?.summary.artifacts ?? 0) > 0;

  return {
    runId,
    currentStatus: statusSummary(input.status, failedHealthRows, degradedHealthRows),
    topologyHealth: {
      label: input.topology
        ? failedNodes > 0
          ? `${failedNodes} failed nodes`
          : blockedNodes > 0
            ? `${blockedNodes} blocked nodes`
            : retryLoopNodes > 0
              ? `${retryLoopNodes} retry-loop nodes`
              : "Topology healthy"
        : "Topology pending",
      detail: input.topology
        ? `${input.topology.summary.nodes} nodes, ${input.topology.summary.edges} edges, ${input.topology.generatedFrom.eventCount} source events.`
        : "Run topology appears after Core returns `/api/topology/latest`.",
      tone: failedNodes > 0 ? "failed" : blockedNodes > 0 ? "blocked" : retryLoopNodes > 0 ? "retry" : input.topology ? "healthy" : "neutral"
    },
    sideEffectRisk: {
      label: input.topology
        ? input.topology.summary.sideEffects === 0
          ? "No side effects recorded"
          : blockedNodes > 0
            ? "Side effects contained"
            : `${input.topology.summary.sideEffects} side-effect rows`
        : "Risk pending",
      detail: input.topology
        ? `${input.topology.summary.blocked} blocked, ${input.topology.summary.sideEffects} observed or intended side-effect records.`
        : "Side-effect ledger data is unavailable until Core responds.",
      tone: !input.topology ? "neutral" : blockedNodes > 0 ? "blocked" : input.topology.summary.sideEffects > 0 ? "warning" : "healthy"
    },
    retries: {
      label: retryLoopNodes > 0 ? "Retry loop contained" : retryEvents > 0 ? `${retryEvents} bounded retries` : "No retry loop",
      detail: retryEvents > 0
        ? `${retryEvents} retry event${retryEvents === 1 ? "" : "s"} recorded with Core policy evidence.`
        : "No scheduled retry events are present in the current run.",
      tone: retryLoopNodes > 0 ? "retry" : retryEvents > 0 ? "warning" : "healthy"
    },
    policyDecisions: {
      label: `${input.health?.summary.policyDecisions ?? input.policies?.decisions.length ?? 0} policy decisions`,
      detail: input.policies
        ? `Preview ${input.policies.preview.decision} with ${input.policies.rules.length} visible rule summaries.`
        : "Policy decisions will appear after Core returns policy data.",
      tone: input.policies?.preview.decision === "block" || input.policies?.preview.decision === "fail-fast" ? "blocked" : input.policies ? "healthy" : "neutral"
    },
    evidenceReadiness: {
      label: evidenceReady ? "Evidence ready" : "Evidence pending",
      detail: input.bundle?.bundle.exists
        ? `${input.bundle.bundle.manifestValid ? "Bundle manifest valid" : "Bundle manifest needs attention"} with replay safety ${input.bundle.bundle.replaySafe ? "ready" : "withheld"}.`
        : input.reports?.reports.some((report) => report.exists)
          ? "Static report metadata is available from Core loopback routes."
          : `${input.health?.summary.artifactCount ?? input.topology?.summary.artifacts ?? 0} artifacts recorded so far.`,
      tone: evidenceReady ? "healthy" : "degraded"
    }
  };
}

function statusSummary(status: ResourceStatus, failedHealthRows: number, degradedHealthRows: number): RunHealthCommandCenterSummary["currentStatus"] {
  if (status === "loading") {
    return {
      label: "Loading Core data",
      detail: "The UI is waiting for Core API responses and keeps skeleton states visible.",
      tone: "neutral"
    };
  }
  if (status === "error") {
    return {
      label: "Core unavailable",
      detail: "Use `TOOLGUARD_CORE_PORT=3660 pnpm dev:core` from the mission manifest, then refresh this page.",
      tone: "failed"
    };
  }
  if (status === "degraded") {
    return {
      label: "Core partially degraded",
      detail: "Some endpoints failed, but available run, topology, policy, and evidence panels remain inspectable.",
      tone: "degraded"
    };
  }
  if (status === "empty") {
    return {
      label: "Awaiting first run",
      detail: "Core is reachable. Run a deterministic demo or mediated tool call to populate evidence.",
      tone: "neutral"
    };
  }
  if (failedHealthRows > 0) {
    return {
      label: `${failedHealthRows} failed health rows`,
      detail: `${degradedHealthRows} degraded health rows also need review.`,
      tone: "failed"
    };
  }
  if (degradedHealthRows > 0) {
    return {
      label: `${degradedHealthRows} degraded health rows`,
      detail: "Core is reachable and has surfaced partial downstream health issues.",
      tone: "degraded"
    };
  }
  return {
    label: "Core connected",
    detail: "Latest Core health and run endpoints are reachable.",
    tone: "healthy"
  };
}

export function selectionIdsForNode(node: TopologyNode): readonly string[] {
  return [
    node.id,
    ...node.eventIds,
    ...node.ledgerIds,
    ...node.artifactIds,
    ...Object.values(node.correlation).flatMap((value) => (typeof value === "string" ? [value] : []))
  ].filter(Boolean);
}

export function selectionMatchesValues(selection: TopologySelection | undefined, values: readonly (string | undefined)[]): boolean {
  if (!selection) return false;
  const selected = new Set(selection.selectedIds);
  return values.some((value) => Boolean(value && selected.has(value)));
}

function uniqueCount(events: readonly CoreEvent[], key: keyof CoreEvent): number {
  const values = new Set(events.map((event) => event[key]).filter((value): value is string => typeof value === "string"));
  return values.size;
}

export function correlationFromEvent(event: CoreEvent): CorrelationContext {
  const correlation: Record<string, string> = {};
  for (const key of correlationKeys) {
    const value = event[key];
    if (typeof value === "string" && value.length > 0) {
      correlation[key] = value;
    }
  }
  return correlation;
}

export function evidenceLinksFromFailure(failure: FailureCardView | FailureCard): readonly EvidenceLink[] {
  return Array.isArray(failure.evidenceLinks) ? failure.evidenceLinks : [];
}

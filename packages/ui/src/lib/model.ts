import type { CoreEvent } from "@toolplane/core";
import type { EvidenceArtifact, EvidenceLink, FailureCard, PolicyDecision } from "@toolplane/core";

export type ScreenId =
  | "overview"
  | "timeline"
  | "health"
  | "failures"
  | "traces"
  | "replay"
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
  readonly rawStdout: readonly EvidenceArtifact[];
  readonly rawStderr: readonly EvidenceArtifact[];
  readonly rawArtifacts: readonly EvidenceArtifact[];
  readonly sanitizedEvents: readonly CoreEvent[];
}

export interface TracePayload {
  readonly runId: string;
  readonly traceId: string;
  readonly generatedAt: string;
  readonly status: "ready" | "degraded" | "empty" | "error";
  readonly events: readonly CoreEvent[];
  readonly nodes: readonly TraceNode[];
  readonly correlation: CorrelationContext;
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

export interface IntegrationsPayload {
  readonly runId: string;
  readonly generatedAt: string;
  readonly integrations: readonly IntegrationView[];
}

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
  readonly artifacts: readonly EvidenceArtifact[];
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

export interface RedactionSummaryView {
  readonly redactionCount: number;
  readonly reasons: readonly string[];
}

export interface ReportExportResponse {
  readonly runId: string;
  readonly reportHtml: string;
  readonly manifestJson: string;
  readonly artifactHashList: string;
  readonly redactionSummary: string;
  readonly manifestValid: boolean;
  readonly validationErrors: readonly string[];
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
  "report.exported"
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

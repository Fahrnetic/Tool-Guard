import type { CoreEvent } from "@toolplane/core";

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
  const reportLinks = events
    .filter((event) => event.type === "report.exported")
    .flatMap((event) => {
      const data = event.data;
      return data && "reportHtml" in data && typeof data.reportHtml === "string" ? [data.reportHtml] : [];
    });
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

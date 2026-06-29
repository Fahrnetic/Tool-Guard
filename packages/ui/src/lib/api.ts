import type { CoreEvent } from "@toolplane/core";
import type {
  FailureInboxPayload,
  BundleExportResponse,
  BundlePayload,
  HealthPayload,
  ImpactPayload,
  IntegrationsPayload,
  LatestRunPayload,
  NarrativePayload,
  PolicyPayload,
  PolicyDraft,
  PolicyScenarioId,
  PolicySimulation,
  ReplayPayload,
  ReplayResponse,
  ReportExportResponse,
  ReportsPayload,
  RunIndexPayload,
  StoryModePayload,
  TopologyPayload,
  TracePayload,
  ValidationDashboardPayload,
  VerificationReceipt,
  VerificationRouteType
} from "./model.js";

const CORE_API_BASE = import.meta.env.VITE_TOOLGUARD_CORE_URL ?? "http://127.0.0.1:3660";

export async function fetchLatestRun(signal?: AbortSignal): Promise<LatestRunPayload> {
  return await fetchJson<LatestRunPayload>("/api/runs/latest", signal);
}

export async function fetchRunIndex(signal?: AbortSignal): Promise<RunIndexPayload> {
  return await fetchJson<RunIndexPayload>("/api/run-index", signal);
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthPayload> {
  return await fetchJson<HealthPayload>("/api/health", signal);
}

export async function fetchFailures(signal?: AbortSignal): Promise<FailureInboxPayload> {
  return await fetchJson<FailureInboxPayload>("/api/failures", signal);
}

export async function fetchImpact(signal?: AbortSignal): Promise<ImpactPayload> {
  return await fetchJson<ImpactPayload>("/api/impact", signal);
}

export async function fetchTrace(traceId = "latest", signal?: AbortSignal): Promise<TracePayload> {
  return await fetchJson<TracePayload>(`/api/traces/${encodeURIComponent(traceId)}`, signal);
}

export async function fetchTopology(runId = "latest", signal?: AbortSignal): Promise<TopologyPayload> {
  return await fetchJson<TopologyPayload>(`/api/topology/${encodeURIComponent(runId)}`, signal);
}

export async function fetchNarrative(runId = "latest", signal?: AbortSignal): Promise<NarrativePayload> {
  return await fetchJson<NarrativePayload>(`/api/narrative/${encodeURIComponent(runId)}`, signal);
}

export async function fetchPolicies(signal?: AbortSignal): Promise<PolicyPayload> {
  return await fetchJson<PolicyPayload>("/api/policies", signal);
}

export async function savePolicyPreview(input: { timeoutMs: number; retryLimit: number }, signal?: AbortSignal): Promise<PolicyPayload> {
  return await fetchJson<PolicyPayload>("/api/policies", signal, {
    method: "PUT",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" }
  });
}

export async function simulatePolicy(input: { scenarioId: PolicyScenarioId; proposedPolicy: PolicyDraft }, signal?: AbortSignal): Promise<PolicySimulation> {
  return await fetchJson<PolicySimulation>("/api/policy/simulate", signal, {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" }
  });
}

export async function fetchIntegrations(signal?: AbortSignal): Promise<IntegrationsPayload> {
  return await fetchJson<IntegrationsPayload>("/api/integrations", signal);
}

export async function verifyIntegration(input: { routeType: VerificationRouteType }, signal?: AbortSignal): Promise<VerificationReceipt> {
  return await fetchJson<VerificationReceipt>("/api/integrations/verify", signal, {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" }
  });
}

export async function fetchReplay(signal?: AbortSignal): Promise<ReplayPayload> {
  return await fetchJson<ReplayPayload>("/api/replay", signal);
}

export async function fetchStoryMode(signal?: AbortSignal): Promise<StoryModePayload> {
  return await fetchJson<StoryModePayload>("/api/story", signal);
}

export async function fetchValidationDashboard(signal?: AbortSignal): Promise<ValidationDashboardPayload> {
  return await fetchJson<ValidationDashboardPayload>("/api/validation-dashboard", signal);
}

export async function resetStoryScenario(input: { scenarioId: string }, signal?: AbortSignal): Promise<unknown> {
  return await fetchJsonAllowingStatus<unknown>("/api/story/reset", signal, {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" }
  });
}

export async function requestReplay(input: { toolName: string; sourceRunId: string; fixtureOnly: boolean; mode?: string; destructive?: boolean }, signal?: AbortSignal): Promise<ReplayResponse> {
  return await fetchJsonAllowingStatus<ReplayResponse>("/api/replay", signal, {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" }
  });
}

export async function fetchReports(signal?: AbortSignal): Promise<ReportsPayload> {
  return await fetchJson<ReportsPayload>("/api/reports", signal);
}

export async function fetchBundle(signal?: AbortSignal): Promise<BundlePayload> {
  return await fetchJson<BundlePayload>("/api/bundle", signal);
}

export async function exportReport(signal?: AbortSignal): Promise<ReportExportResponse> {
  return await fetchJson<ReportExportResponse>("/api/reports/export", signal);
}

export async function exportBundle(signal?: AbortSignal): Promise<BundleExportResponse> {
  return await fetchJson<BundleExportResponse>("/api/bundle/export", signal, {
    method: "POST",
    body: JSON.stringify({ replaySafety: { fixtureOnly: true, safeLoopback: true } }),
    headers: { "content-type": "application/json" }
  });
}

export function streamCoreEvents(input: {
  readonly onEvent: (event: CoreEvent) => void;
  readonly onState: (state: "connected" | "degraded" | "error") => void;
}): () => void {
  const source = new EventSource(`${CORE_API_BASE}/events`);
  source.onopen = () => input.onState("connected");
  source.onerror = () => input.onState(source.readyState === EventSource.CLOSED ? "error" : "degraded");
  source.onmessage = (message) => {
    const parsed = parseCoreEvent(message.data);
    if (parsed) {
      input.onEvent(parsed);
    }
  };
  const requiredTypes = [
    "run.started",
    "run.completed",
    "adapter.connected",
    "server.preflight.started",
    "server.preflight.completed",
    "policy.decision",
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
  ];
  for (const type of requiredTypes) {
    source.addEventListener(type, (message) => {
      const parsed = parseCoreEvent((message as MessageEvent<string>).data);
      if (parsed) {
        input.onEvent(parsed);
      }
    });
  }
  return () => source.close();
}

async function fetchJson<T>(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
  const requestInit: RequestInit = signal ? { ...init, signal } : init;
  const response = await fetch(`${CORE_API_BASE}${path}`, requestInit);
  if (!response.ok) {
    throw new Error(`Core API ${path} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function fetchJsonAllowingStatus<T>(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
  const requestInit: RequestInit = signal ? { ...init, signal } : init;
  const response = await fetch(`${CORE_API_BASE}${path}`, requestInit);
  const body = (await response.json()) as T;
  if (!response.ok && typeof body !== "object") {
    throw new Error(`Core API ${path} returned HTTP ${response.status}`);
  }
  return body;
}

function parseCoreEvent(data: string): CoreEvent | undefined {
  try {
    const parsed = JSON.parse(data) as Partial<CoreEvent>;
    return typeof parsed.eventId === "string" && typeof parsed.type === "string" ? (parsed as CoreEvent) : undefined;
  } catch {
    return undefined;
  }
}

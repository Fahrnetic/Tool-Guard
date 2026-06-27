import type { CoreEvent } from "@toolplane/core";
import type {
  FailureInboxPayload,
  HealthPayload,
  IntegrationsPayload,
  LatestRunPayload,
  PolicyPayload,
  TracePayload
} from "./model.js";

const CORE_API_BASE = import.meta.env.VITE_TOOLGUARD_CORE_URL ?? "http://127.0.0.1:3660";

export async function fetchLatestRun(signal?: AbortSignal): Promise<LatestRunPayload> {
  return await fetchJson<LatestRunPayload>("/api/runs/latest", signal);
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthPayload> {
  return await fetchJson<HealthPayload>("/api/health", signal);
}

export async function fetchFailures(signal?: AbortSignal): Promise<FailureInboxPayload> {
  return await fetchJson<FailureInboxPayload>("/api/failures", signal);
}

export async function fetchTrace(traceId = "latest", signal?: AbortSignal): Promise<TracePayload> {
  return await fetchJson<TracePayload>(`/api/traces/${encodeURIComponent(traceId)}`, signal);
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

export async function fetchIntegrations(signal?: AbortSignal): Promise<IntegrationsPayload> {
  return await fetchJson<IntegrationsPayload>("/api/integrations", signal);
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
    "report.exported"
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

function parseCoreEvent(data: string): CoreEvent | undefined {
  try {
    const parsed = JSON.parse(data) as Partial<CoreEvent>;
    return typeof parsed.eventId === "string" && typeof parsed.type === "string" ? (parsed as CoreEvent) : undefined;
  } catch {
    return undefined;
  }
}

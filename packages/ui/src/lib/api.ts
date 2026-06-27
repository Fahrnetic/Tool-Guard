import type { HealthPayload, LatestRunPayload } from "./model.js";

const CORE_API_BASE = import.meta.env.VITE_TOOLGUARD_CORE_URL ?? "http://127.0.0.1:3660";

export async function fetchLatestRun(signal?: AbortSignal): Promise<LatestRunPayload> {
  return await fetchJson<LatestRunPayload>("/api/runs/latest", signal);
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthPayload> {
  return await fetchJson<HealthPayload>("/api/health", signal);
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = signal ? { signal } : {};
  const response = await fetch(`${CORE_API_BASE}${path}`, init);
  if (!response.ok) {
    throw new Error(`Core API ${path} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

import { Gauge, Registry } from "prom-client";
import type { CoreEvent } from "./events.js";

export interface ToolGuardMetrics {
  readonly eventsTotal: number;
  readonly toolCallsTotal: number;
  readonly failuresTotal: number;
  readonly sanitizedOutputsTotal: number;
  readonly openCircuitsTotal: number;
  readonly policyBlocksTotal: number;
  readonly toolCallDurationMsTotal: number;
  readonly toolCallDurationObservationsTotal: number;
}

export function collectToolGuardMetrics(events: readonly CoreEvent[]): ToolGuardMetrics {
  const durations = collectToolCallDurations(events);
  return {
    eventsTotal: events.length,
    toolCallsTotal: events.filter((event) => event.type === "tool.call.started").length,
    failuresTotal: events.filter((event) => event.type === "tool.call.failed").length,
    sanitizedOutputsTotal: events.filter((event) => event.type === "output.sanitized").length,
    openCircuitsTotal: events.filter((event) => event.type === "circuit.opened").length,
    policyBlocksTotal: events.filter(isPolicyBlockEvent).length,
    toolCallDurationMsTotal: durations.reduce((sum, duration) => sum + duration, 0),
    toolCallDurationObservationsTotal: durations.length
  };
}

export function renderPrometheusMetrics(metrics: ToolGuardMetrics): string {
  return [
    "# HELP toolguard_events_total Total ToolGuard events recorded.",
    "# TYPE toolguard_events_total counter",
    `toolguard_events_total ${metrics.eventsTotal}`,
    "# HELP toolguard_tool_calls_total Total ToolGuard tool calls started.",
    "# TYPE toolguard_tool_calls_total counter",
    `toolguard_tool_calls_total ${metrics.toolCallsTotal}`,
    "# HELP toolguard_failures_total Total failed ToolGuard tool calls.",
    "# TYPE toolguard_failures_total counter",
    `toolguard_failures_total ${metrics.failuresTotal}`,
    "# HELP toolguard_sanitized_outputs_total Total sanitized output events.",
    "# TYPE toolguard_sanitized_outputs_total counter",
    `toolguard_sanitized_outputs_total ${metrics.sanitizedOutputsTotal}`,
    "# HELP toolguard_open_circuits_total Total circuit-open events.",
    "# TYPE toolguard_open_circuits_total counter",
    `toolguard_open_circuits_total ${metrics.openCircuitsTotal}`,
    "# HELP toolguard_policy_blocks_total Total blocked policy decisions.",
    "# TYPE toolguard_policy_blocks_total counter",
    `toolguard_policy_blocks_total ${metrics.policyBlocksTotal}`,
    "# HELP toolguard_tool_call_duration_ms_total Total observed tool-call duration in milliseconds.",
    "# TYPE toolguard_tool_call_duration_ms_total counter",
    `toolguard_tool_call_duration_ms_total ${metrics.toolCallDurationMsTotal}`,
    "# HELP toolguard_tool_call_duration_observations_total Total tool-call duration observations.",
    "# TYPE toolguard_tool_call_duration_observations_total counter",
    `toolguard_tool_call_duration_observations_total ${metrics.toolCallDurationObservationsTotal}`
  ].join("\n");
}

export async function renderPrometheusRegistryMetrics(metrics: ToolGuardMetrics): Promise<string> {
  const registry = new Registry();
  const definitions = [
    ["toolguard_events_total", "Total ToolGuard events recorded.", metrics.eventsTotal],
    ["toolguard_tool_calls_total", "Total ToolGuard tool calls started.", metrics.toolCallsTotal],
    ["toolguard_failures_total", "Total failed ToolGuard tool calls.", metrics.failuresTotal],
    ["toolguard_sanitized_outputs_total", "Total sanitized output events.", metrics.sanitizedOutputsTotal],
    ["toolguard_open_circuits_total", "Total circuit-open events.", metrics.openCircuitsTotal],
    ["toolguard_policy_blocks_total", "Total blocked policy decisions.", metrics.policyBlocksTotal],
    ["toolguard_tool_call_duration_ms_total", "Total observed tool-call duration in milliseconds.", metrics.toolCallDurationMsTotal],
    ["toolguard_tool_call_duration_observations_total", "Total tool-call duration observations.", metrics.toolCallDurationObservationsTotal]
  ] as const;

  for (const [name, help, value] of definitions) {
    const gauge = new Gauge({ name, help, registers: [registry] });
    gauge.set(value);
  }

  return registry.metrics();
}

function collectToolCallDurations(events: readonly CoreEvent[]): number[] {
  const starts = new Map<string, number>();
  const durations: number[] = [];
  for (const event of events) {
    if (!event.toolCallId) continue;
    if (event.type === "tool.call.started") {
      starts.set(event.toolCallId, Date.parse(event.occurredAt));
      continue;
    }
    if (event.type === "tool.call.completed" || event.type === "tool.call.failed") {
      const startedAt = starts.get(event.toolCallId);
      if (startedAt === undefined) continue;
      const duration = Date.parse(event.occurredAt) - startedAt;
      durations.push(Number.isFinite(duration) && duration > 0 ? duration : 0);
    }
  }
  return durations;
}

function isPolicyBlockEvent(event: CoreEvent): boolean {
  if (event.type !== "policy.decision" || !event.data || typeof event.data !== "object") return false;
  const decision = "decision" in event.data ? event.data.decision : undefined;
  return decision === "block" || decision === "blocked" || decision === "deny";
}

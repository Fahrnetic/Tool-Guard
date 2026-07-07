import { Gauge, Registry } from "prom-client";
import type { CoreEvent } from "./events.js";

export interface ToolGuardMetrics {
  readonly eventsTotal: number;
  readonly failuresTotal: number;
  readonly sanitizedOutputsTotal: number;
  readonly openCircuitsTotal: number;
}

export function collectToolGuardMetrics(events: readonly CoreEvent[]): ToolGuardMetrics {
  return {
    eventsTotal: events.length,
    failuresTotal: events.filter((event) => event.type === "tool.call.failed").length,
    sanitizedOutputsTotal: events.filter((event) => event.type === "output.sanitized").length,
    openCircuitsTotal: events.filter((event) => event.type === "circuit.opened").length
  };
}

export function renderPrometheusMetrics(metrics: ToolGuardMetrics): string {
  return [
    "# HELP toolguard_events_total Total ToolGuard events recorded.",
    "# TYPE toolguard_events_total counter",
    `toolguard_events_total ${metrics.eventsTotal}`,
    "# HELP toolguard_failures_total Total failed ToolGuard tool calls.",
    "# TYPE toolguard_failures_total counter",
    `toolguard_failures_total ${metrics.failuresTotal}`,
    "# HELP toolguard_sanitized_outputs_total Total sanitized output events.",
    "# TYPE toolguard_sanitized_outputs_total counter",
    `toolguard_sanitized_outputs_total ${metrics.sanitizedOutputsTotal}`,
    "# HELP toolguard_open_circuits_total Total circuit-open events.",
    "# TYPE toolguard_open_circuits_total counter",
    `toolguard_open_circuits_total ${metrics.openCircuitsTotal}`
  ].join("\n");
}

export async function renderPrometheusRegistryMetrics(metrics: ToolGuardMetrics): Promise<string> {
  const registry = new Registry();
  const definitions = [
    ["toolguard_events_total", "Total ToolGuard events recorded.", metrics.eventsTotal],
    ["toolguard_failures_total", "Total failed ToolGuard tool calls.", metrics.failuresTotal],
    ["toolguard_sanitized_outputs_total", "Total sanitized output events.", metrics.sanitizedOutputsTotal],
    ["toolguard_open_circuits_total", "Total circuit-open events.", metrics.openCircuitsTotal]
  ] as const;

  for (const [name, help, value] of definitions) {
    const gauge = new Gauge({ name, help, registers: [registry] });
    gauge.set(value);
  }

  return registry.metrics();
}

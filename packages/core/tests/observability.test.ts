import { describe, expect, it } from "vitest";
import {
  buildOpenObserveDashboardQueries,
  buildOtlpLogs,
  buildOtlpMetrics,
  buildToolGuardOtelDemoPayloads,
  collectToolGuardMetrics,
  createStructuredLogEntry,
  renderPrometheusMetrics
} from "../src/index.js";
import type { CoreEvent } from "../src/index.js";

describe("observability helpers", () => {
  it("collects safe local metrics from core events", () => {
    const events = [event("tool.call.failed"), event("output.sanitized"), event("circuit.opened"), event("tool.call.completed")];

    const metrics = collectToolGuardMetrics(events);

    expect(metrics).toEqual({
      eventsTotal: 4,
      failuresTotal: 1,
      sanitizedOutputsTotal: 1,
      openCircuitsTotal: 1
    });
    expect(renderPrometheusMetrics(metrics)).toContain("toolguard_events_total 4");
  });

  it("redacts structured log messages and context", () => {
    const entry = createStructuredLogEntry("info", "safe message", {
      authorization: "placeholder-credential-value"
    });

    expect(entry.message).toBe("safe message");
    expect(JSON.stringify(entry.context)).not.toContain("placeholder-credential-value");
  });

  it("builds OTLP-shaped metrics, logs, traces, and dashboard queries for OpenObserve demos", async () => {
    const events = [
      event("run.started"),
      event("tool.call.failed", { toolName: "fixture.fail", authorization: "placeholder-credential-value" }),
      event("output.sanitized"),
      event("circuit.opened")
    ];

    const payloads = await buildToolGuardOtelDemoPayloads(events, "toolguard-local-demo");
    const metrics = buildOtlpMetrics(events, "toolguard-local-demo");
    const logs = buildOtlpLogs(events, "toolguard-local-demo");
    const queries = buildOpenObserveDashboardQueries();

    expect(payloads.traces.spanCount).toBe(4);
    expect(metrics.resourceMetrics[0].scopeMetrics[0].metrics.map((metric) => metric.name)).toEqual(
      expect.arrayContaining(["toolguard_events_total", "toolguard_failures_total", "toolguard_open_circuits_total"])
    );
    expect(logs.resourceLogs[0].scopeLogs[0].logRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severityText: "ERROR",
          attributes: expect.arrayContaining([{ key: "data_toolName", value: { stringValue: "fixture.fail" } }])
        })
      ])
    );
    expect(JSON.stringify(logs)).not.toContain("placeholder-credential-value");
    expect(queries.map((query) => query.backend)).toEqual(expect.arrayContaining(["openobserve", "prometheus", "loki"]));
  });
});

function event(type: CoreEvent["type"], data = {}): CoreEvent {
  return {
    eventId: `event_${type}`,
    sequence: 1,
    type,
    occurredAt: "2026-01-01T00:00:00.000Z",
    summary: type,
    runId: "run_test",
    traceId: "trace_test",
    toolCallId: "toolcall_test",
    attemptId: "attempt_test",
    policyDecisionId: "policy_test",
    harnessId: "harness_test",
    adapterId: "adapter_test",
    downstreamServerId: "server_test",
    data
  };
}

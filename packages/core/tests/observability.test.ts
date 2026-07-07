import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { discoverDockerBridgeMetricsBindings } from "../src/docker-bridge.js";
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
    const events = [
      event("tool.call.started"),
      event("tool.call.failed"),
      event("output.sanitized"),
      event("circuit.opened"),
      event("tool.call.completed"),
      event("policy.decision", { decision: "block" })
    ];

    const metrics = collectToolGuardMetrics(events);

    expect(metrics).toEqual({
      eventsTotal: 6,
      toolCallsTotal: 1,
      failuresTotal: 1,
      sanitizedOutputsTotal: 1,
      openCircuitsTotal: 1,
      policyBlocksTotal: 1,
      toolCallDurationMsTotal: 0,
      toolCallDurationObservationsTotal: 2
    });
    expect(renderPrometheusMetrics(metrics)).toContain("toolguard_events_total 6");
    expect(renderPrometheusMetrics(metrics)).toContain("toolguard_tool_calls_total 1");
    expect(renderPrometheusMetrics(metrics)).toContain("toolguard_policy_blocks_total 1");
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
    expect(payloads.otlpTraces.resourceSpans[0]?.scopeSpans[0].spans).toHaveLength(4);
    expect(metrics.resourceMetrics[0].scopeMetrics[0].metrics.map((metric) => metric.name)).toEqual(
      expect.arrayContaining([
        "toolguard_events_total",
        "toolguard_tool_calls_total",
        "toolguard_failures_total",
        "toolguard_open_circuits_total",
        "toolguard_policy_blocks_total"
      ])
    );
    expect(logs.resourceLogs[0].scopeLogs[0].logRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severityText: "ERROR",
          attributes: expect.arrayContaining([{ key: "data_toolName", value: { stringValue: "fixture.fail" } }])
        })
      ])
    );
    expect(payloads.ndjsonLogs.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "tool.call.failed", level: "error", service_name: "toolguard-local-demo" })
      ])
    );
    expect(JSON.stringify(logs)).not.toContain("placeholder-credential-value");
    expect(payloads.ndjsonLogs.join("\n")).not.toContain("placeholder-credential-value");
    expect(queries.map((query) => query.backend)).toEqual(expect.arrayContaining(["openobserve", "prometheus", "loki"]));
  });

  it("discovers only private Docker bridge gateway addresses for the demo metrics listener", () => {
    const bridgeAddress = (address: string, internal = false): NetworkInterfaceInfo => ({
      address,
      cidr: `${address}/16`,
      family: "IPv4",
      internal,
      mac: "02:42:00:00:00:01",
      netmask: "255.255.0.0"
    });

    expect(
      discoverDockerBridgeMetricsBindings({
        docker0: [bridgeAddress("172.17.0.1")],
        "br-demo": [bridgeAddress("172.24.0.1"), bridgeAddress("203.0.113.10")],
        eth0: [bridgeAddress("192.168.1.20")],
        lo: [bridgeAddress("127.0.0.1", true)]
      }, "")
    ).toEqual([
      { host: "172.17.0.1", interfaceName: "docker0" },
      { host: "172.24.0.1", interfaceName: "br-demo" }
    ]);
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

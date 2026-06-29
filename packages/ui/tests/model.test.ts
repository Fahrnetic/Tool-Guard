import { describe, expect, it } from "vitest";
import {
  correlationFromEvent,
  requiredCoreEventTypes,
  selectionIdsForNode,
  selectionMatchesValues,
  summarizeToolOps,
  type HealthPayload,
  type LatestRunPayload
} from "../src/lib/model.js";
import { healthRowAccessibleLabel } from "../src/screens/HealthMatrix.js";

describe("summarizeToolOps", () => {
  it("uses Core health API data for overview counts and labels", () => {
    const run: LatestRunPayload = {
      runId: "run_test",
      eventsPath: "/runs/test/events.jsonl",
      evidenceDir: "/runs/test",
      eventCount: 2,
      events: [
        {
          eventId: "event_1",
          type: "run.started",
          occurredAt: "2026-06-26T00:00:00.000Z",
          sequence: 1,
          summary: "Run started",
          runId: "run_test",
          traceId: "trace_test",
          harnessId: "harness_test",
          adapterId: "adapter_test",
          downstreamServerId: "server_test",
          toolCallId: "toolcall_test",
          attemptId: "attempt_test",
          policyDecisionId: "policy_test"
        },
        {
          eventId: "event_2",
          type: "report.exported",
          occurredAt: "2026-06-26T00:00:01.000Z",
          sequence: 2,
          summary: "Static report exported",
          runId: "run_test",
          traceId: "trace_test",
          data: { reportHtml: "/runs/test/report.html", manifestJson: "/runs/test/manifest.json" }
        },
        {
          eventId: "event_3",
          type: "report.exported",
          occurredAt: "2026-06-26T00:00:02.000Z",
          sequence: 3,
          summary: "Static report exported again",
          runId: "run_test",
          traceId: "trace_test",
          data: { reportHtml: "/runs/test/report.html", manifestJson: "/runs/test/manifest.json" }
        }
      ]
    };
    const health: HealthPayload = {
      runId: "run_test",
      generatedAt: "2026-06-26T00:00:02.000Z",
      summary: {
        harnesses: 1,
        adapters: 1,
        downstreamServers: 1,
        downstreamTools: 7,
        preflightHealthy: 3,
        preflightDegraded: 4,
        preflightFailed: 0,
        normalizedFailures: 2,
        policyDecisions: 5,
        circuitOpen: 1,
        completedCalls: 1,
        artifactCount: 4
      },
      rows: []
    };

    const summary = summarizeToolOps(run, health);

    expect(summary.downstreamToolCount).toBe(7);
    expect(summary.preflightLabel).toBe("3 healthy, 4 degraded, 0 failed");
    expect(summary.failureCount).toBe(2);
    expect(summary.reportLinks).toEqual(["/runs/test/report.html"]);
    expect(summary.correlationIds).toEqual(["run_test", "trace_test", "toolcall_test", "policy_test"]);
  });
});

describe("correlation helpers", () => {
  it("exposes all populated observability correlation fields", () => {
    const correlation = correlationFromEvent({
      eventId: "event_1",
      type: "tool.call.failed",
      occurredAt: "2026-06-26T00:00:00.000Z",
      sequence: 7,
      summary: "Tool failed",
      runId: "run_test",
      traceId: "trace_test",
      parentId: "parent_test",
      harnessId: "harness_test",
      adapterId: "adapter_test",
      downstreamServerId: "server_test",
      toolCallId: "toolcall_test",
      attemptId: "attempt_test",
      policyDecisionId: "policy_test",
      artifactId: "artifact_test"
    });

    expect(correlation).toEqual({
      runId: "run_test",
      traceId: "trace_test",
      parentId: "parent_test",
      harnessId: "harness_test",
      adapterId: "adapter_test",
      downstreamServerId: "server_test",
      toolCallId: "toolcall_test",
      attemptId: "attempt_test",
      policyDecisionId: "policy_test",
      artifactId: "artifact_test"
    });
  });

  it("tracks the required Core event types rendered by the timeline", () => {
    expect(requiredCoreEventTypes).toEqual([
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
    ]);
  });
});

describe("topology selection helpers", () => {
  it("matches linked views through event, ledger, artifact, and correlation IDs", () => {
    const node = {
      id: "node_attempt",
      type: "attempt",
      label: "Attempt attempt_test",
      status: "failed",
      summary: "Attempt failed",
      correlation: {
        runId: "run_test",
        traceId: "trace_test",
        toolCallId: "toolcall_test",
        attemptId: "attempt_test",
        policyDecisionId: "policy_test"
      },
      eventIds: ["event_failed"],
      ledgerIds: ["ledger_side_effect"],
      artifactIds: ["artifact_stderr"]
    } as const;
    const selection = { node, selectedIds: selectionIdsForNode(node) };

    expect(selectionMatchesValues(selection, ["event_failed"])).toBe(true);
    expect(selectionMatchesValues(selection, ["ledger_side_effect"])).toBe(true);
    expect(selectionMatchesValues(selection, ["artifact_stderr"])).toBe(true);
    expect(selectionMatchesValues(selection, ["policy_test"])).toBe(true);
    expect(selectionMatchesValues(selection, ["unrelated"])).toBe(false);
  });
});

describe("Health Matrix row accessibility", () => {
  it("labels layer, status, latency, failure, retry, circuit, and remediation fields", () => {
    const label = healthRowAccessibleLabel({
      id: "server_downstream_1",
      layer: "downstream server",
      name: "server_fixture",
      status: "degraded",
      preflight: "degraded",
      latencyMs: 96,
      failureType: "preflight_degraded",
      retryable: true,
      circuitState: "open",
      remediation: "Inspect server-level connectivity before retrying tools.",
      runId: "run_test",
      downstreamServerId: "server_fixture"
    });

    expect(label).toContain("downstream server server_fixture");
    expect(label).toContain("status degraded");
    expect(label).toContain("preflight degraded");
    expect(label).toContain("latency 96 milliseconds");
    expect(label).toContain("failure type preflight_degraded");
    expect(label).toContain("retryable with policy");
    expect(label).toContain("circuit open");
    expect(label).toContain("remediation Inspect server-level connectivity before retrying tools.");
  });
});

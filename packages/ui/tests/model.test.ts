import { describe, expect, it } from "vitest";
import {
  correlationFromEvent,
  requiredCoreEventTypes,
  summarizeToolOps,
  type HealthPayload,
  type LatestRunPayload
} from "../src/lib/model.js";

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
      "report.exported"
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { summarizeToolOps, type HealthPayload, type LatestRunPayload } from "../src/lib/model.js";

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
    expect(summary.reportLinks).toContain("/runs/test/report.html");
    expect(summary.correlationIds).toEqual(["run_test", "trace_test", "toolcall_test", "policy_test"]);
  });
});

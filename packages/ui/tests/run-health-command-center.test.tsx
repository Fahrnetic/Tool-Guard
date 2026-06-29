import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Overview } from "../src/screens/Overview.js";
import type { BundlePayload, HealthPayload, LatestRunPayload, PolicyPayload, ReportsPayload, TopologyPayload } from "../src/lib/model.js";

describe("Run Health Command Center", () => {
  it("renders status, topology, side-effect risk, retries, policy, and evidence readiness", () => {
    const html = renderToStaticMarkup(
      <Overview
        run={runPayload}
        health={healthPayload}
        topology={topologyPayload}
        policies={policyPayload}
        reports={reportsPayload}
        bundle={bundlePayload}
        status="ready"
      />
    );

    expect(html).toContain("Run Health Command Center");
    expect(html).toContain("Current status");
    expect(html).toContain("Topology health");
    expect(html).toContain("Side-effect risk");
    expect(html).toContain("Retries");
    expect(html).toContain("Policy decisions");
    expect(html).toContain("Evidence readiness");
    expect(html).toContain("One landing screen for run status, risk, policy, and evidence readiness.");
    expect(html).toContain("Retry loop contained");
    expect(html).toContain("Side effects contained");
    expect(html).toContain("Evidence ready");
  });

  it("shows clear offline Core recovery instructions without overclaiming integrations", () => {
    const html = renderToStaticMarkup(<Overview status="error" error="Core API /api/health returned HTTP 503" />);

    expect(html).toContain("Core API unavailable");
    expect(html).toContain("TOOLGUARD_CORE_PORT=3660 pnpm dev:core");
    expect(html).toContain("Keep using visible fixture and empty-state guidance while Core restarts");
    expect(html).toContain("routed ToolGuard boundaries");
    expect(html).not.toContain("native host tools are intercepted");
    expect(html).not.toContain("all integrations are protected");
  });
});

const runPayload: LatestRunPayload = {
  runId: "run_command_center",
  eventsPath: "/runs/run_command_center/events.jsonl",
  evidenceDir: "/runs/run_command_center",
  eventCount: 3,
  events: [
    {
      eventId: "event_started",
      type: "run.started",
      occurredAt: "2026-06-29T00:00:00.000Z",
      sequence: 1,
      summary: "Run started",
      runId: "run_command_center",
      traceId: "trace_command_center",
      toolCallId: "toolcall_command_center"
    },
    {
      eventId: "event_retry",
      type: "tool.retry.scheduled",
      occurredAt: "2026-06-29T00:00:01.000Z",
      sequence: 2,
      summary: "Retry scheduled",
      runId: "run_command_center",
      traceId: "trace_command_center",
      toolCallId: "toolcall_command_center",
      attemptId: "attempt_retry"
    },
    {
      eventId: "event_report",
      type: "report.exported",
      occurredAt: "2026-06-29T00:00:02.000Z",
      sequence: 3,
      summary: "Report exported",
      runId: "run_command_center",
      traceId: "trace_command_center",
      data: { reportHtml: "/runs/run_command_center/report.html" }
    }
  ]
};

const healthPayload: HealthPayload = {
  runId: "run_command_center",
  generatedAt: "2026-06-29T00:00:03.000Z",
  summary: {
    harnesses: 1,
    adapters: 1,
    downstreamServers: 1,
    downstreamTools: 2,
    preflightHealthy: 2,
    preflightDegraded: 0,
    preflightFailed: 0,
    normalizedFailures: 1,
    policyDecisions: 3,
    circuitOpen: 1,
    completedCalls: 1,
    artifactCount: 2
  },
  rows: []
};

const topologyPayload: TopologyPayload = {
  runId: "run_command_center",
  generatedFrom: {
    eventCount: 3,
    ledgerCount: 1,
    lastEventSequence: 3,
    lastEventOccurredAt: "2026-06-29T00:00:02.000Z"
  },
  summary: {
    nodes: 4,
    edges: 3,
    failures: 1,
    blocked: 1,
    sideEffects: 1,
    artifacts: 2,
    reports: 1
  },
  nodes: [
    {
      id: "node_retry",
      type: "attempt",
      label: "Retry attempt",
      status: "retry-loop",
      summary: "Retry loop detected and contained.",
      correlation: { runId: "run_command_center", traceId: "trace_command_center" },
      eventIds: ["event_retry"],
      ledgerIds: [],
      artifactIds: []
    },
    {
      id: "node_blocked",
      type: "side-effect",
      label: "Blocked fixture write",
      status: "blocked",
      summary: "Fixture-only destructive action blocked before execution.",
      correlation: { runId: "run_command_center" },
      eventIds: [],
      ledgerIds: ["ledger_blocked"],
      artifactIds: []
    }
  ],
  edges: []
};

const policyPayload: PolicyPayload = {
  runId: "run_command_center",
  generatedAt: "2026-06-29T00:00:03.000Z",
  decisions: [],
  rules: [{ id: "rule_1", label: "Destructive action", value: "block", description: "Block before execution." }],
  preview: {
    decision: "block",
    policyDecisionId: "policy_command_center",
    reason: "Fixture-only destructive action remains blocked before execution."
  }
};

const reportsPayload: ReportsPayload = {
  runId: "run_command_center",
  generatedAt: "2026-06-29T00:00:03.000Z",
  reports: [
    {
      runId: "run_command_center",
      generatedAt: "2026-06-29T00:00:03.000Z",
      reportHtml: "/runs/run_command_center/report.html",
      reportUrl: "http://127.0.0.1:3660/api/reports/run_command_center/report.html",
      manifestJson: "/runs/run_command_center/manifest.json",
      manifestUrl: "http://127.0.0.1:3660/api/reports/run_command_center/manifest.json",
      artifactHashList: "/runs/run_command_center/artifact-hashes.json",
      artifactHashUrl: "http://127.0.0.1:3660/api/reports/run_command_center/artifact-hashes.json",
      redactionSummaryPath: "/runs/run_command_center/redaction-summary.json",
      redactionSummaryUrl: "http://127.0.0.1:3660/api/reports/run_command_center/redaction-summary.json",
      manifestValid: true,
      validationErrors: [],
      artifactCount: 2,
      artifacts: [],
      artifactHashes: [],
      redactionSummary: { redactionCount: 0, reasons: [] },
      narrative: "Sanitized failure narrative.",
      remediation: "Inspect separated raw artifacts only when needed.",
      exists: true
    }
  ]
};

const bundlePayload: BundlePayload = {
  runId: "run_command_center",
  generatedAt: "2026-06-29T00:00:03.000Z",
  bundle: {
    exists: true,
    bundleId: "bundle_command_center",
    manifestValid: true,
    replaySafe: true,
    manifestHealth: { status: "healthy", label: "Manifest valid", summary: "Manifest references resolve." },
    artifactHashStatus: { status: "healthy", label: "Artifacts hashed", summary: "Artifacts have hashes." },
    redactionStatus: { status: "healthy", label: "Redaction checked", summary: "Safe previews redacted." },
    replaySafetyStatus: { status: "healthy", label: "Replay safe", summary: "Fixture-only replay." }
  }
};

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImpactPanel } from "../src/screens/ImpactPanel.js";
import type { ImpactPayload } from "../src/lib/model.js";

describe("Observed Impact panel", () => {
  it("lists observed changes, safe affected paths, process children, reversibility, attribution, and rollback guidance", () => {
    const html = renderToStaticMarkup(<ImpactPanel payload={impactPayload} status="ready" />);

    expect(html).toContain("Observed local impact and rollback guidance");
    expect(html).toContain("Observed changes");
    expect(html).toContain("Safe affected paths");
    expect(html).toContain("Process children");
    expect(html).toContain("Reversibility: reversible");
    expect(html).toContain("Attribution: observed-after");
    expect(html).toContain("src/output.json");
    expect(html).toContain("artifact/raw-stdout.txt");
    expect(html).toContain("pid");
    expect(html).toContain("Remove created disposable-workspace path src/output.json.");
    expect(html).toContain("Local changes were observed after the mediated call");
  });

  it("shows useful empty guidance before any impact rows exist", () => {
    const html = renderToStaticMarkup(
      <ImpactPanel payload={{ runId: "run_empty", generatedAt: "2026-06-29T00:00:00.000Z", summary: { entries: 0, observedChanges: 0, safeAffectedPaths: 0, processChildren: 0, rollbackSteps: 0, reversible: 0, blocked: 0 }, entries: [] }} status="ready" />
    );

    expect(html).toContain("No observed impact yet");
    expect(html).toContain("Run a mediated CLI or fixture call");
  });
});

const impactPayload: ImpactPayload = {
  runId: "run_impact",
  generatedAt: "2026-06-29T00:00:02.000Z",
  summary: {
    entries: 1,
    observedChanges: 1,
    safeAffectedPaths: 2,
    processChildren: 1,
    rollbackSteps: 1,
    reversible: 1,
    blocked: 0
  },
  entries: [
    {
      ledgerId: "ledger_impact",
      recordedAt: "2026-06-29T00:00:01.000Z",
      runId: "run_impact",
      traceId: "trace_impact",
      toolCallId: "toolcall_impact",
      attemptId: "attempt_impact",
      policyDecisionId: "policy_impact",
      toolName: "fixture.write-file",
      targetType: "filesystem",
      effectState: "completed",
      reversibility: "reversible",
      operation: "call-completed",
      summary: "Wrote a fixture output file in a contained disposable workspace.",
      attributionLevel: "observed-after",
      evidenceBasis: ["filesystem-diff", "process-lifecycle", "artifact-write"],
      causalClaim: "Local changes were observed after the mediated call in the contained workspace.",
      counterEvidence: [],
      blastRadius: {
        score: 16,
        label: "contained",
        factors: [{ name: "fixture workspace", score: 4, explanation: "Disposable workspace only." }]
      },
      observedImpact: {
        workspaceRoot: "/tmp/toolguard-impact",
        disposableWorkspace: true,
        pathContainment: "contained",
        fileChanges: [
          {
            path: "src/output.json",
            changeType: "created",
            after: { type: "file", sizeBytes: 32, mtimeMs: 1, sha256: "abc123" }
          }
        ],
        safeAffectedPaths: ["src/output.json", "artifact/raw-stdout.txt"],
        tempArtifactWrites: ["artifact/raw-stdout.txt"],
        processLifecycle: {
          pid: 1234,
          processGroupId: 1234,
          startedAt: "2026-06-29T00:00:00.000Z",
          endedAt: "2026-06-29T00:00:01.000Z",
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          cleanupResult: "not-needed",
          terminationSignals: []
        },
        outcome: "completed",
        rollbackGuidance: ["Remove created disposable-workspace path src/output.json."],
        bundleHashes: [{ relativePath: "impact-summary", sha256: "abc123", byteLength: 32 }]
      }
    }
  ]
};

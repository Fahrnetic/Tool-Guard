import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StableId } from "@toolplane/core";
import { FailureInbox } from "../src/screens/FailureInbox.js";
import type { FailureInboxPayload } from "../src/lib/model.js";

describe("Failure Inbox root-cause diagnosis panel", () => {
  it("renders ranked hypotheses, clickable evidence anchors, and visible weak-inference labels", () => {
    const html = renderToStaticMarkup(<FailureInbox payload={payload} status="ready" />);

    expect(html).toContain("Ranked diagnostic hypotheses");
    expect(html).toContain("Rank 1");
    expect(html).toContain("Rank 2");
    expect(html).toContain("High confidence");
    expect(html).toContain("Low confidence");
    expect(html).toContain("Weak inference, not fact");
    expect(html).toContain("Treat it as a lead to verify, not as established root cause.");
    expect(html).toContain("href=\"http://127.0.0.1:3660/api/reports/run_diag/artifacts/artifact_stderr\"");
    expect(html).toContain("href=\"#anchor_safe_env\"");
    expect(html).toContain("Missing binary stderr");
    expect(html).toContain("Safe environment facts");
  });
});

const payload: FailureInboxPayload = {
  runId: "run_diag",
  generatedAt: "2026-06-29T12:00:00.000Z",
  failures: [
    {
      eventId: "event_failed",
      occurredAt: "2026-06-29T12:00:00.000Z",
      summary: "Tool call failed",
      toolName: "fixture.missing-binary",
      failureType: "spawn_failure",
      likelyRootCause: "The executable resolution failed before downstream work could start.",
      failureCause: "missing-binary",
      failureBoundary: "environment",
      failureMechanism: "The executable was not found in the current PATH.",
      rootCauseConfidence: "high",
      contributingFactors: ["Command resolution failed before the tool produced normal output."],
      evidenceAnchors: [
        {
          anchorId: stableId("anchor_stderr"),
          evidenceType: "stderr-anchor",
          label: "Missing binary stderr",
          summary: "stderr contains ENOENT for the requested executable.",
          confidenceContribution: "high",
          artifactId: "artifact_stderr",
          href: "http://127.0.0.1:3660/api/reports/run_diag/artifacts/artifact_stderr"
        },
        {
          anchorId: stableId("anchor_safe_env"),
          evidenceType: "safe-environment",
          label: "Safe environment facts",
          summary: "cwd basename and package manager facts are safe diagnostic context.",
          confidenceContribution: "medium"
        }
      ],
      diagnosticHypotheses: [
        {
          rank: 1,
          cause: "missing-binary",
          boundary: "environment",
          mechanism: "The named executable was not resolved by the process launcher.",
          confidence: "high",
          evidenceAnchorIds: [stableId("anchor_stderr")]
        },
        {
          rank: 2,
          cause: "unknown",
          boundary: "adapter",
          mechanism: "Adapter configuration may have omitted a PATH override.",
          confidence: "low",
          evidenceAnchorIds: [stableId("anchor_safe_env")]
        }
      ],
      retryable: false,
      doNotRetrySameCall: true,
      safeRecoveryOptions: ["Install the executable or update the routed command."],
      humanFix: "Verify the executable is installed and on PATH.",
      evidenceLinks: [
        {
          artifactId: "artifact_stderr",
          label: "stderr",
          href: "http://127.0.0.1:3660/api/reports/run_diag/artifacts/artifact_stderr"
        }
      ],
      safeSummary: "The command failed before downstream work started.",
      rawDetailsSeparated: true,
      correlation: {
        runId: "run_diag",
        traceId: "trace_diag",
        toolCallId: "toolcall_diag",
        attemptId: "attempt_diag",
        policyDecisionId: "policy_diag"
      },
      rawStdout: [],
      rawStderr: [],
      rawArtifacts: [],
      sanitizedEvents: []
    }
  ]
};

function stableId(value: string): StableId {
  return value as StableId;
}

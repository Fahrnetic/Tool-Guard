import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContextImpactMetrics, StableId } from "@toolplane/core";
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
    expect(html).toContain("Estimated context impact");
    expect(html).toContain("1,024 tokens");
    expect(html).toContain("heuristic-chars-div-4");
    expect(html).toContain("Provider token usage unavailable; estimated locally from character count divided by four.");
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
      contextImpact: makeContextImpact(),
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

function makeContextImpact(): ContextImpactMetrics {
  return {
    modelFacingContent: { bytes: 4096, chars: 4096, estimatedTokens: 1024 },
    rawContentEstimate: { bytes: 16384, chars: 16384, estimatedTokens: 4096 },
    safeDisplayedEstimate: { bytes: 2048, chars: 2048, estimatedTokens: 512 },
    tokenEstimate: {
      estimatedTokens: 1024,
      method: "heuristic-chars-div-4",
      provenance: "Provider token usage unavailable; estimated locally from character count divided by four.",
      confidence: "low"
    },
    preventedContextFlood: {
      rawEstimate: { bytes: 16384, chars: 16384, estimatedTokens: 4096 },
      safeDisplayedEstimate: { bytes: 2048, chars: 2048, estimatedTokens: 512 },
      saved: { bytes: 14336, chars: 14336, estimatedTokens: 3584 }
    },
    redactionSavings: { bytes: 1024, chars: 1024, estimatedTokens: 256 },
    truncationSavings: { bytes: 512, chars: 512, estimatedTokens: 128 },
    duplicateRetryContext: {
      fingerprint: "spawn_failure:missing-binary",
      repeatedFingerprintCount: 1,
      estimatedDuplicateBytes: 0,
      estimatedDuplicateChars: 0,
      estimatedDuplicateTokens: 0
    },
    retryAmplification: {
      attemptCount: 1,
      contextMultiplier: 1,
      estimatedAmplifiedBytes: 4096,
      estimatedAmplifiedTokens: 1024
    },
    notes: ["Raw unsafe content is counted for estimates but not copied into model-facing fields."]
  };
}

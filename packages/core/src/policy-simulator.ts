import { createId } from "./ids.js";
import { buildContextWasteDelta } from "./context-impact.js";
import type { StableId } from "./ids.js";
import { scoreBlastRadius } from "./side-effects.js";
import type { CoreSession } from "./session.js";
import type {
  BlastRadiusResult,
  EvidenceLink,
  JsonValue,
  PolicyPreviewDecision,
  PolicySimulationResult,
  ProposedPolicy,
  RecordedPolicyScenarioId
} from "./types.js";

export interface PolicySimulationInput {
  readonly session: CoreSession;
  readonly scenarioId: RecordedPolicyScenarioId;
  readonly proposedPolicy?: ProposedPolicy;
  readonly sideEffectObserver?: (effect: string) => void;
}

interface RecordedScenario {
  readonly scenarioId: RecordedPolicyScenarioId;
  readonly scenarioName: string;
  readonly baselineDecisions: readonly PolicyPreviewDecision[];
  readonly proposedDecisions: (policy: ProposedPolicy) => readonly PolicyPreviewDecision[];
  readonly before: BlastRadiusResult;
  readonly after: (policy: ProposedPolicy) => BlastRadiusResult;
  readonly explanation: (policy: ProposedPolicy) => string;
}

export const RECORDED_POLICY_SCENARIOS: readonly RecordedScenario[] = [
  {
    scenarioId: "safe-success",
    scenarioName: "Safe success",
    baselineDecisions: ["allow"],
    proposedDecisions: () => ["allow", "close circuit"],
    before: scoreBlastRadius({
      targetType: "mcp-tool",
      effectState: "completed",
      reversibility: "reversible",
      destructiveRisk: "none"
    }),
    after: () =>
      scoreBlastRadius({
        targetType: "mcp-tool",
        effectState: "completed",
        reversibility: "reversible",
        destructiveRisk: "none"
      }),
    explanation: () =>
      "The proposed policy would keep the safe recorded call allowed and would close a previously open circuit after a healthy dry-run recovery signal."
  },
  {
    scenarioId: "blocked-destructive",
    scenarioName: "Blocked destructive fixture",
    baselineDecisions: ["allow"],
    proposedDecisions: (policy) => (policy.destructiveAction === "allow-fixture-only" ? ["allow"] : ["block"]),
    before: scoreBlastRadius({
      targetType: "filesystem",
      effectState: "planned",
      reversibility: "irreversible-risk",
      destructiveRisk: "high"
    }),
    after: (policy) => {
      const input = {
        targetType: "filesystem",
        effectState: policy.destructiveAction === "allow-fixture-only" ? "simulated" : "blocked",
        reversibility: policy.destructiveAction === "allow-fixture-only" ? "fixture-only" : "irreversible-risk",
        destructiveRisk: "high"
      } as const;
      return policy.destructiveAction === "allow-fixture-only"
        ? scoreBlastRadius(input)
        : scoreBlastRadius({ ...input, failureType: "destructive_action_blocked" });
    },
    explanation: (policy) =>
      policy.destructiveAction === "allow-fixture-only"
        ? "The proposed policy would permit only fixture-marked destructive simulations and would still avoid real workspace mutation."
        : "The proposed policy would change the recorded destructive run from allowed risk to a pre-execution block, reducing blast radius before downstream execution."
  },
  {
    scenarioId: "retry-loop-failure",
    scenarioName: "Retry-loop failure",
    baselineDecisions: ["retry", "retry", "open circuit"],
    proposedDecisions: (policy) =>
      (policy.retryLimit ?? 1) <= 0 ? ["fail-fast", "open circuit"] : ["retry", "fail-fast", "open circuit"],
    before: scoreBlastRadius({
      targetType: "process",
      effectState: "unknown",
      reversibility: "manual-review",
      destructiveRisk: "medium",
      failureType: "process_crash"
    }),
    after: (policy) =>
      scoreBlastRadius({
        targetType: "process",
        effectState: "blocked",
        reversibility: "manual-review",
        destructiveRisk: "medium",
        failureType: (policy.retryLimit ?? 1) <= 0 ? "circuit_open" : "policy_blocked"
      }),
    explanation: (policy) =>
      (policy.retryLimit ?? 1) <= 0
        ? "The proposed policy would fail fast instead of replaying the same failing call, then keep the scoped circuit open for containment."
        : "The proposed policy would permit a bounded recovery retry, then fail fast and open the circuit when the retry-loop threshold is reached."
  }
];

export async function simulatePolicy(input: PolicySimulationInput): Promise<PolicySimulationResult> {
  const scenario = RECORDED_POLICY_SCENARIOS.find((candidate) => candidate.scenarioId === input.scenarioId);
  if (!scenario) {
    throw new Error(`Unknown policy simulation scenario: ${input.scenarioId}`);
  }

  const proposedPolicy = normalizeProposedPolicy(input.proposedPolicy);
  const before = scenario.before;
  const after = scenario.after(proposedPolicy);
  const simulationId = createId("simulation");
  const resultWithoutLinks = {
    simulationId,
    runId: input.session.runId,
    scenarioId: scenario.scenarioId,
    scenarioName: scenario.scenarioName,
    generatedAt: new Date().toISOString(),
    proposedPolicy,
    previewDecisions: uniqueDecisions([...scenario.baselineDecisions, ...scenario.proposedDecisions(proposedPolicy)]),
    blastRadius: {
      before,
      after,
      delta: after.score - before.score
    },
    contextDelta: buildContextWasteDelta({
      beforeContent: scenarioContextSummary(scenario, proposedPolicy, "before"),
      afterContent: scenarioContextSummary(scenario, proposedPolicy, "after"),
      notes: ["Negative deltas mean the proposed policy would reduce model-facing context."]
    }),
    explanation: scenario.explanation(proposedPolicy),
    dryRun: {
      downstreamExecuted: false,
      sideEffectsExecuted: false,
      replayedFromRecordedScenario: true,
      evidenceOnly: true
    }
  } satisfies Omit<PolicySimulationResult, "evidenceLinks">;

  const artifact = await input.session.recordRawArtifact(makeArtifactContext(input.session.runId), {
    kind: "policy-simulation",
    fileName: `policy-simulation-${scenario.scenarioId}-${simulationId}.json`,
    content: resultWithoutLinks as unknown as JsonValue,
    redacted: true
  });
  const evidenceLinks: EvidenceLink[] = [
    {
      artifactId: artifact.artifactId,
      href: artifact.relativePath,
      label: `Policy simulation receipt for ${scenario.scenarioName}`
    }
  ];
  const result: PolicySimulationResult = { ...resultWithoutLinks, evidenceLinks };
  await input.session.emitPolicySimulated(result);
  return result;
}

function scenarioContextSummary(
  scenario: RecordedScenario,
  policy: ProposedPolicy,
  phase: "before" | "after"
): string {
  const decisions = phase === "before" ? scenario.baselineDecisions : scenario.proposedDecisions(policy);
  const repeat = scenario.scenarioId === "retry-loop-failure" && phase === "before" ? 3 : decisions.length;
  const unit = `${scenario.scenarioName}: ${decisions.join(", ")}. ${scenario.explanation(policy)}`;
  return Array.from({ length: Math.max(1, repeat) }, () => unit).join("\n");
}

function normalizeProposedPolicy(policy: ProposedPolicy | undefined): ProposedPolicy {
  return {
    retryLimit: clampInteger(policy?.retryLimit, 1, 0, 5),
    circuitFailureThreshold: clampInteger(policy?.circuitFailureThreshold, 2, 1, 10),
    destructiveAction: policy?.destructiveAction ?? "block",
    timeoutMs: clampInteger(policy?.timeoutMs, 1000, 1, 60_000)
  };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function uniqueDecisions(decisions: readonly PolicyPreviewDecision[]): readonly PolicyPreviewDecision[] {
  return [...new Set(decisions)];
}

function makeArtifactContext(runId: StableId) {
  return {
    runId,
    traceId: createId("trace"),
    toolCallId: createId("toolcall"),
    harnessId: createId("harness"),
    adapterId: createId("adapter"),
    downstreamServerId: createId("server"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName: "policy.simulator",
    arguments: {},
    idempotency: "idempotent" as const,
    sourcePath: "non-mcp-direct" as const
  };
}

import { createHash } from "node:crypto";
import type {
  BlastRadiusFactor,
  BlastRadiusLabel,
  BlastRadiusResult,
  FailureCard,
  FailureType,
  JsonObject,
  RegisteredTool,
  RecordedRouteConfig,
  RetryLoopFinding,
  SideEffectLedgerEntry,
  SideEffectReversibility,
  SideEffectState,
  SideEffectTargetType,
  ToolCall,
  ToolProtocol
} from "./types.js";

export function labelBlastRadius(score: number): BlastRadiusLabel {
  if (score >= 75) return "system-risk";
  if (score >= 50) return "workspace-risk";
  if (score >= 25) return "limited";
  return "contained";
}

export function scoreBlastRadius(input: {
  readonly targetType: SideEffectTargetType;
  readonly effectState: SideEffectState;
  readonly reversibility: SideEffectReversibility;
  readonly destructiveRisk: RegisteredTool["destructiveRisk"];
  readonly failureType?: FailureType | undefined;
}): BlastRadiusResult {
  const factors: BlastRadiusFactor[] = [];
  const add = (name: string, score: number, explanation: string): void => {
    factors.push({ name, score, explanation });
  };

  const targetScore: Record<SideEffectTargetType, number> = {
    filesystem: 35,
    process: 25,
    git: 45,
    "network-loopback": 30,
    "mcp-tool": 25,
    "python-framework-tool": 25,
    "report-artifact": 20,
    "ui-action": 20
  };
  add("target-type", targetScore[input.targetType], `Target classified as ${input.targetType}.`);

  const stateScore: Record<SideEffectState, number> = {
    none: 0,
    planned: 10,
    blocked: 0,
    simulated: 5,
    completed: 25,
    partial: 35,
    unknown: 20
  };
  add("effect-state", stateScore[input.effectState], `Effect state classified as ${input.effectState}.`);

  const reversibilityScore: Record<SideEffectReversibility, number> = {
    reversible: 0,
    "fixture-only": 0,
    "manual-review": 20,
    "irreversible-risk": 35
  };
  add(
    "reversibility",
    reversibilityScore[input.reversibility],
    `Reversibility classified as ${input.reversibility}.`
  );

  const riskScore: Record<RegisteredTool["destructiveRisk"], number> = {
    none: 0,
    low: 5,
    medium: 15,
    high: 30
  };
  add("destructive-risk", riskScore[input.destructiveRisk], `Tool destructive risk is ${input.destructiveRisk}.`);

  if (input.failureType === "destructive_action_blocked" || input.failureType === "policy_blocked") {
    add("policy-containment", -15, "Policy blocked the side effect before downstream execution.");
  }
  if (input.failureType === "circuit_open") {
    add("circuit-containment", -10, "Circuit breaker fast-failed before downstream execution.");
  }

  const score = Math.max(0, Math.min(100, factors.reduce((sum, factor) => sum + factor.score, 0)));
  return {
    score,
    label: labelBlastRadius(score),
    factors: factors.filter((factor) => factor.score !== 0).sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
  };
}

export function inferSideEffect(input: {
  readonly tool?: RegisteredTool | undefined;
  readonly call: ToolCall;
  readonly failureType?: FailureType | undefined;
  readonly outcome: "completed" | "failed" | "blocked" | "retry";
}): {
  readonly targetType: SideEffectTargetType;
  readonly effectState: SideEffectState;
  readonly reversibility: SideEffectReversibility;
  readonly operation: SideEffectLedgerEntry["operation"];
  readonly summary: string;
  readonly destructiveRisk: RegisteredTool["destructiveRisk"];
} {
  const destructiveRisk = input.tool?.destructiveRisk ?? "none";
  const targetType = inferTargetType(input.tool?.protocol, destructiveRisk, input.call);
  const fixtureOnly = input.call.arguments.fixtureOnly === true;
  const reversibility: SideEffectReversibility =
    destructiveRisk === "high" && !fixtureOnly
      ? "irreversible-risk"
      : fixtureOnly
        ? "fixture-only"
        : destructiveRisk === "medium"
          ? "manual-review"
          : "reversible";

  if (input.outcome === "retry") {
    return {
      targetType,
      effectState: "planned",
      reversibility,
      operation: "retry-planned",
      summary: `Retry planned for ${input.call.toolName}; no new downstream side effect has completed yet.`,
      destructiveRisk
    };
  }

  if (
    input.outcome === "blocked" ||
    input.failureType === "destructive_action_blocked" ||
    input.failureType === "policy_blocked" ||
    input.failureType === "circuit_open"
  ) {
    return {
      targetType,
      effectState: "blocked",
      reversibility,
      operation: "call-blocked",
      summary: `Side effect blocked before execution for ${input.call.toolName}.`,
      destructiveRisk
    };
  }

  if (input.outcome === "completed") {
    return {
      targetType,
      effectState: fixtureOnly && destructiveRisk !== "none" ? "simulated" : "completed",
      reversibility,
      operation: "call-completed",
      summary:
        fixtureOnly && destructiveRisk !== "none"
          ? `Fixture-only side effect simulated for ${input.call.toolName}.`
          : `Call completed for ${input.call.toolName}; side effect classified as ${targetType}.`,
      destructiveRisk
    };
  }

  return {
    targetType,
    effectState: input.failureType === "timeout" || input.failureType === "cancellation" ? "unknown" : "none",
    reversibility,
    operation: "call-failed",
    summary: `Call failed for ${input.call.toolName}; side effect state is ${input.failureType === "timeout" ? "unknown" : "none"}.`,
    destructiveRisk
  };
}

export function buildRecordedRouteConfig(input: {
  readonly tool?: RegisteredTool | undefined;
  readonly call: ToolCall;
}): RecordedRouteConfig {
  const metadata = input.tool?.routeMetadata ?? input.call.routeMetadata;
  const adapterConfigHash = metadata?.adapterConfigHash ?? metadata?.configHash;
  return {
    routeType: nonEmpty(metadata?.routeType) ?? input.call.sourcePath,
    routeId: nonEmpty(metadata?.routeId) ?? `${input.call.adapterId}:${input.call.downstreamServerId}:${input.call.toolName}`,
    downstreamTargetIdentity:
      nonEmpty(metadata?.downstreamTargetIdentity) ?? `${input.call.downstreamServerId}:${input.call.originalToolName ?? input.call.toolName}`,
    ...(metadata?.endpoint ? { endpoint: metadata.endpoint } : {}),
    ...(metadata?.transport ? { transport: metadata.transport } : {}),
    toolRoute: {
      toolName: input.call.toolName,
      originalToolName: input.call.originalToolName ?? input.call.toolName,
      protocol: input.tool?.protocol ?? "in-process",
      sourcePath: input.call.sourcePath,
      ...(metadata?.toolRoute ?? {})
    },
    ...(adapterConfigHash ? { adapterConfigHash } : {}),
    ...(metadata?.loopbackEndpoint ? { loopbackEndpoint: metadata.loopbackEndpoint } : {})
  };
}

export function buildCallFingerprint(call: ToolCall, failureType?: FailureType): string {
  const stable = stableStringify(call.arguments);
  return createHash("sha256")
    .update(`${call.downstreamServerId}:${call.toolName}:${stable}:${failureType ?? "unknown"}`)
    .digest("hex");
}

export function classifyRetryLoop(input: {
  readonly fingerprint: string;
  readonly repeatedFailures: number;
  readonly scheduledRetry: boolean;
  readonly threshold?: number;
}): RetryLoopFinding {
  const threshold = input.threshold ?? 3;
  const classification =
    input.repeatedFailures >= threshold ? "loop-detected" : input.scheduledRetry ? "recovery-retry" : "none";
  const explanation =
    classification === "loop-detected"
      ? `Repeated same-tool and same-arguments failures reached ${input.repeatedFailures}; stop repeating the identical call and change recovery strategy.`
      : classification === "recovery-retry"
        ? "A bounded recovery retry is planned for the same fingerprint, but the retry-loop threshold has not been reached."
        : "No retry loop detected for this call fingerprint.";
  return { fingerprint: input.fingerprint, repeatedFailures: input.repeatedFailures, classification, explanation };
}

export function sideEffectSummary(entry: SideEffectLedgerEntry): string {
  return `${entry.effectState} ${entry.targetType} side effect, ${entry.reversibility}, blast radius ${entry.blastRadius.score} (${entry.blastRadius.label}).`;
}

export function mergeFailureIntelligence(
  failure: FailureCard,
  entry: SideEffectLedgerEntry,
  retryLoopFinding?: RetryLoopFinding
): FailureCard {
  return {
    ...failure,
    sideEffectSummary: sideEffectSummary(entry),
    ...(retryLoopFinding ? { retryLoopFinding } : {}),
    blastRadiusScore: entry.blastRadius.score,
    blastRadiusLabel: entry.blastRadius.label,
    blastRadiusFactors: entry.blastRadius.factors,
    rawDetailsSeparated: true
  };
}

function inferTargetType(
  protocol: ToolProtocol | undefined,
  destructiveRisk: RegisteredTool["destructiveRisk"],
  call: ToolCall
): SideEffectTargetType {
  const toolName = call.toolName.toLowerCase();
  const originalToolName = call.originalToolName?.toLowerCase() ?? "";
  const downstreamServerId = call.downstreamServerId.toLowerCase();
  const nameParts = [toolName, originalToolName, downstreamServerId];

  if (isReportArtifactTarget(nameParts)) return "report-artifact";
  if (isGitTarget(nameParts)) return "git";
  if (call.sourcePath === "framework-adapter") return "python-framework-tool";
  if (call.sourcePath === "cli-wrapper") return "process";
  if (destructiveRisk === "high") return "filesystem";
  if (protocol === "process") return "process";
  if (protocol === "http") return "network-loopback";
  if (protocol === "mcp") return "mcp-tool";
  if (protocol === "browser") return "ui-action";
  if (protocol === "fixture") return "filesystem";
  return "process";
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function isGitTarget(parts: readonly string[]): boolean {
  return parts.some((part) => part === "git" || part.startsWith("git.") || part.includes("/git/") || part.includes(" git "));
}

function isReportArtifactTarget(parts: readonly string[]): boolean {
  return parts.some(
    (part) =>
      part === "report" ||
      part.startsWith("report.") ||
      part.includes("report-artifact") ||
      part.includes("artifact") ||
      part.includes("manifest")
  );
}

function stableStringify(value: JsonObject): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

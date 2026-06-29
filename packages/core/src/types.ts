import type { StableId } from "./ids.js";

export type HarnessKind = "direct" | "mcp" | "python-framework" | "cli" | "ui" | "test";
export type AdapterKind = "direct" | "mcp" | "python-framework" | "cli" | "http";
export type ToolProtocol = "in-process" | "process" | "http" | "mcp" | "browser" | "fixture";

export interface HarnessDescriptor {
  readonly harnessId: StableId;
  readonly kind: HarnessKind;
  readonly name: string;
  readonly version?: string;
}

export interface AdapterDescriptor {
  readonly adapterId: StableId;
  readonly kind: AdapterKind;
  readonly name: string;
  readonly version?: string;
}

export type JsonSchemaType = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonSchema {
  readonly type?: JsonSchemaType;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly additionalProperties?: boolean;
}

export interface ToolDefinition {
  readonly toolName: string;
  readonly title: string;
  readonly description: string;
  readonly protocol: ToolProtocol;
  readonly downstreamServerId: StableId;
  readonly inputSchema: JsonSchema;
  readonly destructiveRisk: "none" | "low" | "medium" | "high";
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly call: ToolCall;
}

export interface RegisteredTool extends ToolDefinition {
  readonly inputSchema: JsonSchema;
  readonly execute: (context: ToolExecutionContext) => Promise<JsonValue> | JsonValue;
  readonly preflight?: () => Promise<PreflightProbeResult> | PreflightProbeResult;
}

export interface PreflightProbeResult {
  readonly status: "healthy" | "degraded" | "failed";
  readonly summary: string;
  readonly remediation?: string;
}

export interface PreflightFinding extends PreflightProbeResult {
  readonly downstreamServerId: StableId;
  readonly toolName: string;
}

export interface ToolCall {
  readonly runId: StableId;
  readonly traceId: StableId;
  readonly parentId?: StableId;
  readonly harnessId: StableId;
  readonly adapterId: StableId;
  readonly downstreamServerId: StableId;
  readonly toolCallId: StableId;
  readonly attemptId: StableId;
  readonly policyDecisionId: StableId;
  readonly toolName: string;
  readonly originalToolName?: string;
  readonly arguments: JsonObject;
  readonly deadlineMs?: number;
  readonly idempotency: "idempotent" | "non-idempotent" | "unknown";
  readonly sourcePath: "non-mcp-direct" | "mcp-adapter" | "framework-adapter" | "cli-wrapper";
}

export interface ToolResult {
  readonly toolName: string;
  readonly output: JsonValue;
  readonly safeSummary: string;
  readonly artifactIds: readonly StableId[];
}

export type FailureType =
  | "unknown_tool"
  | "invalid_arguments"
  | "timeout"
  | "cancellation"
  | "cwd_mismatch"
  | "malformed_json"
  | "process_crash"
  | "non_zero_exit"
  | "spawn_failure"
  | "output_limit_exceeded"
  | "prompt_injection_output"
  | "secret_leak_risk"
  | "destructive_action_blocked"
  | "circuit_open"
  | "policy_blocked"
  | "sidecar_unavailable"
  | "sidecar_protocol_error"
  | "unknown";

export interface FailureCard {
  readonly toolName: string;
  readonly failureType: FailureType;
  readonly likelyRootCause: string;
  readonly retryable: boolean;
  readonly doNotRetrySameCall: boolean;
  readonly safeRecoveryOptions: readonly string[];
  readonly humanFix?: string;
  readonly evidenceLinks: readonly EvidenceLink[];
  readonly safeSummary: string;
  readonly sideEffectSummary?: string;
  readonly retryLoopFinding?: RetryLoopFinding;
  readonly blastRadiusScore?: number;
  readonly blastRadiusLabel?: BlastRadiusLabel;
  readonly blastRadiusFactors?: readonly BlastRadiusFactor[];
  readonly rawDetailsSeparated: true;
}

export interface EvidenceArtifact {
  readonly artifactId: StableId;
  readonly runId: StableId;
  readonly traceId: StableId;
  readonly toolCallId?: StableId;
  readonly kind: "raw-stdout" | "raw-stderr" | "raw-result" | "safe-summary" | "report";
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly redacted: boolean;
}

export interface EvidenceLink {
  readonly artifactId: StableId;
  readonly href: string;
  readonly label: string;
}

export interface PolicyDecision {
  readonly policyDecisionId: StableId;
  readonly decision: "allow" | "block" | "retry" | "open-circuit" | "close-circuit" | "fail-fast";
  readonly reason: string;
  readonly retryable: boolean;
}

export type SideEffectState = "none" | "planned" | "blocked" | "simulated" | "completed" | "partial" | "unknown";
export type SideEffectReversibility = "reversible" | "fixture-only" | "manual-review" | "irreversible-risk";
export type SideEffectTargetType =
  | "none"
  | "fixture"
  | "workspace"
  | "filesystem"
  | "process"
  | "network"
  | "mcp-server"
  | "browser"
  | "system"
  | "unknown";

export type BlastRadiusLabel = "contained" | "limited" | "workspace-risk" | "system-risk";

export interface BlastRadiusFactor {
  readonly name: string;
  readonly score: number;
  readonly explanation: string;
}

export interface BlastRadiusResult {
  readonly score: number;
  readonly label: BlastRadiusLabel;
  readonly factors: readonly BlastRadiusFactor[];
}

export interface RetryLoopFinding {
  readonly fingerprint: string;
  readonly repeatedFailures: number;
  readonly classification: "none" | "recovery-retry" | "loop-detected";
  readonly explanation: string;
}

export interface SideEffectLedgerEntry {
  readonly ledgerId: StableId;
  readonly recordedAt: string;
  readonly runId: StableId;
  readonly traceId: StableId;
  readonly parentId?: StableId;
  readonly harnessId: StableId;
  readonly adapterId: StableId;
  readonly downstreamServerId: StableId;
  readonly toolCallId: StableId;
  readonly attemptId: StableId;
  readonly policyDecisionId: StableId;
  readonly artifactIds: readonly StableId[];
  readonly toolName: string;
  readonly targetType: SideEffectTargetType;
  readonly effectState: SideEffectState;
  readonly reversibility: SideEffectReversibility;
  readonly operation: "call-completed" | "call-failed" | "call-blocked" | "retry-planned";
  readonly summary: string;
  readonly blastRadius: BlastRadiusResult;
  readonly retryLoopFinding?: RetryLoopFinding;
}

export interface TraceSummary {
  readonly runId: StableId;
  readonly traceId: StableId;
  readonly parentId?: StableId;
  readonly harnessId: StableId;
  readonly adapterId: StableId;
  readonly downstreamServerId: StableId;
  readonly toolCallIds: readonly StableId[];
  readonly artifactIds: readonly StableId[];
}

export interface ReportManifest {
  readonly reportId: StableId;
  readonly runId: StableId;
  readonly generatedAt: string;
  readonly eventFile: string;
  readonly reportFile: string;
  readonly artifactHashFile: string;
  readonly redactionSummaryFile: string;
  readonly ledgerFile?: string;
  readonly ledgerSha256?: string;
  readonly artifacts: readonly EvidenceArtifact[];
  readonly redactionSummary: {
    readonly redactionCount: number;
    readonly reasons: readonly string[];
  };
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

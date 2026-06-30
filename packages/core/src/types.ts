import type { StableId } from "./ids.js";

export type HarnessKind = "direct" | "mcp" | "python-framework" | "cli" | "ui" | "test";
export type AdapterKind = "direct" | "mcp" | "python-framework" | "cli" | "http";
export type ToolProtocol = "in-process" | "process" | "http" | "mcp" | "browser" | "fixture";

export interface LoopbackEndpointMetadata {
  readonly protocol: "http" | "https";
  readonly host: string;
  readonly port: number;
  readonly routeId?: string;
  readonly toolName?: string;
  readonly verificationStatus: "verified" | "unverified" | "failed";
  readonly verified: boolean;
}

export interface ToolRouteMetadata {
  readonly workspaceRoot?: string;
  readonly sandboxRoot?: string;
  readonly routeType?: string;
  readonly routeId?: string;
  readonly downstreamTargetIdentity?: string;
  readonly endpoint?: {
    readonly protocol?: string;
    readonly host?: string;
    readonly port?: number;
    readonly path?: string;
  };
  readonly transport?: {
    readonly kind?: string;
    readonly command?: string;
    readonly url?: string;
  };
  readonly toolRoute?: Readonly<Record<string, JsonValue>>;
  readonly adapterConfigHash?: string;
  readonly configHash?: string;
  readonly loopbackEndpoint?: LoopbackEndpointMetadata;
}

export interface RecordedRouteConfig {
  readonly routeType: string;
  readonly routeId: string;
  readonly downstreamTargetIdentity: string;
  readonly endpoint?: ToolRouteMetadata["endpoint"];
  readonly transport?: ToolRouteMetadata["transport"];
  readonly toolRoute: Readonly<Record<string, JsonValue>>;
  readonly adapterConfigHash?: string;
  readonly loopbackEndpoint?: LoopbackEndpointMetadata;
}

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
  readonly routeMetadata?: ToolRouteMetadata;
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
  readonly harnessName?: string;
  readonly adapterId: StableId;
  readonly adapterName?: string;
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
  readonly runName?: string;
  readonly tags?: readonly string[];
  readonly labels?: {
    readonly session?: string;
    readonly task?: string;
    readonly repo?: string;
    readonly agent?: string;
  };
  readonly routeMetadata?: ToolRouteMetadata;
}

export interface ToolResult {
  readonly toolName: string;
  readonly output: JsonValue;
  readonly safeSummary: string;
  readonly artifactIds: readonly StableId[];
  readonly contextImpact: ContextImpactMetrics;
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
  readonly failureCause: DiagnosticFailureCause;
  readonly failureBoundary: DiagnosticFailureBoundary;
  readonly failureMechanism: string;
  readonly rootCauseConfidence: RootCauseConfidence;
  readonly contributingFactors: readonly string[];
  readonly evidenceAnchors: readonly DiagnosticEvidenceAnchor[];
  readonly diagnosticHypotheses: readonly DiagnosticHypothesis[];
  readonly retryable: boolean;
  readonly doNotRetrySameCall: boolean;
  readonly safeRecoveryOptions: readonly string[];
  readonly humanFix?: string;
  readonly evidenceLinks: readonly EvidenceLink[];
  readonly safeSummary: string;
  readonly contextImpact: ContextImpactMetrics;
  readonly sideEffectSummary?: string;
  readonly retryLoopFinding?: RetryLoopFinding;
  readonly blastRadiusScore?: number;
  readonly blastRadiusLabel?: BlastRadiusLabel;
  readonly blastRadiusFactors?: readonly BlastRadiusFactor[];
  readonly rawDetailsSeparated: true;
}

export type DiagnosticFailureCause =
  | "missing-binary"
  | "wrong-cwd"
  | "permission-denied-temp"
  | "schema-mismatch"
  | "protocol-parse-failure"
  | "caller-deadline-timeout"
  | "downstream-hang-timeout"
  | "caller-cancellation"
  | "policy-block"
  | "circuit-open"
  | "suspicious-output"
  | "secret-leak-risk"
  | "process-exit"
  | "process-crash"
  | "sidecar-unavailable"
  | "sidecar-protocol"
  | "output-budget"
  | "unknown";

export type DiagnosticFailureBoundary =
  | "caller"
  | "adapter"
  | "core"
  | "policy"
  | "environment"
  | "downstream"
  | "protocol"
  | "safety"
  | "unknown";

export type RootCauseConfidence = "high" | "medium" | "low";

export interface DiagnosticEvidenceAnchor {
  readonly anchorId: StableId;
  readonly evidenceType:
    | "command-resolution"
    | "cwd-fact"
    | "package-context"
    | "permission-fact"
    | "schema-validation"
    | "parse-offset"
    | "protocol-frame"
    | "timeout-source"
    | "safe-environment"
    | "raw-artifact"
    | "policy-decision"
    | "stderr-anchor"
    | "stdout-anchor";
  readonly label: string;
  readonly summary: string;
  readonly confidenceContribution: RootCauseConfidence;
  readonly artifactId?: StableId;
  readonly href?: string;
  readonly path?: string;
}

export interface DiagnosticHypothesis {
  readonly rank: number;
  readonly cause: DiagnosticFailureCause;
  readonly boundary: DiagnosticFailureBoundary;
  readonly mechanism: string;
  readonly confidence: RootCauseConfidence;
  readonly evidenceAnchorIds: readonly StableId[];
}

export interface EvidenceArtifact {
  readonly artifactId: StableId;
  readonly runId: StableId;
  readonly traceId: StableId;
  readonly toolCallId?: StableId;
  readonly kind:
    | "raw-stdout"
    | "raw-stderr"
    | "raw-result"
    | "safe-summary"
    | "report"
    | "impact-summary"
    | "policy-simulation"
    | "verification-receipt";
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

export type PolicyPreviewDecision = "allow" | "block" | "retry" | "fail-fast" | "open circuit" | "close circuit";
export type RecordedPolicyScenarioId = "safe-success" | "blocked-destructive" | "retry-loop-failure" | "output-budget-flood";

export interface ProposedPolicy {
  readonly retryLimit?: number;
  readonly circuitFailureThreshold?: number;
  readonly destructiveAction?: "allow-fixture-only" | "block";
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
  readonly outputBudgetBytes?: number;
}

export interface PolicySimulationResult {
  readonly simulationId: StableId;
  readonly runId: StableId;
  readonly scenarioId: RecordedPolicyScenarioId;
  readonly scenarioName: string;
  readonly generatedAt: string;
  readonly proposedPolicy: ProposedPolicy;
  readonly previewDecisions: readonly PolicyPreviewDecision[];
  readonly blastRadius: {
    readonly before: BlastRadiusResult;
    readonly after: BlastRadiusResult;
    readonly delta: number;
  };
  readonly contextDelta: ContextWasteDelta;
  readonly explanation: string;
  readonly dryRun: {
    readonly downstreamExecuted: false;
    readonly sideEffectsExecuted: false;
    readonly replayedFromRecordedScenario: true;
    readonly evidenceOnly: true;
  };
  readonly evidenceLinks: readonly EvidenceLink[];
}

export type TriageSeverity = "low" | "medium" | "high" | "critical";
export type TriageState = "new" | "grouped" | "ready-to-file" | "actioned";

export interface TriageQuestionAnswer {
  readonly question: "what failed" | "why" | "impact" | "waste" | "next safe action";
  readonly answer: string;
  readonly evidence: readonly EvidenceLink[];
}

export interface TriageFailureGroup {
  readonly fingerprint: string;
  readonly count: number;
  readonly lastOccurrence: string;
  readonly severity: TriageSeverity;
  readonly state: TriageState;
  readonly toolName: string;
  readonly failureType: FailureType;
  readonly title: string;
  readonly summary: string;
  readonly answers: readonly TriageQuestionAnswer[];
  readonly nextSafeActions: readonly string[];
  readonly topologyLinks: readonly EvidenceLink[];
  readonly timelineLinks: readonly EvidenceLink[];
  readonly evidenceLinks: readonly EvidenceLink[];
  readonly rawArtifactLabels: readonly string[];
  readonly issuePacketPreview: string;
  readonly factors: readonly string[];
}

export interface TriagePayload {
  readonly runId: StableId;
  readonly generatedAt: string;
  readonly groups: readonly TriageFailureGroup[];
  readonly summary: {
    readonly groups: number;
    readonly failures: number;
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
  };
  readonly states: readonly TriageState[];
  readonly links: {
    readonly topology: EvidenceLink;
    readonly timeline: EvidenceLink;
    readonly evidenceBundle: EvidenceLink;
  };
}

export interface IssuePacketExport {
  readonly runId: StableId;
  readonly generatedAt: string;
  readonly issuePacketPath: string;
  readonly issuePacketUrl: string;
  readonly markdown: string;
  readonly noSecretFindings: readonly string[];
  readonly containedLinks: true;
  readonly groups: readonly string[];
}

export type TokenEstimateMethod = "heuristic-chars-div-4" | "provider-reported" | "local-tokenizer";
export type TokenEstimateConfidence = "high" | "medium" | "low";

export interface ContextSizeEstimate {
  readonly bytes: number;
  readonly chars: number;
  readonly estimatedTokens: number;
}

export interface ContextTokenEstimate {
  readonly estimatedTokens: number;
  readonly method: TokenEstimateMethod;
  readonly provenance: string;
  readonly confidence: TokenEstimateConfidence;
}

export interface ContextSavings {
  readonly bytes: number;
  readonly chars: number;
  readonly estimatedTokens: number;
}

export interface DuplicateRetryContext {
  readonly fingerprint: string;
  readonly repeatedFingerprintCount: number;
  readonly estimatedDuplicateBytes: number;
  readonly estimatedDuplicateChars: number;
  readonly estimatedDuplicateTokens: number;
}

export interface RetryAmplificationMetrics {
  readonly attemptCount: number;
  readonly contextMultiplier: number;
  readonly estimatedAmplifiedBytes: number;
  readonly estimatedAmplifiedTokens: number;
}

export interface ContextImpactMetrics {
  readonly modelFacingContent: ContextSizeEstimate;
  readonly rawContentEstimate: ContextSizeEstimate;
  readonly safeDisplayedEstimate: ContextSizeEstimate;
  readonly tokenEstimate: ContextTokenEstimate;
  readonly preventedContextFlood: {
    readonly rawEstimate: ContextSizeEstimate;
    readonly safeDisplayedEstimate: ContextSizeEstimate;
    readonly saved: ContextSavings;
  };
  readonly redactionSavings: ContextSavings;
  readonly truncationSavings: ContextSavings;
  readonly duplicateRetryContext: DuplicateRetryContext;
  readonly retryAmplification: RetryAmplificationMetrics;
  readonly notes: readonly string[];
}

export interface ContextWasteDelta {
  readonly before: ContextSizeEstimate;
  readonly after: ContextSizeEstimate;
  readonly delta: ContextSavings;
  readonly estimation: ContextTokenEstimate;
  readonly notes: readonly string[];
}

export type IntegrationRouteType = "mcp-routed" | "sdk-wrapped-python" | "cli-supervised";
export type IntegrationProbeStatus = "configured" | "available" | "unsupported" | "not-yet-verified";
export type IntegrationRouteCoverageState =
  | "configured"
  | "available"
  | "unsupported"
  | "not-verified"
  | "producing-evidence";

export interface IntegrationCapabilityCheck {
  readonly capability: string;
  readonly status: IntegrationProbeStatus;
  readonly localOnly: true;
  readonly evidence: string;
}

export interface IntegrationRouteCoverageEntry {
  readonly state: IntegrationRouteCoverageState;
  readonly label: string;
  readonly localOnly: true;
  readonly evidence: string;
}

export interface IntegrationVerificationReceipt {
  readonly receiptId: StableId;
  readonly runId: StableId;
  readonly timestamp: string;
  readonly routeType: IntegrationRouteType;
  readonly checkedCapabilities: readonly IntegrationCapabilityCheck[];
  readonly routeCoverage: readonly IntegrationRouteCoverageEntry[];
  readonly limitation: string;
  readonly evidenceLinks: readonly EvidenceLink[];
}

export type SideEffectState = "none" | "planned" | "blocked" | "simulated" | "completed" | "partial" | "unknown";
export type SideEffectReversibility = "reversible" | "fixture-only" | "manual-review" | "irreversible-risk";
export type SideEffectTargetType =
  | "filesystem"
  | "process"
  | "git"
  | "network-loopback"
  | "mcp-tool"
  | "python-framework-tool"
  | "report-artifact"
  | "ui-action";

export type ImpactAttributionLevel =
  | "observed-caused"
  | "observed-after"
  | "inferred-risk"
  | "blocked-before-execution"
  | "unknown";
export type ImpactEvidenceBasis =
  | "filesystem-diff"
  | "git-status-diff"
  | "process-lifecycle"
  | "policy-decision"
  | "postflight-no-mutation"
  | "timeout-no-postflight"
  | "artifact-write";

export interface FileMetadata {
  readonly type: "file" | "directory" | "other";
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly sha256?: string;
}

export interface ObservedFileChange {
  readonly path: string;
  readonly changeType: "created" | "modified" | "deleted";
  readonly before?: FileMetadata;
  readonly after?: FileMetadata;
}

export interface ObservedGitStatus {
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly changed: boolean;
}

export interface ObservedProcessLifecycle {
  readonly pid: number | null;
  readonly processGroupId: number | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly cleanupResult: "not-needed" | "terminated" | "force-killed" | "already-exited" | "unknown";
  readonly terminationSignals: readonly string[];
}

export interface ObservedLocalImpact {
  readonly workspaceRoot: string;
  readonly disposableWorkspace: boolean;
  readonly pathContainment: "contained" | "rejected";
  readonly gitStatus?: ObservedGitStatus;
  readonly fileChanges: readonly ObservedFileChange[];
  readonly tempArtifactWrites: readonly string[];
  readonly processLifecycle?: ObservedProcessLifecycle;
  readonly outcome: SideEffectState;
  readonly rollbackGuidance: readonly string[];
  readonly bundleHashes: readonly { readonly relativePath: string; readonly sha256: string; readonly byteLength: number }[];
}

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
  readonly attributionLevel: ImpactAttributionLevel;
  readonly evidenceBasis: readonly ImpactEvidenceBasis[];
  readonly causalClaim: string;
  readonly counterEvidence: readonly string[];
  readonly observedImpact?: ObservedLocalImpact;
  readonly routeConfig: RecordedRouteConfig;
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
  readonly contextEstimationNotes?: {
    readonly tokenEstimateMethod: TokenEstimateMethod;
    readonly provenance: string;
    readonly confidence: TokenEstimateConfidence;
    readonly notes: readonly string[];
  };
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

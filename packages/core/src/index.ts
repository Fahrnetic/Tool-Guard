export { PROJECT_NAME, PRODUCT_DISPLAY_NAME } from "./product.js";
export { createId, type StableId } from "./ids.js";
export { EventBus, type CoreEvent, type CoreEventType, type CorrelationFields } from "./events.js";
export { EvidenceRecorder, type EvidenceRecorderOptions } from "./evidence.js";
export { ToolRegistry, validateJsonSchema, type ArgumentValidationResult } from "./registry.js";
export { CoreSession, type CoreSessionOptions } from "./session.js";
export {
  SIDECAR_PROTOCOL_VERSION,
  createCoreApiServer,
  type CoreApiServerHandle,
  type CoreApiServerOptions
} from "./server.js";
export { exportStaticReport, validateReportManifest, type StaticReportResult, type ManifestValidationResult } from "./report.js";
export {
  redactJsonValue,
  redactJsonValueWithSummary,
  redactString,
  redactStringWithSummary,
  countRedactions,
  type JsonRedactionResult,
  type RedactionResult
} from "./redaction.js";
export {
  ClassifiedToolError,
  buildFailureCard,
  classifyFailure,
  detectSuspiciousOutput,
  getRawFailureDetails,
  type FailureClassification
} from "./classifier.js";
export { createChaosFixtures, registerChaosFixtures, type ChaosFixtureOptions } from "./chaos-fixtures.js";
export {
  buildCallFingerprint,
  classifyRetryLoop,
  inferSideEffect,
  labelBlastRadius,
  mergeFailureIntelligence,
  scoreBlastRadius,
  sideEffectSummary
} from "./side-effects.js";
export {
  buildRunNarrative,
  buildRunTopology,
  generateAndPersistNarrative,
  generateAndPersistTopology,
  type RunNarrative,
  type RunTopology,
  type TopologyEdge,
  type TopologyEdgeType,
  type TopologyNode,
  type TopologyNodeStatus,
  type TopologyNodeType
} from "./topology.js";
export { RECORDED_POLICY_SCENARIOS, simulatePolicy, type PolicySimulationInput } from "./policy-simulator.js";
export { verifyIntegrationRoute, type IntegrationVerificationInput } from "./integration-verification.js";
export type {
  AdapterDescriptor,
  AdapterKind,
  EvidenceArtifact,
  EvidenceLink,
  FailureCard,
  FailureType,
  BlastRadiusFactor,
  BlastRadiusLabel,
  BlastRadiusResult,
  HarnessDescriptor,
  HarnessKind,
  JsonSchema,
  JsonSchemaType,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  IntegrationCapabilityCheck,
  IntegrationProbeStatus,
  IntegrationRouteType,
  IntegrationVerificationReceipt,
  PreflightFinding,
  PreflightProbeResult,
  PolicyDecision,
  PolicyPreviewDecision,
  PolicySimulationResult,
  ProposedPolicy,
  RecordedPolicyScenarioId,
  RetryLoopFinding,
  RegisteredTool,
  ReportManifest,
  SideEffectLedgerEntry,
  SideEffectReversibility,
  SideEffectState,
  SideEffectTargetType,
  ToolCall,
  ToolExecutionContext,
  ToolDefinition,
  ToolProtocol,
  ToolResult,
  TraceSummary
} from "./types.js";

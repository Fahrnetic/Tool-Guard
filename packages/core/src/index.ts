export { PROJECT_NAME, PRODUCT_DISPLAY_NAME } from "./product.js";
export { createId, type StableId } from "./ids.js";
export { EventBus, type CoreEvent, type CoreEventType, type CorrelationFields } from "./events.js";
export { EvidenceRecorder, type EvidenceRecorderOptions } from "./evidence.js";
export { CoreSession, type CoreSessionOptions } from "./session.js";
export type {
  AdapterDescriptor,
  AdapterKind,
  EvidenceArtifact,
  EvidenceLink,
  FailureCard,
  FailureType,
  HarnessDescriptor,
  HarnessKind,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  PolicyDecision,
  ReportManifest,
  ToolCall,
  ToolDefinition,
  ToolProtocol,
  ToolResult,
  TraceSummary
} from "./types.js";

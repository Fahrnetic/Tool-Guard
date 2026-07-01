import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceRecorder } from "./evidence.js";
import type { CoreEvent, CoreEventType } from "./events.js";
import { createId, type StableId } from "./ids.js";
import { redactJsonValue, redactString } from "./redaction.js";
import type { JsonObject, JsonValue, VisibilityMetadata } from "./types.js";
import { CANONICAL_VISIBILITY_SCHEMA_VERSION, stableVisibilityJson } from "./visibility.js";

export interface VisibilityOtelExportInput {
  readonly events: readonly CoreEvent[];
  readonly outputPath?: string;
  readonly serviceName?: string;
  readonly exportedAt?: string;
}

export interface VisibilityOtelExportResult {
  readonly schemaVersion: typeof CANONICAL_VISIBILITY_SCHEMA_VERSION;
  readonly format: "opentelemetry-resource-spans-json";
  readonly requiresCredentials: false;
  readonly exportedAt: string;
  readonly spanCount: number;
  readonly outputPath?: string;
  readonly resourceSpans: readonly OTelResourceSpan[];
}

export interface OTelResourceSpan {
  readonly resource: { readonly attributes: readonly OTelAttribute[] };
  readonly scopeSpans: readonly [
    {
      readonly scope: { readonly name: "toolguard.visibility"; readonly version: typeof CANONICAL_VISIBILITY_SCHEMA_VERSION };
      readonly spans: readonly OTelSpan[];
    }
  ];
}

export interface OTelSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: 1;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly OTelAttribute[];
  readonly status: { readonly code: 0 | 1 | 2; readonly message?: string };
  readonly events?: readonly OTelSpanEvent[];
}

export interface OTelSpanEvent {
  readonly name: string;
  readonly timeUnixNano: string;
  readonly attributes: readonly OTelAttribute[];
}

export type OTelAttribute =
  | { readonly key: string; readonly value: { readonly stringValue: string } }
  | { readonly key: string; readonly value: { readonly boolValue: boolean } }
  | { readonly key: string; readonly value: { readonly intValue: string } };

export interface VisibilityImportInput {
  readonly jsonl?: string;
  readonly inputPath?: string;
  readonly recorder?: EvidenceRecorder;
  readonly sourceLabel?: string;
}

export interface VisibilityImportResult {
  readonly schemaVersion: typeof CANONICAL_VISIBILITY_SCHEMA_VERSION;
  readonly valid: boolean;
  readonly accepted: number;
  readonly rejected: number;
  readonly events: readonly CoreEvent[];
  readonly errors: readonly VisibilityImportValidationError[];
}

export interface VisibilityImportValidationError {
  readonly line: number;
  readonly code:
    | "missing_input"
    | "invalid_json"
    | "not_object"
    | "unsupported_schema_version"
    | "missing_required_field"
    | "invalid_event_type"
    | "invalid_visibility";
  readonly message: string;
}

const KNOWN_EVENT_TYPES: ReadonlySet<CoreEventType> = new Set([
  "run.started",
  "run.completed",
  "adapter.connected",
  "server.preflight.started",
  "server.preflight.completed",
  "policy.decision",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
  "tool.retry.scheduled",
  "side_effect.recorded",
  "blast_radius.scored",
  "retry_loop.detected",
  "circuit.opened",
  "circuit.closed",
  "output.sanitized",
  "evidence.artifact.created",
  "report.exported",
  "topology.generated",
  "narrative.generated",
  "policy.simulated",
  "integration.verified",
  "bundle.exported"
]);

const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[0-9a-f]$/;

export async function exportVisibilityOtel(input: VisibilityOtelExportInput): Promise<VisibilityOtelExportResult> {
  const spans = input.events.map(eventToSpan);
  const result: VisibilityOtelExportResult = {
    schemaVersion: CANONICAL_VISIBILITY_SCHEMA_VERSION,
    format: "opentelemetry-resource-spans-json",
    requiresCredentials: false,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    spanCount: spans.length,
    ...(input.outputPath ? { outputPath: input.outputPath } : {}),
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttribute("service.name", input.serviceName ?? "ToolGuard local visibility"),
            stringAttribute("toolguard.visibility.schema_version", CANONICAL_VISIBILITY_SCHEMA_VERSION),
            boolAttribute("toolguard.local_export", true),
            boolAttribute("toolguard.requires_credentials", false)
          ]
        },
        scopeSpans: [
          {
            scope: { name: "toolguard.visibility", version: CANONICAL_VISIBILITY_SCHEMA_VERSION },
            spans
          }
        ]
      }
    ]
  };
  if (input.outputPath) await writeFile(input.outputPath, stableVisibilityJson(result), "utf8");
  return result;
}

export async function importVisibilityEventsJsonl(input: VisibilityImportInput): Promise<VisibilityImportResult> {
  const jsonl = input.jsonl ?? (input.inputPath ? await readFile(input.inputPath, "utf8") : undefined);
  if (jsonl === undefined) {
    return {
      schemaVersion: CANONICAL_VISIBILITY_SCHEMA_VERSION,
      valid: false,
      accepted: 0,
      rejected: 1,
      events: [],
      errors: [{ line: 0, code: "missing_input", message: "JSONL import requires jsonl content or inputPath." }]
    };
  }

  const sourceLabel = redactString(input.sourceLabel ?? (input.inputPath ? path.basename(input.inputPath) : "jsonl"));
  const events: CoreEvent[] = [];
  const errors: VisibilityImportValidationError[] = [];
  const lines = jsonl.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]?.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push({ line: lineNumber, code: "invalid_json", message: `Line ${lineNumber} is not valid JSON.` });
      continue;
    }

    const validationError = validateImportedEventShape(parsed, lineNumber);
    if (validationError) {
      errors.push(validationError);
      continue;
    }

    const imported = normalizeImportedEvent(parsed as JsonObject, lineNumber, sourceLabel);
    events.push(imported);
    if (input.recorder) await input.recorder.appendEvent(imported);
  }

  return {
    schemaVersion: CANONICAL_VISIBILITY_SCHEMA_VERSION,
    valid: errors.length === 0,
    accepted: events.length,
    rejected: errors.length,
    events,
    errors
  };
}

function eventToSpan(event: CoreEvent): OTelSpan {
  const failureType = failureTypeForEvent(event);
  const evidenceArtifactId = evidenceArtifactIdForEvent(event);
  const attributes: OTelAttribute[] = [
    stringAttribute("toolguard.event.id", event.eventId),
    stringAttribute("toolguard.event.type", event.type),
    stringAttribute("toolguard.run.id", event.runId),
    stringAttribute("toolguard.trace.id", event.traceId),
    stringAttribute("toolguard.visibility.schema_version", event.schemaVersion ?? CANONICAL_VISIBILITY_SCHEMA_VERSION),
    stringAttribute("toolguard.summary", event.summary),
    intAttribute("toolguard.sequence", event.sequence)
  ];
  addOptionalString(attributes, "toolguard.parent.id", event.parentId);
  addOptionalString(attributes, "toolguard.harness.id", event.harnessId);
  addOptionalString(attributes, "toolguard.adapter.id", event.adapterId);
  addOptionalString(attributes, "toolguard.downstream_server.id", event.downstreamServerId);
  addOptionalString(attributes, "toolguard.tool_call.id", event.toolCallId);
  addOptionalString(attributes, "toolguard.attempt.id", event.attemptId);
  addOptionalString(attributes, "toolguard.policy_decision.id", event.policyDecisionId);
  addOptionalString(attributes, "toolguard.visibility.level", event.visibility?.visibilityLevel);
  addOptionalString(attributes, "toolguard.visibility.coverage_claim", event.visibility?.coverageClaim);
  addOptionalString(attributes, "toolguard.visibility.route_type", event.visibility?.routeType);
  addOptionalString(attributes, "toolguard.visibility.route_passport_id", event.visibility?.routePassportId);
  addOptionalString(attributes, "toolguard.visibility.traceparent", event.visibility?.traceContext.traceparent);
  if (failureType) addOptionalString(attributes, "toolguard.failure.type", failureType);
  if (evidenceArtifactId) addOptionalString(attributes, "toolguard.evidence.artifact_id", evidenceArtifactId);

  const unixNanos = toUnixNano(event.occurredAt);
  return {
    traceId: otelTraceId(event),
    spanId: hashHex(event.eventId, 16),
    ...(event.parentId ? { parentSpanId: hashHex(event.parentId, 16) } : {}),
    name: spanName(event),
    kind: 1,
    startTimeUnixNano: unixNanos,
    endTimeUnixNano: unixNanos,
    attributes,
    status: failureType ? { code: 2, message: failureType } : event.type === "run.completed" ? { code: 1 } : { code: 0 },
    ...(evidenceArtifactId
      ? {
          events: [
            {
              name: "toolguard.evidence.link",
              timeUnixNano: unixNanos,
              attributes: [stringAttribute("toolguard.evidence.artifact_id", evidenceArtifactId)]
            }
          ]
        }
      : {})
  };
}

function validateImportedEventShape(value: unknown, line: number): VisibilityImportValidationError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { line, code: "not_object", message: `Line ${line} must be a JSON object.` };
  }
  const event = value as Record<string, unknown>;
  if (event.schemaVersion !== undefined && event.schemaVersion !== CANONICAL_VISIBILITY_SCHEMA_VERSION) {
    return { line, code: "unsupported_schema_version", message: `Line ${line} uses unsupported visibility schema version.` };
  }
  for (const field of ["eventId", "type", "occurredAt", "summary", "runId", "traceId"] as const) {
    if (typeof event[field] !== "string" || !event[field]) {
      return { line, code: "missing_required_field", message: `Line ${line} is missing required string field ${field}.` };
    }
  }
  if (typeof event.sequence !== "number" || !Number.isFinite(event.sequence)) {
    return { line, code: "missing_required_field", message: `Line ${line} is missing required numeric field sequence.` };
  }
  if (!KNOWN_EVENT_TYPES.has(event.type as CoreEventType)) {
    return { line, code: "invalid_event_type", message: `Line ${line} has an unsupported event type.` };
  }
  if (event.visibility !== undefined && (!event.visibility || typeof event.visibility !== "object" || Array.isArray(event.visibility))) {
    return { line, code: "invalid_visibility", message: `Line ${line} has invalid visibility metadata.` };
  }
  const visibility = event.visibility as Record<string, unknown> | undefined;
  if (visibility?.schemaVersion !== undefined && visibility.schemaVersion !== CANONICAL_VISIBILITY_SCHEMA_VERSION) {
    return {
      line,
      code: "unsupported_schema_version",
      message: `Line ${line} uses unsupported nested visibility schema version.`
    };
  }
  return undefined;
}

function normalizeImportedEvent(event: JsonObject, line: number, sourceLabel: string): CoreEvent {
  const existingData = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data : undefined;
  const parentId = safeId(event.parentId);
  const harnessId = safeId(event.harnessId);
  const adapterId = safeId(event.adapterId);
  const downstreamServerId = safeId(event.downstreamServerId);
  const toolCallId = safeId(event.toolCallId);
  const attemptId = safeId(event.attemptId);
  const policyDecisionId = safeId(event.policyDecisionId);
  const artifactId = safeId(event.artifactId);
  return {
    eventId: safeEventId(event.eventId) ?? createId("event"),
    schemaVersion: CANONICAL_VISIBILITY_SCHEMA_VERSION,
    type: event.type as CoreEventType,
    occurredAt: safeString(event.occurredAt) ?? new Date(0).toISOString(),
    sequence: typeof event.sequence === "number" ? event.sequence : line,
    summary: redactString(safeString(event.summary) ?? "Imported visibility event."),
    runId: safeId(event.runId) ?? createId("run"),
    traceId: safeId(event.traceId) ?? createId("trace"),
    ...(parentId ? { parentId } : {}),
    ...(harnessId ? { harnessId } : {}),
    ...(adapterId ? { adapterId } : {}),
    ...(downstreamServerId ? { downstreamServerId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(policyDecisionId ? { policyDecisionId } : {}),
    ...(artifactId ? { artifactId } : {}),
    visibility: normalizeVisibility(event),
    data: {
      ...(existingData ? (redactJsonValue(existingData) as JsonObject) : {}),
      import: {
        sourceLabel,
        importedAt: new Date(0).toISOString(),
        originalEventId: redactString(String(event.eventId)),
        originalVisibilityLevel: importedVisibility(event)?.visibilityLevel ?? "unknown"
      }
    }
  };
}

function normalizeVisibility(event: JsonObject): VisibilityMetadata {
  const existing = importedVisibility(event);
  const traceparent =
    existing?.traceContext?.traceparent && TRACEPARENT_PATTERN.test(existing.traceContext.traceparent)
      ? existing.traceContext.traceparent
      : `00-${hashHex(String(event.traceId ?? event.eventId), 32)}-${hashHex(String(event.eventId ?? event.traceId), 16)}-01`;
  return {
    schemaVersion: CANONICAL_VISIBILITY_SCHEMA_VERSION,
    visibilityLevel: "imported",
    coverageClaim: "imported",
    ...(existing?.routePassportId ? { routePassportId: redactString(existing.routePassportId) } : {}),
    ...(existing?.routeType ? { routeType: redactString(existing.routeType) } : {}),
    ...(existing?.routeId ? { routeId: redactString(existing.routeId) } : {}),
    ...(existing?.evidenceScope ? { evidenceScope: existing.evidenceScope } : {}),
    producingEvidence: true,
    harness: {
      ...(existing?.harness?.harnessId ? { harnessId: redactString(existing.harness.harnessId) } : {}),
      ...(existing?.harness?.name ? { name: redactString(existing.harness.name) } : {}),
      ...(existing?.harness?.kind ? { kind: existing.harness.kind } : {})
    },
    platform: {
      ...(existing?.platform?.hostId ? { hostId: redactString(existing.platform.hostId) } : {}),
      ...(existing?.platform?.hostName ? { hostName: redactString(existing.platform.hostName) } : {}),
      ...(existing?.platform?.hostFamily ? { hostFamily: redactString(existing.platform.hostFamily) } : {}),
      ...(existing?.platform?.supportedHostIds ? { supportedHostIds: existing.platform.supportedHostIds.map(redactString) } : {}),
      ...(existing?.platform?.osPlatform ? { osPlatform: redactString(String(existing.platform.osPlatform)) } : {}),
      ...(existing?.platform?.osFamily ? { osFamily: existing.platform.osFamily } : {}),
      ...(existing?.platform?.transport ? { transport: redactString(existing.platform.transport) } : {}),
      ...(existing?.platform?.configHash ? { configHash: redactString(existing.platform.configHash) } : {})
    },
    traceContext: {
      traceparent,
      ...(existing?.traceContext?.tracestate ? { tracestate: redactString(existing.traceContext.tracestate) } : {}),
      source: existing?.traceContext?.traceparent ? "provided" : "generated"
    }
  };
}

function importedVisibility(event: JsonObject): VisibilityMetadata | undefined {
  const visibility = event.visibility;
  if (!visibility || typeof visibility !== "object" || Array.isArray(visibility)) return undefined;
  return visibility as unknown as VisibilityMetadata;
}

function spanName(event: CoreEvent): string {
  const data = event.data;
  const toolName = data && typeof data === "object" && "toolName" in data ? String(data.toolName) : undefined;
  return toolName ? `${event.type} ${redactString(toolName)}` : `ToolGuard ${event.type}`;
}

function failureTypeForEvent(event: CoreEvent): string | undefined {
  const data = event.data;
  if (event.type === "tool.call.failed" && data && typeof data === "object" && "failureType" in data) {
    return typeof data.failureType === "string" ? redactString(data.failureType) : "unknown";
  }
  return undefined;
}

function evidenceArtifactIdForEvent(event: CoreEvent): string | undefined {
  const data = event.data;
  if (event.artifactId) return event.artifactId;
  if (data && typeof data === "object" && "artifactId" in data && typeof data.artifactId === "string") {
    return redactString(data.artifactId);
  }
  return undefined;
}

function otelTraceId(event: CoreEvent): string {
  const traceparent = event.visibility?.traceContext.traceparent;
  if (traceparent && TRACEPARENT_PATTERN.test(traceparent)) return traceparent.split("-")[1] ?? hashHex(event.traceId, 32);
  return hashHex(event.traceId, 32);
}

function toUnixNano(iso: string): string {
  const millis = Date.parse(iso);
  return String(Number.isFinite(millis) ? BigInt(millis) * 1_000_000n : 0n);
}

function addOptionalString(attributes: OTelAttribute[], key: string, value: string | undefined): void {
  if (value) attributes.push(stringAttribute(key, value));
}

function stringAttribute(key: string, value: string): OTelAttribute {
  return { key, value: { stringValue: redactString(value).slice(0, 1_000) } };
}

function boolAttribute(key: string, value: boolean): OTelAttribute {
  return { key, value: { boolValue: value } };
}

function intAttribute(key: string, value: number): OTelAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function safeString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value ? redactString(value).slice(0, 1_000) : undefined;
}

function safeEventId(value: JsonValue | undefined): StableId | undefined {
  return typeof value === "string" && /^event_[A-Za-z0-9_-]+$/.test(value) ? (value as StableId) : undefined;
}

function safeId(value: JsonValue | undefined): StableId | undefined {
  return typeof value === "string" && /^[A-Za-z]+_[A-Za-z0-9_-]+$/.test(value) ? (redactString(value) as StableId) : undefined;
}

function hashHex(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

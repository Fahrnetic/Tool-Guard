import { createHash } from "node:crypto";
import { redactString } from "./redaction.js";
import type {
  ToolCall,
  VisibilityLevel,
  VisibilityMetadata,
  VisibilityTraceContext
} from "./types.js";

export const CANONICAL_VISIBILITY_SCHEMA_VERSION = "toolguard.visibility.v1" as const;

const SOURCE_VISIBILITY: Record<ToolCall["sourcePath"], VisibilityLevel> = {
  "mcp-adapter": "mediated",
  "cli-wrapper": "supervised",
  "framework-adapter": "observed",
  "non-mcp-direct": "observed"
};

const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[0-9a-f]$/;

export function buildVisibilityMetadata(call: ToolCall): VisibilityMetadata {
  const level = visibilityLevelForCall(call);
  const coverageClaim = call.routeMetadata?.coverage?.claim ?? level;
  return {
    schemaVersion: CANONICAL_VISIBILITY_SCHEMA_VERSION,
    visibilityLevel: level,
    coverageClaim,
    ...(call.routeMetadata?.platform?.routePassportId ? { routePassportId: safeString(call.routeMetadata.platform.routePassportId) } : {}),
    ...(call.routeMetadata?.routeType ? { routeType: safeString(call.routeMetadata.routeType) } : {}),
    ...(call.routeMetadata?.routeId ? { routeId: safeString(call.routeMetadata.routeId) } : {}),
    ...(call.routeMetadata?.coverage?.evidenceScope ? { evidenceScope: call.routeMetadata.coverage.evidenceScope } : {}),
    producingEvidence: call.routeMetadata?.coverage?.producingEvidence ?? true,
    harness: {
      harnessId: safeString(call.harnessId),
      ...(call.harnessName ? { name: safeString(call.harnessName) } : {})
    },
    platform: {
      ...(call.routeMetadata?.platform?.hostId ? { hostId: safeString(call.routeMetadata.platform.hostId) } : {}),
      ...(call.routeMetadata?.platform?.hostName ? { hostName: safeString(call.routeMetadata.platform.hostName) } : {}),
      ...(call.routeMetadata?.platform?.hostFamily ? { hostFamily: safeString(call.routeMetadata.platform.hostFamily) } : {}),
      ...(call.routeMetadata?.platform?.supportedHostIds
        ? { supportedHostIds: call.routeMetadata.platform.supportedHostIds.map(safeString) }
        : {}),
      ...(call.routeMetadata?.platform?.osPlatform ? { osPlatform: safeString(call.routeMetadata.platform.osPlatform) } : {}),
      ...(call.routeMetadata?.platform?.osFamily ? { osFamily: call.routeMetadata.platform.osFamily } : {}),
      ...(call.routeMetadata?.platform?.transport ?? call.routeMetadata?.transport?.kind
        ? { transport: safeString(call.routeMetadata.platform?.transport ?? call.routeMetadata.transport?.kind ?? "") }
        : {}),
      ...(call.routeMetadata?.platform?.configHash ?? call.routeMetadata?.configHash ?? call.routeMetadata?.adapterConfigHash
        ? {
            configHash: safeString(
              call.routeMetadata.platform?.configHash ?? call.routeMetadata.configHash ?? call.routeMetadata.adapterConfigHash ?? ""
            )
          }
        : {})
    },
    traceContext: traceContextForCall(call)
  };
}

export function visibilityLevelForCall(call: ToolCall): VisibilityLevel {
  const explicit = call.routeMetadata?.coverage?.claim;
  if (explicit) return explicit;
  return SOURCE_VISIBILITY[call.sourcePath];
}

export function traceContextForCall(call: ToolCall): VisibilityTraceContext {
  const provided = call.routeMetadata?.traceContext?.traceparent?.toLowerCase();
  if (provided && TRACEPARENT_PATTERN.test(provided)) {
    return {
      traceparent: provided,
      ...(call.routeMetadata?.traceContext?.tracestate ? { tracestate: safeString(call.routeMetadata.traceContext.tracestate) } : {}),
      source: "provided"
    };
  }
  return {
    traceparent: generatedTraceparent(call),
    source: "generated"
  };
}

export function visibilityLabels(metadata: VisibilityMetadata): readonly string[] {
  return [
    metadata.visibilityLevel,
    metadata.coverageClaim,
    ...(metadata.evidenceScope ? [metadata.evidenceScope] : []),
    metadata.producingEvidence ? "producing-evidence" : "not-producing-evidence",
    ...(metadata.routeType ? [metadata.routeType] : [])
  ];
}

export function stableVisibilityJson(value: unknown): string {
  return `${stableStringify(value)}\n`;
}

function generatedTraceparent(call: ToolCall): string {
  const seed = `${call.runId}:${call.traceId}:${call.parentId ?? ""}:${call.toolCallId}:${call.attemptId}`;
  const hash = createHash("sha256").update(seed).digest("hex");
  return `00-${hash.slice(0, 32)}-${hash.slice(32, 48)}-01`;
}

function safeString(value: string): string {
  return redactString(String(value)).slice(0, 500);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value), null, 2);
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableStringify);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortForStableStringify(entry)])
    );
  }
  return value;
}

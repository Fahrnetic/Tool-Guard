import { createId, type StableId } from "./ids.js";
import { ToolRegistry } from "./registry.js";
import type { CoreSession } from "./session.js";
import { redactJsonValueWithSummary, redactString, redactStringWithSummary } from "./redaction.js";
import type { CoreEvent } from "./events.js";
import type { JsonObject, JsonValue, JsonSchema, ToolCall, ToolResult, VisibilityMetadata } from "./types.js";

export interface LocalFunctionWrapperOptions {
  readonly session: CoreSession;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonSchema;
  readonly execute: (arguments_: JsonObject) => Promise<JsonValue> | JsonValue;
  readonly route?: {
    readonly routeId?: string;
    readonly harnessId?: StableId;
    readonly adapterId?: StableId;
    readonly traceparent?: string;
    readonly tracestate?: string;
  };
}

export type LocalFunctionWrapperResult = ToolResult & {
  readonly routeType: "js-ts-wrapper";
  readonly limitations: readonly string[];
};

export interface HttpWebhookImportInput {
  readonly source?: string;
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, JsonValue>>;
  readonly body?: JsonValue;
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export interface BrowserEvidenceImportInput {
  readonly pageUrl?: string;
  readonly screenshot?: {
    readonly label?: string;
    readonly mimeType?: string;
    readonly byteLength?: number;
    readonly sha256?: string;
  };
  readonly console?: readonly {
    readonly level?: string;
    readonly message?: string;
    readonly count?: number;
  }[];
  readonly network?: readonly {
    readonly method?: string;
    readonly url?: string;
    readonly status?: number;
  }[];
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export interface VisibilityEvidenceImportResult {
  readonly event: CoreEvent;
  readonly artifactId: StableId;
  readonly safeSummary: string;
  readonly safeEvidence: JsonObject;
  readonly visibility: VisibilityMetadata;
  readonly limitations: readonly string[];
}

export interface ProviderToolCallNormalizationInput {
  readonly provider: "openai" | "anthropic" | "generic";
  readonly payload: JsonObject;
}

export interface ProviderToolCallNormalizationResult {
  readonly provider: "openai" | "anthropic" | "generic";
  readonly normalized: {
    readonly originalToolCallId?: string;
    readonly toolName: string;
    readonly arguments: JsonObject;
    readonly routeType: "js-ts-wrapper";
    readonly visibilityLevel: "mediated";
  };
  readonly limitations: readonly string[];
}

const HTTP_IMPORT_LIMITATIONS = [
  "Imported HTTP/webhook evidence is observed after the fact; ToolGuard did not mediate the original action.",
  "Payloads are bounded, redacted, and stored as safe summaries without credentials."
] as const;

const HTTP_IMPORT_MAX_DEPTH = 6;
const HTTP_IMPORT_MAX_STRING_LENGTH = 2_000;
const HTTP_IMPORT_MAX_ARRAY_ENTRIES = 50;
const HTTP_IMPORT_MAX_OBJECT_KEYS = 50;

const BROWSER_IMPORT_LIMITATIONS = [
  "Browser evidence is observed/imported; ToolGuard did not mediate native browser actions.",
  "Screenshots are represented by metadata and safe console/network summaries by default."
] as const;

export function wrapLocalToolFunction(
  options: LocalFunctionWrapperOptions
): (arguments_: JsonObject) => Promise<LocalFunctionWrapperResult> {
  return async (arguments_: JsonObject): Promise<LocalFunctionWrapperResult> => {
    const downstreamServerId = createId("server");
    const registry = new ToolRegistry();
    const routeMetadata = {
      routeType: "js-ts-wrapper",
      ...(options.route?.routeId ? { routeId: options.route.routeId } : {}),
      downstreamTargetIdentity: options.name,
      transport: { kind: "in-process-function" },
      toolRoute: { wrapper: "wrapLocalToolFunction", explicit: true },
      traceContext: {
        ...(options.route?.traceparent ? { traceparent: options.route.traceparent } : {}),
        ...(options.route?.tracestate ? { tracestate: options.route.tracestate } : {})
      },
      platform: {
        hostId: "local-js-ts-wrapper",
        hostName: "Local JS/TS wrapper",
        transport: "in-process-function"
      },
      coverage: { claim: "mediated", evidenceScope: "route", producingEvidence: true }
    } as const;
    registry.register({
      toolName: options.name,
      title: options.name,
      description: options.description ?? "Explicit local JS/TS ToolGuard wrapper.",
      protocol: "in-process",
      downstreamServerId,
      inputSchema: options.inputSchema ?? { type: "object" },
      destructiveRisk: "none",
      routeMetadata,
      execute: ({ call }) => options.execute(call.arguments)
    });

    const call: ToolCall = {
      runId: options.session.runId,
      traceId: createId("trace"),
      parentId: createId("parent"),
      harnessId: options.route?.harnessId ?? createId("harness"),
      harnessName: "local-js-ts",
      adapterId: options.route?.adapterId ?? createId("adapter"),
      adapterName: "toolguard-js-ts-wrapper",
      downstreamServerId,
      toolCallId: createId("toolcall"),
      attemptId: createId("attempt"),
      policyDecisionId: createId("policy"),
      toolName: options.name,
      originalToolName: options.name,
      arguments: arguments_,
      deadlineMs: 1_000,
      idempotency: "idempotent",
      sourcePath: "non-mcp-direct",
      routeMetadata
    };

    const result = await options.session.executeToolCall(registry, call);
    if ("failureType" in result) {
      throw new Error(result.safeSummary);
    }
    return {
      ...result,
      routeType: "js-ts-wrapper",
      limitations: ["Only explicit calls through this wrapper are mediated; native host tools that bypass it are not covered."]
    };
  };
}

export function normalizeProviderToolCall(input: ProviderToolCallNormalizationInput): ProviderToolCallNormalizationResult {
  const candidate = input.provider === "anthropic" ? anthropicToolUse(input.payload) : openAiToolCall(input.payload);
  return {
    provider: input.provider,
    normalized: {
      ...(candidate.id ? { originalToolCallId: redactString(candidate.id).slice(0, 200) } : {}),
      toolName: redactString(candidate.name || "provider.tool").slice(0, 200),
      arguments: redactJsonValueWithSummary(candidate.arguments).value as JsonObject,
      routeType: "js-ts-wrapper",
      visibilityLevel: "mediated"
    },
    limitations: [
      "Provider tool-call normalization is an explicit local wrapper example, not native provider interception.",
      "Provider arguments are bounded and redacted before they become ToolGuard-visible route evidence."
    ]
  };
}

export async function importHttpWebhookEvidence(
  session: CoreSession,
  input: HttpWebhookImportInput
): Promise<VisibilityEvidenceImportResult> {
  const call = importCall(session.runId, "http-webhook-import", "imported", input.traceparent, input.tracestate);
  const bounded = boundJsonValueWithSummary({
    source: input.source ?? "local-http-webhook",
    method: input.method ?? "POST",
    path: input.path ?? "/",
    headers: input.headers ?? {},
    body: input.body ?? {}
  });
  const redacted = redactJsonValueWithSummary(bounded.value);
  const safeEvidence = {
    kind: "http-webhook-import",
    ...(redacted.value as JsonObject),
    redaction: { count: redacted.count, reasons: [...redacted.reasons] },
    truncation: { count: bounded.count, reasons: [...bounded.reasons] },
    limitations: [...HTTP_IMPORT_LIMITATIONS]
  };
  return await recordVisibilityImport(session, call, "HTTP/webhook visibility evidence imported", safeEvidence, HTTP_IMPORT_LIMITATIONS);
}

export async function importBrowserEvidence(
  session: CoreSession,
  input: BrowserEvidenceImportInput
): Promise<VisibilityEvidenceImportResult> {
  const call = importCall(session.runId, "browser-evidence-import", "observed", input.traceparent, input.tracestate);
  const safeConsole = (input.console ?? []).slice(0, 50).map((entry) => ({
    level: redactString(String(entry.level ?? "log")).slice(0, 32),
    message: redactString(String(entry.message ?? "")).slice(0, 500),
    count: boundedNumber(entry.count, 1, 1_000)
  }));
  const safeNetwork = (input.network ?? []).slice(0, 100).map((entry) => ({
    method: redactString(String(entry.method ?? "GET")).slice(0, 16),
    url: redactUrl(String(entry.url ?? "")),
    status: boundedNumber(entry.status, 0, 999)
  }));
  const screenshot = {
    label: redactString(input.screenshot?.label ?? "browser screenshot").slice(0, 200),
    mimeType: input.screenshot?.mimeType === "image/jpeg" ? "image/jpeg" : "image/png",
    byteLength: boundedNumber(input.screenshot?.byteLength, 0, 5_000_000),
    ...(typeof input.screenshot?.sha256 === "string" && /^[a-f0-9]{64}$/i.test(input.screenshot.sha256)
      ? { sha256: input.screenshot.sha256.toLowerCase() }
      : {})
  };
  const safeEvidence = {
    kind: "browser-evidence-import",
    pageUrl: redactUrl(input.pageUrl ?? ""),
    screenshot,
    console: safeConsole,
    network: safeNetwork,
    limitations: [...BROWSER_IMPORT_LIMITATIONS]
  };
  const redaction = redactJsonValueWithSummary(safeEvidence as JsonValue);
  return await recordVisibilityImport(
    session,
    call,
    "Browser visibility evidence imported",
    { ...(redaction.value as JsonObject), redaction: { count: redaction.count, reasons: [...redaction.reasons] } },
    BROWSER_IMPORT_LIMITATIONS
  );
}

function importCall(
  runId: StableId,
  routeType: "http-webhook-import" | "browser-evidence-import",
  claim: "imported" | "observed",
  traceparent?: string,
  tracestate?: string
): ToolCall {
  return {
    runId,
    traceId: createId("trace"),
    parentId: createId("parent"),
    harnessId: createId("harness"),
    harnessName: routeType,
    adapterId: createId("adapter"),
    adapterName: "toolguard-local-visibility-import",
    downstreamServerId: createId("server"),
    toolCallId: createId("toolcall"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName: `visibility.${routeType}`,
    arguments: {},
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    routeMetadata: {
      routeType,
      routeId: `route_${routeType}`,
      transport: { kind: routeType === "http-webhook-import" ? "http-loopback-import" : "browser-summary-import" },
      traceContext: {
        ...(traceparent ? { traceparent } : {}),
        ...(tracestate ? { tracestate } : {})
      },
      platform: {
        hostId: routeType,
        hostName: routeType === "http-webhook-import" ? "HTTP/webhook import" : "Browser evidence import",
        transport: routeType === "http-webhook-import" ? "http-loopback-import" : "browser-summary-import"
      },
      coverage: { claim, evidenceScope: "route", producingEvidence: true }
    }
  };
}

async function recordVisibilityImport(
  session: CoreSession,
  call: ToolCall,
  summary: string,
  safeEvidence: JsonObject,
  limitations: readonly string[]
): Promise<VisibilityEvidenceImportResult> {
  const artifact = await session.recordRawArtifact(call, {
    kind: "safe-summary",
    fileName: `${call.toolCallId}.visibility-import.json`,
    content: safeEvidence,
    redacted: true
  });
  const event = await session.emitVisibilityImported(call, summary, {
    artifactId: artifact.artifactId,
    safeEvidence,
    limitations: [...limitations]
  });
  return {
    event,
    artifactId: artifact.artifactId,
    safeSummary: redactStringWithSummary(`${summary}: ${JSON.stringify(safeEvidence)}`).value.slice(0, 1_000),
    safeEvidence,
    visibility: event.visibility!,
    limitations
  };
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function boundJsonValueWithSummary(value: JsonValue): {
  readonly value: JsonValue;
  readonly count: number;
  readonly reasons: readonly string[];
} {
  const state = { count: 0, reasons: new Set<string>() };
  const bounded = boundJsonValue(value, state, 0);
  return { value: bounded, count: state.count, reasons: [...state.reasons] };
}

function boundJsonValue(value: JsonValue, state: { count: number; reasons: Set<string> }, depth: number): JsonValue {
  if (depth > HTTP_IMPORT_MAX_DEPTH) {
    return truncationMarker("max-depth", state);
  }
  if (typeof value === "string") {
    if (value.length <= HTTP_IMPORT_MAX_STRING_LENGTH) return value;
    state.count += 1;
    state.reasons.add("max-string-length");
    return `${value.slice(0, HTTP_IMPORT_MAX_STRING_LENGTH)}[TRUNCATED:max-string-length:${value.length - HTTP_IMPORT_MAX_STRING_LENGTH}]`;
  }
  if (Array.isArray(value)) {
    const entries = value.slice(0, HTTP_IMPORT_MAX_ARRAY_ENTRIES).map((entry) => boundJsonValue(entry, state, depth + 1));
    if (value.length > HTTP_IMPORT_MAX_ARRAY_ENTRIES) {
      entries.push(truncationMarker("max-array-entries", state, value.length - HTTP_IMPORT_MAX_ARRAY_ENTRIES));
    }
    return entries;
  }
  if (value && typeof value === "object") {
    const bounded: Record<string, JsonValue> = {};
    const entries = Object.entries(value);
    for (const [key, entry] of entries.slice(0, HTTP_IMPORT_MAX_OBJECT_KEYS)) {
      bounded[redactString(key).slice(0, 200)] = boundJsonValue(entry, state, depth + 1);
    }
    if (entries.length > HTTP_IMPORT_MAX_OBJECT_KEYS) {
      bounded.__truncated__ = truncationMarker("max-object-keys", state, entries.length - HTTP_IMPORT_MAX_OBJECT_KEYS);
    }
    return bounded as JsonObject;
  }
  return value;
}

function truncationMarker(reason: string, state: { count: number; reasons: Set<string> }, omitted = 1): string {
  state.count += 1;
  state.reasons.add(reason);
  return `[TRUNCATED:${reason}:${omitted}]`;
}

function openAiToolCall(payload: JsonObject): { id?: string; name: string; arguments: JsonObject } {
  const functionCall =
    payload.function && typeof payload.function === "object" && !Array.isArray(payload.function)
      ? (payload.function as JsonObject)
      : payload;
  const rawArguments =
    typeof functionCall.arguments === "string" ? parseJsonObject(functionCall.arguments) : jsonObject(functionCall.arguments);
  return {
    ...(typeof payload.id === "string" ? { id: payload.id } : {}),
    name: typeof functionCall.name === "string" ? functionCall.name : "provider.tool",
    arguments: rawArguments
  };
}

function anthropicToolUse(payload: JsonObject): { id?: string; name: string; arguments: JsonObject } {
  return {
    ...(typeof payload.id === "string" ? { id: payload.id } : {}),
    name: typeof payload.name === "string" ? payload.name : "provider.tool",
    arguments: jsonObject(payload.input)
  };
}

function parseJsonObject(value: string): JsonObject {
  try {
    return jsonObject(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, "[REDACTED:url-query]");
    }
    return redactString(url.toString()).slice(0, 1_000);
  } catch {
    return redactString(value).slice(0, 1_000);
  }
}

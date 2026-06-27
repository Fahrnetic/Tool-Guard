import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CoreSession } from "./session.js";
import { ToolRegistry } from "./registry.js";
import { registerChaosFixtures } from "./chaos-fixtures.js";
import { validateReportManifest } from "./report.js";
import { createId, type StableId } from "./ids.js";
import type { CoreEvent } from "./events.js";
import type { JsonObject, JsonValue, ToolCall } from "./types.js";

export const SIDECAR_PROTOCOL_VERSION = "toolguard.sidecar.v1";

export interface CoreApiServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly evidenceRoot?: string;
  readonly session?: CoreSession;
  readonly registry?: ToolRegistry;
  readonly seedDirectRun?: boolean;
}

export interface CoreApiServerHandle {
  readonly session: CoreSession;
  readonly server: http.Server;
  readonly registry: ToolRegistry;
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

export function createCoreApiServer(options: CoreApiServerOptions = {}): CoreApiServerHandle {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.TOOLGUARD_CORE_PORT ?? 3660);
  const evidenceRoot = options.evidenceRoot ?? path.join(process.cwd(), "runs");
  const session = options.session ?? new CoreSession({ evidenceRoot, runId: createId("run") });
  const runId = session.runId;
  const registry = options.registry ?? new ToolRegistry();
  const seedDirectRun = options.seedDirectRun ?? options.session === undefined;
  const registerDefaultTools = options.registry === undefined;

  const downstreamServerId = createId("server");
  if (registerDefaultTools) {
    registerChaosFixtures(registry, { sandboxRoot: evidenceRoot });
    registry.register({
      toolName: "fixture.echo",
      title: "Echo fixture",
      description: "Safe in-process fixture used by the local Core API.",
      protocol: "fixture",
      downstreamServerId,
      inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string" } } },
      destructiveRisk: "none",
      preflight: () => ({ status: "healthy", summary: "Local in-process fixture is ready." }),
      execute: ({ call }) => ({ echoed: String(call.arguments.message ?? "") })
    });
  }

  const clients = new Set<http.ServerResponse>();
  session.bus.subscribe((event) => {
    for (const client of clients) {
      writeSseEvent(client, event);
    }
  });

  const server = http.createServer(async (request, response) => {
    try {
      response.setHeader("access-control-allow-origin", "http://127.0.0.1:3661");
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://${host}:${port}`);
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "ToolGuard Core", runId, events: session.recorder.events.length });
        return;
      }

      if (url.pathname === "/events") {
        response.writeHead(200, {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream"
        });
        clients.add(response);
        for (const event of session.recorder.events) {
          writeSseEvent(response, event);
        }
        request.on("close", () => {
          clients.delete(response);
        });
        return;
      }

      if (url.pathname === "/api/runs/latest") {
        sendJson(response, 200, {
          runId,
          eventsPath: session.recorder.eventsPath,
          evidenceDir: session.recorder.runDir,
          eventCount: session.recorder.events.length,
          events: session.recorder.events
        });
        return;
      }

      if (url.pathname === "/api/health") {
        sendJson(response, 200, buildHealthPayload(runId, session.recorder.events));
        return;
      }

      if (url.pathname === "/api/evidence" || url.pathname === `/api/runs/${runId}/evidence`) {
        sendJson(response, 200, {
          runId,
          evidenceDir: session.recorder.runDir,
          eventsPath: session.recorder.eventsPath,
          eventCount: session.recorder.events.length,
          artifactEvents: session.recorder.events.filter((event) => event.type === "evidence.artifact.created")
        });
        return;
      }

      if (url.pathname === "/api/reports/export") {
        const report = await session.exportReport();
        const validation = await validateReportManifest({ runDir: session.recorder.runDir });
        sendJson(response, 200, {
          runId,
          reportHtml: report.reportPath,
          manifestJson: report.manifestPath,
          artifactHashList: report.artifactHashPath,
          redactionSummary: report.redactionSummaryPath,
          manifestValid: validation.valid,
          validationErrors: validation.errors
        });
        return;
      }

      if (url.pathname === "/api/events/ingest") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const body = await readJsonBody(request, 512 * 1024);
        if (!body.ok || !isCoreEventLike(body.payload)) {
          sendJson(response, body.ok ? 400 : body.statusCode, {
            error: body.ok ? "invalid_event" : body.message
          });
          return;
        }
        const event = body.payload as unknown as CoreEvent;
        await session.recorder.appendEvent(event);
        session.bus.publish(event);
        sendJson(response, 202, { ok: true, eventId: event.eventId, type: event.type, runId: event.runId });
        return;
      }

      if (url.pathname === "/api/sidecar/v1/tool-calls") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }

        const body = await readSidecarJsonBody(request);
        if (!body.ok) {
          const call = makeSidecarFailureToolCall(undefined, runId, body.toolName);
          const failureCard = await session.failToolCall(call, "sidecar_protocol_error", [body.message]);
          sendJson(response, body.statusCode, {
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            status: "failure",
            failureCard,
            evidenceDir: session.recorder.runDir,
            eventsPath: session.recorder.eventsPath
          });
          return;
        }

        const payload = body.payload;
        const validation = validateSidecarPayload(payload);
        if (!validation.valid) {
          const call = makeSidecarFailureToolCall(payload, runId, validation.toolName);
          const failureCard = await session.failToolCall(call, "sidecar_protocol_error", validation.errors);
          sendJson(response, validation.statusCode, {
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            status: "failure",
            failureCard,
            evidenceDir: session.recorder.runDir,
            eventsPath: session.recorder.eventsPath
          });
          return;
        }

        const call = makeSidecarToolCall(payload, runId, registry);
        if (payload.protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
          const failureCard = await session.failToolCall(call, "sidecar_protocol_error", [
            `Expected ${SIDECAR_PROTOCOL_VERSION}, received ${String(payload.protocolVersion)}`
          ]);
          sendJson(response, 426, {
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            status: "failure",
            failureCard,
            evidenceDir: session.recorder.runDir,
            eventsPath: session.recorder.eventsPath
          });
          return;
        }

        await session.emitAdapterConnected(
          {
            runId: call.runId,
            traceId: call.traceId,
            ...(call.parentId ? { parentId: call.parentId } : {}),
            harnessId: call.harnessId,
            adapterId: call.adapterId,
            downstreamServerId: call.downstreamServerId
          },
          `Python framework adapter connected: ${stringFrom(payload.adapterName, "unknown")}`
        );
        const result = await session.executeToolCall(registry, call);
        sendJson(response, 200, {
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          status: "failureType" in result ? "failure" : "success",
          correlation: {
            runId: call.runId,
            traceId: call.traceId,
            parentId: call.parentId,
            harnessId: call.harnessId,
            adapterId: call.adapterId,
            downstreamServerId: call.downstreamServerId,
            toolCallId: call.toolCallId,
            attemptId: call.attemptId,
            policyDecisionId: call.policyDecisionId
          },
          result: "failureType" in result ? undefined : result,
          failureCard: "failureType" in result ? result : undefined,
          evidenceDir: session.recorder.runDir,
          eventsPath: session.recorder.eventsPath
        });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "unknown_error" });
    }
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  }).then(async () => {
    if (seedDirectRun) {
      const call = makeApiToolCall(runId, downstreamServerId);
      await session.preflight(registry, {
        runId,
        traceId: call.traceId,
        harnessId: call.harnessId,
        adapterId: call.adapterId
      });
      await session.executeToolCall(registry, call);
    }
  });

  return {
    session,
    server,
    registry,
    ready,
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of clients) {
          client.end();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

type JsonBodyResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly statusCode: number; readonly message: string };

async function readJsonBody(request: http.IncomingMessage, limitBytes: number): Promise<JsonBodyResult> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    byteLength += buffer.byteLength;
    if (byteLength > limitBytes) {
      return { ok: false, statusCode: 413, message: `Request body exceeded the ${limitBytes} byte limit.` };
    }
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (!isRecord(parsed)) {
      return { ok: false, statusCode: 400, message: "Request body must be a JSON object." };
    }
    return { ok: true, payload: parsed };
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      message: `Request body was malformed JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function isCoreEventLike(value: Record<string, unknown>): boolean {
  return (
    typeof value.eventId === "string" &&
    typeof value.type === "string" &&
    typeof value.occurredAt === "string" &&
    typeof value.sequence === "number" &&
    typeof value.summary === "string" &&
    typeof value.runId === "string" &&
    typeof value.traceId === "string"
  );
}

function makeApiToolCall(runId: StableId, downstreamServerId: StableId): ToolCall {
  return {
    runId,
    traceId: createId("trace"),
    parentId: createId("parent"),
    harnessId: createId("harness"),
    adapterId: createId("adapter"),
    downstreamServerId,
    toolCallId: createId("toolcall"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName: "fixture.echo",
    arguments: { message: "hello from core api" },
    deadlineMs: 1_000,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct"
  };
}

function makeSidecarToolCall(payload: SidecarToolCallRequest, runId: StableId, registry: ToolRegistry): ToolCall {
  const toolName = stringFrom(payload.toolName, "sidecar.request");
  const tool = registry.get(toolName);
  return {
    runId: stableIdFrom(payload.correlation?.runId, runId),
    traceId: stableIdFrom(payload.correlation?.traceId, createId("trace")),
    ...(payload.correlation?.parentId ? { parentId: stableIdFrom(payload.correlation.parentId, createId("parent")) } : {}),
    harnessId: stableIdFrom(payload.harnessId ?? payload.correlation?.harnessId, createId("harness")),
    adapterId: stableIdFrom(payload.adapterId ?? payload.correlation?.adapterId, createId("adapter")),
    downstreamServerId: stableIdFrom(
      payload.downstreamServerId ?? payload.correlation?.downstreamServerId,
      tool?.downstreamServerId ?? createId("server")
    ),
    toolCallId: stableIdFrom(payload.correlation?.toolCallId, createId("toolcall")),
    attemptId: stableIdFrom(payload.correlation?.attemptId, createId("attempt")),
    policyDecisionId: stableIdFrom(payload.correlation?.policyDecisionId, createId("policy")),
    toolName,
    ...(typeof payload.originalToolName === "string" ? { originalToolName: payload.originalToolName } : {}),
    arguments: jsonObjectFrom(payload.arguments),
    deadlineMs: numberFrom(payload.deadlineMs, 1_000),
    idempotency:
      payload.idempotency === "non-idempotent" || payload.idempotency === "unknown" ? payload.idempotency : "idempotent",
    sourcePath: "framework-adapter"
  };
}

function makeSidecarFailureToolCall(
  payload: SidecarToolCallRequest | undefined,
  runId: StableId,
  toolName = "sidecar.request"
): ToolCall {
  return {
    runId: stableIdFrom(payload?.correlation?.runId, runId),
    traceId: stableIdFrom(payload?.correlation?.traceId, createId("trace")),
    ...(payload?.correlation?.parentId ? { parentId: stableIdFrom(payload.correlation.parentId, createId("parent")) } : {}),
    harnessId: stableIdFrom(payload?.harnessId ?? payload?.correlation?.harnessId, createId("harness")),
    adapterId: stableIdFrom(payload?.adapterId ?? payload?.correlation?.adapterId, createId("adapter")),
    downstreamServerId: stableIdFrom(payload?.downstreamServerId ?? payload?.correlation?.downstreamServerId, createId("server")),
    toolCallId: stableIdFrom(payload?.correlation?.toolCallId, createId("toolcall")),
    attemptId: stableIdFrom(payload?.correlation?.attemptId, createId("attempt")),
    policyDecisionId: stableIdFrom(payload?.correlation?.policyDecisionId, createId("policy")),
    toolName,
    arguments: {},
    deadlineMs: numberFrom(payload?.deadlineMs, 1_000),
    idempotency:
      payload?.idempotency === "non-idempotent" || payload?.idempotency === "unknown" ? payload.idempotency : "idempotent",
    sourcePath: "framework-adapter"
  };
}

interface SidecarToolCallRequest {
  readonly protocolVersion?: unknown;
  readonly toolName?: unknown;
  readonly originalToolName?: unknown;
  readonly arguments?: unknown;
  readonly deadlineMs?: unknown;
  readonly idempotency?: unknown;
  readonly harnessId?: unknown;
  readonly adapterId?: unknown;
  readonly adapterName?: unknown;
  readonly downstreamServerId?: unknown;
  readonly correlation?: {
    readonly runId?: unknown;
    readonly traceId?: unknown;
    readonly parentId?: unknown;
    readonly harnessId?: unknown;
    readonly adapterId?: unknown;
    readonly downstreamServerId?: unknown;
    readonly toolCallId?: unknown;
    readonly attemptId?: unknown;
    readonly policyDecisionId?: unknown;
  };
}

type SidecarJsonBodyResult =
  | { readonly ok: true; readonly payload: SidecarToolCallRequest }
  | { readonly ok: false; readonly statusCode: number; readonly message: string; readonly toolName?: string };

async function readSidecarJsonBody(request: http.IncomingMessage): Promise<SidecarJsonBodyResult> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    byteLength += buffer.byteLength;
    if (byteLength > 256 * 1024) {
      return {
        ok: false,
        statusCode: 413,
        message: "ToolGuard sidecar request body exceeded the 262144 byte limit."
      };
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return { ok: true, payload: {} };
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(parsed)) {
      return { ok: false, statusCode: 400, message: "ToolGuard sidecar request body must be a JSON object." };
    }
    return { ok: true, payload: parsed as SidecarToolCallRequest };
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      message: `ToolGuard sidecar request body was malformed JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
}

function validateSidecarPayload(payload: SidecarToolCallRequest): {
  readonly valid: boolean;
  readonly statusCode: number;
  readonly errors: readonly string[];
  readonly toolName?: string;
} {
  if (payload.protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
    return {
      valid: true,
      statusCode: 426,
      errors: [],
      toolName: typeof payload.toolName === "string" && payload.toolName.length > 0 ? payload.toolName : "sidecar.request"
    };
  }
  const errors: string[] = [];
  const toolName = typeof payload.toolName === "string" && payload.toolName.length > 0 ? payload.toolName : undefined;
  if (!toolName) {
    errors.push("Sidecar request field toolName must be a non-empty string.");
  }
  if (!isRecord(payload.arguments)) {
    errors.push("Sidecar request field arguments must be a JSON object.");
  }
  return {
    valid: errors.length === 0,
    statusCode: 400,
    errors,
    toolName: toolName ?? "sidecar.request"
  };
}

function jsonObjectFrom(value: unknown): JsonObject {
  return isRecord(value) ? (value as JsonObject) : {};
}

function stringFrom(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stableIdFrom(value: unknown, fallback: StableId): StableId {
  return stringFrom(value, fallback) as StableId;
}

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, JsonValue | unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function writeSseEvent(response: http.ServerResponse, event: CoreEvent): void {
  response.write(`event: ${event.type}\n`);
  response.write(`id: ${event.eventId}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function buildHealthPayload(runId: StableId, events: readonly CoreEvent[]): JsonObject {
  const latestPreflight = findLastEventWithFindings(events);
  const findings = latestPreflight?.data && "findings" in latestPreflight.data ? latestPreflight.data.findings : [];
  const findingRows = Array.isArray(findings)
    ? findings.flatMap((finding) => (isRecord(finding) ? [finding] : []))
    : [];
  const failureEvents = events.filter((event) => event.type === "tool.call.failed");
  const completedEvents = events.filter((event) => event.type === "tool.call.completed");
  const policyEvents = events.filter((event) => event.type === "policy.decision");
  const circuitOpenEvents = events.filter((event) => event.type === "circuit.opened");
  const latestFailureByTarget = new Map<string, CoreEvent>();
  for (const event of failureEvents) {
    latestFailureByTarget.set(`${event.downstreamServerId ?? "server:unknown"}:${event.summary}`, event);
  }

  const rows: JsonObject[] = [
    {
      id: "harness:direct",
      layer: "harness",
      name: "Direct/API harness",
      status: events.some((event) => event.type === "run.started") ? "healthy" : "degraded",
      preflight: "observed",
      latencyMs: 0,
      failureType: failureCardField(failureEvents.at(-1)?.data, "failureType", "none"),
      retryable: failureCardField(failureEvents.at(-1)?.data, "retryable", false),
      circuitState: circuitOpenEvents.length > 0 ? "open" : "closed",
      remediation: failureEvents.length > 0 ? "Inspect the latest Failure Card and separated raw artifacts." : "No action required.",
      runId
    },
    {
      id: "adapter:http-core",
      layer: "adapter",
      name: "Core HTTP/SSE adapter",
      status: "healthy",
      preflight: "reachable",
      latencyMs: 0,
      failureType: "none",
      retryable: false,
      circuitState: "closed",
      remediation: "Core API is serving loopback observability endpoints.",
      runId
    },
    ...findingRows.map((finding, index) => {
      const status = stringValue(finding.status, "degraded");
      const toolName = stringValue(finding.toolName, `tool-${index + 1}`);
      const downstreamServerId = stringValue(finding.downstreamServerId, "server:unknown");
      const failure = [...latestFailureByTarget.values()].find((event) => event.downstreamServerId === downstreamServerId);
      const failureCard = failure?.data && "failureType" in failure.data ? failure.data : undefined;
      return {
        id: `tool:${toolName}`,
        layer: "downstream tool",
        name: toolName,
        status,
        preflight: status,
        latencyMs: status === "healthy" ? 18 : status === "degraded" ? 94 : 0,
        failureType: failureCard && "failureType" in failureCard ? failureCard.failureType : status === "healthy" ? "none" : "preflight_degraded",
        retryable: failureCard && "retryable" in failureCard ? failureCard.retryable : status !== "healthy",
        circuitState: circuitOpenEvents.some((event) => event.downstreamServerId === downstreamServerId) ? "open" : "closed",
        remediation: stringValue(
          finding.remediation,
          status === "healthy" ? "No action required." : stringValue(finding.summary, "Inspect downstream fixture health.")
        ),
        runId,
        downstreamServerId
      };
    })
  ];

  return {
    runId,
    generatedAt: new Date().toISOString(),
    summary: {
      harnesses: 1,
      adapters: 1,
      downstreamServers: new Set(findingRows.map((finding) => stringValue(finding.downstreamServerId, "server:unknown"))).size,
      downstreamTools: findingRows.length,
      preflightHealthy: rows.filter((row) => row.status === "healthy").length,
      preflightDegraded: rows.filter((row) => row.status === "degraded").length,
      preflightFailed: rows.filter((row) => row.status === "failed").length,
      normalizedFailures: failureEvents.length,
      policyDecisions: policyEvents.length,
      circuitOpen: circuitOpenEvents.length,
      completedCalls: completedEvents.length,
      artifactCount: events.filter((event) => event.type === "evidence.artifact.created").length
    },
    rows
  };
}

function findLastEvent(events: readonly CoreEvent[], type: CoreEvent["type"]): CoreEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) {
      return event;
    }
  }
  return undefined;
}

function findLastEventWithFindings(events: readonly CoreEvent[]): CoreEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "server.preflight.completed" && isRecord(event.data) && Array.isArray(event.data.findings)) {
      return event;
    }
  }
  return findLastEvent(events, "server.preflight.completed");
}

function failureCardField<T extends string | boolean>(
  data: CoreEvent["data"] | undefined,
  field: "failureType" | "retryable",
  fallback: T
): T {
  if (isRecord(data) && field in data && typeof data[field] === typeof fallback) {
    return data[field] as T;
  }
  return fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const handle = createCoreApiServer();
  handle.ready
    .then(() => {
      const address = handle.server.address();
      if (typeof address === "object" && address) {
        console.log(`ToolGuard Core listening on http://${address.address}:${address.port}`);
        console.log(`Evidence events: ${handle.session.recorder.eventsPath}`);
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });

  const shutdown = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

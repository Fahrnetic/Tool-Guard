import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CoreSession } from "./session.js";
import { ToolRegistry } from "./registry.js";
import { registerChaosFixtures } from "./chaos-fixtures.js";
import { validateReportManifest } from "./report.js";
import { createId, type StableId } from "./ids.js";
import { buildFailureCard, classifyFailure } from "./classifier.js";
import type { CoreEvent } from "./events.js";
import type { FailureType, JsonObject, JsonValue, ToolCall } from "./types.js";

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

      if (url.pathname === "/api/sidecar/v1/tool-calls") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }

        const payload = await readJsonBody(request);
        const call = makeSidecarToolCall(payload, runId, registry);
        if (payload.protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
          sendJson(response, 426, {
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            status: "failure",
            failureCard: makeSidecarFailureCard(call, "sidecar_protocol_error"),
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
  const toolName = stringFrom(payload.toolName, "fixture.good");
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

function makeSidecarFailureCard(call: ToolCall, failureType: FailureType) {
  return buildFailureCard({
    call,
    classification: classifyFailure({ failureType }),
    evidenceLinks: []
  });
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

async function readJsonBody(request: http.IncomingMessage): Promise<SidecarToolCallRequest> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    byteLength += buffer.byteLength;
    if (byteLength > 256 * 1024) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return isRecord(parsed) ? (parsed as SidecarToolCallRequest) : {};
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

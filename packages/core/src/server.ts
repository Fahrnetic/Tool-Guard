import http from "node:http";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CoreSession } from "./session.js";
import { ToolRegistry } from "./registry.js";
import { registerChaosFixtures } from "./chaos-fixtures.js";
import { exportEvidenceBundle, validateEvidenceBundleManifest, type EvidenceBundleManifest } from "./bundle.js";
import { validateReportManifest } from "./report.js";
import { redactStringWithSummary } from "./redaction.js";
import { buildRunNarrative, buildRunTopology, generateAndPersistNarrative, generateAndPersistTopology } from "./topology.js";
import { simulatePolicy } from "./policy-simulator.js";
import { verifyIntegrationRoute } from "./integration-verification.js";
import {
  buildDemoStoryModePayload,
  defaultDemoStoryScenarioRuntime,
  type DemoStoryScenarioId,
  type DemoStoryScenarioRuntime
} from "./story-mode.js";
import { createId, type StableId } from "./ids.js";
import type { CoreEvent } from "./events.js";
import type {
  EvidenceArtifact,
  FailureCard,
  IntegrationRouteType,
  JsonObject,
  JsonValue,
  PolicyDecision,
  RecordedPolicyScenarioId,
  SideEffectLedgerEntry,
  ToolCall
} from "./types.js";

import { SIDECAR_PROTOCOL_VERSION } from "./sidecar-protocol.js";
export { SIDECAR_PROTOCOL_VERSION } from "./sidecar-protocol.js";

export interface CoreApiServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly evidenceRoot?: string;
  readonly session?: CoreSession;
  readonly registry?: ToolRegistry;
  readonly seedDirectRun?: boolean;
  readonly storyScenarioRuntime?: DemoStoryScenarioRuntime;
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
  const storyScenarioRuntime = options.storyScenarioRuntime ?? defaultDemoStoryScenarioRuntime;

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
      response.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
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

      if (url.pathname === "/api/run-index" || url.pathname === "/api/runs") {
        const records = await session.recorder.listRunIndexRecords();
        sendJson(response, 200, {
          indexPath: session.recorder.runIndexPath,
          count: records.length,
          records
        });
        return;
      }

      if (url.pathname === "/api/health") {
        sendJson(response, 200, buildHealthPayload(runId, session.recorder.events));
        return;
      }

      if (url.pathname === "/api/validation-dashboard") {
        sendJson(
          response,
          200,
          await buildValidationDashboardPayload({
            runId,
            runDir: session.recorder.runDir,
            events: session.recorder.events,
            currentServerPort: currentServerPort(port, server)
          })
        );
        return;
      }

      if (url.pathname.startsWith("/api/topology/")) {
        const requestedRunId = decodeURIComponent(url.pathname.slice("/api/topology/".length));
        if (requestedRunId === "demo-empty") {
          sendJson(response, 200, buildEmptyTopologyPayload());
          return;
        }
        if (requestedRunId === "demo-loading") {
          await delay(1_600);
          sendJson(response, 200, buildRunTopology({ runId, events: session.recorder.events, ledger: session.recorder.ledger }));
          return;
        } else if (requestedRunId !== runId && requestedRunId !== "latest") {
          sendJson(response, 404, { error: "topology_run_not_found", runId: requestedRunId });
          return;
        }
        const topology = await generateAndPersistTopology({
          runId,
          runDir: session.recorder.runDir,
          events: session.recorder.events,
          ledger: session.recorder.ledger
        });
        await session.emitGeneratedArtifact("topology.generated", "Topology graph generated", {
          runId,
          path: path.join(session.recorder.runDir, "topology.json"),
          nodeCount: topology.nodes.length,
          edgeCount: topology.edges.length,
          sourceEventCount: topology.generatedFrom.eventCount,
          sourceLedgerCount: topology.generatedFrom.ledgerCount
        });
        sendJson(response, 200, topology);
        return;
      }

      if (url.pathname.startsWith("/api/narrative/")) {
        const requestedRunId = decodeURIComponent(url.pathname.slice("/api/narrative/".length));
        if (requestedRunId === "demo-empty") {
          sendJson(response, 200, buildEmptyNarrativePayload());
          return;
        }
        if (requestedRunId === "demo-loading") {
          await delay(1_600);
          const topology = buildRunTopology({ runId, events: session.recorder.events, ledger: session.recorder.ledger });
          sendJson(response, 200, buildRunNarrative({ runId, events: session.recorder.events, ledger: session.recorder.ledger, topology }));
          return;
        } else if (requestedRunId !== runId && requestedRunId !== "latest") {
          sendJson(response, 404, { error: "narrative_run_not_found", runId: requestedRunId });
          return;
        }
        const topology = await generateAndPersistTopology({
          runId,
          runDir: session.recorder.runDir,
          events: session.recorder.events,
          ledger: session.recorder.ledger
        });
        const narrative = await generateAndPersistNarrative({
          runId,
          runDir: session.recorder.runDir,
          events: session.recorder.events,
          ledger: session.recorder.ledger,
          topology
        });
        await session.emitGeneratedArtifact("narrative.generated", "Run health narrative generated", {
          runId,
          path: path.join(session.recorder.runDir, "narrative.json"),
          sourceEventCount: narrative.generatedFrom.eventCount,
          sourceLedgerCount: narrative.generatedFrom.ledgerCount
        });
        sendJson(response, 200, narrative);
        return;
      }

      if (url.pathname === "/api/failures") {
        sendJson(response, 200, await buildFailuresPayload(runId, session.recorder.events, session.recorder.runDir, configuredBaseUrl(host, port, server)));
        return;
      }

      if (url.pathname === "/api/impact") {
        sendJson(response, 200, buildImpactPayload(runId, session.recorder.ledger));
        return;
      }

      if (url.pathname.startsWith("/api/traces/")) {
        const requestedTraceId = decodeURIComponent(url.pathname.slice("/api/traces/".length));
        sendJson(response, 200, await buildTracePayload(runId, session.recorder.events, requestedTraceId, session.recorder.runDir));
        return;
      }

      if (url.pathname === "/api/policies") {
        if (request.method === "PUT") {
          const body = await readJsonBody(request, 64 * 1024);
          sendJson(response, 200, buildPolicyPayload(runId, session.recorder.events, body.ok ? body.payload : undefined));
          return;
        }
        sendJson(response, 200, buildPolicyPayload(runId, session.recorder.events));
        return;
      }

      if (url.pathname === "/api/policy/simulate") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const body = await readJsonBody(request, 64 * 1024);
        if (!body.ok || !isRecord(body.payload)) {
          sendJson(response, body.ok ? 400 : body.statusCode, { error: body.ok ? "invalid_policy_simulation_request" : body.message });
          return;
        }
        const scenarioId = parseScenarioId(body.payload.scenarioId);
        if (!scenarioId) {
          sendJson(response, 400, { error: "unknown_policy_simulation_scenario" });
          return;
        }
        const simulation = await simulatePolicy({
          session,
          scenarioId,
          proposedPolicy: isRecord(body.payload.proposedPolicy) ? body.payload.proposedPolicy : {}
        });
        sendJson(response, 200, simulation);
        return;
      }

      if (url.pathname === "/api/integrations") {
        sendJson(response, 200, buildIntegrationsPayload(runId));
        return;
      }

      if (url.pathname === "/api/integrations/verify") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const body = await readJsonBody(request, 64 * 1024);
        if (!body.ok || !isRecord(body.payload)) {
          sendJson(response, body.ok ? 400 : body.statusCode, { error: body.ok ? "invalid_integration_verification_request" : body.message });
          return;
        }
        const routeType = parseRouteType(body.payload.routeType);
        if (!routeType) {
          sendJson(response, 400, { error: "unknown_integration_route_type" });
          return;
        }
        sendJson(response, 200, await verifyIntegrationRoute({ session, routeType }));
        return;
      }

      if (url.pathname === "/api/story") {
        sendJson(response, 200, buildDemoStoryModePayload());
        return;
      }

      if (url.pathname === "/api/story/reset") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const body = await readJsonBody(request, 64 * 1024);
        if (!body.ok || !isRecord(body.payload) || typeof body.payload.scenarioId !== "string") {
          sendJson(response, body.ok ? 400 : body.statusCode, { error: body.ok ? "invalid_story_reset_request" : body.message });
          return;
        }
        const reset = await storyScenarioRuntime.resetScenario(body.payload.scenarioId as DemoStoryScenarioId);
        sendJson(response, reset.ok === false ? 404 : 200, reset);
        return;
      }

      if (url.pathname === "/api/replay") {
        if (request.method === "POST") {
          const body = await readJsonBody(request, 64 * 1024);
          if (!body.ok) {
            sendJson(response, body.statusCode, { status: "failed", error: body.message });
            return;
          }
          const replay = await handleReplayRequest({
            runId,
            session,
            registry,
            downstreamServerId,
            payload: body.payload
          });
          sendJson(response, replay.statusCode, replay.body);
          return;
        }
        sendJson(response, 200, buildReplayPayload(runId, session.recorder.events));
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
        const baseUrl = configuredBaseUrl(host, port, server);
        sendJson(response, 200, {
          runId,
          reportHtml: report.reportPath,
          reportUrl: reportFileUrl(baseUrl, runId, "report.html"),
          manifestJson: report.manifestPath,
          manifestUrl: reportFileUrl(baseUrl, runId, "manifest.json"),
          artifactHashList: report.artifactHashPath,
          artifactHashUrl: reportFileUrl(baseUrl, runId, "artifact-hashes.json"),
          redactionSummary: report.redactionSummaryPath,
          redactionSummaryUrl: reportFileUrl(baseUrl, runId, "redaction-summary.json"),
          manifestValid: validation.valid,
          validationErrors: validation.errors
        });
        return;
      }

      if (url.pathname === "/api/bundle/export") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const body = await readJsonBody(request, 64 * 1024);
        if (!body.ok) {
          sendJson(response, body.statusCode, { error: body.message });
          return;
        }
        const replaySafety = isRecord(body.payload) && isRecord(body.payload.replaySafety) ? body.payload.replaySafety : {};
        const bundle = await exportEvidenceBundle({
          session,
          replaySafety: {
            fixtureOnly: replaySafety.fixtureOnly === true,
            safeLoopback: replaySafety.safeLoopback === true
          }
        });
        sendJson(response, 200, {
          runId,
          bundleDir: bundle.bundleDir,
          manifestJson: bundle.manifestPath,
          manifestUrl: bundleFileUrl(configuredBaseUrl(host, port, server), runId, "manifest.json"),
          manifestValidation: bundle.validationPath,
          manifestValidationUrl: bundleFileUrl(configuredBaseUrl(host, port, server), runId, "manifest-validation.json"),
          manifestValid: bundle.validation.valid,
          validationErrors: bundle.validation.errors,
          replayInstructions: bundle.manifest.replay.instructionsFile
            ? path.join(bundle.bundleDir, bundle.manifest.replay.instructionsFile)
            : undefined,
          replayInstructionsUrl: bundle.manifest.replay.instructionsFile
            ? bundleFileUrl(configuredBaseUrl(host, port, server), runId, bundle.manifest.replay.instructionsFile)
            : undefined,
          files: bundle.manifest.files
        });
        return;
      }

      if (url.pathname === "/api/bundle") {
        sendJson(response, 200, await buildBundlePayload({ runId, runDir: session.recorder.runDir, baseUrl: configuredBaseUrl(host, port, server) }));
        return;
      }

      if (url.pathname.startsWith("/api/bundles/") && url.pathname.includes("/files/")) {
        await serveBundleFile({
          response,
          runId,
          requestedPath: url.pathname,
          runDir: session.recorder.runDir
        });
        return;
      }

      if (url.pathname === "/api/reports") {
        sendJson(response, 200, await buildReportsPayload({ runId, runDir: session.recorder.runDir, events: session.recorder.events, baseUrl: configuredBaseUrl(host, port, server) }));
        return;
      }

      if (url.pathname.startsWith("/api/reports/") && url.pathname.includes("/files/")) {
        await serveReportFile({
          response,
          runId,
          requestedPath: url.pathname,
          runDir: session.recorder.runDir
        });
        return;
      }

      if (url.pathname.startsWith("/api/reports/") && url.pathname.includes("/artifacts/")) {
        await serveArtifactFile({
          response,
          runId,
          requestedPath: url.pathname,
          runDir: session.recorder.runDir,
          events: session.recorder.events
        });
        return;
      }

      if (url.pathname.startsWith("/api/reports/")) {
        const requestedRunId = decodeURIComponent(url.pathname.slice("/api/reports/".length));
        if (requestedRunId !== runId && requestedRunId !== "latest") {
          sendJson(response, 404, { error: "report_run_not_found", runId: requestedRunId });
          return;
        }
        sendJson(response, 200, await buildReportDetailPayload({ runId, runDir: session.recorder.runDir, events: session.recorder.events, baseUrl: configuredBaseUrl(host, port, server) }));
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
    harnessName: stringFrom(payload.harnessName, "python-framework"),
    adapterId: stableIdFrom(payload.adapterId ?? payload.correlation?.adapterId, createId("adapter")),
    adapterName: stringFrom(payload.adapterName, "toolguard-python-adapter"),
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
    sourcePath: "framework-adapter",
    runName: stringFrom(payload.runName, `python ${toolName}`),
    tags: stringArrayFrom(payload.tags),
    labels: safeLabelsFrom(payload.labels)
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
    harnessName: stringFrom(payload?.harnessName, "python-framework"),
    adapterId: stableIdFrom(payload?.adapterId ?? payload?.correlation?.adapterId, createId("adapter")),
    adapterName: stringFrom(payload?.adapterName, "toolguard-python-adapter"),
    downstreamServerId: stableIdFrom(payload?.downstreamServerId ?? payload?.correlation?.downstreamServerId, createId("server")),
    toolCallId: stableIdFrom(payload?.correlation?.toolCallId, createId("toolcall")),
    attemptId: stableIdFrom(payload?.correlation?.attemptId, createId("attempt")),
    policyDecisionId: stableIdFrom(payload?.correlation?.policyDecisionId, createId("policy")),
    toolName,
    arguments: {},
    deadlineMs: numberFrom(payload?.deadlineMs, 1_000),
    idempotency:
      payload?.idempotency === "non-idempotent" || payload?.idempotency === "unknown" ? payload.idempotency : "idempotent",
    sourcePath: "framework-adapter",
    runName: stringFrom(payload?.runName, `python ${toolName}`),
    tags: stringArrayFrom(payload?.tags),
    labels: safeLabelsFrom(payload?.labels)
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
  readonly harnessName?: unknown;
  readonly runName?: unknown;
  readonly tags?: unknown;
  readonly labels?: unknown;
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

function stringArrayFrom(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function safeLabelsFrom(value: unknown): NonNullable<ToolCall["labels"]> {
  if (!isRecord(value)) {
    return {};
  }
  return {
    ...(typeof value.session === "string" ? { session: value.session } : {}),
    ...(typeof value.task === "string" ? { task: value.task } : {}),
    ...(typeof value.repo === "string" ? { repo: value.repo } : {}),
    ...(typeof value.agent === "string" ? { agent: value.agent } : {})
  };
}

function isRecord(value: unknown): value is Record<string, JsonValue | unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildEmptyTopologyPayload(): JsonObject {
  return {
    runId: "demo-empty",
    generatedFrom: {
      eventCount: 0,
      ledgerCount: 0,
      lastEventSequence: 0
    },
    summary: {
      nodes: 0,
      edges: 0,
      failures: 0,
      blocked: 0,
      sideEffects: 0,
      artifacts: 0,
      reports: 0
    },
    nodes: [],
    edges: []
  };
}

function buildEmptyNarrativePayload(): JsonObject {
  return {
    runId: "demo-empty",
    generatedFrom: {
      eventCount: 0,
      ledgerCount: 0,
      lastEventSequence: 0
    },
    text: [
      "Root cause: No topology data has been recorded for this deterministic empty fixture run.",
      "Blast radius: None. No downstream calls, policy decisions, side effects, or artifacts exist.",
      "Side effects: None observed or simulated.",
      "Recovery status: Waiting for a ToolGuard run that emits topology evidence.",
      "Next safe action: Run a demo fixture when you want a populated topology, or keep this state to validate empty-state handling."
    ].join("\n"),
    sections: {
      rootCause: "No topology data has been recorded for this deterministic empty fixture run.",
      blastRadius: "None. No downstream calls, policy decisions, side effects, or artifacts exist.",
      sideEffects: "None observed or simulated.",
      recoveryStatus: "Waiting for a ToolGuard run that emits topology evidence.",
      nextSafeAction: "Run a demo fixture when you want a populated topology, or keep this state to validate empty-state handling."
    }
  };
}

function configuredBaseUrl(host: string, port: number, server: http.Server): string {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const loopbackHost = normalizeLoopbackHost(host);
  return `http://${loopbackHost}:${actualPort}`;
}

function currentServerPort(configuredPort: number, server: http.Server): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : configuredPort;
}

function normalizeLoopbackHost(host: string): string {
  if (host === "localhost" || host === "127.0.0.1") {
    return host;
  }
  if (host === "::1" || host === "[::1]") {
    return "[::1]";
  }
  return "127.0.0.1";
}

type ReportFileName = "report.html" | "manifest.json" | "artifact-hashes.json" | "redaction-summary.json";

const reportFileNames = new Set<ReportFileName>(["report.html", "manifest.json", "artifact-hashes.json", "redaction-summary.json"]);

function reportFileUrl(baseUrl: string, runId: StableId, fileName: ReportFileName): string {
  return `${baseUrl}/api/reports/${encodeURIComponent(runId)}/files/${fileName}`;
}

function artifactFileUrl(baseUrl: string, runId: StableId, artifactId: StableId): string {
  return `${baseUrl}/api/reports/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

function bundleFileUrl(baseUrl: string, runId: StableId, relativePath: string): string {
  const encodedPath = relativePath.split(/[\\/]+/).map((part) => encodeURIComponent(part)).join("/");
  return `${baseUrl}/api/bundles/${encodeURIComponent(runId)}/files/${encodedPath}`;
}

async function serveReportFile(input: {
  readonly response: http.ServerResponse;
  readonly runId: StableId;
  readonly requestedPath: string;
  readonly runDir: string;
}): Promise<void> {
  const match = /^\/api\/reports\/([^/]+)\/files\/([^/]+)$/.exec(input.requestedPath);
  const requestedRunId = match ? decodeURIComponent(match[1] ?? "") : "";
  const requestedFileName = match ? decodeURIComponent(match[2] ?? "") : "";
  if ((requestedRunId !== input.runId && requestedRunId !== "latest") || !reportFileNames.has(requestedFileName as ReportFileName)) {
    sendJson(input.response, 404, { error: "report_file_not_found", runId: requestedRunId, fileName: requestedFileName });
    return;
  }
  await serveRunFile(input.response, input.runDir, requestedFileName, contentTypeForFile(requestedFileName));
}

async function serveArtifactFile(input: {
  readonly response: http.ServerResponse;
  readonly runId: StableId;
  readonly requestedPath: string;
  readonly runDir: string;
  readonly events: readonly CoreEvent[];
}): Promise<void> {
  const match = /^\/api\/reports\/([^/]+)\/artifacts\/([^/]+)$/.exec(input.requestedPath);
  const requestedRunId = match ? decodeURIComponent(match[1] ?? "") : "";
  const requestedArtifactId = match ? decodeURIComponent(match[2] ?? "") : "";
  const artifact = input.events
    .flatMap((event) => (isEvidenceArtifact(event.data) ? [event.data] : []))
    .find((candidate) => candidate.artifactId === requestedArtifactId);
  if ((requestedRunId !== input.runId && requestedRunId !== "latest") || !artifact) {
    sendJson(input.response, 404, { error: "artifact_not_found", runId: requestedRunId, artifactId: requestedArtifactId });
    return;
  }
  await serveSafeArtifactFile(input.response, input.runDir, artifact);
}

async function serveBundleFile(input: {
  readonly response: http.ServerResponse;
  readonly runId: StableId;
  readonly requestedPath: string;
  readonly runDir: string;
}): Promise<void> {
  const match = /^\/api\/bundles\/([^/]+)\/files\/(.+)$/.exec(input.requestedPath);
  const requestedRunId = match ? decodeURIComponent(match[1] ?? "") : "";
  const requestedRelativePath = match
    ? (match[2] ?? "").split("/").map((part) => decodeURIComponent(part)).join(path.sep)
    : "";
  if ((requestedRunId !== input.runId && requestedRunId !== "latest") || requestedRelativePath.length === 0) {
    sendJson(input.response, 404, { error: "bundle_file_not_found", runId: requestedRunId, fileName: requestedRelativePath });
    return;
  }
  await serveRunFile(input.response, path.join(input.runDir, "bundle"), requestedRelativePath, contentTypeForBundleFile(requestedRelativePath), requestedRelativePath.includes(`raw-untrusted${path.sep}`));
}

async function serveRunFile(response: http.ServerResponse, runDir: string, relativePath: string, contentType: string, rawUntrusted = false): Promise<void> {
  const safeRunDir = path.resolve(runDir);
  const filePath = path.resolve(runDir, relativePath);
  if (filePath !== safeRunDir && !filePath.startsWith(`${safeRunDir}${path.sep}`)) {
    sendJson(response, 403, { error: "path_outside_run_directory" });
    return;
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(rawUntrusted ? { "x-toolguard-raw-untrusted": "true" } : {})
    });
    response.end(content);
  } catch (error) {
    sendJson(response, 404, { error: "file_not_found", message: error instanceof Error ? error.message : "Could not read run file." });
  }
}

async function serveSafeArtifactFile(response: http.ServerResponse, runDir: string, artifact: EvidenceArtifact): Promise<void> {
  const safeRunDir = path.resolve(runDir);
  const filePath = path.resolve(runDir, artifact.relativePath);
  if (filePath !== safeRunDir && !filePath.startsWith(`${safeRunDir}${path.sep}`)) {
    sendJson(response, 403, { error: "path_outside_run_directory" });
    return;
  }
  try {
    const content = await readFile(filePath, "utf8");
    const redacted = redactStringWithSummary(content);
    response.writeHead(200, {
      "content-type": contentTypeForArtifact(artifact),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-toolguard-redacted": String(redacted.count > 0 || artifact.redacted)
    });
    response.end(redacted.value);
  } catch (error) {
    sendJson(response, 404, { error: "file_not_found", message: error instanceof Error ? error.message : "Could not read run artifact." });
  }
}

function contentTypeForFile(fileName: string): string {
  return fileName.endsWith(".html") ? "text/html; charset=utf-8" : "application/json; charset=utf-8";
}

function contentTypeForBundleFile(fileName: string): string {
  if (fileName.endsWith(".html")) return "text/html; charset=utf-8";
  if (fileName.endsWith(".txt") || fileName.endsWith(".jsonl")) return "text/plain; charset=utf-8";
  return "application/json; charset=utf-8";
}

function contentTypeForArtifact(artifact: EvidenceArtifact): string {
  return artifact.relativePath.endsWith(".json") || artifact.kind === "raw-result" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
}

async function handleReplayRequest(input: {
  readonly runId: StableId;
  readonly session: CoreSession;
  readonly registry: ToolRegistry;
  readonly downstreamServerId: StableId;
  readonly payload: Record<string, unknown>;
}): Promise<{ readonly statusCode: number; readonly body: JsonObject }> {
  const sourceRunId = stringValue(input.payload.sourceRunId, input.runId);
  const requestedTool = stringValue(input.payload.toolName, "fixture.wrong-cwd");
  const fixtureOnly = input.payload.fixtureOnly === true;
  const realWorld = input.payload.mode === "real-world" || input.payload.realWorld === true;
  const destructive = input.payload.destructive === true || requestedTool.includes("rm -rf") || requestedTool.includes("delete");
  if (!fixtureOnly || realWorld || destructive) {
    return {
      statusCode: 409,
      body: {
        status: "blocked",
        replayId: createId("report"),
        sourceRunId,
        runId: input.runId,
        reason: "Replay is fixture-only. Destructive or real-world commands are blocked before execution.",
        safe: false,
        fixtureOnly
      }
    };
  }
  const toolName = requestedTool.startsWith("fixture.") ? requestedTool : "fixture.wrong-cwd";
  const tool = input.registry.get(toolName);
  if (!tool) {
    return {
      statusCode: 404,
      body: {
        status: "failed",
        replayId: createId("report"),
        sourceRunId,
        runId: input.runId,
        reason: `Replay fixture ${toolName} is not registered.`,
        safe: false,
        fixtureOnly: true
      }
    };
  }
  const call = makeReplayToolCall(input.runId, input.downstreamServerId, toolName, sourceRunId);
  const result = await input.session.executeToolCall(input.registry, call);
  return {
    statusCode: "failureType" in result ? 200 : 201,
    body: {
      status: "failureType" in result ? "failed" : "success",
      replayId: createId("report"),
      sourceRunId,
      runId: call.runId,
      freshCorrelation: {
        traceId: call.traceId,
        ...(call.parentId ? { parentId: call.parentId } : {}),
        harnessId: call.harnessId,
        adapterId: call.adapterId,
        downstreamServerId: call.downstreamServerId,
        toolCallId: call.toolCallId,
        attemptId: call.attemptId,
        policyDecisionId: call.policyDecisionId
      },
      fixtureOnly: true,
      safe: true,
      result: result as unknown as JsonValue
    }
  };
}

function makeReplayToolCall(runId: StableId, downstreamServerId: StableId, toolName: string, sourceRunId: string): ToolCall {
  return {
    runId,
    traceId: createId("trace"),
    parentId: sourceRunId as StableId,
    harnessId: createId("harness"),
    adapterId: createId("adapter"),
    downstreamServerId,
    toolCallId: createId("toolcall"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName,
    arguments: {},
    deadlineMs: 1_000,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct"
  };
}

function buildReplayPayload(runId: StableId, events: readonly CoreEvent[]): JsonObject {
  const failedEvents = events.filter((event) => event.type === "tool.call.failed");
  return {
    runId,
    generatedAt: new Date().toISOString(),
    replayableRuns: [
      {
        sourceRunId: runId,
        label: failedEvents.length > 0 ? "Latest failed ToolGuard run" : "Latest ToolGuard run",
        failureCount: failedEvents.length,
        safe: true,
        fixtureOnly: true
      }
    ],
    fixtures: [
      {
        id: "fixture.wrong-cwd",
        label: "Wrong cwd failure reconstruction",
        status: "safe",
        safe: true,
        fixtureOnly: true,
        destructiveRisk: "none",
        description: "Replays the deterministic cwd mismatch failure with fresh correlation IDs."
      },
      {
        id: "fixture.prompt-injection-output",
        label: "Prompt-injection sanitizer proof",
        status: "safe",
        safe: true,
        fixtureOnly: true,
        destructiveRisk: "none",
        description: "Replays a safe fixture that proves suspicious output stays contained."
      },
      {
        id: "real-world.rm-rf",
        label: "Real-world destructive command",
        status: "blocked",
        safe: false,
        fixtureOnly: false,
        destructiveRisk: "high",
        description: "Blocked by policy. Replay Lab never executes destructive real-world commands."
      }
    ],
    latestReplayEvents: events
      .filter((event) => event.parentId === runId)
      .slice(-8) as unknown as JsonValue
  };
}

async function buildReportsPayload(input: {
  readonly runId: StableId;
  readonly runDir: string;
  readonly events: readonly CoreEvent[];
  readonly baseUrl: string;
}): Promise<JsonObject> {
  const detail = await buildReportDetailPayload(input);
  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    reports: [detail]
  };
}

async function buildValidationDashboardPayload(input: {
  readonly runId: StableId;
  readonly runDir: string;
  readonly events: readonly CoreEvent[];
  readonly currentServerPort?: number;
}): Promise<JsonObject> {
  const reportExists = await fileExists(path.join(input.runDir, "report.html"));
  const manifestExists = await fileExists(path.join(input.runDir, "manifest.json"));
  const bundleManifestExists = await fileExists(path.join(input.runDir, "bundle", "manifest.json"));
  const topologyExists = await fileExists(path.join(input.runDir, "topology.json"));
  const narrativeExists = await fileExists(path.join(input.runDir, "narrative.json"));
  const ledgerExists = await fileExists(path.join(input.runDir, "ledger.jsonl"));
  const scanText = await readExistingFiles([
    path.join(input.runDir, "ledger.jsonl"),
    path.join(input.runDir, "topology.json"),
    path.join(input.runDir, "narrative.json"),
    path.join(input.runDir, "bundle", "manifest.json"),
    path.join(input.runDir, "bundle", "replay-instructions.json")
  ]);
  const secretFindings = findSecretPatterns(scanText);
  const approvedPorts = [3660, 3661, 3662, 3663, 3664, 3665, 3666, 3667, 3668, 3669];
  const processHygiene = await probeProcessHygiene({
    approvedPorts,
    currentServerPort: input.currentServerPort,
    currentPid: process.pid
  });
  const checks = [
    validationCheck("tests", "Tests", "warn", "Run `pnpm test` for the current checkout gate transcript."),
    validationCheck("typecheck", "Typecheck", "warn", "Run `pnpm typecheck` for the current checkout gate transcript."),
    validationCheck("lint", "Lint", "warn", "Run `pnpm lint` for the current checkout gate transcript."),
    validationCheck(
      "demo-readiness",
      "Demo readiness",
      input.events.some((event) => event.type === "run.started") && input.events.some((event) => event.type === "tool.call.failed")
        ? "pass"
        : "warn",
      input.events.some((event) => event.type === "run.started")
        ? "Deterministic local run events and Failure Card evidence are present."
        : "Run `pnpm demo` to populate deterministic demo evidence."
    ),
    validationCheck(
      "evidence-export",
      "Evidence export",
      reportExists && manifestExists && bundleManifestExists ? "pass" : reportExists && manifestExists ? "warn" : "fail",
      reportExists && manifestExists && bundleManifestExists
        ? "Static report, manifest, and evidence bundle manifest are present."
        : "Export report and bundle from the local Core loopback API."
    ),
    validationCheck(
      "no-secret-scan",
      "No-secret scan",
      secretFindings.length === 0 ? "pass" : "fail",
      secretFindings.length === 0
        ? "No secret-shaped values found in ledger, topology labels, narratives, bundle metadata, or story text."
        : `Secret-shaped findings: ${secretFindings.join(", ")}`
    ),
    validationCheck(
      "process-hygiene",
      "Process hygiene",
      processHygiene.status,
      processHygiene.detail
    )
  ];

  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    deterministicSeed: "toolguard-flagship-demo-v0.11",
    approvedPorts,
    artifactCoverage: {
      ledger: ledgerExists,
      topology: topologyExists,
      narrative: narrativeExists,
      report: reportExists,
      manifest: manifestExists,
      bundleManifest: bundleManifestExists
    },
    processHygiene,
    checks
  };
}

async function probeProcessHygiene(input: {
  readonly approvedPorts: readonly number[];
  readonly currentServerPort: number | undefined;
  readonly currentPid: number;
}): Promise<{
  readonly status: "pass" | "warn" | "fail";
  readonly detail: string;
  readonly approvedPorts: number[];
  readonly openApprovedPorts: number[];
  readonly expectedOpenPorts: number[];
  readonly unexpectedOpenPorts: number[];
  readonly currentPid: number;
}> {
  const openApprovedPorts = await openLoopbackPorts(input.approvedPorts);
  const expectedOpenPorts: number[] =
    input.currentServerPort && input.approvedPorts.includes(input.currentServerPort) ? [input.currentServerPort] : [];
  const unexpectedOpenPorts = openApprovedPorts.filter((port) => !expectedOpenPorts.includes(port));
  const approvedPortRange = `${input.approvedPorts[0]}-${input.approvedPorts.at(-1)}`;
  if (unexpectedOpenPorts.length > 0) {
    return {
      status: "fail",
      detail: `Local cleanup probe found unexpected ToolGuard-owned approved loopback ports still open: ${unexpectedOpenPorts.join(
        ", "
      )}. Expected open ports: ${expectedOpenPorts.join(", ") || "none"}; current Core PID: ${input.currentPid}.`,
      approvedPorts: [...input.approvedPorts],
      openApprovedPorts,
      expectedOpenPorts,
      unexpectedOpenPorts,
      currentPid: input.currentPid
    };
  }

  return {
    status: "pass",
    detail: `Local cleanup probe checked approved loopback ports ${approvedPortRange}; no unexpected ToolGuard-owned ports are open. Expected open ports: ${
      expectedOpenPorts.join(", ") || "none"
    }; current Core PID: ${input.currentPid}.`,
    approvedPorts: [...input.approvedPorts],
    openApprovedPorts,
    expectedOpenPorts,
    unexpectedOpenPorts,
    currentPid: input.currentPid
  };
}

async function openLoopbackPorts(ports: readonly number[]): Promise<number[]> {
  const states = await Promise.all(ports.map(async (port) => ({ port, open: await isLoopbackPortOpen(port) })));
  return states.filter((state) => state.open).map((state) => state.port);
}

async function isLoopbackPortOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

function validationCheck(id: string, label: string, status: "pass" | "fail" | "warn", detail: string): JsonObject {
  return { id, label, status, detail };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readExistingFiles(filePaths: readonly string[]): Promise<string> {
  const chunks: string[] = [];
  for (const filePath of filePaths) {
    try {
      chunks.push(await readFile(filePath, "utf8"));
    } catch {
      // Missing optional outputs are represented by validation checks, not scan failures.
    }
  }
  chunks.push(JSON.stringify(buildDemoStoryModePayload()));
  return chunks.join("\n");
}

function findSecretPatterns(text: string): readonly string[] {
  const patterns: readonly [string, RegExp][] = [
    ["bearer-token", /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
    ["openai-key", /sk-[A-Za-z0-9]{12,}/],
    ["private-key", /-----BEGIN [A-Z ]+PRIVATE KEY-----/],
    ["api-key-assignment", /\b(api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i]
  ];
  return patterns.flatMap(([label, pattern]) => (pattern.test(text) ? [label] : []));
}

async function buildReportDetailPayload(input: {
  readonly runId: StableId;
  readonly runDir: string;
  readonly events: readonly CoreEvent[];
  readonly baseUrl: string;
}): Promise<JsonObject> {
  const reportPath = path.join(input.runDir, "report.html");
  const manifestPath = path.join(input.runDir, "manifest.json");
  const artifactHashPath = path.join(input.runDir, "artifact-hashes.json");
  const redactionSummaryPath = path.join(input.runDir, "redaction-summary.json");
  const manifest = await readJsonFile(manifestPath);
  const artifactHashes = await readJsonFile(artifactHashPath);
  const redactionSummary = await readJsonFile(redactionSummaryPath);
  const validation = await validateReportManifest({ runDir: input.runDir }).catch((error: unknown) => ({
    valid: false,
    errors: [error instanceof Error ? error.message : String(error)]
  }));
  const failureCards = input.events
    .filter((event) => event.type === "tool.call.failed" && isFailureCard(event.data))
    .map((event) => event.data as FailureCard);
  const artifacts = input.events.flatMap((event) => (isEvidenceArtifact(event.data) ? [event.data] : []));
  const narrative = failureCards.length
    ? failureCards.map((failure) => `${failure.toolName}: ${failure.failureType}. ${failure.likelyRootCause}`).join("\n")
    : "No failures recorded. Report exports still include events, hashes, and redaction proof.";
  const remediation = failureCards.flatMap((failure) => failure.safeRecoveryOptions).join("\n");
  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    reportHtml: reportPath,
    reportUrl: reportFileUrl(input.baseUrl, input.runId, "report.html"),
    manifestJson: manifestPath,
    manifestUrl: reportFileUrl(input.baseUrl, input.runId, "manifest.json"),
    artifactHashList: artifactHashPath,
    artifactHashUrl: reportFileUrl(input.baseUrl, input.runId, "artifact-hashes.json"),
    redactionSummaryPath,
    redactionSummaryUrl: reportFileUrl(input.baseUrl, input.runId, "redaction-summary.json"),
    manifestValid: validation.valid,
    validationErrors: [...validation.errors],
    artifactCount: artifacts.length,
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      artifactUrl: artifactFileUrl(input.baseUrl, input.runId, artifact.artifactId)
    })) as unknown as JsonValue,
    artifactHashes: (artifactHashes ?? []) as JsonValue,
    redactionSummary: (redactionSummary ?? { redactionCount: 0, reasons: [] }) as JsonValue,
    narrative,
    remediation: remediation || "No remediation required for successful fixture runs.",
    exists: Boolean(manifest)
  };
}

async function buildBundlePayload(input: {
  readonly runId: StableId;
  readonly runDir: string;
  readonly baseUrl: string;
}): Promise<JsonObject> {
  const bundleDir = path.join(input.runDir, "bundle");
  const manifestPath = path.join(bundleDir, "manifest.json");
  const validationPath = path.join(bundleDir, "manifest-validation.json");
  const manifest = await readJsonFile(manifestPath);
  if (!isEvidenceBundleManifest(manifest)) {
    return {
      runId: input.runId,
      generatedAt: new Date().toISOString(),
      bundle: {
        exists: false,
        manifestHealth: {
          status: "missing",
          label: "No evidence bundle exported",
          summary: "Create a bundle to inspect manifest health, hashes, redaction status, and replay safety."
        },
        artifactHashStatus: {
          status: "missing",
          label: "No artifact hash list",
          summary: "artifact-hashes.json is generated during bundle export."
        },
        redactionStatus: {
          status: "missing",
          label: "No redaction summary",
          summary: "redaction-summary.json is generated during bundle export."
        },
        replaySafetyStatus: {
          status: "missing",
          label: "Replay safety unknown",
          summary: "Replay safety is evaluated from fixture-only or safe loopback evidence."
        }
      }
    };
  }

  const validation = await validateEvidenceBundleManifest({ bundleDir }).catch((error: unknown) => ({
    valid: false,
    errors: [error instanceof Error ? error.message : String(error)]
  }));
  const validationFile = await readJsonFile(validationPath);
  const redactionSummary = await readJsonFile(path.join(bundleDir, manifest.redaction.summaryFile));
  const redactionCount = isRecord(redactionSummary) && typeof redactionSummary.redactionCount === "number" ? redactionSummary.redactionCount : 0;
  const redactionReasons = isRecord(redactionSummary) && Array.isArray(redactionSummary.reasons)
    ? redactionSummary.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  const requiredFiles = Object.entries(manifest.files).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const hashByPath = new Map(manifest.artifactHashes.map((artifact) => [artifact.relativePath, artifact]));
  const fileRows = requiredFiles.map(([key, relativePath]) => {
    const hash = hashByPath.get(relativePath);
    return {
      key,
      relativePath,
      url: bundleFileUrl(input.baseUrl, input.runId, relativePath),
      present: !validation.errors.some((error) => error.includes(relativePath) && error.startsWith("Missing bundle file reference")),
      hashed: Boolean(hash),
      sha256: hash?.sha256 ?? "",
      byteLength: hash?.byteLength ?? 0
    };
  });
  const rawArtifacts = manifest.rawArtifacts.map((relativePath) => {
    const hash = hashByPath.get(relativePath);
    return {
      relativePath,
      url: bundleFileUrl(input.baseUrl, input.runId, relativePath),
      sha256: hash?.sha256 ?? "",
      byteLength: hash?.byteLength ?? 0
    };
  });

  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    bundle: {
      exists: true,
      bundleId: manifest.bundleId,
      bundleDir,
      generatedAt: manifest.generatedAt,
      manifestJson: manifestPath,
      manifestUrl: bundleFileUrl(input.baseUrl, input.runId, "manifest.json"),
      manifestValidation: validationPath,
      manifestValidationUrl: bundleFileUrl(input.baseUrl, input.runId, "manifest-validation.json"),
      manifestValid: validation.valid,
      validationErrors: [...validation.errors],
      reportManifestValid: manifest.reportManifestValidation.valid,
      reportManifestErrors: [...manifest.reportManifestValidation.errors],
      replaySafe: manifest.replay.safe,
      replayReason: manifest.replay.reason,
      replayInstructionsUrl: manifest.replay.instructionsFile ? bundleFileUrl(input.baseUrl, input.runId, manifest.replay.instructionsFile) : "",
      files: fileRows,
      rawArtifacts,
      artifactHashes: manifest.artifactHashes.map((artifact) => ({ ...artifact })),
      redactionSummary: {
        redactionCount,
        reasons: redactionReasons
      },
      manifestHealth: {
        status: validation.valid && manifest.reportManifestValidation.valid ? "healthy" : "failed",
        label: validation.valid && manifest.reportManifestValidation.valid ? "Manifest valid" : "Manifest needs attention",
        summary: validation.valid
          ? "Bundle manifest references resolve, artifact hashes match, and the report manifest validation is included."
          : validation.errors.join("\n")
      },
      artifactHashStatus: {
        status: validation.valid ? "healthy" : "failed",
        label: validation.valid ? `${manifest.artifactHashes.length} hashed bundle files` : "Hash validation failed",
        summary: validation.valid ? "All required bundle files include matching SHA-256 entries." : validation.errors.join("\n")
      },
      redactionStatus: {
        status: "healthy",
        label: `${redactionCount} redactions recorded`,
        summary: redactionReasons.length ? redactionReasons.join("\n") : "No secret-shaped values appeared in the safe bundle summary."
      },
      replaySafetyStatus: {
        status: manifest.replay.safe ? "healthy" : "blocked",
        label: manifest.replay.safe ? "Replay instructions safe" : "Replay withheld",
        summary: manifest.replay.reason
      },
      validationFile: validationFile ?? { valid: validation.valid, errors: [...validation.errors] }
    }
  };
}

async function readJsonFile(filePath: string): Promise<JsonValue | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as JsonValue;
  } catch {
    return undefined;
  }
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

  const downstreamServerRows = buildDownstreamServerHealthRows({
    findingRows,
    failureEvents,
    circuitOpenEvents,
    runId
  });

  const downstreamToolRows = findingRows.map((finding, index) => {
    const status = stringValue(finding.status, "degraded");
    const toolName = stringValue(finding.toolName, `tool-${index + 1}`);
    const downstreamServerId = stringValue(finding.downstreamServerId, "server:unknown");
    const failure = [...latestFailureByTarget.values()].find((event) => event.downstreamServerId === downstreamServerId);
    const failureCard = failure?.data && "failureType" in failure.data ? failure.data : undefined;
    return {
      id: `tool:${downstreamServerId}:${toolName}`,
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
  });

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
    ...downstreamServerRows,
    ...downstreamToolRows
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

function buildDownstreamServerHealthRows(input: {
  readonly findingRows: readonly Record<string, unknown>[];
  readonly failureEvents: readonly CoreEvent[];
  readonly circuitOpenEvents: readonly CoreEvent[];
  readonly runId: StableId;
}): JsonObject[] {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const finding of input.findingRows) {
    const downstreamServerId = stringValue(finding.downstreamServerId, "server:unknown");
    grouped.set(downstreamServerId, [...(grouped.get(downstreamServerId) ?? []), finding]);
  }

  return [...grouped.entries()].map(([downstreamServerId, serverFindings]) => {
    const statuses = serverFindings.map((finding) => stringValue(finding.status, "degraded"));
    const status = statuses.includes("failed") ? "failed" : statuses.includes("degraded") ? "degraded" : "healthy";
    const latestFailure = [...input.failureEvents].reverse().find((event) => event.downstreamServerId === downstreamServerId);
    const failureType = failureCardField(latestFailure?.data, "failureType", status === "healthy" ? "none" : "preflight_degraded");
    const retryable = failureCardField(latestFailure?.data, "retryable", status !== "healthy");
    const toolCount = serverFindings.length;
    const degradedCount = statuses.filter((entry) => entry === "degraded").length;
    const failedCount = statuses.filter((entry) => entry === "failed").length;
    const remediation =
      status === "healthy"
        ? `All ${toolCount} downstream tools passed preflight.`
        : `${failedCount} failed and ${degradedCount} degraded tool preflight checks. Inspect server-level connectivity before retrying tools.`;

    return {
      id: `server:${downstreamServerId}`,
      layer: "downstream server",
      name: downstreamServerId,
      status,
      preflight: status,
      latencyMs: status === "healthy" ? 22 : status === "degraded" ? 96 : 0,
      failureType,
      retryable,
      circuitState: input.circuitOpenEvents.some((event) => event.downstreamServerId === downstreamServerId) ? "open" : "closed",
      remediation,
      runId: input.runId,
      downstreamServerId
    };
  });
}

async function buildFailuresPayload(runId: StableId, events: readonly CoreEvent[], runDir: string, baseUrl: string): Promise<JsonObject> {
  const artifactEvents = events.filter((event) => event.type === "evidence.artifact.created");
  const artifacts = artifactEvents.flatMap((event) => (isEvidenceArtifact(event.data) ? [event.data] : []));
  const sanitizedEvents = events.filter((event) => event.type === "output.sanitized");
  const failures = await Promise.all(events
    .filter((event) => event.type === "tool.call.failed" && isFailureCard(event.data))
    .map(async (event) => {
      const card = event.data as FailureCard;
      const linkedArtifactIds = new Set(card.evidenceLinks.map((link) => link.artifactId));
      const cardArtifacts = await enrichArtifacts(
        runDir,
        artifacts.filter((artifact) => linkedArtifactIds.has(artifact.artifactId) || artifact.toolCallId === event.toolCallId),
        events
      );
      return {
        ...card,
        evidenceLinks: card.evidenceLinks.map((link) => ({
          ...link,
          href: artifactFileUrl(baseUrl, runId, link.artifactId)
        })),
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        summary: event.summary,
        correlation: correlationFromCoreEvent(event),
        rawStdout: cardArtifacts.filter((artifact) => artifact.kind === "raw-stdout"),
        rawStderr: cardArtifacts.filter((artifact) => artifact.kind === "raw-stderr"),
        rawArtifacts: cardArtifacts,
        sanitizedEvents: sanitizedEvents.filter((sanitized) => sanitized.toolCallId === event.toolCallId)
      };
    }));
  return {
    runId,
    generatedAt: new Date().toISOString(),
    failures: failures as unknown as JsonValue
  };
}

function buildImpactPayload(runId: StableId, ledger: readonly SideEffectLedgerEntry[]): JsonObject {
  const entries = ledger.map((entry) => ({
    ledgerId: entry.ledgerId,
    recordedAt: entry.recordedAt,
    runId: entry.runId,
    traceId: entry.traceId,
    toolCallId: entry.toolCallId,
    attemptId: entry.attemptId,
    policyDecisionId: entry.policyDecisionId,
    toolName: entry.toolName,
    targetType: entry.targetType,
    effectState: entry.effectState,
    reversibility: entry.reversibility,
    operation: entry.operation,
    summary: entry.summary,
    attributionLevel: entry.attributionLevel,
    evidenceBasis: entry.evidenceBasis,
    causalClaim: entry.causalClaim,
    counterEvidence: entry.counterEvidence,
    blastRadius: entry.blastRadius,
    ...(entry.retryLoopFinding ? { retryLoopFinding: entry.retryLoopFinding } : {}),
    observedImpact: entry.observedImpact
      ? {
          workspaceRoot: entry.observedImpact.workspaceRoot,
          disposableWorkspace: entry.observedImpact.disposableWorkspace,
          pathContainment: entry.observedImpact.pathContainment,
          ...(entry.observedImpact.gitStatus ? { gitStatus: entry.observedImpact.gitStatus } : {}),
          fileChanges: entry.observedImpact.fileChanges,
          safeAffectedPaths: [
            ...new Set([
              ...entry.observedImpact.fileChanges.map((change) => change.path),
              ...entry.observedImpact.tempArtifactWrites
            ])
          ],
          tempArtifactWrites: entry.observedImpact.tempArtifactWrites,
          ...(entry.observedImpact.processLifecycle ? { processLifecycle: entry.observedImpact.processLifecycle } : {}),
          outcome: entry.observedImpact.outcome,
          rollbackGuidance: entry.observedImpact.rollbackGuidance,
          bundleHashes: entry.observedImpact.bundleHashes
        }
      : undefined
  }));
  return {
    runId,
    generatedAt: new Date().toISOString(),
    summary: {
      entries: ledger.length,
      observedChanges: ledger.reduce((count, entry) => count + (entry.observedImpact?.fileChanges.length ?? 0), 0),
      safeAffectedPaths: ledger.reduce(
        (count, entry) => count + new Set([...(entry.observedImpact?.fileChanges.map((change) => change.path) ?? []), ...(entry.observedImpact?.tempArtifactWrites ?? [])]).size,
        0
      ),
      processChildren: ledger.filter((entry) => Boolean(entry.observedImpact?.processLifecycle)).length,
      rollbackSteps: ledger.reduce((count, entry) => count + (entry.observedImpact?.rollbackGuidance.length ?? 0), 0),
      reversible: ledger.filter((entry) => entry.reversibility !== "irreversible-risk").length,
      blocked: ledger.filter((entry) => entry.effectState === "blocked").length
    },
    entries: entries as unknown as JsonValue
  };
}

async function buildTracePayload(runId: StableId, events: readonly CoreEvent[], requestedTraceId: string, runDir: string): Promise<JsonObject> {
  const fallbackTraceId = events.find((event) => event.traceId)?.traceId ?? "trace:waiting";
  const traceId = requestedTraceId === "latest" ? fallbackTraceId : requestedTraceId;
  const traceEvents = events.filter((event) => event.traceId === traceId);
  const baseEvents = traceEvents.length > 0 ? traceEvents : events;
  const artifacts = baseEvents.flatMap((event) => (isEvidenceArtifact(event.data) ? [event.data] : []));
  const rawArtifacts = await enrichArtifacts(runDir, artifacts, events);
  const warnings =
    traceEvents.length === 0 && events.length > 0
      ? [`Trace ${traceId} was not found. Showing latest run events as partial context.`]
      : [];
  return {
    runId,
    traceId,
    generatedAt: new Date().toISOString(),
    status: events.length === 0 ? "empty" : warnings.length > 0 ? "degraded" : "ready",
    events: baseEvents as unknown as JsonValue,
    nodes: buildTraceNodes(baseEvents),
    correlation: mergedCorrelationFromEvents(baseEvents, runId, traceId),
    rawStdout: rawArtifacts.filter((artifact) => artifact.kind === "raw-stdout") as unknown as JsonValue,
    rawStderr: rawArtifacts.filter((artifact) => artifact.kind === "raw-stderr") as unknown as JsonValue,
    rawArtifacts: rawArtifacts as unknown as JsonValue,
    warnings
  };
}

async function enrichArtifacts(runDir: string, artifacts: readonly EvidenceArtifact[], events: readonly CoreEvent[]): Promise<JsonObject[]> {
  return await Promise.all(artifacts.map(async (artifact) => {
    const outputLimit = outputLimitForArtifact(events, artifact.artifactId);
    const artifactPath = path.resolve(runDir, artifact.relativePath);
    const safeRunDir = path.resolve(runDir);
    if (!artifactPath.startsWith(`${safeRunDir}${path.sep}`)) {
      return {
        ...artifact,
        content: "",
        truncated: Boolean(outputLimit),
        ...(outputLimit ? { outputLimitBytes: outputLimit } : {}),
        contentUnavailable: "Artifact path is outside the run directory."
      };
    }
    try {
      const rawContent = await readFile(artifactPath, "utf8");
      const redacted = redactStringWithSummary(rawContent);
      return {
        ...artifact,
        content: redacted.value,
        truncated: Boolean(outputLimit),
        redacted: artifact.redacted || redacted.count > 0,
        redactionReasons: [...redacted.reasons],
        redactionCount: redacted.count,
        ...(outputLimit ? { outputLimitBytes: outputLimit } : {})
      };
    } catch (error) {
      return {
        ...artifact,
        content: "",
        truncated: Boolean(outputLimit),
        ...(outputLimit ? { outputLimitBytes: outputLimit } : {}),
        contentUnavailable: error instanceof Error ? error.message : "Artifact content could not be read."
      };
    }
  }));
}

function outputLimitForArtifact(events: readonly CoreEvent[], artifactId: StableId): number | undefined {
  const event = events.find((candidate) => {
    if (candidate.type !== "output.sanitized" || !isRecord(candidate.data)) {
      return false;
    }
    const data = sanitizedEventData(candidate.data);
    return data.artifactId === artifactId && data.reason === "output_limit";
  });
  if (event && isRecord(event.data)) {
    const data = sanitizedEventData(event.data);
    if (typeof data.outputLimitBytes === "number") {
      return data.outputLimitBytes;
    }
  }
  return undefined;
}

function sanitizedEventData(data: Record<string, unknown>): Record<string, unknown> {
  return isRecord(data.data) ? data.data : data;
}

function mergedCorrelationFromEvents(events: readonly CoreEvent[], runId: StableId, traceId: string): JsonObject {
  const correlation: Record<string, string> = { runId, traceId };
  for (const event of events) {
    for (const key of [
      "parentId",
      "harnessId",
      "adapterId",
      "downstreamServerId",
      "toolCallId",
      "attemptId",
      "policyDecisionId",
      "artifactId"
    ] as const) {
      if (!correlation[key] && typeof event[key] === "string") {
        correlation[key] = event[key];
      }
    }
  }
  return correlation;
}

function buildTraceNodes(events: readonly CoreEvent[]): JsonObject[] {
  const nodes = new Map<string, JsonObject>();
  for (const event of events) {
    const correlated = [
      ["harness", event.harnessId, undefined],
      ["adapter", event.adapterId, event.harnessId],
      ["downstream", event.downstreamServerId, event.adapterId],
      ["toolCall", event.toolCallId, event.downstreamServerId],
      ["attempt", event.attemptId, event.toolCallId],
      ["policyDecision", event.policyDecisionId, event.attemptId],
      ["artifact", event.artifactId, event.toolCallId]
    ] as const;
    for (const [kind, id, parentId] of correlated) {
      if (!id || nodes.has(id)) {
        continue;
      }
      nodes.set(id, {
        id,
        label: id,
        kind,
        ...(parentId ? { parentId } : {}),
        summary: `${kind} observed in ${event.type}`
      });
    }
  }
  return [...nodes.values()];
}

function buildPolicyPayload(runId: StableId, events: readonly CoreEvent[], draft?: Record<string, unknown>): JsonObject {
  const retryLimit = typeof draft?.retryLimit === "number" && Number.isFinite(draft.retryLimit) ? draft.retryLimit : 1;
  const timeoutMs = typeof draft?.timeoutMs === "number" && Number.isFinite(draft.timeoutMs) ? draft.timeoutMs : 1000;
  const decisions = events
    .filter((event) => event.type === "policy.decision" && isPolicyDecision(event.data))
    .map((event) => ({
      ...(event.data as PolicyDecision),
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      correlation: correlationFromCoreEvent(event)
    }));
  return {
    runId,
    generatedAt: new Date().toISOString(),
    decisions,
    rules: [
      {
        id: "retry-limit",
        label: "Bounded retry rules",
        value: `${retryLimit} retry maximum`,
        description: "Retryable failures are retried only within configured limits and every attempt is evidenced."
      },
      {
        id: "circuit-threshold",
        label: "Circuit thresholds",
        value: "2 qualifying failures open circuit",
        description: "Repeated qualifying target failures open a scoped circuit and fail fast until recovery."
      },
      {
        id: "timeout",
        label: "Deadlines and timeouts",
        value: `${timeoutMs} ms preview deadline`,
        description: "Downstream work must complete before the deadline or returns a timeout Failure Card."
      },
      {
        id: "output-limit",
        label: "Output limits",
        value: "64 KiB safe output budget",
        description: "Oversized output is bounded, linked as evidence, and marked as truncated for model safety."
      },
      {
        id: "sanitizer",
        label: "Sanitizer policy",
        value: "Prompt-injection and secret-shaped output contained",
        description: "Suspicious content emits output.sanitized and keeps raw data in separated artifacts."
      },
      {
        id: "preflight",
        label: "Preflight gates",
        value: "Registered tool and argument checks before execution",
        description: "Unknown tools and invalid arguments fail closed before downstream execution."
      }
    ],
    preview: {
      decision: retryLimit < 0 || timeoutMs < 1 ? "block" : retryLimit === 0 ? "allow" : "retry",
      policyDecisionId: decisions.at(-1)?.policyDecisionId ?? "policy_preview",
      reason:
        retryLimit < 0 || timeoutMs < 1
          ? "Invalid policy values would block execution."
          : retryLimit === 0
            ? "Preview allows first execution with no automatic same-call retry."
            : "Preview allows execution and may retry bounded retryable failures."
    }
  };
}

function buildIntegrationsPayload(runId: StableId): JsonObject {
  return {
    runId,
    generatedAt: new Date().toISOString(),
    integrations: [
      {
        id: "cline",
        name: "Cline",
        route: "MCP-routed",
        claimLevel: "available",
        status: "available",
        limitation: "ToolGuard protects calls routed through the MCP proxy only, not native host tools."
      },
      {
        id: "roo-code",
        name: "Roo Code",
        route: "MCP-routed",
        claimLevel: "available",
        status: "available",
        limitation: "Use generated MCP config snippets with local ToolGuard Core on loopback."
      },
      {
        id: "claude-desktop-code",
        name: "Claude Desktop / Code",
        route: "MCP-routed",
        claimLevel: "available",
        status: "available",
        limitation: "Native host tools are outside ToolGuard unless configured through MCP."
      },
      {
        id: "cursor-windsurf",
        name: "Cursor / Windsurf",
        route: "MCP-routed",
        claimLevel: "not-yet-verified",
        status: "not-yet-verified",
        limitation: "MCP route is the supported claim. Native IDE tool interception is not claimed."
      },
      {
        id: "python-framework-adapters",
        name: "Python framework adapters",
        route: "SDK-wrapped",
        claimLevel: "configured",
        status: "configured",
        limitation: "Framework support requires installing and using ToolGuard wrapper functions rather than direct tools."
      },
      {
        id: "aider-crush",
        name: "Aider / Crush-style CLIs",
        route: "CLI-supervised",
        claimLevel: "available",
        status: "available",
        limitation: "Process-level supervision only unless a stable native tool-router boundary is proven."
      },
      {
        id: "native-host-tools",
        name: "Unrouted native host tools",
        route: "unsupported",
        claimLevel: "unsupported",
        status: "unsupported",
        limitation: "Unsupported in v0. Calls must route through MCP, SDK wrappers, CLI shim, or ToolGuard API."
      }
    ]
  };
}

function parseScenarioId(value: unknown): RecordedPolicyScenarioId | undefined {
  return value === "safe-success" || value === "blocked-destructive" || value === "retry-loop-failure"
    ? value
    : undefined;
}

function parseRouteType(value: unknown): IntegrationRouteType | undefined {
  return value === "mcp-routed" || value === "sdk-wrapped-python" || value === "cli-supervised" ? value : undefined;
}

function correlationFromCoreEvent(event: CoreEvent): JsonObject {
  return {
    runId: event.runId,
    traceId: event.traceId,
    ...(event.parentId ? { parentId: event.parentId } : {}),
    ...(event.harnessId ? { harnessId: event.harnessId } : {}),
    ...(event.adapterId ? { adapterId: event.adapterId } : {}),
    ...(event.downstreamServerId ? { downstreamServerId: event.downstreamServerId } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(event.policyDecisionId ? { policyDecisionId: event.policyDecisionId } : {}),
    ...(event.artifactId ? { artifactId: event.artifactId } : {})
  };
}

function isFailureCard(value: CoreEvent["data"]): value is FailureCard {
  return isRecord(value) && typeof value.toolName === "string" && typeof value.failureType === "string";
}

function isEvidenceArtifact(value: CoreEvent["data"]): value is EvidenceArtifact {
  return isRecord(value) && typeof value.artifactId === "string" && typeof value.kind === "string";
}

function isPolicyDecision(value: CoreEvent["data"]): value is PolicyDecision {
  return isRecord(value) && typeof value.policyDecisionId === "string" && typeof value.decision === "string";
}

function isEvidenceBundleManifest(value: unknown): value is EvidenceBundleManifest {
  return (
    isRecord(value) &&
    typeof value.bundleId === "string" &&
    typeof value.runId === "string" &&
    isRecord(value.files) &&
    Array.isArray(value.artifactHashes) &&
    Array.isArray(value.rawArtifacts) &&
    isRecord(value.reportManifestValidation) &&
    isRecord(value.redaction) &&
    isRecord(value.replay)
  );
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

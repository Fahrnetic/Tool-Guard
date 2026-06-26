import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CoreSession } from "./session.js";
import { ToolRegistry } from "./registry.js";
import { createId, type StableId } from "./ids.js";
import type { CoreEvent } from "./events.js";
import type { ToolCall } from "./types.js";

export interface CoreApiServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly evidenceRoot?: string;
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
  const runId = createId("run");
  const evidenceRoot = options.evidenceRoot ?? path.join(process.cwd(), "runs");
  const session = new CoreSession({ evidenceRoot, runId });
  const registry = new ToolRegistry();

  const downstreamServerId = createId("server");
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
          eventCount: session.recorder.events.length,
          events: session.recorder.events
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
    const call = makeApiToolCall(runId, downstreamServerId);
    await session.preflight(registry, {
      runId,
      traceId: call.traceId,
      harnessId: call.harnessId,
      adapterId: call.adapterId
    });
    await session.executeToolCall(registry, call);
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

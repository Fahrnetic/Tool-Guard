import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ClassifiedToolError,
  CoreSession,
  ToolRegistry,
  createCoreApiServer,
  createId,
  type CoreApiServerHandle,
  type CoreEvent,
  type DemoStoryScenarioRuntime
} from "@toolplane/core";
import { ToolGuardMcpRouter, createInMemoryDownstreamServer } from "./index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PreflightProbeResult } from "@toolplane/core";

export interface McpAdapterDemoOptions {
  readonly evidenceRoot?: string;
  readonly session?: CoreSession;
  readonly coreRegistry?: ToolRegistry;
}

export interface McpAdapterDemoResult {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly preflight: readonly PreflightProbeResult[];
  readonly healthyResult: CallToolResult;
  readonly chaosResult: CallToolResult;
  readonly events: readonly CoreEvent[];
  readonly transcript: string;
}

export interface McpAdapterDemoApiServerHandle {
  readonly api: CoreApiServerHandle;
  readonly result: McpAdapterDemoResult;
  close(): Promise<void>;
}

export async function runMcpAdapterDemo(options: McpAdapterDemoOptions = {}): Promise<McpAdapterDemoResult> {
  const evidenceRoot = options.evidenceRoot ?? (await mkdtemp(path.join(os.tmpdir(), "toolguard-mcp-demo-")));
  const session =
    options.session ??
    new CoreSession({
      evidenceRoot,
      runId: createId("run"),
      retry: { maxRetries: 0 },
      circuitBreaker: { failureThreshold: 2, openMs: 500 }
    });
  const coreRegistry = options.coreRegistry ?? new ToolRegistry();
  const router = await ToolGuardMcpRouter.create({
    session,
    coreRegistry,
    downstreamServers: [
      createInMemoryDownstreamServer({
        serverId: "server_good",
        name: "safe-good-fixture",
        tools: [
          {
            name: "echo",
            description: "Safe deterministic echo fixture exposed through ToolGuard MCP.",
            inputSchema: {
              type: "object",
              required: ["message"],
              properties: { message: { type: "string" } },
              additionalProperties: false
            }
          }
        ],
        handler: ({ args, serverId }) => ({ echoed: String(args.message ?? ""), serverId })
      }),
      createInMemoryDownstreamServer({
        serverId: "server_chaos",
        name: "safe-chaos-fixture",
        preflightStatus: "failed",
        tools: [
          {
            name: "malformed",
            description: "Safe deterministic chaos fixture that should be blocked by preflight.",
            inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }
          }
        ],
        handler: async () => {
          throw new ClassifiedToolError("malformed_json", "Malformed fixture payload", [
            'raw payload: {"unterminated": true'
          ]);
        }
      })
    ],
    deadlineMs: 250
  });

  try {
    const preflight = await router.preflight();
    const healthyResult = await router.callVirtualTool("tg__server_good__echo", { message: "hello through ToolGuard" });
    const chaosResult = await router.callVirtualTool("tg__server_chaos__malformed", {});
    const transcript = renderMcpDemoTranscript({
      runId: session.runId,
      evidenceDir: session.recorder.runDir,
      preflight,
      healthyResult,
      chaosResult
    });

    return {
      runId: session.runId,
      evidenceDir: session.recorder.runDir,
      preflight,
      healthyResult,
      chaosResult,
      events: session.recorder.events,
      transcript
    };
  } finally {
    await router.close();
  }
}

export async function createMcpAdapterDemoApiServer(options: {
  readonly host?: string;
  readonly port?: number;
  readonly evidenceRoot?: string;
  readonly storyScenarioRuntime?: DemoStoryScenarioRuntime;
} = {}): Promise<McpAdapterDemoApiServerHandle> {
  const evidenceRoot = options.evidenceRoot ?? (await mkdtemp(path.join(os.tmpdir(), "toolguard-mcp-demo-api-")));
  const session = new CoreSession({
    evidenceRoot,
    runId: createId("run"),
    retry: { maxRetries: 1 },
    circuitBreaker: { failureThreshold: 2, openMs: 500 }
  });
  const coreRegistry = new ToolRegistry();
  const api = createCoreApiServer({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    evidenceRoot,
    session,
    registry: coreRegistry,
    seedDirectRun: false,
    ...(options.storyScenarioRuntime === undefined ? {} : { storyScenarioRuntime: options.storyScenarioRuntime })
  });
  await api.ready;
  const result = await runMcpAdapterDemo({ evidenceRoot, session, coreRegistry });
  await session.exportReport();

  return {
    api,
    result: {
      ...result,
      events: session.recorder.events,
      transcript: `${result.transcript}\nCore/API observability: http://${options.host ?? "127.0.0.1"}:${options.port ?? 3660}/api/runs/latest`
    },
    close: () => api.close()
  };
}

function renderMcpDemoTranscript(input: {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly preflight: readonly PreflightProbeResult[];
  readonly healthyResult: CallToolResult;
  readonly chaosResult: CallToolResult;
}): string {
  const healthyStatus = input.healthyResult.isError ? "error" : "ok";
  const chaosFailure =
    typeof input.chaosResult.structuredContent === "object" &&
    input.chaosResult.structuredContent !== null &&
    "failureType" in input.chaosResult.structuredContent
      ? String(input.chaosResult.structuredContent.failureType)
      : "unknown";

  return [
    "ToolGuard MCP adapter demo",
    `runId: ${input.runId}`,
    `evidenceDir: ${input.evidenceDir}`,
    "downstream preflight:",
    ...input.preflight.map((finding) => `  - ${finding.status}: ${finding.summary}`),
    `healthy mediated call: ${healthyStatus}`,
    `healthy response: ${JSON.stringify(input.healthyResult.structuredContent)}`,
    `chaos failure: ${chaosFailure}`,
    "Failure Card:",
    JSON.stringify(input.chaosResult.structuredContent, null, 2)
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const serve = process.argv.includes("--serve");
  const run = serve ? createMcpAdapterDemoApiServer() : runMcpAdapterDemo();
  run
    .then((resultOrHandle) => {
      const result = "result" in resultOrHandle ? resultOrHandle.result : resultOrHandle;
      console.log(result.transcript);
      if ("api" in resultOrHandle) {
        console.log("Core/API observability endpoints:");
        console.log("  curl http://127.0.0.1:3660/health");
        console.log("  curl http://127.0.0.1:3660/api/runs/latest");
        console.log("  curl -N http://127.0.0.1:3660/events");
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

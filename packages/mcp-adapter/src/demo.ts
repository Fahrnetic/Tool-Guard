import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ClassifiedToolError, CoreSession, ToolRegistry, createId, type CoreEvent } from "@toolplane/core";
import { ToolGuardMcpRouter, createInMemoryDownstreamServer } from "./index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PreflightProbeResult } from "@toolplane/core";

export interface McpAdapterDemoResult {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly preflight: readonly PreflightProbeResult[];
  readonly healthyResult: CallToolResult;
  readonly chaosResult: CallToolResult;
  readonly events: readonly CoreEvent[];
  readonly transcript: string;
}

export async function runMcpAdapterDemo(): Promise<McpAdapterDemoResult> {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "toolguard-mcp-demo-"));
  const session = new CoreSession({
    evidenceRoot,
    runId: createId("run"),
    retry: { maxRetries: 0 },
    circuitBreaker: { failureThreshold: 2, openMs: 500 }
  });
  const router = await ToolGuardMcpRouter.create({
    session,
    coreRegistry: new ToolRegistry(),
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
  runMcpAdapterDemo()
    .then((result) => {
      console.log(result.transcript);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

import path from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CoreSession, ToolRegistry, createId } from "@toolplane/core";
import { ToolGuardMcpRouter, type DownstreamMcpServer } from "./index.js";

export interface ToolGuardMcpStdioServerOptions {
  readonly evidenceRoot?: string;
  readonly downstreamServers?: readonly DownstreamMcpServer[];
}

export async function startToolGuardMcpStdioServer(options: ToolGuardMcpStdioServerOptions = {}): Promise<ToolGuardMcpRouter> {
  const session = new CoreSession({
    evidenceRoot: options.evidenceRoot ?? path.join(process.cwd(), "runs"),
    runId: createId("run")
  });
  const router = await ToolGuardMcpRouter.create({
    session,
    coreRegistry: new ToolRegistry(),
    downstreamServers: options.downstreamServers ?? []
  });
  await router.createUpstreamMcpServer().connect(new StdioServerTransport());
  return router;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startToolGuardMcpStdioServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

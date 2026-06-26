import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { CoreSession, ToolRegistry, createId } from "@toolplane/core";
import {
  SdkDownstreamMcpServer,
  ToolGuardMcpRouter,
  createInMemoryDownstreamServer,
  type DownstreamMcpServer
} from "../src/index.js";
import { loadToolGuardProfileFromEnvironment } from "../src/server.js";

describe("MCP SDK boundary behavior", () => {
  it("exposes virtual tool input schemas through real SDK tools/list discovery", async () => {
    const router = await makeRouter([
      createInMemoryDownstreamServer({
        serverId: "server_schema",
        name: "schema",
        tools: [
          {
            name: "lookup",
            description: "Lookup by query and limit",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                limit: { type: "number" }
              },
              required: ["query"],
              additionalProperties: false
            }
          }
        ],
        handler: async () => ({ ok: true })
      })
    ]);
    const { client, close } = await connectSdkClient(router.createUpstreamMcpServer());

    const first = await client.listTools();
    const second = await client.listTools();
    await close();
    await router.close();

    expect(first.tools.map((tool) => tool.name)).toEqual(["tg__server_schema__lookup"]);
    expect(second.tools).toEqual(first.tools);
    expect(first.tools[0]?.inputSchema).toEqual(
      expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          query: expect.objectContaining({ type: "string" }),
          limit: expect.objectContaining({ type: "number" })
        }),
        required: ["query"]
      })
    );
  });

  it("converts SDK downstream CallToolResult.isError envelopes into Failure Cards", async () => {
    const downstreamServer = new McpServer({ name: "downstream-error-fixture", version: "0.0.0" });
    downstreamServer.registerTool(
      "explode",
      {
        description: "Returns an MCP error result envelope",
        inputSchema: {}
      },
      async () => ({
        content: [{ type: "text", text: "raw downstream stderr: SECRET_TOKEN_SHOULD_NOT_LEAK" }],
        isError: true
      })
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await downstreamServer.connect(serverTransport);
    const sdkDownstream = new SdkDownstreamMcpServer({
      serverId: "server_sdk_error",
      name: "SDK error fixture",
      createTransport: () => clientTransport
    });
    const router = await makeRouter([sdkDownstream]);

    const result = await router.callVirtualTool("tg__server_sdk_error__explode", {});
    await router.close();
    await downstreamServer.close();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        failureType: "unknown",
        rawDetailsSeparated: true,
        doNotRetrySameCall: true
      })
    );
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_SHOULD_NOT_LEAK");
    expect(router.session.recorder.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool.call.failed", downstreamServerId: "server_sdk_error" }),
        expect.objectContaining({ type: "evidence.artifact.created", downstreamServerId: "server_sdk_error" })
      ])
    );
  });

  it("loads generated-snippet stdio downstream profile configuration from TOOLGUARD_PROFILE", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "toolguard-profile-"));
    const profilePath = path.join(tempDir, "toolguard.profile.json");
    await writeFile(
      profilePath,
      JSON.stringify({
        evidenceRoot: path.join(tempDir, "runs"),
        downstreamServers: [
          {
            serverId: "server_local_stdio",
            name: "Local stdio fixture",
            version: "0.1.0",
            command: "node",
            args: ["fixture.js"],
            env: { SAFE_ENV: "1" },
            cwd: tempDir
          }
        ]
      })
    );

    const profile = await loadToolGuardProfileFromEnvironment({
      TOOLGUARD_PROFILE: profilePath,
      TOOLGUARD_CORE_URL: "http://127.0.0.1:3660"
    });

    expect(profile.evidenceRoot).toBe(path.join(tempDir, "runs"));
    expect(profile.downstreamServers).toHaveLength(1);
    expect(profile.downstreamServers[0]).toEqual(
      expect.objectContaining({
        serverId: "server_local_stdio",
        name: "Local stdio fixture",
        version: "0.1.0"
      })
    );
  });

  it("fails safely when generated snippets still contain an unresolved TOOLGUARD_PROFILE placeholder", async () => {
    await expect(
      loadToolGuardProfileFromEnvironment({
        TOOLGUARD_PROFILE: "<TOOLGUARD_PROFILE>",
        TOOLGUARD_CORE_URL: "http://127.0.0.1:3660"
      })
    ).rejects.toThrow(/placeholder/i);
  });
});

async function makeRouter(downstreamServers: readonly DownstreamMcpServer[]): Promise<ToolGuardMcpRouter> {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "toolguard-mcp-sdk-"));
  return ToolGuardMcpRouter.create({
    session: new CoreSession({ evidenceRoot, runId: createId("run") }),
    coreRegistry: new ToolRegistry(),
    downstreamServers,
    deadlineMs: 250
  });
}

async function connectSdkClient(server: McpServer): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "sdk-boundary-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

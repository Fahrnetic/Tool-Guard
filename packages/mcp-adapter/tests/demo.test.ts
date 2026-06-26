import { describe, expect, it } from "vitest";
import { createMcpAdapterDemoApiServer, runMcpAdapterDemo } from "../src/demo.js";

describe("MCP adapter demo coverage", () => {
  it("shows a healthy mediated call and one chaos failure through ToolGuard", async () => {
    const demo = await runMcpAdapterDemo();

    expect(demo.preflight).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "healthy" }),
        expect.objectContaining({ status: "failed" })
      ])
    );
    expect(demo.healthyResult.isError).toBe(false);
    expect(demo.healthyResult.structuredContent).toEqual({ echoed: "hello through ToolGuard", serverId: "server_good" });
    expect(demo.chaosResult.isError).toBe(true);
    expect(demo.chaosResult.structuredContent).toEqual(
      expect.objectContaining({
        failureType: "policy_blocked",
        rawDetailsSeparated: true,
        doNotRetrySameCall: true
      })
    );
    expect(demo.transcript).toContain("healthy mediated call");
    expect(demo.transcript).toContain("chaos failure");
    expect(demo.transcript).toContain("Failure Card");
    expect(demo.transcript).not.toMatch(/direct downstream fixture config/i);
    expect(demo.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "adapter.connected", adapterId: "adapter_mcp_toolguard" }),
        expect.objectContaining({ type: "server.preflight.completed" }),
        expect.objectContaining({ type: "tool.call.completed", downstreamServerId: "server_good" }),
        expect.objectContaining({ type: "tool.call.failed", downstreamServerId: "server_chaos" })
      ])
    );
  });

  it("exposes MCP adapter run events through the Core/API curl surface", async () => {
    const demoApi = await createMcpAdapterDemoApiServer({ port: 0 });
    try {
      const address = demoApi.api.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected Core/API test server to listen on a TCP port.");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const health = (await (await fetch(`${baseUrl}/health`)).json()) as { ok: boolean; runId: string };
      expect(health).toEqual(expect.objectContaining({ ok: true, runId: demoApi.result.runId }));

      const latest = (await (await fetch(`${baseUrl}/api/runs/latest`)).json()) as {
        runId: string;
        eventCount: number;
        events: Array<{
          type: string;
          summary: string;
          adapterId?: string;
          downstreamServerId?: string;
          toolCallId?: string;
          attemptId?: string;
          artifactId?: string;
          data?: unknown;
        }>;
      };

      expect(latest.runId).toBe(demoApi.result.runId);
      expect(latest.eventCount).toBe(latest.events.length);
      expect(latest.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "adapter.connected", adapterId: "adapter_mcp_toolguard" }),
          expect.objectContaining({ type: "server.preflight.started", adapterId: "adapter_mcp_toolguard" }),
          expect.objectContaining({ type: "server.preflight.completed", adapterId: "adapter_mcp_toolguard" }),
          expect.objectContaining({ type: "tool.call.started", adapterId: "adapter_mcp_toolguard" }),
          expect.objectContaining({
            type: "tool.call.completed",
            adapterId: "adapter_mcp_toolguard",
            downstreamServerId: "server_good"
          }),
          expect.objectContaining({
            type: "tool.call.failed",
            adapterId: "adapter_mcp_toolguard",
            downstreamServerId: "server_chaos"
          }),
          expect.objectContaining({ type: "evidence.artifact.created" }),
          expect.objectContaining({ type: "report.exported" })
        ])
      );

      const failed = latest.events.find((event) => event.type === "tool.call.failed");
      expect(failed).toEqual(
        expect.objectContaining({
          toolCallId: expect.stringMatching(/^toolcall_/),
          attemptId: expect.stringMatching(/^attempt_/)
        })
      );
      expect(JSON.stringify(failed)).not.toMatch(/raw payload: \{"unterminated": true/);

      const report = latest.events.find((event) => event.type === "report.exported");
      expect(report?.data).toEqual(
        expect.objectContaining({
          reportHtml: expect.stringContaining("report.html"),
          manifestJson: expect.stringContaining("manifest.json")
        })
      );
    } finally {
      await demoApi.close();
    }
  });
});

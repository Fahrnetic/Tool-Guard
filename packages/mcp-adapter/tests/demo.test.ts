import { describe, expect, it } from "vitest";
import { runMcpAdapterDemo } from "../src/demo.js";

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
});

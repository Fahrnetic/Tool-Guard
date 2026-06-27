import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runPortfolioDemo } from "../src/portfolio-demo.js";

describe("portfolio demo orchestration", () => {
  it("validates final acceptance surfaces without starting UI in unit mode", async () => {
    const result = await runPortfolioDemo({ startUi: false, holdMs: 0 });

    expect(result.coreUrl).toBe("http://127.0.0.1:3660");
    expect(result.uiUrl).toBeUndefined();
    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.failureCount).toBeGreaterThan(0);
    expect(result.preflightStatuses.some((status) => status.includes(":healthy"))).toBe(true);
    expect(result.preflightStatuses.some((status) => status.includes(":failed"))).toBe(true);
    expect(result.integrationClaimLevels).toEqual(
      expect.arrayContaining([
        "Cline:MCP-routed:available",
        "Python framework adapters:SDK-wrapped:configured",
        "Aider / Crush-style CLIs:CLI-supervised:available",
        "Unrouted native host tools:unsupported:unsupported"
      ])
    );
    expect(result.transcript).toContain("approvedPorts: 3660-3669");
    expect(result.transcript).toContain("not native host tools");
    expect(result.transcript).not.toMatch(/native host tool interception is supported/i);
    expect(result.reportHtml).toBeDefined();
    expect(result.manifestJson).toBeDefined();
    await expect(access(result.reportHtml ?? "")).resolves.toBeUndefined();
    await expect(access(result.manifestJson ?? "")).resolves.toBeUndefined();
  });
});

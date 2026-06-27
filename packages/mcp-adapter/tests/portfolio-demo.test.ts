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
    expect(result.preflightStatuses.some((status) => status.includes(":degraded"))).toBe(true);
    expect(result.preflightStatuses.some((status) => status.includes(":failed"))).toBe(true);
    expect(result.chaosFixtureRows).toEqual(
      expect.arrayContaining([
        "fixture.good:healthy",
        "fixture.wrong-cwd:degraded",
        "fixture.slow:degraded",
        "fixture.hanging-stream:degraded",
        "fixture.crash-after-initialize:degraded",
        "fixture.malformed-json:degraded",
        "fixture.prompt-injection-output:degraded"
      ])
    );
    expect(result.requiredEventTypes).toEqual(
      expect.arrayContaining([
        "adapter.connected",
        "server.preflight.completed",
        "tool.call.completed",
        "tool.call.failed",
        "output.sanitized",
        "circuit.opened",
        "evidence.artifact.created",
        "report.exported"
      ])
    );
    expect(result.replayStatus).toMatch(/failed|blocked/);
    expect(result.redactionScanPassed).toBe(true);
    expect(result.noOverclaimScanPassed).toBe(true);
    expect(result.cleanupVerified).toBe(true);
    expect(result.integrationClaimLevels).toEqual(
      expect.arrayContaining([
        "Cline:MCP-routed:available",
        "Python framework adapters:SDK-wrapped:configured",
        "Aider / Crush-style CLIs:CLI-supervised:available",
        "Unrouted native host tools:unsupported:unsupported"
      ])
    );
    expect(result.transcript).toContain("approvedPorts: 3660-3669");
    expect(result.transcript).toContain("Core deterministic chaos fixture preflight");
    expect(result.transcript).toContain("fixture.crash-after-initialize attempt 3: circuit_open");
    expect(result.transcript).toContain("CLI wrapper");
    expect(result.transcript).toContain("Python framework adapters");
    expect(result.transcript).toContain("langgraph=success");
    expect(result.transcript).toContain("crewai=failureType");
    expect(result.transcript).toContain("replayStatus");
    expect(result.transcript).toContain("redactionScan: passed");
    expect(result.transcript).toContain("integrationOverclaimScan: passed");
    expect(result.transcript).toContain("not native host tools");
    expect(result.transcript).not.toMatch(/native host tool interception is supported/i);
    expect(result.transcript).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i);
    expect(result.transcript).not.toMatch(/tg_demo_1234567890abcdef/);
    expect(result.reportHtml).toBeDefined();
    expect(result.manifestJson).toBeDefined();
    await expect(access(result.reportHtml ?? "")).resolves.toBeUndefined();
    await expect(access(result.manifestJson ?? "")).resolves.toBeUndefined();
  }, 20_000);
});

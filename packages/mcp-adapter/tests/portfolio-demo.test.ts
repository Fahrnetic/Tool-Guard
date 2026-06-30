import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runPortfolioDemo } from "../src/portfolio-demo.js";

describe("portfolio demo orchestration", () => {
  it("validates final acceptance surfaces without starting UI in unit mode", async () => {
    const result = await runPortfolioDemo({ startUi: false, holdMs: 0 });
    const repeated = await runPortfolioDemo({ startUi: false, holdMs: 0 });

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
        "run.started",
        "run.completed",
        "adapter.connected",
        "server.preflight.started",
        "server.preflight.completed",
        "tool.call.started",
        "tool.call.completed",
        "tool.call.failed",
        "tool.retry.scheduled",
        "output.sanitized",
        "circuit.opened",
        "circuit.closed",
        "evidence.artifact.created",
        "report.exported"
      ])
    );
    expect(result.replayStatus).toMatch(/failed|blocked/);
    expect(result.redactionScanPassed).toBe(true);
    expect(result.noOverclaimScanPassed).toBe(true);
    expect(result.cleanupVerified).toBe(true);
    expect(result.scenarioList).toEqual([
      "raw failure",
      "ToolGuard mediation",
      "topology map",
      "policy simulation",
      "integration verification",
      "evidence bundle export"
    ]);
    expect(repeated.scenarioList).toEqual(result.scenarioList);
    expect(repeated.evidenceDir).toBe(result.evidenceDir);
    expect(repeated.reportHtml).toBe(result.reportHtml);
    expect(repeated.manifestJson).toBe(result.manifestJson);
    expect(result.evidenceBundleManifest).toBeDefined();
    expect(result.transcript).toContain("cleanupProbe: portsClosed=3660,3661,3662,3663,3664,3665,3666,3667,3668,3669");
    expect(result.transcript).toContain("deterministicSeed: toolguard-flagship-demo-v0.11");
    expect(result.transcript).toContain("fixtureReset: cleared deterministic run directory");
    expect(result.transcript).toContain("topologyMap: nodes=");
    expect(result.transcript).toContain("policySimulation: decisions=");
    expect(result.transcript).toContain("integrationVerification: route=mcp-routed");
    expect(result.transcript).toContain("bundleManifestJson:");
    expect(result.integrationClaimLevels).toEqual(
      expect.arrayContaining([
        "Cline:MCP-routed:available",
        "Python framework adapters:SDK-wrapped:not-yet-verified",
        "Aider / Crush-style CLIs:CLI-supervised:not-yet-verified",
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
  }, 40_000);
});

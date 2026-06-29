import { describe, expect, it } from "vitest";
import { DemoStoryScenarioRuntime, buildDemoStoryModePayload, resetDemoStoryScenario } from "../src/story-mode.js";

describe("demo story mode data", () => {
  it("offers stable fixture-only or loopback-only scenarios and required stages", () => {
    const story = buildDemoStoryModePayload();

    expect(story.serveCommand).toBe("pnpm demo:serve");
    expect(story.stageOrder.map((stage) => stage.label)).toEqual([
      "Run raw",
      "Run through ToolGuard",
      "Inspect topology",
      "Simulate policy",
      "Export evidence"
    ]);
    expect(story.scenarios.length).toBeGreaterThanOrEqual(5);
    expect(story.scenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
        "raw-failure",
        "prompt-injection",
        "destructive-fixture-block",
        "retry-loop-containment",
        "malformed-mcp-response"
      ])
    );
    expect(story.scenarios.every((scenario) => scenario.fixtureOnly && scenario.loopbackOnly)).toBe(true);
    expect(story.scenarios.every((scenario) => scenario.route === "fixture-only" || scenario.route === "loopback-only")).toBe(true);
    expect(story.processHygiene.noExternalServices).toBe(true);
    expect(story.processHygiene.approvedPorts.every((port) => port >= 3660 && port <= 3669)).toBe(true);
  });

  it("uses the same deterministic fixture input for raw and mediated comparisons", () => {
    const first = buildDemoStoryModePayload();
    const second = buildDemoStoryModePayload();

    expect(first.scenarios.map((scenario) => scenario.stableLabel)).toEqual(second.scenarios.map((scenario) => scenario.stableLabel));
    expect(first.scenarios.map((scenario) => scenario.deterministicOutcome)).toEqual(
      second.scenarios.map((scenario) => scenario.deterministicOutcome)
    );

    for (const scenario of first.scenarios) {
      expect(scenario.comparison.raw.fixtureId).toBe(scenario.fixtureId);
      expect(scenario.comparison.mediated.fixtureId).toBe(scenario.fixtureId);
      expect(scenario.comparison.raw.scenarioInput).toEqual(scenario.scenarioInput);
      expect(scenario.comparison.mediated.scenarioInput).toEqual(scenario.scenarioInput);
      expect(scenario.resetControl.endpoint).toBe("/api/story/reset");
      expect(scenario.cleanup.afterScenario).toMatch(/Reset|Close/i);
      expect(scenario.cleanup.onExit).toMatch(/Close Core\/API/);
    }
  });

  it("returns actual reset receipts for known scenarios", async () => {
    const reset = await resetDemoStoryScenario("prompt-injection");
    expect(reset).toMatchObject({
      ok: true,
      scenarioId: "prompt-injection",
      fixtureState: {
        reset: true,
        fixtureId: "fixture.prompt-injection-output",
        scenarioSeed: "story-seed-002"
      },
      processCleanup: {
        scenarioOwnedProcessesClosed: 0,
        closedPids: [],
        errors: []
      }
    });
    expect(Date.parse(reset.ok ? reset.resetAt : "")).not.toBeNaN();
    await expect(resetDemoStoryScenario("missing" as never)).resolves.toMatchObject({
      ok: false,
      error: "unknown_story_scenario"
    });
  });

  it("resets fixture targets and closes scenario-owned process handles", async () => {
    const fixtureResets: string[] = [];
    const closedPids: number[] = [];
    const runtime = new DemoStoryScenarioRuntime({
      resetTargets: [
        {
          port: 3662,
          reset: (scenario) => {
            fixtureResets.push(`${scenario.id}:${scenario.fixtureId}`);
          }
        },
        {
          port: 3663,
          reset: (scenario) => {
            fixtureResets.push(`${scenario.id}:${scenario.scenarioSeed}`);
          }
        }
      ]
    });
    runtime.registerScenarioProcess("malformed-mcp-response", {
      pid: 4242,
      close: () => {
        closedPids.push(4242);
      }
    });

    const reset = await runtime.resetScenario("malformed-mcp-response");

    expect(reset).toMatchObject({
      ok: true,
      scenarioId: "malformed-mcp-response",
      processCleanup: {
        scenarioOwnedProcessesClosed: 1,
        closedPids: [4242],
        errors: []
      },
      fixtureStack: {
        resetTargets: [3662, 3663],
        resetCount: 2,
        errors: []
      }
    });
    expect(fixtureResets).toEqual([
      "malformed-mcp-response:fixture.mcp-malformed-response",
      "malformed-mcp-response:story-seed-005"
    ]);
    expect(closedPids).toEqual([4242]);

    const secondReset = await runtime.resetScenario("malformed-mcp-response");
    expect(secondReset.ok ? secondReset.processCleanup.scenarioOwnedProcessesClosed : -1).toBe(0);
    expect(secondReset.ok ? secondReset.fixtureState.resetCount : -1).toBe(2);
  });
});

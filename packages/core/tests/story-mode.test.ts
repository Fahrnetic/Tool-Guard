import { describe, expect, it } from "vitest";
import { buildDemoStoryModePayload, resetDemoStoryScenario } from "../src/story-mode.js";

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

  it("returns deterministic reset receipts for known scenarios", () => {
    const reset = resetDemoStoryScenario("prompt-injection");
    expect(reset).toMatchObject({
      ok: true,
      scenarioId: "prompt-injection",
      resetAt: new Date(0).toISOString()
    });
    expect(resetDemoStoryScenario("missing" as never)).toMatchObject({
      ok: false,
      error: "unknown_story_scenario"
    });
  });
});

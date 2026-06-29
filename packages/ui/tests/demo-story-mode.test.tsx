import { buildDemoStoryModePayload } from "@toolplane/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DemoStoryMode } from "../src/screens/DemoStoryMode.js";

describe("Demo Story Mode", () => {
  it("renders cinematic story navigation and side-by-side comparison fields from Core payload data", () => {
    const html = renderToStaticMarkup(<DemoStoryMode payload={buildDemoStoryModePayload()} status="ready" />);

    expect(html).toContain("The failure story, staged like a live incident review");
    expect(html).toContain("Scenario picker");
    expect(html).toContain("Step-by-step narrative navigation");
    expect(html).toContain("Before and after comparison");
    expect(html).toContain("Raw result");
    expect(html).toContain("ToolGuard result");
    expect(html).toContain("Failure type");
    expect(html).toContain("Safe summary");
    expect(html).toContain("Retry behavior");
    expect(html).toContain("Blast radius");
    expect(html).toContain("Side effects");
    expect(html).toContain("Evidence");
    expect(html).toContain("Recovery");
    expect(html).toContain("Scenario input");
    expect(html).toContain("aria-current=\"step\"");
  });

  it("renders loading and empty states for story data lifecycle", () => {
    const loadingHtml = renderToStaticMarkup(<DemoStoryMode status="loading" />);
    expect(loadingHtml).toContain("Loading Demo Story Mode");
    expect(loadingHtml).toContain("animate-pulse");

    const payload = { ...buildDemoStoryModePayload(), scenarios: [], stageOrder: [] };
    const emptyHtml = renderToStaticMarkup(<DemoStoryMode payload={payload} status="empty" />);
    expect(emptyHtml).toContain("No story scenarios are available");
    expect(emptyHtml).toContain("raw failure, prompt injection, destructive block");
  });
});

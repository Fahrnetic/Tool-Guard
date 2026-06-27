import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CoreEvent, CoreEventType } from "@toolplane/core";
import { Timeline } from "../src/screens/Timeline.js";
import { requiredCoreEventTypes } from "../src/lib/model.js";

describe("Live Run Timeline", () => {
  it("renders every required Core event type with timestamps, source layer, ordering, and duplicate suppression", () => {
    const events = requiredCoreEventTypes.map((type, index) => makeTimelineEvent(type, index + 1));
    const adapterEvent = events.find((event) => event.type === "adapter.connected");
    if (!adapterEvent) {
      throw new Error("Fixture did not include adapter.connected");
    }
    const duplicatedAdapter = {
      ...adapterEvent,
      summary: "Duplicate adapter event from reconnect"
    } as CoreEvent;
    const outOfOrderEvents = [events[3]!, events[0]!, duplicatedAdapter, ...events.slice(1)];

    const html = renderToStaticMarkup(
      <Timeline events={outOfOrderEvents} status="ready" streamState="connected" />
    );

    for (const type of requiredCoreEventTypes) {
      expect(html).toContain(`${type} observed`);
      expect(html).toContain(`>${type}<`);
    }
    expect(html).toContain("2026-06-27T12:00:03.000Z");
    expect(html).toContain("Source layer: harness → adapter");
    expect(html).toContain("Source layer: downstream");
    expect(html).toContain("Source layer: evidence");
    expect(html).toContain(">14</span> unique events rendered");
    expect(html.match(/event_adapter_connected/g)).toHaveLength(1);
    expect(html.indexOf(">run.started<")).toBeLessThan(html.indexOf(">adapter.connected<"));
    expect(html.indexOf(">adapter.connected<")).toBeLessThan(html.indexOf(">report.exported<"));
  });
});

function makeTimelineEvent(type: CoreEventType, sequence: number): CoreEvent {
  const base = {
    eventId: type === "adapter.connected" ? "event_adapter_connected" : `event_${sequence}`,
    type,
    occurredAt: `2026-06-27T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    sequence,
    summary: `Rendered ${type}`,
    runId: "run_timeline",
    traceId: `trace_${sequence}`
  } satisfies CoreEvent;

  if (type === "evidence.artifact.created" || type === "report.exported") {
    return {
      ...base,
      artifactId: `artifact_${sequence}`
    };
  }

  if (type === "run.started" || type === "run.completed") {
    return base;
  }

  if (type.startsWith("server.") || type.startsWith("tool.") || type.startsWith("circuit.") || type === "output.sanitized") {
    return {
      ...base,
      harnessId: "harness_timeline",
      adapterId: "adapter_timeline",
      downstreamServerId: "server_timeline",
      toolCallId: `toolcall_${sequence}`,
      attemptId: `attempt_${sequence}`,
      policyDecisionId: `policy_${sequence}`
    };
  }

  return {
    ...base,
    harnessId: "harness_timeline",
    adapterId: "adapter_timeline"
  };
}

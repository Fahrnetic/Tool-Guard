import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FailureTopologyMap } from "../src/screens/FailureTopologyMap.js";
import type { TopologyPayload } from "../src/lib/model.js";

describe("Failure Topology Map demo states", () => {
  it("renders a meaningful selectable empty fixture state", () => {
    const html = renderToStaticMarkup(
      <FailureTopologyMap topology={emptyTopology} selectedRunId="demo-empty" status="ready" />
    );

    expect(html).toContain("Topology demo states");
    expect(html).toContain("Empty fixture run");
    expect(html).toContain("No topology data in selected fixture run");
    expect(html).toContain("deterministic empty topology fixture is loaded");
    expect(html).toContain("What would appear here");
    expect(html).toContain("route mocks");
    expect(html).toContain("aria-checked=\"true\"");
  });

  it("renders a capture-friendly loading skeleton selector state", () => {
    const html = renderToStaticMarkup(
      <FailureTopologyMap selectedRunId="demo-loading" status="loading" />
    );

    expect(html).toContain("Loading Failure Topology");
    expect(html).toContain("/api/topology/demo-loading");
    expect(html).toContain("Loading skeleton demo");
    expect(html).toContain("animate-pulse");
    expect(html).toContain("aria-checked=\"true\"");
  });
});

const emptyTopology: TopologyPayload = {
  runId: "demo-empty",
  generatedFrom: {
    eventCount: 0,
    ledgerCount: 0,
    lastEventSequence: 0
  },
  summary: {
    nodes: 0,
    edges: 0,
    failures: 0,
    blocked: 0,
    sideEffects: 0,
    artifacts: 0,
    reports: 0
  },
  nodes: [],
  edges: []
};

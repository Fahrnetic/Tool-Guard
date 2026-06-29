import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunIndexRecord } from "@toolplane/core";
import { buildRunComparisons, filterRunIndexRecords, RunIndexWorkbench } from "../src/screens/RunIndexWorkbench.js";
import type { RunIndexPayload } from "../src/lib/model.js";

describe("Run Index Workbench", () => {
  it("renders latest real failures, filters, and comparison lanes from Core run index records", () => {
    const html = renderToStaticMarkup(<RunIndexWorkbench payload={payload} status="ready" />);

    expect(html).toContain("Latest real failures and correlated attempts");
    expect(html).toContain("Core run index backed");
    expect(html).toContain("Failure type");
    expect(html).toContain("Route");
    expect(html).toContain("Tool or status");
    expect(html).toContain("Time");
    expect(html).toContain("malformed_json");
    expect(html).toContain("Raw result");
    expect(html).toContain("ToolGuard mediated result");
    expect(html).toContain("Repeated attempts");
    expect(html).toContain("raw malformed response");
    expect(html).toContain("mediated malformed response");
  });

  it("filters by failure type, route, tool/status, and time", () => {
    const filtered = filterRunIndexRecords(payload.records, {
      failureType: "malformed_json",
      routeType: "mcp",
      toolOrStatus: "failed",
      timeWindow: "24h"
    }, new Date("2026-06-29T12:00:00.000Z"));

    expect(filtered.map((record) => record.runId)).toEqual(["run_mediated_2", "run_mediated_1"]);
  });

  it("builds correlated raw, mediated, and repeated attempt comparison groups", () => {
    const groups = buildRunComparisons(payload.records);

    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group).toBeDefined();
    expect(group?.raw.map((record) => record.runId)).toEqual(["run_raw_1"]);
    expect(group?.mediated.map((record) => record.runId)).toEqual(["run_mediated_2", "run_mediated_1"]);
    expect(group?.repeated.map((record) => record.runId)).toEqual(["run_mediated_2", "run_mediated_1"]);
  });
});

const baseRecord = {
  runName: "fixture failure",
  sourcePath: "mcp-adapter",
  hostHarness: { id: "harness_demo", name: "demo harness" },
  adapter: { id: "adapter_demo", name: "ToolGuard MCP adapter" },
  downstreamTarget: { id: "fixture_server", toolName: "malformed_fixture" },
  tool: "malformed_fixture",
  evidencePath: "/runs/demo",
  eventsPath: "/runs/demo/events.jsonl",
  tags: ["demo"],
  labels: { task: "malformed-response-demo", session: "demo-session" },
  status: "failed",
  firstFailure: {
    failureType: "malformed_json",
    summary: "Malformed JSON stayed separated from the safe summary."
  }
} satisfies Omit<RunIndexRecord, "runId" | "routeType" | "startedAt">;

const payload: RunIndexPayload = {
  indexPath: "/runs/run-index.jsonl",
  count: 3,
  records: [
    {
      ...baseRecord,
      runId: "run_mediated_2",
      runName: "mediated malformed response retry",
      routeType: "mcp",
      startedAt: "2026-06-29T11:00:00.000Z"
    },
    {
      ...baseRecord,
      runId: "run_mediated_1",
      runName: "mediated malformed response",
      routeType: "mcp",
      startedAt: "2026-06-29T10:00:00.000Z"
    },
    {
      ...baseRecord,
      runId: "run_raw_1",
      runName: "raw malformed response",
      routeType: "direct",
      sourcePath: "non-mcp-direct",
      adapter: { id: "adapter_raw", name: "raw harness" },
      startedAt: "2026-06-28T10:00:00.000Z"
    }
  ]
};

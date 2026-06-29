import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CoreEvent } from "@toolplane/core";
import { TraceExplorer } from "../src/screens/TraceExplorer.js";
import { type TopologySelection, type TracePayload } from "../src/lib/model.js";

describe("Trace Explorer topology selection", () => {
  it("highlights trace nodes, event rows, and artifacts linked to the selected topology node", () => {
    const topologySelection = {
      node: {
        id: "node_attempt_selected",
        type: "attempt",
        label: "Attempt attempt_selected",
        status: "failed",
        summary: "Attempt failed",
        correlation: {
          runId: "run_trace",
          traceId: "trace_selected",
          toolCallId: "toolcall_selected",
          attemptId: "attempt_selected",
          policyDecisionId: "policy_selected"
        },
        eventIds: ["event_selected"],
        ledgerIds: [],
        artifactIds: ["artifact_selected"]
      },
      selectedIds: [
        "node_attempt_selected",
        "event_selected",
        "toolcall_selected",
        "attempt_selected",
        "policy_selected",
        "artifact_selected"
      ]
    } satisfies TopologySelection;

    const html = renderToStaticMarkup(
      <TraceExplorer payload={makeTracePayload()} status="ready" topologySelection={topologySelection} />
    );

    expect(html).toContain("node_attempt_selected");
    expect(html).toContain("toolcall_selected");
    expect(html).toContain("artifact_selected");
    expect(html).toContain("aria-selected=\"true\" class=\"rounded-xl border p-3 outline-none transition hover:border-primary/45 focus-visible:border-primary border-primary bg-primary/10 shadow-lg shadow-primary/10\"");
    expect(html).toContain("aria-selected=\"true\" class=\"border-l-2 transition hover:bg-primary/5 border-primary bg-primary/10\"");
    expect(html).toContain("aria-selected=\"true\" class=\"rounded-lg border p-3 transition border-primary bg-primary/10 shadow-lg shadow-primary/10\"");
    expect(html.match(/aria-selected="true"/g)).toHaveLength(3);
  });
});

function makeTracePayload(): TracePayload {
  return {
    runId: "run_trace",
    traceId: "trace_selected",
    generatedAt: "2026-06-28T12:00:00.000Z",
    status: "ready",
    correlation: {
      runId: "run_trace",
      traceId: "trace_selected",
      toolCallId: "toolcall_selected",
      attemptId: "attempt_selected",
      policyDecisionId: "policy_selected",
      artifactId: "artifact_selected"
    },
    warnings: [],
    nodes: [
      {
        id: "node_attempt_selected",
        label: "Attempt attempt_selected",
        kind: "attempt",
        parentId: "toolcall_selected",
        summary: "Selected topology attempt."
      },
      {
        id: "node_attempt_other",
        label: "Attempt attempt_other",
        kind: "attempt",
        parentId: "toolcall_other",
        summary: "Unselected topology attempt."
      }
    ],
    events: [
      makeTraceEvent({
        eventId: "event_selected",
        toolCallId: "toolcall_selected",
        attemptId: "attempt_selected",
        policyDecisionId: "policy_selected",
        artifactId: "artifact_selected",
        sequence: 1
      }),
      makeTraceEvent({
        eventId: "event_other",
        toolCallId: "toolcall_other",
        attemptId: "attempt_other",
        policyDecisionId: "policy_other",
        artifactId: "artifact_other",
        sequence: 2
      })
    ],
    rawStdout: [],
    rawStderr: [
      {
        artifactId: "artifact_selected",
        runId: "run_trace",
        traceId: "trace_selected",
        toolCallId: "toolcall_selected",
        kind: "raw-stderr",
        relativePath: "runs/run_trace/artifacts/stderr.txt",
        sha256: "sha256",
        byteLength: 12,
        redacted: true,
        content: "safe stderr",
        truncated: false
      }
    ],
    rawArtifacts: []
  };
}

function makeTraceEvent(fields: {
  readonly eventId: `event_${string}`;
  readonly toolCallId: `toolcall_${string}`;
  readonly attemptId: `attempt_${string}`;
  readonly policyDecisionId: `policy_${string}`;
  readonly artifactId: `artifact_${string}`;
  readonly sequence: number;
}): CoreEvent {
  return {
    eventId: fields.eventId,
    type: "tool.call.failed",
    occurredAt: `2026-06-28T12:00:0${fields.sequence}.000Z`,
    sequence: fields.sequence,
    summary: `Rendered ${fields.eventId}`,
    runId: "run_trace",
    traceId: "trace_selected",
    toolCallId: fields.toolCallId,
    attemptId: fields.attemptId,
    policyDecisionId: fields.policyDecisionId,
    artifactId: fields.artifactId
  };
}

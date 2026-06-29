import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CoreSession, createId, type CoreEvent, type ToolCall } from "../src/index.js";

function makeToolCall(sourcePath: ToolCall["sourcePath"]): ToolCall {
  return {
    runId: createId("run"),
    traceId: createId("trace"),
    parentId: createId("parent"),
    harnessId: createId("harness"),
    adapterId: createId("adapter"),
    downstreamServerId: createId("server"),
    toolCallId: createId("toolcall"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName: "fixture.echo",
    arguments: { message: "hello" },
    idempotency: "idempotent",
    sourcePath
  };
}

describe("core event lifecycle", () => {
  it("persists append-only lifecycle events with stable correlation fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-core-"));
    const call = makeToolCall("non-mcp-direct");
    const session = new CoreSession({
      evidenceRoot: root,
      runId: call.runId,
      clock: () => new Date("2026-06-26T00:00:00.000Z")
    });
    const streamed: CoreEvent[] = [];
    session.bus.subscribe((event) => streamed.push(event));

    await session.mediateSuccessfulCall(call, { ok: true });

    const jsonl = await readFile(session.recorder.eventsPath, "utf8");
    const persisted = jsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CoreEvent);

    expect(persisted.map((event) => event.type)).toEqual([
      "run.started",
      "tool.call.started",
      "evidence.artifact.created",
      "tool.call.completed",
      "side_effect.recorded",
      "blast_radius.scored",
      "run.completed"
    ]);
    expect(streamed.map((event) => event.eventId)).toEqual(persisted.map((event) => event.eventId));

    for (const event of persisted) {
      expect(event.runId).toBe(call.runId);
      expect(event.traceId).toBe(call.traceId);
      expect(event.parentId).toBe(call.parentId);
      expect(event.harnessId).toBe(call.harnessId);
      expect(event.adapterId).toBe(call.adapterId);
      expect(event.downstreamServerId).toBe(call.downstreamServerId);
      expect(event.toolCallId).toBe(call.toolCallId);
      expect(event.attemptId).toBe(call.attemptId);
      expect(event.policyDecisionId).toBe(call.policyDecisionId);
    }

    const artifactEvent = persisted.find((event) => event.type === "evidence.artifact.created");
    expect(artifactEvent?.artifactId).toMatch(/^artifact_/);
  });

  it("accepts normalized calls from MCP and non-MCP adapter paths without protocol imports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-core-"));
    const directCall = makeToolCall("non-mcp-direct");
    const mcpCall = { ...makeToolCall("mcp-adapter"), runId: directCall.runId };
    const session = new CoreSession({ evidenceRoot: root, runId: directCall.runId });

    await expect(session.mediateSuccessfulCall(directCall, { from: "direct" })).resolves.toMatchObject({
      safeSummary: "Tool fixture.echo completed successfully."
    });
    await expect(session.mediateSuccessfulCall(mcpCall, { from: "mcp" })).resolves.toMatchObject({
      safeSummary: "Tool fixture.echo completed successfully."
    });
  });
});

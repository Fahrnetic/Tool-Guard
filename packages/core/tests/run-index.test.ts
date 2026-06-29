import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CoreSession,
  ToolRegistry,
  createCoreApiServer,
  createId,
  type RunIndexRecord,
  type StableId,
  type ToolCall
} from "../src/index.js";

describe("durable run index", () => {
  it("indexes successful and failed core calls with safe labels", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-run-index-"));
    const registry = new ToolRegistry();
    registry.register({
      toolName: "fixture.ok",
      title: "OK",
      description: "Successful fixture",
      protocol: "fixture",
      downstreamServerId: "server_fixture",
      inputSchema: { type: "object" },
      destructiveRisk: "none",
      execute: () => ({ ok: true })
    });
    registry.register({
      toolName: "fixture.fail",
      title: "Fail",
      description: "Failing fixture",
      protocol: "fixture",
      downstreamServerId: "server_fixture",
      inputSchema: { type: "object" },
      destructiveRisk: "none",
      execute: () => {
        throw new Error("token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      }
    });
    const success = new CoreSession({ evidenceRoot: root, runId: createId("run") });
    const failure = new CoreSession({ evidenceRoot: root, runId: createId("run") });

    await success.executeToolCall(registry, makeCall(success.runId, "fixture.ok", "success label"));
    await failure.executeToolCall(registry, makeCall(failure.runId, "fixture.fail", "token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));

    const records = await failure.recorder.listRunIndexRecords();
    expect(records.map((record) => record.status)).toEqual(expect.arrayContaining(["succeeded", "failed"]));
    const failed = records.find((record) => record.runId === failure.runId);
    expect(failed).toMatchObject({
      routeType: "direct",
      tool: "fixture.fail",
      status: "failed",
      firstFailure: expect.objectContaining({ failureType: "unknown" })
    });
    expect(failed?.startedAt).toMatch(/T/);
    expect(failed?.completedAt).toMatch(/T/);
    expect(failed?.evidencePath).toContain(failure.runId);
    expect(JSON.stringify(records)).not.toContain("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(JSON.stringify(records)).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const jsonl = await readFile(path.join(root, "run-index.jsonl"), "utf8");
    expect(jsonl).toContain(success.runId);
    expect(jsonl).toContain(failure.runId);
  });

  it("serves previously recorded run index entries after Core restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-run-index-restart-"));
    const first = createCoreApiServer({ port: 0, evidenceRoot: root, seedDirectRun: true });
    await first.ready;
    const runId = first.session.runId;
    await first.close();

    const second = createCoreApiServer({ port: 0, evidenceRoot: root, seedDirectRun: false });
    await second.ready;
    const address = second.server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected test server address");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/run-index`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { count: number; records: RunIndexRecord[] };
      expect(body.count).toBeGreaterThanOrEqual(1);
      expect(body.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            status: "succeeded",
            routeType: "direct",
            evidencePath: expect.stringContaining(runId)
          })
        ])
      );
    } finally {
      await second.close();
    }
  });

  it("preserves multiple records that share one durable run id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-run-index-shared-run-"));
    const registry = new ToolRegistry();
    registry.register({
      toolName: "fixture.fail",
      title: "Fail",
      description: "Failing fixture",
      protocol: "fixture",
      downstreamServerId: "server_fixture",
      inputSchema: { type: "object" },
      destructiveRisk: "none",
      execute: ({ call }) => {
        throw new Error(`failed ${call.toolCallId}`);
      }
    });
    const sharedRunId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId: sharedRunId });
    const firstCall = makeCall(sharedRunId, "fixture.fail", "shared session");
    const secondCall = makeCall(sharedRunId, "fixture.fail", "shared session");

    await session.executeToolCall(registry, firstCall);
    await session.executeToolCall(registry, secondCall);

    const records = await session.recorder.listRunIndexRecords();
    const sharedRecords = records.filter((record) => record.runId === sharedRunId);
    expect(sharedRecords).toHaveLength(2);
    expect(sharedRecords.map((record) => record.runIndexRecordId).sort()).toEqual(
      [`${sharedRunId}:${firstCall.toolCallId}`, `${sharedRunId}:${secondCall.toolCallId}`].sort()
    );
    expect(new Set(sharedRecords.map((record) => record.runIndexRecordId)).size).toBe(2);

    const jsonl = await readFile(path.join(root, "run-index.jsonl"), "utf8");
    expect(jsonl.match(new RegExp(sharedRunId, "g"))?.length).toBeGreaterThanOrEqual(2);
    expect(jsonl).toContain(firstCall.toolCallId);
    expect(jsonl).toContain(secondCall.toolCallId);
  });
});

function makeCall(runId: StableId, toolName: string, sessionLabel: string): ToolCall {
  return {
    runId,
    traceId: createId("trace"),
    parentId: createId("parent"),
    harnessId: "harness_test",
    harnessName: "direct-test",
    adapterId: "adapter_core",
    adapterName: "toolguard-core",
    downstreamServerId: "server_fixture",
    toolCallId: createId("toolcall"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName,
    arguments: {},
    deadlineMs: 1_000,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    runName: `direct ${toolName}`,
    tags: ["diagnostic", "run-index"],
    labels: {
      session: sessionLabel,
      task: "run index task",
      repo: "toolplane",
      agent: "core worker"
    }
  };
}

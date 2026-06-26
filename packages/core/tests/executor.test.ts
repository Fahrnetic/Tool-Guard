import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CoreSession,
  ToolRegistry,
  createId,
  type CoreEvent,
  type FailureCard,
  type ToolCall
} from "../src/index.js";

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
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
    deadlineMs: 50,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    ...overrides
  };
}

async function readEvents(session: CoreSession): Promise<CoreEvent[]> {
  return (await readFile(session.recorder.eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CoreEvent);
}

describe("safe executor preflight and evidence", () => {
  it("fails unknown tools before downstream execution and records failed evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-core-"));
    const session = new CoreSession({ evidenceRoot: root, runId: createId("run") });
    const registry = new ToolRegistry();
    const downstreamInvocations: string[] = [];

    registry.register({
      toolName: "fixture.echo",
      title: "Echo",
      description: "Echoes input",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string" } } },
      destructiveRisk: "none",
      execute: async () => {
        downstreamInvocations.push("called");
        return { ok: true };
      }
    });

    const call = makeCall({ runId: session.runId, toolName: "fixture.missing" });
    const result = await session.executeToolCall(registry, call);

    expect("failureType" in result ? result.failureType : undefined).toBe("unknown_tool");
    expect(downstreamInvocations).toEqual([]);

    const events = await readEvents(session);
    expect(events.map((event) => event.type)).toContain("tool.call.failed");
    expect(events.map((event) => event.type)).toContain("evidence.artifact.created");
    expect(events.find((event) => event.type === "tool.call.failed")?.data).toMatchObject({
      toolName: "fixture.missing",
      rawDetailsSeparated: true
    } satisfies Partial<FailureCard>);
  });

  it("fails invalid arguments before downstream execution and records preflight evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-core-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const registry = new ToolRegistry();
    let invoked = false;

    registry.register({
      toolName: "fixture.echo",
      title: "Echo",
      description: "Echoes input",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string" } } },
      destructiveRisk: "none",
      execute: async () => {
        invoked = true;
        return { ok: true };
      }
    });

    const result = await session.executeToolCall(registry, makeCall({ runId, arguments: { message: 42 } }));

    expect("failureType" in result ? result.failureType : undefined).toBe("invalid_arguments");
    expect(invoked).toBe(false);
    const events = await readEvents(session);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.call.started",
      "server.preflight.started",
      "server.preflight.completed",
      "evidence.artifact.created",
      "tool.call.failed",
      "run.completed"
    ]);
  });

  it("terminates timed-out and cancelled calls with safe failure cards and raw artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-core-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const registry = new ToolRegistry();
    let sawAbort = false;

    registry.register({
      toolName: "fixture.slow",
      title: "Slow",
      description: "Cooperative slow fixture",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      execute: ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("RAW_SECRET_TOKEN should stay in an artifact"));
          });
          setTimeout(() => resolve({ ok: true }), 5_000);
        })
    });

    const result = await session.executeToolCall(registry, makeCall({ runId, toolName: "fixture.slow", arguments: {} }));

    expect("failureType" in result ? result.failureType : undefined).toBe("timeout");
    expect(sawAbort).toBe(true);
    expect(JSON.stringify(result)).not.toContain("RAW_SECRET_TOKEN");

    const events = await readEvents(session);
    const failed = events.find((event) => event.type === "tool.call.failed");
    expect(failed?.data).toMatchObject({ failureType: "timeout", rawDetailsSeparated: true });

    const artifactEvent = events.find((event) => event.type === "evidence.artifact.created");
    expect(artifactEvent?.artifactId).toMatch(/^artifact_/);
  });

  it("cancels calls through an external abort signal before returning safe failure evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-core-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const registry = new ToolRegistry();
    const cancellation = new AbortController();
    let sawAbort = false;

    registry.register({
      toolName: "fixture.cancel",
      title: "Cancelable",
      description: "Cancelable fixture",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      execute: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("cancelled raw detail"));
          });
        })
    });

    setTimeout(() => cancellation.abort(), 5);
    const result = await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.cancel", arguments: {}, deadlineMs: 1_000 }),
      { signal: cancellation.signal }
    );

    expect("failureType" in result ? result.failureType : undefined).toBe("cancellation");
    expect(sawAbort).toBe(true);
    const events = await readEvents(session);
    expect(events.find((event) => event.type === "tool.call.failed")?.data).toMatchObject({
      failureType: "cancellation"
    });
  });

  it("returns on deadline even when downstream ignores abort", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-core-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const registry = new ToolRegistry();

    registry.register({
      toolName: "fixture.hang",
      title: "Hanging",
      description: "Never resolves and ignores abort",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      execute: () => new Promise(() => undefined)
    });

    const started = Date.now();
    const result = await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.hang", arguments: {}, deadlineMs: 10 })
    );

    expect(Date.now() - started).toBeLessThan(500);
    expect("failureType" in result ? result.failureType : undefined).toBe("timeout");
  });

  it("enforces output limits and keeps raw output separate from safe summaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-core-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId, outputLimitBytes: 24 });
    const registry = new ToolRegistry();

    registry.register({
      toolName: "fixture.big",
      title: "Big output",
      description: "Returns oversized output",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      execute: async () => ({ text: "x".repeat(200) })
    });

    const result = await session.executeToolCall(registry, makeCall({ runId, toolName: "fixture.big", arguments: {} }));

    expect("safeSummary" in result ? result.safeSummary : "").toContain("truncated");
    expect(JSON.stringify(result)).not.toContain("x".repeat(80));
    const events = await readEvents(session);
    expect(events.map((event) => event.type)).toContain("output.sanitized");
  });

  it("emits protocol-independent preflight events with actionable findings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-core-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const registry = new ToolRegistry();
    const downstreamServerId = createId("server");

    registry.register({
      toolName: "fixture.echo",
      title: "Echo",
      description: "Echoes input",
      protocol: "fixture",
      downstreamServerId,
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      preflight: async () => ({ status: "healthy", summary: "Fixture is ready" }),
      execute: async () => ({ ok: true })
    });

    const findings = await session.preflight(registry, {
      runId,
      traceId: createId("trace"),
      harnessId: createId("harness"),
      adapterId: createId("adapter")
    });

    expect(findings).toEqual([
      expect.objectContaining({ downstreamServerId, status: "healthy", summary: "Fixture is ready" })
    ]);
    const events = await readEvents(session);
    expect(events.map((event) => event.type)).toEqual(["server.preflight.started", "server.preflight.completed"]);
  });
});

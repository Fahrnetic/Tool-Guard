import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_VISIBILITY_SCHEMA_VERSION,
  CoreSession,
  createId,
  type CoreEvent,
  type ToolCall
} from "../src/index.js";

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

  it("persists canonical visibility metadata and W3C trace context on every event", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-visibility-events-"));
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const call: ToolCall = {
      ...makeToolCall("mcp-adapter"),
      harnessName: "Cline",
      adapterName: "ToolGuard MCP",
      routeMetadata: {
        routeType: "mcp-routed",
        routeId: "route_cline_mcp",
        transport: { kind: "stdio" },
        traceContext: { traceparent },
        platform: {
          hostId: "cline",
          hostName: "Cline",
          osPlatform: "linux",
          osFamily: "linux",
          transport: "stdio",
          routePassportId: "passport_cline_mcp",
          configHash: "fnv1a-12345678"
        },
        coverage: {
          claim: "mediated",
          evidenceScope: "route",
          producingEvidence: true
        }
      }
    };
    const session = new CoreSession({
      evidenceRoot: root,
      runId: call.runId,
      clock: () => new Date("2026-06-26T00:00:00.000Z")
    });

    await session.mediateSuccessfulCall(call, { ok: true, secret: `Bearer ${"A".repeat(32)}` });

    const persisted = (await readFile(session.recorder.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CoreEvent);

    for (const event of persisted) {
      expect(event.schemaVersion).toBe(CANONICAL_VISIBILITY_SCHEMA_VERSION);
      expect(event.visibility).toMatchObject({
        schemaVersion: CANONICAL_VISIBILITY_SCHEMA_VERSION,
        visibilityLevel: "mediated",
        coverageClaim: "mediated",
        routePassportId: "passport_cline_mcp",
        routeType: "mcp-routed",
        evidenceScope: "route",
        producingEvidence: true,
        harness: { harnessId: call.harnessId, name: "Cline" },
        platform: {
          hostId: "cline",
          hostName: "Cline",
          osPlatform: "linux",
          osFamily: "linux",
          transport: "stdio",
          configHash: "fnv1a-12345678"
        },
        traceContext: { traceparent, source: "provided" }
      });
      expect(JSON.stringify(event)).not.toContain("A".repeat(32));
    }
  });

  it("labels direct ToolGuard Core failures as mediated in JSONL visibility metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-direct-core-visibility-"));
    const call = {
      ...makeToolCall("non-mcp-direct"),
      harnessName: "Core API demo",
      adapterName: "ToolGuard Core",
      runName: "direct local ToolGuard failure"
    };
    const session = new CoreSession({ evidenceRoot: root, runId: call.runId });

    await session.failToolCall(call, "non_zero_exit", ["safe direct fixture failure"]);

    const persisted = (await readFile(session.recorder.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CoreEvent);

    expect(persisted.length).toBeGreaterThan(0);
    for (const event of persisted) {
      expect(event.visibility).toMatchObject({
        visibilityLevel: "mediated",
        coverageClaim: "mediated",
        harness: { name: "Core API demo" }
      });
    }
  });

  it("preserves explicit observed claims for non-routed imported evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-observed-import-visibility-"));
    const call = {
      ...makeToolCall("non-mcp-direct"),
      routeMetadata: {
        coverage: {
          claim: "observed" as const,
          evidenceScope: "host-config" as const,
          producingEvidence: false
        }
      }
    };
    const session = new CoreSession({ evidenceRoot: root, runId: call.runId });

    await session.failToolCall(call, "non_zero_exit", ["safe imported observation"]);

    const persisted = (await readFile(session.recorder.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CoreEvent);

    expect(persisted.every((event) => event.visibility?.visibilityLevel === "observed")).toBe(true);
    expect(persisted.every((event) => event.visibility?.coverageClaim === "observed")).toBe(true);
    expect(persisted.every((event) => event.visibility?.evidenceScope === "host-config")).toBe(true);
    expect(persisted.every((event) => event.visibility?.producingEvidence === false)).toBe(true);
  });

  it("generates deterministic W3C trace context when route metadata does not provide one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-visibility-generated-trace-"));
    const call = makeToolCall("cli-wrapper");
    const session = new CoreSession({ evidenceRoot: root, runId: call.runId });

    await session.failToolCall(call, "non_zero_exit", ["safe local failure"]);

    const persisted = (await readFile(session.recorder.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CoreEvent);
    const traceparents = persisted.map((event) => event.visibility?.traceContext.traceparent);

    expect(new Set(traceparents).size).toBe(1);
    expect(traceparents[0]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(persisted[0]?.visibility?.traceContext.source).toBe("generated");
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

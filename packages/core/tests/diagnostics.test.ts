import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClassifiedToolError, CoreSession, ToolRegistry, createId, type FailureCard, type ToolCall } from "../src/index.js";

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
    deadlineMs: 25,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    ...overrides
  };
}

function expectFailure(result: unknown): FailureCard {
  expect(result).toHaveProperty("failureType");
  return result as FailureCard;
}

async function createSession(): Promise<CoreSession> {
  const root = await mkdtemp(path.join(tmpdir(), "toolguard-diagnostics-"));
  return new CoreSession({ evidenceRoot: root, runId: createId("run") });
}

describe("root-cause diagnostics", () => {
  it("adds diagnostic fields and evidence anchors to Failure Cards", async () => {
    const session = await createSession();
    const call = makeCall({ runId: session.runId, toolName: "missing-bin", arguments: { command: "definitely-missing-toolguard-bin" } });

    const failure = await session.failToolCall(call, "spawn_failure", [
      "spawn definitely-missing-toolguard-bin ENOENT"
    ]);

    expect(failure.failureCause).toBe("missing-binary");
    expect(failure.failureBoundary).toBe("environment");
    expect(failure.failureMechanism).toContain("executable");
    expect(failure.rootCauseConfidence).toBe("high");
    expect(failure.diagnosticHypotheses[0]).toMatchObject({ cause: "missing-binary", rank: 1 });
    expect(failure.evidenceAnchors.length).toBeGreaterThan(0);
    expect(failure.evidenceAnchors.map((anchor) => anchor.evidenceType)).toContain("command-resolution");
  });

  it("diagnoses wrong cwd with cwd and package context evidence", async () => {
    const session = await createSession();
    const call = makeCall({
      runId: session.runId,
      toolName: "fixture.wrong-cwd",
      arguments: { expectedCwd: "/tmp/toolguard-fixture-sandbox" }
    });

    const failure = await session.failToolCall(call, "cwd_mismatch", [
      "expected cwd: /tmp/toolguard-fixture-sandbox",
      `actual cwd: ${process.cwd()}`
    ]);

    expect(failure.failureCause).toBe("wrong-cwd");
    expect(failure.evidenceAnchors.map((anchor) => anchor.evidenceType)).toEqual(
      expect.arrayContaining(["cwd-fact", "package-context"])
    );
    expect(failure.contributingFactors.join(" ")).toMatch(/working directory/i);
  });

  it("diagnoses permission denied in temporary directories without real repo mutation", async () => {
    const session = await createSession();
    const call = makeCall({
      runId: session.runId,
      toolName: "fixture.permission",
      arguments: { cwd: path.join(tmpdir(), "toolguard-denied") }
    });

    const failure = await session.failToolCall(call, "non_zero_exit", [
      `EACCES: permission denied, open '${path.join(tmpdir(), "toolguard-denied", "out.txt")}'`
    ]);

    expect(failure.failureCause).toBe("permission-denied-temp");
    expect(failure.failureBoundary).toBe("environment");
    expect(failure.evidenceAnchors.map((anchor) => anchor.evidenceType)).toContain("permission-fact");
  });

  it("diagnoses schema mismatches with validation path anchors", async () => {
    const session = await createSession();
    const registry = new ToolRegistry();
    let invoked = false;
    registry.register({
      toolName: "fixture.echo",
      title: "Echo",
      description: "Echoes input",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: {
        type: "object",
        required: ["message"],
        properties: { message: { type: "string" } },
        additionalProperties: false
      },
      destructiveRisk: "none",
      execute: () => {
        invoked = true;
        return { ok: true };
      }
    });

    const failure = expectFailure(await session.executeToolCall(registry, makeCall({ runId: session.runId, arguments: { message: 42 } })));

    expect(invoked).toBe(false);
    expect(failure.failureCause).toBe("schema-mismatch");
    expect(failure.evidenceAnchors).toContainEqual(
      expect.objectContaining({ evidenceType: "schema-validation", path: "arguments.message" })
    );
  });

  it("diagnoses protocol parse failures with parse or frame evidence", async () => {
    const session = await createSession();
    const call = makeCall({ runId: session.runId, toolName: "fixture.malformed-json" });

    const failure = await session.failToolCall(call, "malformed_json", [
      'raw payload: {"unterminated": true',
      "parse error: Unexpected end of JSON input at position 23"
    ]);

    expect(failure.failureCause).toBe("protocol-parse-failure");
    expect(failure.evidenceAnchors).toContainEqual(
      expect.objectContaining({ evidenceType: "parse-offset", summary: expect.stringContaining("23") })
    );
  });

  it("diagnoses timeout source as caller deadline when deadline evidence exists", async () => {
    const session = await createSession();
    const registry = new ToolRegistry();
    registry.register({
      toolName: "fixture.slow",
      title: "Slow",
      description: "Exceeds deadline",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      execute: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("slow fixture aborted by deadline")));
        })
    });

    const failure = expectFailure(await session.executeToolCall(registry, makeCall({ runId: session.runId, toolName: "fixture.slow", arguments: {}, deadlineMs: 5 })));

    expect(failure.failureCause).toBe("caller-deadline-timeout");
    expect(failure.failureMechanism).toContain("deadline");
    expect(failure.evidenceAnchors).toContainEqual(
      expect.objectContaining({ evidenceType: "timeout-source", summary: expect.stringContaining("5ms") })
    );
  });

  it("redacts diagnostic hypotheses and anchors", async () => {
    const session = await createSession();
    const call = makeCall({ runId: session.runId, toolName: "fixture.secret-diagnostic" });
    const failure = await session.failToolCall(call, "process_crash", [
      "stderr: token=supersecretvaluethatshouldberemoved123456",
      "Bearer abcdefghijklmnopqrstuvwxyz123456"
    ]);

    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("supersecretvaluethatshouldberemoved123456");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(serialized).toContain("[REDACTED:");
  });

  it("uses raw classified details as diagnostic evidence without leaking them into safe summaries", async () => {
    const session = await createSession();
    const call = makeCall({ runId: session.runId, toolName: "fixture.classified" });

    const failure = await session.failToolCall(call, new ClassifiedToolError("malformed_json", "Bad frame", [
      "frame: content-length mismatch",
      "parse offset: 9"
    ]).failureType, ["frame: content-length mismatch", "parse offset: 9"]);

    expect(failure.failureCause).toBe("protocol-parse-failure");
    expect(failure.safeSummary).not.toContain("content-length mismatch");
    expect(failure.evidenceAnchors.map((anchor) => anchor.evidenceType)).toContain("parse-offset");
  });
});

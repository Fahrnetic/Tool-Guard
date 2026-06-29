import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClassifiedToolError,
  CoreSession,
  ToolRegistry,
  createId,
  exportStaticReport,
  simulatePolicy,
  type CoreEvent,
  type FailureCard,
  type ToolCall,
  type ToolResult
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
    toolName: "fixture.target",
    arguments: {},
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
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CoreEvent);
}

describe("context and token waste accounting", () => {
  it("records model-facing bytes/chars and heuristic token estimate provenance for bounded output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-context-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId, outputLimitBytes: 48 });
    const registry = new ToolRegistry();
    registry.register({
      toolName: "fixture.big",
      title: "Large output",
      description: "Returns oversized content.",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      execute: () => ({ blob: "x".repeat(512) })
    });

    const result = (await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.big" })
    )) as ToolResult;

    expect(result.contextImpact.modelFacingContent.bytes).toBeGreaterThan(0);
    expect(result.contextImpact.modelFacingContent.chars).toBeGreaterThan(0);
    expect(result.contextImpact.tokenEstimate.method).toBe("heuristic-chars-div-4");
    expect(result.contextImpact.tokenEstimate.provenance).toMatch(/provider token usage unavailable/i);
    expect(result.contextImpact.preventedContextFlood.rawEstimate.bytes).toBeGreaterThan(
      result.contextImpact.preventedContextFlood.safeDisplayedEstimate.bytes
    );
    expect(result.contextImpact.truncationSavings.bytes).toBeGreaterThan(0);

    const completed = (await readEvents(session)).find((event) => event.type === "tool.call.completed");
    expect(completed?.data).toMatchObject({
      contextImpact: {
        tokenEstimate: { method: "heuristic-chars-div-4" }
      }
    });
  });

  it("measures redaction savings for secret-like output without exposing raw secret in model-facing fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-context-secret-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const registry = new ToolRegistry();
    const secret = `Bearer ${"A".repeat(32)}`;
    registry.register({
      toolName: "fixture.secret",
      title: "Secret output",
      description: "Returns secret-like content.",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      execute: () => ({ message: "safe prefix", authorization: secret })
    });

    const failure = (await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.secret" })
    )) as FailureCard;

    expect(failure.failureType).toBe("secret_leak_risk");
    expect(failure.contextImpact.redactionSavings.bytes).toBeGreaterThan(0);
    expect(failure.contextImpact.truncationSavings.bytes).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(failure.contextImpact)).not.toContain(secret);
  });

  it("measures duplicate retry context and retry amplification for repeated failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-context-retry-"));
    const runId = createId("run");
    const session = new CoreSession({
      evidenceRoot: root,
      runId,
      retry: { maxRetries: 2 },
      circuitBreaker: { failureThreshold: 99 }
    });
    const registry = new ToolRegistry();
    let calls = 0;
    registry.register({
      toolName: "fixture.retry-loop",
      title: "Retry loop",
      description: "Always fails the same way.",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      execute: () => {
        calls += 1;
        throw new ClassifiedToolError("process_crash", "same crash", ["identical raw failure"]);
      }
    });

    const failure = (await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.retry-loop" })
    )) as FailureCard;

    expect(calls).toBe(3);
    expect(failure.contextImpact.duplicateRetryContext.repeatedFingerprintCount).toBe(3);
    expect(failure.contextImpact.duplicateRetryContext.estimatedDuplicateBytes).toBeGreaterThan(0);
    expect(failure.contextImpact.retryAmplification.attemptCount).toBe(3);
    expect(failure.contextImpact.retryAmplification.contextMultiplier).toBe(3);
  });

  it("adds context waste deltas to policy simulation and estimation notes to reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-context-report-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });

    const simulation = await simulatePolicy({
      session,
      scenarioId: "retry-loop-failure",
      proposedPolicy: { retryLimit: 0 }
    });
    expect(simulation.contextDelta.before.estimatedTokens).toBeGreaterThan(
      simulation.contextDelta.after.estimatedTokens
    );
    expect(simulation.contextDelta.delta.estimatedTokens).toBeLessThan(0);
    expect(simulation.contextDelta.estimation.method).toBe("heuristic-chars-div-4");

    await session.failToolCall(makeCall({ runId }), "timeout", ["deadline exceeded"]);
    const report = await exportStaticReport({ runDir: session.recorder.runDir });
    const html = await readFile(report.reportPath, "utf8");
    const manifest = await readFile(report.manifestPath, "utf8");
    expect(html).toMatch(/Token estimate method/i);
    expect(html).toMatch(/heuristic-chars-div-4/);
    expect(manifest).toMatch(/contextEstimationNotes/);
  });
});

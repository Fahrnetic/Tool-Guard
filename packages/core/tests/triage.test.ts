import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClassifiedToolError,
  CoreSession,
  ToolRegistry,
  buildTriagePayload,
  createId,
  exportIssuePacket,
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
    toolName: "fixture.triage",
    arguments: {},
    deadlineMs: 50,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    ...overrides
  };
}

describe("failure triage workflow and issue export", () => {
  it("groups repeated failures by fingerprint, assigns severity, and answers incident questions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-triage-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId, retry: { maxRetries: 1 }, circuitBreaker: { failureThreshold: 99 } });
    const registry = new ToolRegistry();
    registry.register({
      toolName: "fixture.triage",
      title: "Triage failure",
      description: "Always fails with the same sanitized classified error.",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      execute: () => {
        throw new ClassifiedToolError("process_crash", "repeatable crash", ["same crash evidence"]);
      }
    });

    const failure = (await session.executeToolCall(registry, makeCall({ runId }))) as FailureCard;
    expect(failure.retryLoopFinding?.repeatedFailures).toBe(2);

    const triage = buildTriagePayload({
      runId,
      events: session.recorder.events,
      ledger: session.recorder.ledger,
      baseUrl: "http://127.0.0.1:3660"
    });

    expect(triage.groups).toHaveLength(1);
    expect(triage.summary.failures).toBeGreaterThanOrEqual(1);
    expect(triage.groups[0]?.count).toBeGreaterThanOrEqual(1);
    expect(triage.groups[0]?.severity).toMatch(/medium|high|critical/);
    expect(triage.groups[0]?.answers.map((answer) => answer.question)).toEqual([
      "what failed",
      "why",
      "impact",
      "waste",
      "next safe action"
    ]);
    expect(triage.groups[0]?.nextSafeActions.join(" ")).toMatch(/safe loopback|fixture-only|Do not retry/i);
  });

  it("exports safe Markdown issue packets with contained loopback links and no secret-shaped values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-triage-export-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    await session.failToolCall(makeCall({ runId, toolName: "fixture.secret-risk" }), "secret_leak_risk", [
      `Bearer ${"A".repeat(32)}`
    ]);

    const exported = await exportIssuePacket({
      runId,
      runDir: session.recorder.runDir,
      events: session.recorder.events,
      ledger: session.recorder.ledger,
      baseUrl: "http://127.0.0.1:3660"
    });
    const markdown = await readFile(exported.issuePacketPath, "utf8");

    expect(exported.containedLinks).toBe(true);
    expect(exported.noSecretFindings).toEqual([]);
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("### Recommended fix / next safe actions");
    expect(markdown).toContain("http://127.0.0.1:3660/api/topology/");
    expect(markdown).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i);
    expect(markdown).not.toMatch(/\]\((?!http:\/\/127\.0\.0\.1:3660\/api\/)[^)]+\)/);
  });
});

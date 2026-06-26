import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClassifiedToolError,
  CoreSession,
  ToolRegistry,
  createId,
  exportStaticReport,
  registerChaosFixtures,
  redactString,
  validateReportManifest,
  type CoreEvent,
  type FailureCard,
  type RegisteredTool,
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
    toolName: "fixture.target",
    arguments: {},
    deadlineMs: 25,
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

function retryableCrashTool(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    toolName: "fixture.target",
    title: "Retryable target",
    description: "Fails with a retryable process crash.",
    protocol: "fixture",
    downstreamServerId: createId("server"),
    inputSchema: { type: "object", properties: {} },
    destructiveRisk: "none",
    execute: () => {
      throw new ClassifiedToolError("process_crash", "crash", ["controlled retryable crash"]);
    },
    ...overrides
  };
}

describe("policy, redaction, reports, and demos", () => {
  const placeholderBearer = `Bearer ${"X".repeat(24)}`;
  const placeholderApiKey = `sk-${"X".repeat(32)}`;
  const placeholderAssignedKey = `api_key=${"X".repeat(32)}`;

  it("evaluates policy before downstream execution and blocks destructive real-world calls", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-policy-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const registry = new ToolRegistry();
    let invoked = false;

    registry.register({
      toolName: "fixture.destructive",
      title: "Destructive fixture",
      description: "A destructive fixture that is safe only when fixtureOnly is true.",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: {
        type: "object",
        properties: { fixtureOnly: { type: "boolean" } },
        additionalProperties: false
      },
      destructiveRisk: "high",
      execute: () => {
        invoked = true;
        return { ok: true };
      }
    });

    const result = await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.destructive", arguments: {}, idempotency: "non-idempotent" })
    );

    expect("failureType" in result ? result.failureType : undefined).toBe("destructive_action_blocked");
    expect(invoked).toBe(false);
    const events = await readEvents(session);
    const policyEvent = events.find((event) => event.type === "policy.decision");
    const failedEvent = events.find((event) => event.type === "tool.call.failed");
    expect(policyEvent?.sequence).toBeLessThan(failedEvent?.sequence ?? Number.MAX_SAFE_INTEGER);
    expect(policyEvent?.data).toMatchObject({ decision: "block", retryable: false });

    const allowed = await session.executeToolCall(
      registry,
      makeCall({
        runId,
        toolName: "fixture.destructive",
        arguments: { fixtureOnly: true },
        idempotency: "non-idempotent"
      })
    );
    expect("failureType" in allowed).toBe(false);
    expect(invoked).toBe(true);
  });

  it("bounds retryable failures with unique attempts and retry evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-retry-"));
    const runId = createId("run");
    const session = new CoreSession({
      evidenceRoot: root,
      runId,
      retry: { maxRetries: 2 },
      circuitBreaker: { failureThreshold: 99 }
    });
    const registry = new ToolRegistry();
    let calls = 0;

    registry.register(
      retryableCrashTool({
        execute: () => {
          calls += 1;
          throw new ClassifiedToolError("process_crash", "crash", [`attempt ${calls}`]);
        }
      })
    );

    const result = await session.executeToolCall(registry, makeCall({ runId }));

    expect("failureType" in result ? result.failureType : undefined).toBe("process_crash");
    expect(calls).toBe(3);
    const events = await readEvents(session);
    expect(events.filter((event) => event.type === "tool.retry.scheduled")).toHaveLength(2);
    expect(new Set(events.filter((event) => event.type === "tool.call.started").map((event) => event.attemptId)).size).toBe(
      3
    );
  });

  it("suppresses automatic retries for non-idempotent unsafe calls and explains it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-unsafe-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId, retry: { maxRetries: 3 } });
    const registry = new ToolRegistry();
    let calls = 0;
    registry.register(
      retryableCrashTool({
        destructiveRisk: "medium",
        execute: () => {
          calls += 1;
          throw new ClassifiedToolError("process_crash", "crash", ["unsafe call failed"]);
        }
      })
    );

    const result = await session.executeToolCall(
      registry,
      makeCall({ runId, idempotency: "non-idempotent", arguments: { fixtureOnly: true } })
    );

    expect("failureType" in result ? result.failureType : undefined).toBe("process_crash");
    expect(calls).toBe(1);
    expect((result as FailureCard).safeSummary).toMatch(/not retried/i);
    const events = await readEvents(session);
    expect(events.filter((event) => event.type === "tool.retry.scheduled")).toHaveLength(0);
  });

  it("opens circuit per affected target, fast-fails, and closes after cooldown recovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-circuit-"));
    const runId = createId("run");
    let now = 0;
    const session = new CoreSession({
      evidenceRoot: root,
      runId,
      clock: () => new Date(now),
      retry: { maxRetries: 0 },
      circuitBreaker: { failureThreshold: 2, openMs: 50 }
    });
    const registry = new ToolRegistry();
    let unhealthy = true;
    let failingCalls = 0;
    const affectedServerId = createId("server");
    const healthyServerId = createId("server");

    registry.register(
      retryableCrashTool({
        downstreamServerId: affectedServerId,
        execute: () => {
          failingCalls += 1;
          if (unhealthy) {
            throw new ClassifiedToolError("process_crash", "crash", ["qualifying failure"]);
          }
          return { recovered: true };
        }
      })
    );
    registry.register({
      toolName: "fixture.healthy",
      title: "Healthy target",
      description: "Unrelated target that should not be blocked.",
      protocol: "fixture",
      downstreamServerId: healthyServerId,
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      execute: () => ({ ok: true })
    });

    await session.executeToolCall(registry, makeCall({ runId, downstreamServerId: affectedServerId }));
    await session.executeToolCall(registry, makeCall({ runId, downstreamServerId: affectedServerId }));
    const fastFailed = await session.executeToolCall(registry, makeCall({ runId, downstreamServerId: affectedServerId }));
    const healthy = await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.healthy", downstreamServerId: healthyServerId })
    );
    now = 51;
    unhealthy = false;
    const recovered = await session.executeToolCall(registry, makeCall({ runId, downstreamServerId: affectedServerId }));

    expect("failureType" in fastFailed ? fastFailed.failureType : undefined).toBe("circuit_open");
    expect("failureType" in healthy).toBe(false);
    expect("failureType" in recovered).toBe(false);
    expect(failingCalls).toBe(3);
    const events = await readEvents(session);
    expect(events.map((event) => event.type)).toContain("circuit.opened");
    expect(events.map((event) => event.type)).toContain("circuit.closed");
  });

  it("redacts secret-shaped values from user-visible strings and exported reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-redact-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const registry = new ToolRegistry();
    registry.register({
      toolName: "fixture.secret",
      title: "Secret output",
      description: "Returns secret-like output.",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {} },
      destructiveRisk: "none",
      execute: () => ({ token: placeholderBearer, apiKey: placeholderApiKey })
    });

    const result = await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.secret", arguments: {} })
    );
    expect("failureType" in result ? result.failureType : undefined).toBe("secret_leak_risk");
    expect(JSON.stringify(result)).not.toMatch(/Bearer|sk-/);
    expect(redactString(placeholderAssignedKey)).toContain("[REDACTED:");

    const report = await exportStaticReport({ runDir: session.recorder.runDir });
    const html = await readFile(report.reportPath, "utf8");
    const manifest = await readFile(report.manifestPath, "utf8");
    expect(html).not.toMatch(/Bearer|sk-|X{12,}/);
    expect(manifest).not.toMatch(/Bearer|sk-|X{12,}/);
  });

  it("exports and validates browser-safe static report artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-report-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const registry = new ToolRegistry();
    registerChaosFixtures(registry, { sandboxRoot: root });

    await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.prompt-injection-output", arguments: {} })
    );
    const report = await session.exportReport();
    const validation = await validateReportManifest({ runDir: session.recorder.runDir });

    expect(validation.valid).toBe(true);
    await expect(access(report.reportPath)).resolves.toBeUndefined();
    await expect(access(report.manifestPath)).resolves.toBeUndefined();
    await expect(access(path.join(session.recorder.runDir, "artifact-hashes.json"))).resolves.toBeUndefined();
    await expect(access(path.join(session.recorder.runDir, "redaction-summary.json"))).resolves.toBeUndefined();
    const html = await readFile(report.reportPath, "utf8");
    expect(html).toContain("Failure narrative");
    expect(html).toContain("Remediation steps");
    expect(html).not.toMatch(/ignore previous instructions/i);
    const events = await readEvents(session);
    expect(events.map((event) => event.type)).toContain("report.exported");
  });
});

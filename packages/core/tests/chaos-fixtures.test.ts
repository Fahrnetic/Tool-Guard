import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CoreSession,
  ToolRegistry,
  createId,
  registerChaosFixtures,
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
    toolName: "fixture.good",
    arguments: {},
    deadlineMs: 25,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    ...overrides
  };
}

async function executeFixture(
  toolName: string,
  options: { readonly deadlineMs?: number } = {}
): Promise<{ readonly session: CoreSession; readonly result: ToolResult | FailureCard; readonly events: CoreEvent[] }> {
  const root = await mkdtemp(path.join(tmpdir(), "toolguard-chaos-"));
  const runId = createId("run");
  const session = new CoreSession({ evidenceRoot: root, runId });
  const registry = new ToolRegistry();
  registerChaosFixtures(registry, { sandboxRoot: root });

  const result = await session.executeToolCall(
    registry,
    makeCall({ runId, toolName, arguments: {}, deadlineMs: options.deadlineMs ?? 25 })
  );
  const events = (await readFile(session.recorder.eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CoreEvent);

  return { session, result, events };
}

function expectFailureCard(result: ToolResult | FailureCard, failureType: FailureCard["failureType"]): FailureCard {
  expect("failureType" in result ? result.failureType : undefined).toBe(failureType);
  const failure = result as FailureCard;
  expect(failure.toolName).toMatch(/^fixture\./);
  expect(failure.failureType).toBe(failureType);
  expect(failure.likelyRootCause).not.toHaveLength(0);
  expect(typeof failure.retryable).toBe("boolean");
  expect(typeof failure.doNotRetrySameCall).toBe("boolean");
  expect(failure.safeRecoveryOptions.length).toBeGreaterThan(0);
  expect(failure.humanFix).not.toHaveLength(0);
  expect(failure.evidenceLinks.length).toBeGreaterThan(0);
  expect(failure.safeSummary).not.toHaveLength(0);
  expect(failure.rawDetailsSeparated).toBe(true);
  return failure;
}

async function expectEvidenceLinksResolve(
  session: CoreSession,
  events: readonly CoreEvent[],
  failure: FailureCard
): Promise<void> {
  const artifactIds = new Set(
    events
      .filter((event) => event.type === "evidence.artifact.created")
      .map((event) => event.artifactId)
      .filter((artifactId): artifactId is NonNullable<typeof artifactId> => Boolean(artifactId))
  );
  for (const link of failure.evidenceLinks) {
    expect(artifactIds.has(link.artifactId)).toBe(true);
    await expect(access(path.join(session.recorder.runDir, link.href))).resolves.toBeUndefined();
  }
}

describe("deterministic chaos fixtures and failure cards", () => {
  it("returns stable successful results for the good fixture across repeated runs", async () => {
    const first = await executeFixture("fixture.good");
    const second = await executeFixture("fixture.good");

    expect("failureType" in first.result).toBe(false);
    expect("failureType" in second.result).toBe(false);
    expect((first.result as ToolResult).output).toEqual({
      ok: true,
      fixture: "good",
      message: "ToolGuard chaos fixture completed deterministically."
    });
    expect((second.result as ToolResult).output).toEqual((first.result as ToolResult).output);
    expect(first.events.map((event) => event.type)).toContain("tool.call.completed");
    expect(first.events.map((event) => event.type)).not.toContain("tool.call.failed");
  });

  it.each([
    ["fixture.wrong-cwd", "cwd_mismatch", false],
    ["fixture.malformed-json", "malformed_json", false],
    ["fixture.crash-after-initialize", "process_crash", true]
  ] as const)("classifies %s into a normalized failure card", async (toolName, failureType, retryable) => {
    const { session, result, events } = await executeFixture(toolName);

    const failure = expectFailureCard(result, failureType);
    await expectEvidenceLinksResolve(session, events, failure);
    expect(failure.retryable).toBe(retryable);
    if (!retryable) {
      expect(failure.doNotRetrySameCall).toBe(true);
      expect(failure.safeRecoveryOptions.join(" ")).toMatch(/change|fix|inspect|repair|use/i);
    }
  });

  it.each([
    ["fixture.slow", "timeout"],
    ["fixture.hanging-stream", "timeout"]
  ] as const)("bounds %s by deadlines without hanging the test process", async (toolName, failureType) => {
    const started = Date.now();
    const { session, result, events } = await executeFixture(toolName, { deadlineMs: 10 });

    expect(Date.now() - started).toBeLessThan(500);
    const failure = expectFailureCard(result, failureType);
    await expectEvidenceLinksResolve(session, events, failure);
    expect(events.find((event) => event.type === "tool.call.failed")?.data).toMatchObject({ failureType });
  });

  it("sanitizes prompt-injection fixture output and suppresses same-call retry", async () => {
    const { session, result, events } = await executeFixture("fixture.prompt-injection-output");

    const failure = expectFailureCard(result, "prompt_injection_output");
    await expectEvidenceLinksResolve(session, events, failure);
    expect(failure.retryable).toBe(false);
    expect(failure.doNotRetrySameCall).toBe(true);
    expect(JSON.stringify(failure)).not.toMatch(/ignore previous instructions/i);
    expect(events.map((event) => event.type)).toContain("output.sanitized");
  });

  it("keeps malformed payloads out of failure cards while retaining resolvable evidence links", async () => {
    const { session, result, events } = await executeFixture("fixture.malformed-json");
    const failure = expectFailureCard(result, "malformed_json");

    expect(JSON.stringify(failure)).not.toContain('{"unterminated":');
    await expectEvidenceLinksResolve(session, events, failure);
  });
});

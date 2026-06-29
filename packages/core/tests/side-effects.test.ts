import { access, mkdtemp, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CoreSession,
  ToolRegistry,
  createId,
  labelBlastRadius,
  registerChaosFixtures,
  validateReportManifest,
  type CoreEvent,
  type FailureCard,
  type RegisteredTool,
  type SideEffectLedgerEntry,
  type SideEffectTargetType,
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
    toolName: "fixture.good",
    arguments: {},
    deadlineMs: 25,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    ...overrides
  };
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function gitInit(cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile("git", ["init"], { cwd }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.end();
  });
}

async function fixtureSession(
  options: { readonly outputLimitBytes?: number; readonly maxRetries?: number; readonly circuitThreshold?: number } = {}
) {
  const root = await mkdtemp(path.join(tmpdir(), "toolguard-ledger-"));
  const runId = createId("run");
  const session = new CoreSession({
    evidenceRoot: root,
    runId,
    ...(options.outputLimitBytes ? { outputLimitBytes: options.outputLimitBytes } : {}),
    retry: { maxRetries: options.maxRetries ?? 1 },
    circuitBreaker: { failureThreshold: options.circuitThreshold ?? 2, openMs: 1_000 }
  });
  const registry = new ToolRegistry();
  registerChaosFixtures(registry, { sandboxRoot: root });
  return { root, runId, session, registry };
}

describe("side-effect ledger, blast radius, and retry-loop intelligence", () => {
  it("uses only the architecture-required side-effect target taxonomy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-target-taxonomy-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const registry = new ToolRegistry();
    const expectedTargetTypes = [
      "filesystem",
      "process",
      "git",
      "network-loopback",
      "mcp-tool",
      "python-framework-tool",
      "report-artifact",
      "ui-action"
    ] satisfies readonly SideEffectTargetType[];

    const baseTool = {
      title: "Target taxonomy fixture",
      description: "Records a successful side-effect target classification.",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
      destructiveRisk: "none" as const,
      execute: () => ({ ok: true })
    };
    const tools: RegisteredTool[] = [
      { ...baseTool, toolName: "target.filesystem", protocol: "fixture" },
      { ...baseTool, toolName: "target.process", protocol: "process" },
      { ...baseTool, toolName: "git.status", protocol: "process" },
      { ...baseTool, toolName: "target.http", protocol: "http" },
      { ...baseTool, toolName: "target.mcp", protocol: "mcp" },
      { ...baseTool, toolName: "target.python", protocol: "in-process" },
      { ...baseTool, toolName: "report.export", protocol: "in-process" },
      { ...baseTool, toolName: "target.browser", protocol: "browser" }
    ];

    for (const tool of tools) {
      registry.register(tool);
      await session.executeToolCall(
        registry,
        makeCall({
          runId,
          toolName: tool.toolName,
          downstreamServerId: tool.downstreamServerId,
          sourcePath: tool.toolName === "target.python" ? "framework-adapter" : "non-mcp-direct"
        })
      );
    }

    const ledger = await readJsonl<SideEffectLedgerEntry>(session.recorder.ledgerPath);
    expect(ledger.map((row) => row.targetType)).toEqual(expectedTargetTypes);
  });

  it("records ledger rows and events for completed, blocked, retried, and failed calls", async () => {
    const { runId, session, registry } = await fixtureSession({ maxRetries: 1 });

    await session.executeToolCall(registry, makeCall({ runId, toolName: "fixture.good" }));
    await session.executeToolCall(
      registry,
      makeCall({
        runId,
        toolName: "fixture.destructive-block",
        arguments: {},
        idempotency: "non-idempotent"
      })
    );
    await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.timeout-retry", deadlineMs: 5, idempotency: "idempotent" })
    );

    const ledger = await readJsonl<SideEffectLedgerEntry>(session.recorder.ledgerPath);
    const events = await readJsonl<CoreEvent>(session.recorder.eventsPath);

    expect(ledger.map((row) => row.effectState)).toEqual(
      expect.arrayContaining(["completed", "blocked", "planned", "none"])
    );
    expect(ledger.every((row) => row.runId === runId && row.traceId && row.toolCallId && row.attemptId)).toBe(true);
    expect(ledger.every((row) => row.policyDecisionId && row.blastRadius.score >= 0 && row.blastRadius.score <= 100)).toBe(
      true
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["side_effect.recorded", "blast_radius.scored"])
    );
  });

  it("captures observed impact for fixture routes using registered sandbox metadata when cwd is absent", async () => {
    const { runId, session, registry, root } = await fixtureSession();

    await session.executeToolCall(registry, makeCall({ runId, toolName: "fixture.good", arguments: {} }));
    const ledger = await readJsonl<SideEffectLedgerEntry>(session.recorder.ledgerPath);
    const row = ledger.find((entry) => entry.toolName === "fixture.good");

    expect(row?.observedImpact?.workspaceRoot).toBe(root);
    expect(row?.observedImpact?.fileChanges).toContainEqual(
      expect.objectContaining({ path: "fixture-sandbox", changeType: "created" })
    );
    expect(row?.evidenceBasis).toContain("filesystem-diff");
    expect(row?.attributionLevel).toBe("observed-after");
  });

  it("resolves timeout impact to no observed local mutation when postflight file and git checks are unchanged", async () => {
    const { runId, session, registry, root } = await fixtureSession({ maxRetries: 0 });
    await gitInit(root);

    await session.executeToolCall(registry, makeCall({ runId, toolName: "fixture.slow", arguments: {}, deadlineMs: 5 }));
    const ledger = await readJsonl<SideEffectLedgerEntry>(session.recorder.ledgerPath);
    const row = ledger.find((entry) => entry.toolName === "fixture.slow");

    expect(row?.effectState).toBe("none");
    expect(row?.observedImpact?.outcome).toBe("none");
    expect(row?.observedImpact?.fileChanges).toEqual([]);
    expect(row?.observedImpact?.gitStatus?.changed).toBe(false);
    expect(row?.observedImpact?.gitStatus?.after).toEqual(row?.observedImpact?.gitStatus?.before);
    expect(row?.evidenceBasis).toContain("postflight-no-mutation");
    expect(row?.attributionLevel).toBe("observed-caused");
    expect(row?.causalClaim).toMatch(/No local mutation was observed/i);
  });

  it("classifies destructive fixture attempts as blocked or simulated without workspace mutation", async () => {
    const { runId, session, registry, root } = await fixtureSession();

    const blocked = await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.destructive-block", arguments: {}, idempotency: "non-idempotent" })
    );
    const simulated = await session.executeToolCall(
      registry,
      makeCall({
        runId,
        toolName: "fixture.destructive-block",
        arguments: { fixtureOnly: true },
        idempotency: "non-idempotent"
      })
    );
    const ledger = await readJsonl<SideEffectLedgerEntry>(session.recorder.ledgerPath);

    expect((blocked as FailureCard).failureType).toBe("destructive_action_blocked");
    expect("failureType" in simulated).toBe(false);
    expect(ledger.filter((row) => row.toolName === "fixture.destructive-block").map((row) => row.effectState)).toEqual([
      "blocked",
      "simulated"
    ]);
    expect(ledger.filter((row) => row.toolName === "fixture.destructive-block").map((row) => row.reversibility)).toEqual([
      "irreversible-risk",
      "fixture-only"
    ]);
    await expect(access(path.join(root, "fixture-sandbox"))).rejects.toThrow();
  });

  it("assigns deterministic blast-radius scores and boundary labels", async () => {
    expect([0, 24, 25, 49, 50, 74, 75, 100].map(labelBlastRadius)).toEqual([
      "contained",
      "contained",
      "limited",
      "limited",
      "workspace-risk",
      "workspace-risk",
      "system-risk",
      "system-risk"
    ]);

    const first = await fixtureSession();
    await first.session.executeToolCall(
      first.registry,
      makeCall({ runId: first.runId, toolName: "fixture.destructive-block", arguments: {} })
    );
    const second = await fixtureSession();
    await second.session.executeToolCall(
      second.registry,
      makeCall({ runId: second.runId, toolName: "fixture.destructive-block", arguments: {} })
    );
    const firstLedger = await readJsonl<SideEffectLedgerEntry>(first.session.recorder.ledgerPath);
    const secondLedger = await readJsonl<SideEffectLedgerEntry>(second.session.recorder.ledgerPath);

    expect(firstLedger[0]?.blastRadius.score).toBe(secondLedger[0]?.blastRadius.score);
    expect(firstLedger[0]?.blastRadius.factors.length).toBeGreaterThan(0);
  });

  it("detects retry loops and extends failure cards while preserving raw-detail separation", async () => {
    const { runId, session, registry } = await fixtureSession({ maxRetries: 2, circuitThreshold: 99 });

    const result = await session.executeToolCall(
      registry,
      makeCall({ runId, toolName: "fixture.circuit-open-fast-fail", deadlineMs: 100, idempotency: "idempotent" })
    );
    const failure = result as FailureCard;
    const events = await readJsonl<CoreEvent>(session.recorder.eventsPath);

    expect(failure.retryLoopFinding?.classification).toBe("loop-detected");
    expect(failure.retryLoopFinding?.explanation).toMatch(/stop repeating the identical call/i);
    expect(failure.sideEffectSummary).toMatch(/blast radius/i);
    expect(failure.blastRadiusFactors?.length).toBeGreaterThan(0);
    expect(failure.rawDetailsSeparated).toBe(true);
    expect(JSON.stringify(failure)).not.toMatch(/controlled circuit-open qualifying failure/);
    expect(events.map((event) => event.type)).toContain("retry_loop.detected");
  });

  it("hashes ledger artifacts in the report manifest and redacts safe outputs", async () => {
    const { runId, session, registry } = await fixtureSession({ outputLimitBytes: 24 });

    await session.executeToolCall(registry, makeCall({ runId, toolName: "fixture.output-limit-failure" }));
    const report = await session.exportReport();
    const validation = await validateReportManifest({ runDir: session.recorder.runDir });
    const manifest = JSON.parse(await readFile(report.manifestPath, "utf8")) as {
      ledgerFile?: string;
      ledgerSha256?: string;
    };
    const ledgerText = await readFile(session.recorder.ledgerPath, "utf8");

    expect(validation.valid).toBe(true);
    expect(manifest.ledgerFile).toBe("ledger.jsonl");
    expect(manifest.ledgerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ledgerText).not.toMatch(/Bearer|sk-|api_key|secret/i);
  });
});

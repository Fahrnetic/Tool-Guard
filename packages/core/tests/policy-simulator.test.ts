import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoreSession,
  createCoreApiServer,
  createId,
  simulatePolicy,
  verifyIntegrationRoute,
  type CoreApiServerHandle,
  type CoreEvent,
  type IntegrationVerificationReceipt,
  type PolicySimulationResult
} from "../src/index.js";

const serverHandles: CoreApiServerHandle[] = [];

afterEach(async () => {
  await Promise.all(serverHandles.splice(0).map((handle) => handle.close()));
});

async function readJsonl<T>(filePath: string): Promise<T[]> {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

describe("policy simulator and integration verification core", () => {
  it("dry-runs recorded scenarios without executing downstream side effects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-policy-sim-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const observedSideEffects: string[] = [];

    const safe = await simulatePolicy({
      session,
      scenarioId: "safe-success",
      proposedPolicy: { retryLimit: 1, circuitFailureThreshold: 2 },
      sideEffectObserver: (effect) => observedSideEffects.push(effect)
    });
    const blocked = await simulatePolicy({
      session,
      scenarioId: "blocked-destructive",
      proposedPolicy: { destructiveAction: "block", retryLimit: 0 },
      sideEffectObserver: (effect) => observedSideEffects.push(effect)
    });
    const retryLoop = await simulatePolicy({
      session,
      scenarioId: "retry-loop-failure",
      proposedPolicy: { retryLimit: 2, circuitFailureThreshold: 2 },
      sideEffectObserver: (effect) => observedSideEffects.push(effect)
    });

    expect([safe.scenarioId, blocked.scenarioId, retryLoop.scenarioId]).toEqual([
      "safe-success",
      "blocked-destructive",
      "retry-loop-failure"
    ]);
    expect(observedSideEffects).toEqual([]);
    expect(new Set([...safe.previewDecisions, ...blocked.previewDecisions, ...retryLoop.previewDecisions])).toEqual(
      new Set(["allow", "block", "retry", "fail-fast", "open circuit", "close circuit"])
    );
    expect(blocked.blastRadius.before.score).toBeGreaterThan(blocked.blastRadius.after.score);
    expect(blocked.blastRadius.delta).toBe(blocked.blastRadius.after.score - blocked.blastRadius.before.score);
    expect(retryLoop.explanation).toMatch(/would/i);
    expect(retryLoop.dryRun.downstreamExecuted).toBe(false);

    const events = await readJsonl<CoreEvent>(session.recorder.eventsPath);
    expect(events.filter((event) => event.type === "policy.simulated")).toHaveLength(3);
    expect(events.filter((event) => event.type === "evidence.artifact.created").length).toBeGreaterThanOrEqual(3);
  });

  it("supports output-limit policy knobs and reports before/after context waste deltas", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-policy-output-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });

    const simulation = await simulatePolicy({
      session,
      scenarioId: "output-budget-flood",
      proposedPolicy: { outputLimitBytes: 256, outputBudgetBytes: 256 }
    });

    expect(simulation.scenarioId).toBe("output-budget-flood");
    expect(simulation.previewDecisions).toContain("fail-fast");
    expect(simulation.proposedPolicy.outputLimitBytes).toBe(256);
    expect(simulation.proposedPolicy.outputBudgetBytes).toBe(256);
    expect(simulation.contextDelta.before.bytes).toBeGreaterThan(simulation.contextDelta.after.bytes);
    expect(simulation.contextDelta.delta.bytes).toBeLessThan(0);
    expect(simulation.contextDelta.delta.estimatedTokens).toBeLessThan(0);
    expect(simulation.contextDelta.notes.join(" ")).toMatch(/output/i);
    expect(simulation.dryRun.downstreamExecuted).toBe(false);
  });

  it("verifies MCP, Python, and CLI routes with local-only probes and receipt artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-verify-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });

    const receipts = [
      await verifyIntegrationRoute({ session, routeType: "mcp-routed" }),
      await verifyIntegrationRoute({ session, routeType: "sdk-wrapped-python" }),
      await verifyIntegrationRoute({ session, routeType: "cli-supervised" })
    ];

    expect(receipts.map((receipt) => receipt.routeType)).toEqual([
      "mcp-routed",
      "sdk-wrapped-python",
      "cli-supervised"
    ]);
    expect(receipts.every((receipt) => receipt.timestamp && receipt.checkedCapabilities.length >= 3)).toBe(true);
    expect(receipts.flatMap((receipt) => receipt.checkedCapabilities.map((capability) => capability.status))).not.toContain(
      "not-yet-verified"
    );
    expect(receipts.flatMap((receipt) => receipt.checkedCapabilities.map((capability) => capability.evidence))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Executed adapter import probe/),
        expect.stringMatching(/^Executed config generation probe/),
        expect.stringMatching(/^Executed MCP virtual routed tool probe/),
        expect.stringMatching(/^Executed Python adapter import probe/),
        expect.stringMatching(/^Executed Python loopback safety probe/),
        expect.stringMatching(/^Executed Python wrapper sidecar route/),
        expect.stringMatching(/^Executed CLI process probe/),
        expect.stringMatching(/^Executed CLI argv probe/),
        expect.stringMatching(/^Executed CLI destructive guard probe/)
      ])
    );
    expect(receipts.flatMap((receipt) => receipt.checkedCapabilities.map((capability) => capability.capability))).toEqual(
      expect.arrayContaining([
        "adapter availability",
        "config snippet validity",
        "virtual routed tool evidence",
        "sidecar compatibility",
        "loopback URL safety",
        "wrapper sidecar evidence",
        "process probe",
        "argv boundary",
        "destructive guard"
      ])
    );
    expect(receipts.every((receipt) => receipt.limitation.includes("only"))).toBe(true);
    expect(receipts.every((receipt) => receipt.evidenceLinks.length > 0)).toBe(true);

    const events = await readJsonl<CoreEvent>(session.recorder.eventsPath);
    expect(events.filter((event) => event.type === "integration.verified")).toHaveLength(3);
    expect(events.filter((event) => event.type === "evidence.artifact.created").length).toBeGreaterThanOrEqual(3);
  });

  it("serves simulation and verification over Core API endpoints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-policy-api-"));
    const session = new CoreSession({ evidenceRoot: root, runId: createId("run") });
    const handle = createCoreApiServer({ host: "127.0.0.1", port: 0, evidenceRoot: root, session });
    serverHandles.push(handle);
    await handle.ready;
    const address = handle.server.address();
    expect(typeof address).toBe("object");
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    const simulation = await postJson<PolicySimulationResult>(`${baseUrl}/api/policy/simulate`, {
      scenarioId: "output-budget-flood",
      proposedPolicy: { outputBudgetBytes: 128 }
    });
    const verification = await postJson<IntegrationVerificationReceipt>(`${baseUrl}/api/integrations/verify`, {
      routeType: "cli-supervised"
    });

    expect(simulation.previewDecisions).toContain("fail-fast");
    expect(simulation.contextDelta.delta.bytes).toBeLessThan(0);
    expect(simulation.dryRun.downstreamExecuted).toBe(false);
    expect(verification.routeType).toBe("cli-supervised");
    expect(verification.checkedCapabilities.map((capability) => capability.capability)).toEqual(
      expect.arrayContaining(["process probe", "argv boundary", "destructive guard"])
    );
  });

  it("does not overclaim integration coverage booleans from failed receipt labels", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-integrations-api-"));
    const session = new CoreSession({ evidenceRoot: root, runId: createId("run") });
    const handle = createCoreApiServer({ host: "127.0.0.1", port: 0, evidenceRoot: root, session });
    serverHandles.push(handle);
    await handle.ready;
    const address = handle.server.address();
    expect(typeof address).toBe("object");
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    await session.emitIntegrationVerified({
      receiptId: createId("receipt"),
      runId: session.runId,
      timestamp: new Date().toISOString(),
      routeType: "mcp-routed",
      checkedCapabilities: [
        {
          capability: "virtual routed tool evidence",
          status: "not-yet-verified",
          localOnly: true,
          evidence: "Local probe executed but did not pass: fixture failure"
        }
      ],
      routeCoverage: [
        {
          state: "configured",
          label: "MCP routed adapter path configured",
          localOnly: true,
          evidence: "No local route configuration check passed in this doctor run."
        },
        {
          state: "available",
          label: "MCP routed adapter path available",
          localOnly: true,
          evidence: "No local route availability probe passed in this doctor run."
        },
        {
          state: "producing-evidence",
          label: "MCP routed adapter path producing evidence",
          localOnly: true,
          evidence: "This label is not proof that the failed route produced evidence."
        }
      ],
      limitation: "Local-only MCP verification checks calls routed through ToolGuard MCP configuration only.",
      evidenceLinks: []
    });

    const payload = await getJson<{
      routeCoverage: Array<{
        routeType: string;
        configured: boolean;
        available: boolean;
        producingEvidence: boolean;
      }>;
      integrations: Array<{ id: string; claimLevel: string; status: string }>;
    }>(`${baseUrl}/api/integrations`);
    const mcpRow = payload.routeCoverage.find((row) => row.routeType === "mcp-routed");
    expect(mcpRow).toMatchObject({ configured: false, available: false, producingEvidence: false });
    expect(payload.integrations.filter((integration) => integration.id === "cline" || integration.id === "roo-code")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ claimLevel: "not-yet-verified", status: "not-yet-verified" })
      ])
    );
  });

  it("does not count generic receipt artifacts as route-specific evidence production", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-integrations-evidence-"));
    const session = new CoreSession({ evidenceRoot: root, runId: createId("run") });
    const handle = createCoreApiServer({ host: "127.0.0.1", port: 0, evidenceRoot: root, session });
    serverHandles.push(handle);
    await handle.ready;
    const address = handle.server.address();
    expect(typeof address).toBe("object");
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    await session.emitIntegrationVerified({
      receiptId: createId("receipt"),
      runId: session.runId,
      timestamp: new Date().toISOString(),
      routeType: "mcp-routed",
      checkedCapabilities: [
        {
          capability: "adapter availability",
          status: "available",
          localOnly: true,
          evidence: "Executed adapter import probe for @toolplane/mcp-adapter."
        },
        {
          capability: "config snippet validity",
          status: "configured",
          localOnly: true,
          evidence: "Executed config generation probe for MCP snippets."
        },
        {
          capability: "virtual routed tool evidence",
          status: "not-yet-verified",
          localOnly: true,
          evidence: "Local route-specific evidence probe executed but did not pass."
        }
      ],
      routeCoverage: [
        {
          state: "configured",
          label: "MCP routed adapter path configured",
          localOnly: true,
          evidence: "At least one local route configuration check passed."
        },
        {
          state: "available",
          label: "MCP routed adapter path available",
          localOnly: true,
          evidence: "At least one local route availability probe passed."
        },
        {
          state: "producing-evidence",
          label: "MCP routed adapter path producing evidence",
          localOnly: true,
          evidence: "Generic receipt artifact exists, but the routed evidence probe failed."
        }
      ],
      limitation: "Local-only MCP verification checks calls routed through ToolGuard MCP configuration only.",
      evidenceLinks: [
        {
          artifactId: createId("artifact"),
          href: "artifacts/integration-verification-mcp-routed-receipt.json",
          label: "Generic verification receipt artifact"
        }
      ]
    });

    const payload = await getJson<{
      routeCoverage: Array<{
        routeType: string;
        configured: boolean;
        available: boolean;
        producingEvidence: boolean;
      }>;
      integrations: Array<{ id: string; claimLevel: string; status: string }>;
    }>(`${baseUrl}/api/integrations`);
    const mcpRow = payload.routeCoverage.find((row) => row.routeType === "mcp-routed");
    expect(mcpRow).toMatchObject({ configured: true, available: true, producingEvidence: false });
    expect(payload.integrations.filter((integration) => integration.id === "cline" || integration.id === "roo-code")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ claimLevel: "not-yet-verified", status: "not-yet-verified" })
      ])
    );
  });
});
